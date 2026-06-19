import type {
  PhorestPort,
  Service,
  SlotISO,
  CustomerResult,
  AppointmentSummary,
} from './phorest.types.js';
import { env } from '../config/env.js';
import { logger } from '../core/logger.js';
import { DateTime } from 'luxon';

const REQUIRED_ENV = [
  'PHOREST_BASE_URL',
  'PHOREST_API_USERNAME',
  'PHOREST_API_SECRET',
  'PHOREST_BUSINESS_ID',
  'PHOREST_BRANCH_ID',
] as const;

type RequiredKey = (typeof REQUIRED_ENV)[number];

type ServiceRecord = {
  serviceId: string;
  name: string;
  internetName?: string;
  price?: number;
  duration?: number;
  archived?: boolean;
  disqualifiedStaff?: string[];
};

type StaffRecord = {
  staffId: string;
  firstName?: string;
  lastName?: string;
  archived?: boolean;
  hideFromOnlineBookings?: boolean;
  hideFromAppointmentScreen?: boolean;
  disqualifiedServices?: string[];
};

type ServiceResponse = {
  _embedded?: { services?: ServiceRecord[] };
  page?: { number: number; totalPages: number };
};

type StaffResponse = {
  _embedded?: { staffs?: StaffRecord[] };
};

type AvailabilityResponse = {
  data?: Array<{
    startTime?: string;
    clientSchedules?: Array<{
      serviceSchedules?: Array<{
        startTime?: string;
      }>;
    }>;
  }>;
};

type ClientRecord = {
  clientId: string;
  firstName?: string;
  lastName?: string;
  mobile?: string;
  email?: string;
};

type ClientResponse = {
  _embedded?: { clients?: ClientRecord[] };
  page?: { number: number; totalPages: number };
};

type ClientCreateResponse = { clientId: string };

type BookingResponse = {
  bookingId?: string;
  clientAppointmentSchedules?: Array<{
    serviceSchedules?: Array<{
      appointmentId?: string;
    }>;
  }>;
};

type AppointmentResponse = {
  appointmentId: string;
  version: number;
  appointmentDate: string;
  startTime: string;
  endTime?: string;
  serviceName?: string;
  price?: number;
  staffId: string;
  roomId?: string;
  machineId?: string;
  confirmed?: boolean;
  serviceId: string;
  state?: string;
  activationState?: string;
  clientId?: string;
};

type AppointmentListResponse = {
  _embedded?: { appointments?: AppointmentResponse[] };
  page?: { number: number; totalPages: number };
};

type ServiceDetailResponse = ServiceRecord & {
  duration?: number;
  price?: number;
};

type RequestOptions = RequestInit & { expectEmpty?: boolean };

// ⏰ PHOREST TIMEZONE CONVENTION (learned the hard way — read before touching times):
//  - GET /appointment returns times in salon-LOCAL time (e.g. "12:45:00" = 12:45 PM local).
//  - POST /appointments/availability returns slot times in UTC (e.g. "...T19:00:00Z").
//  - WRITES (booking/reschedule) send salon-local wall-clock; Phorest stores it as-is.
// RULE: normalize EVERYTHING to salon-local at this adapter boundary, so the rest of
// the app (and the model) only ever deals with salon-local time. Never hand a raw
// Phorest time string to a caller/UI without converting it here first.
const SALON_TIMEZONE = env.TIMEZONE || 'America/New_York';
const PREFERRED_STAFF_ID = env.PHOREST_PRIMARY_STAFF_ID;
const PREFERRED_SERVICE_IDS = new Set(env.PHOREST_PREFERRED_SERVICE_IDS);

class PhorestHttpError extends Error {
  status: number;
  data: unknown;

  constructor(status: number, message: string, data: unknown) {
    super(message);
    this.name = 'PhorestHttpError';
    this.status = status;
    this.data = data;
  }
}

function assertEnv() {
  const missing: RequiredKey[] = REQUIRED_ENV.filter((key) => !env[key]);
  if (missing.length) {
    throw new Error(`Missing Phorest env vars: ${missing.join(', ')}`);
  }
}

function baseUrl(): string {
  assertEnv();
  const url = env.PHOREST_BASE_URL.trim();
  return url.endsWith('/') ? url : `${url}/`;
}

function businessBranchPath(path: string) {
  const root = `api/business/${env.PHOREST_BUSINESS_ID}/branch/${env.PHOREST_BRANCH_ID}`;
  return `${root}${path.startsWith('/') ? path : `/${path}`}`;
}

function parseSalonDate(date: string): DateTime {
  const dt = DateTime.fromISO(date, { zone: SALON_TIMEZONE }).startOf('day');
  if (!dt.isValid) {
    throw new Error(`Invalid date: ${date}`);
  }
  return dt;
}

function parseSalonDateTime(dateTime: string): DateTime {
  let dt = DateTime.fromISO(dateTime, { zone: SALON_TIMEZONE });
  if (!dt.isValid) {
    dt = DateTime.fromFormat(dateTime, 'yyyy-MM-dd HH:mm:ss', {
      zone: SALON_TIMEZONE,
    });
  }
  if (!dt.isValid) {
    throw new Error(`Invalid datetime: ${dateTime}`);
  }
  return dt;
}

function toPhorestIso(dt: DateTime): string {
  return dt
    .setZone(SALON_TIMEZONE)
    .toISO({ suppressMilliseconds: true }) as string;
}

// Hard cap on any single Phorest round-trip. Without this, a hung request
// becomes unbounded dead air for the caller (undici default headersTimeout ~300s).
const PHOREST_TIMEOUT_MS = Number(process.env.PHOREST_TIMEOUT_MS || 4000);

async function phorestFetch<T = unknown>(
  path: string,
  options: RequestOptions = {}
): Promise<T> {
  assertEnv();
  const url = new URL(path, baseUrl());
  const { expectEmpty, ...init } = options;
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  headers.set(
    'Authorization',
    `Basic ${Buffer.from(`${env.PHOREST_API_USERNAME}:${env.PHOREST_API_SECRET}`).toString('base64')}`
  );

  // Up to 2 attempts: retry once on a network/timeout error or a 5xx.
  // Never retry a 4xx (it's a deterministic client error — retrying just wastes the caller's time).
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(url, {
        ...init,
        headers,
        signal: AbortSignal.timeout(PHOREST_TIMEOUT_MS),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        const redacted = text.slice(0, 500);
        if (response.status >= 500 && attempt === 0) {
          lastError = new PhorestHttpError(
            response.status,
            `Phorest request failed with ${response.status}`,
            redacted
          );
          logger.warn(
            { url: url.toString(), status: response.status },
            'Phorest 5xx — retrying once'
          );
          continue;
        }
        logger.error(
          {
            msg: 'Phorest request failed',
            url: url.toString(),
            status: response.status,
            body: redacted,
          },
          'Phorest request failed'
        );
        throw new PhorestHttpError(
          response.status,
          `Phorest request failed with ${response.status}`,
          redacted
        );
      }

      if (expectEmpty || response.status === 204) {
        return undefined as T;
      }

      if (response.headers.get('Content-Length') === '0') {
        return undefined as T;
      }

      return (await response.json()) as T;
    } catch (error) {
      // PhorestHttpError for 4xx is already final; rethrow immediately.
      if (error instanceof PhorestHttpError) throw error;
      // Network error or timeout (AbortError) — retry once, then give up.
      lastError = error;
      if (attempt === 0) {
        logger.warn(
          { url: url.toString(), err: String(error) },
          'Phorest request error — retrying once'
        );
        continue;
      }
      logger.error(
        { url: url.toString(), err: String(error) },
        'Phorest request failed after retry'
      );
      throw error;
    }
  }
  throw lastError;
}

let serviceCache: Map<string, ServiceDetailResponse> | null = null;
let staffCache: StaffRecord[] | null = null;
let clientPhoneIndex: Map<string, ClientRecord> | null = null;
let clientPhoneIndexLoading: Promise<Map<string, ClientRecord>> | null = null;

async function loadClientPhoneIndex(): Promise<Map<string, ClientRecord>> {
  if (clientPhoneIndex) return clientPhoneIndex;
  if (clientPhoneIndexLoading) return clientPhoneIndexLoading;

  clientPhoneIndexLoading = (async () => {
    const index = new Map<string, ClientRecord>();
    const addPage = (clients: ClientRecord[]) => {
      for (const client of clients) {
        const phone = normalizePhone(client.mobile ?? '');
        if (phone && phone.length >= 7) {
          index.set(phone, client);
        }
      }
    };

    const clientPath = (page: number) =>
      `api/business/${env.PHOREST_BUSINESS_ID}/client?size=200&page=${page}`;

    const fetchPage = (page: number) =>
      phorestFetch<ClientResponse>(clientPath(page)).catch((err) => {
        logger.warn(
          { page, err: String(err) },
          'Client index page failed — skipping'
        );
        return null;
      });

    // Fetch page 0 to learn the page count, then fetch the rest with BOUNDED
    // concurrency. Firing every page at once blows past undici's 6-connections-
    // per-origin limit, and because each request's abort timer starts when
    // fetch() is called, the queued requests time out while still waiting. A
    // small batch keeps every in-flight request actually on the wire.
    const first = await phorestFetch<ClientResponse>(clientPath(0));
    addPage(first._embedded?.clients ?? []);
    const totalPages = first.page?.totalPages ?? 1;

    const CONCURRENCY = 5;
    for (let start = 1; start < totalPages; start += CONCURRENCY) {
      const end = Math.min(start + CONCURRENCY, totalPages);
      const batch = await Promise.all(
        Array.from({ length: end - start }, (_, i) => fetchPage(start + i))
      );
      for (const resp of batch) {
        if (resp) addPage(resp._embedded?.clients ?? []);
      }
    }

    logger.info(
      { clientCount: index.size, pages: totalPages },
      'Client phone index loaded'
    );
    clientPhoneIndex = index;
    clientPhoneIndexLoading = null;
    return index;
  })();

  return clientPhoneIndexLoading;
}

// Prices/services change rarely, so cache the catalog and only refresh on a TTL
// (default 24h; tune with SERVICE_CACHE_TTL_HOURS — e.g. 336 for 2 weeks). This
// keeps get_prices/availability instant without re-hitting Phorest every call,
// while still picking up real price changes without a server restart.
const SERVICE_CACHE_TTL_MS =
  Number(process.env.SERVICE_CACHE_TTL_HOURS || 24) * 60 * 60 * 1000;
let serviceCacheAt = 0;

async function loadServices(): Promise<Map<string, ServiceDetailResponse>> {
  if (serviceCache && Date.now() - serviceCacheAt < SERVICE_CACHE_TTL_MS) {
    return serviceCache;
  }

  const results = new Map<string, ServiceDetailResponse>();
  let page = 0;
  while (true) {
    const response = await phorestFetch<ServiceResponse>(
      businessBranchPath(`/service?size=100&page=${page}`)
    );
    const services = response._embedded?.services ?? [];
    for (const svc of services) {
      if (svc.archived) continue;
      results.set(svc.serviceId, svc);
    }
    const totalPages = response.page?.totalPages ?? 1;
    if (page >= totalPages - 1) break;
    page += 1;
  }

  serviceCache = results;
  serviceCacheAt = Date.now();
  return results;
}

async function loadService(
  serviceId: string
): Promise<ServiceDetailResponse | undefined> {
  const cache = await loadServices();
  const current = cache.get(serviceId);
  if (current) return current;

  const response = await phorestFetch<ServiceDetailResponse>(
    businessBranchPath(`/service/${serviceId}`)
  );
  cache.set(serviceId, response);
  return response;
}

async function loadStaff(): Promise<StaffRecord[]> {
  if (staffCache) return staffCache;
  const response = await phorestFetch<StaffResponse>(
    businessBranchPath('/staff?size=100')
  );
  const staff = response._embedded?.staffs ?? [];
  staffCache = staff;
  return staff;
}

function normaliseService(record: ServiceDetailResponse): Service {
  return {
    id: record.serviceId,
    name: record.internetName || record.name,
    price: typeof record.price === 'number' ? Number(record.price) : 0,
    durationMin: typeof record.duration === 'number' ? record.duration : 0,
  };
}

function splitName(fullName: string): { firstName: string; lastName: string } {
  const trimmed = fullName.trim();
  if (!trimmed) {
    return { firstName: 'Guest', lastName: 'Client' };
  }
  const parts = trimmed.split(/\s+/);
  const firstName = parts.shift() ?? 'Guest';
  const lastName = parts.length ? parts.join(' ') : 'Client';
  return { firstName, lastName };
}

function sanitisePhone(phone?: string) {
  if (!phone) return undefined;
  const digits = phone.replace(/[^0-9]/g, '');
  return digits || undefined;
}

function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.length === 11 && digits.startsWith('1')
    ? digits.slice(1)
    : digits;
}

async function findClientByEmail(email: string): Promise<string | undefined> {
  const response = await phorestFetch<ClientResponse>(
    `api/business/${env.PHOREST_BUSINESS_ID}/client?email=${encodeURIComponent(email)}&size=1`
  );
  return response._embedded?.clients?.[0]?.clientId;
}

async function findClientByPhone(phone: string): Promise<string | undefined> {
  const normalized = normalizePhone(phone);
  if (!normalized || normalized.length < 7) return undefined;
  const index = await loadClientPhoneIndex();
  return index.get(normalized)?.clientId;
}

async function createClient(customer: {
  name: string;
  phone?: string;
  email?: string;
}): Promise<string> {
  const { firstName, lastName } = splitName(customer.name);
  const phone = sanitisePhone(customer.phone);
  // Phorest requires an email — generate a placeholder if none provided
  const email =
    customer.email?.trim() ||
    `${phone || Date.now()}@placeholder.richasthreading.com`;
  const payload = {
    firstName,
    lastName,
    email,
    mobile: phone,
    creatingBranchId: env.PHOREST_BRANCH_ID,
  };

  const response = await phorestFetch<ClientCreateResponse>(
    `api/business/${env.PHOREST_BUSINESS_ID}/client`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    }
  );
  if (!response.clientId) {
    throw new Error('Failed to create Phorest client');
  }

  // Keep the in-memory phone index hot: a caller who books a new profile and
  // calls back in the same process should resolve instantly without a re-scan.
  if (clientPhoneIndex && phone) {
    const normalized = normalizePhone(phone);
    if (normalized && normalized.length >= 7) {
      clientPhoneIndex.set(normalized, {
        clientId: response.clientId,
        firstName,
        lastName,
        mobile: phone,
        email,
      });
    }
  }

  return response.clientId;
}

async function getOrCreateClient(customer: {
  name: string;
  phone?: string;
  email?: string;
}): Promise<string> {
  const email = customer.email?.trim().toLowerCase();
  if (email) {
    const existing = await findClientByEmail(email);
    if (existing) return existing;
  }

  const phone = sanitisePhone(customer.phone);
  if (phone) {
    const existing = await findClientByPhone(phone);
    if (existing) return existing;
  }

  return createClient(customer);
}

async function pickStaffId(
  serviceId: string,
  disqualified: string[] = []
): Promise<string> {
  const staffList = await loadStaff();
  const allowed = staffList.filter((staff) => {
    if (staff.archived) return false;
    if (staff.hideFromOnlineBookings) return false;
    if (staff.hideFromAppointmentScreen) return false;
    const disqualifiedServices = staff.disqualifiedServices ?? [];
    if (disqualified.includes(staff.staffId)) return false;
    return !disqualifiedServices.includes(serviceId);
  });

  if (PREFERRED_STAFF_ID) {
    const preferred = allowed.find(
      (staff) => staff.staffId === PREFERRED_STAFF_ID
    );
    if (preferred) return preferred.staffId;
  }

  const staffId = allowed[0]?.staffId;
  if (!staffId) {
    if (PREFERRED_STAFF_ID) {
      logger.warn(
        { serviceId, PREFERRED_STAFF_ID },
        'Preferred staff unavailable, forcing booking'
      );
      return PREFERRED_STAFF_ID;
    }
    throw new Error('No eligible staff available for service');
  }
  return staffId;
}

async function fetchAppointment(
  appointmentId: string
): Promise<AppointmentResponse | undefined> {
  // Fast path: fetch the single appointment by ID directly (1 round-trip).
  // The history scan below is a fallback only if the direct lookup isn't
  // available on this tenant — it can cost up to 10 sequential round-trips.
  try {
    const direct = await phorestFetch<AppointmentResponse>(
      businessBranchPath(`/appointment/${appointmentId}`)
    );
    if (direct?.appointmentId) return direct;
  } catch (error) {
    logger.warn(
      { appointmentId, err: String(error) },
      'Direct appointment fetch failed — falling back to history scan'
    );
  }

  const now = new Date();
  const updatedTo = now.toISOString();
  const updatedFrom = new Date(
    now.getTime() - 30 * 24 * 60 * 60 * 1000
  ).toISOString();

  let page = 0;
  while (page < 10) {
    const response = await phorestFetch<AppointmentListResponse>(
      businessBranchPath(
        `/appointment?updated_from=${encodeURIComponent(updatedFrom)}&updated_to=${encodeURIComponent(updatedTo)}&size=100&page=${page}`
      )
    );

    const appointments = response._embedded?.appointments ?? [];
    const match = appointments.find(
      (item) => item.appointmentId === appointmentId
    );
    if (match) return match;

    const totalPages = response.page?.totalPages ?? 1;
    if (page >= totalPages - 1) break;
    page += 1;
  }

  return undefined;
}

export const realPhorest: PhorestPort = {
  async listServices(): Promise<Service[]> {
    const services = await loadServices();
    const normalised = Array.from(services.values()).map(normaliseService);
    return normalised.sort((a, b) => {
      const aPref = PREFERRED_SERVICE_IDS.has(a.id) ? 0 : 1;
      const bPref = PREFERRED_SERVICE_IDS.has(b.id) ? 0 : 1;
      if (aPref !== bPref) return aPref - bPref;
      return a.name.localeCompare(b.name);
    });
  },

  async getAvailability(serviceId: string, date: string): Promise<SlotISO[]> {
    const start = parseSalonDate(date);
    const end = start.endOf('day');

    const response = await phorestFetch<AvailabilityResponse>(
      businessBranchPath('/appointments/availability'),
      {
        method: 'POST',
        body: JSON.stringify({
          startTime: toPhorestIso(start),
          endTime: toPhorestIso(end),
          clientServiceSelections: [
            {
              serviceSelections: [
                {
                  serviceId,
                  staffId: PREFERRED_STAFF_ID || undefined,
                },
              ],
            },
          ],
        }),
      }
    );

    const slotSet = new Set<string>();

    for (const slot of response.data ?? []) {
      if (slot.startTime) slotSet.add(slot.startTime);
      for (const clientSchedule of slot.clientSchedules ?? []) {
        for (const serviceSchedule of clientSchedule.serviceSchedules ?? []) {
          if (serviceSchedule.startTime) {
            slotSet.add(serviceSchedule.startTime);
          }
        }
      }
    }

    // The availability endpoint returns slot times in UTC (e.g. "...T19:00:00Z"),
    // UNLIKE the appointment GET endpoint which returns salon-local time. Convert
    // every slot to salon-local ISO so the rest of the app (and the model) reads
    // the right wall-clock time — otherwise 3 PM (19:00Z) gets spoken as "7 PM".
    return Array.from(slotSet)
      .map(
        (s) =>
          DateTime.fromISO(s, { zone: 'utc' })
            .setZone(SALON_TIMEZONE)
            .toISO({ suppressMilliseconds: true })!
      )
      .filter(Boolean)
      .sort();
  },

  async createAppointment(serviceId, startIso, customer) {
    const service = await loadService(serviceId);
    if (!service) {
      throw new Error(`Service ${serviceId} not found in Phorest`);
    }

    const start = parseSalonDateTime(startIso);
    const end = start.plus({ minutes: service.duration ?? 0 });

    // These two are independent — resolve them concurrently to shave a
    // round-trip off the booking the caller is waiting on.
    const [clientId, staffId] = await Promise.all([
      getOrCreateClient(customer),
      pickStaffId(serviceId, service.disqualifiedStaff ?? []),
    ]);

    const payload = {
      clientId,
      // Create the booking ACTIVE, not as a RESERVED/held hold. Phorest's
      // booking lifecycle is ACTIVE|RESERVED|CANCELED; a RESERVED booking can
      // render as a white, uneditable block in the Phorest calendar. (If a
      // tenant ever forces RESERVED-on-create, follow with POST
      // .../booking/{bookingId}/activate using response.bookingId.)
      bookingStatus: 'ACTIVE',
      clientAppointmentSchedules: [
        {
          clientId,
          serviceSchedules: [
            {
              serviceId,
              staffId,
              startTime: toPhorestIso(start),
              endTime: toPhorestIso(end),
            },
          ],
        },
      ],
    };

    const response = await phorestFetch<BookingResponse>(
      businessBranchPath('/booking?force_selected_time=true'),
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    );

    const appointmentId =
      response.clientAppointmentSchedules?.[0]?.serviceSchedules?.[0]
        ?.appointmentId;
    if (!appointmentId) {
      throw new Error('Phorest booking response missing appointmentId');
    }

    // Non-blocking diagnostic: read the appointment back and log its real state
    // so we can see whether it lands ACTIVE/BOOKED (normal, editable) vs a
    // RESERVED hold (white, uneditable). Does not delay the caller's confirmation.
    void fetchAppointment(appointmentId)
      .then((appt) => {
        if (appt) {
          logger.info(
            {
              appointmentId,
              state: appt.state,
              activationState: appt.activationState,
              confirmed: appt.confirmed,
            },
            '🗓️  Booking state after create'
          );
        }
      })
      .catch(() => {});

    return { appointmentId, bookingId: response.bookingId };
  },

  async updateAppointment(appointmentId: string, newStartIso: string) {
    const appointment = await fetchAppointment(appointmentId);
    if (!appointment) {
      throw new Error(`Appointment ${appointmentId} not found`);
    }

    const service = await loadService(appointment.serviceId);
    if (!service) {
      throw new Error(`Service ${appointment.serviceId} not found`);
    }

    const start = parseSalonDateTime(newStartIso);
    const end = start.plus({ minutes: service.duration ?? 0 });

    const payload = {
      appointmentId,
      version: appointment.version,
      appointmentDate: start.toISODate(),
      startTime: start.toFormat('HH:mm:ss'),
      endTime: end.toFormat('HH:mm:ss'),
      price: appointment.price,
      staffId: appointment.staffId,
      roomId: appointment.roomId,
      machineId: appointment.machineId,
      confirmed: appointment.confirmed,
    };

    await phorestFetch(
      businessBranchPath(
        `/appointment/${appointmentId}?force_selected_time=true`
      ),
      {
        method: 'PUT',
        body: JSON.stringify(payload),
        expectEmpty: true,
      }
    );

    return { appointmentId };
  },

  async cancelAppointment(appointmentId: string) {
    await phorestFetch(
      businessBranchPath(
        `/appointment/cancel?appointment_id=${encodeURIComponent(appointmentId)}`
      ),
      {
        method: 'POST',
        expectEmpty: true,
      }
    );

    return { appointmentId, cancelled: true as const };
  },

  async lookupCustomerByPhone(phone: string): Promise<CustomerResult | null> {
    const normalized = normalizePhone(phone);
    if (!normalized || normalized.length < 7) return null;

    // Phorest's ?mobile= param doesn't filter — use our cached phone index
    const index = await loadClientPhoneIndex();
    const client = index.get(normalized);
    if (!client) return null;
    return {
      clientId: client.clientId,
      firstName: client.firstName || '',
      lastName: client.lastName || '',
      ...(client.mobile !== undefined && { phone: client.mobile }),
      ...(client.email !== undefined && { email: client.email }),
    };
  },

  async lookupCustomerByName(
    firstName: string,
    lastName: string
  ): Promise<CustomerResult[]> {
    const response = await phorestFetch<ClientResponse>(
      `api/business/${env.PHOREST_BUSINESS_ID}/client?firstName=${encodeURIComponent(firstName)}&lastName=${encodeURIComponent(lastName)}&size=10`
    );
    const clients = response._embedded?.clients ?? [];
    return clients.map((c) => ({
      clientId: c.clientId,
      firstName: c.firstName || firstName,
      lastName: c.lastName || lastName,
      ...(c.mobile !== undefined && { phone: c.mobile }),
      ...(c.email !== undefined && { email: c.email }),
    }));
  },

  async listAppointments(
    clientId: string,
    fromDate?: string
  ): Promise<AppointmentSummary[]> {
    const today =
      fromDate ?? DateTime.now().setZone(SALON_TIMEZONE).toISODate()!;
    // Phorest requires both from_date and to_date AND caps the range at 31 days
    // ("Max date range allowed is 31 days"). Use 30 to stay safely under it.
    const toDate = DateTime.fromISO(today).plus({ days: 30 }).toISODate()!;
    // CRITICAL: the param is snake_case `client_id`. The camelCase `clientId`
    // is silently IGNORED by Phorest and returns EVERY client's appointments
    // (a privacy leak + wrong-client reschedule/cancel risk). We also re-filter
    // by clientId client-side as defense-in-depth.
    const response = await phorestFetch<AppointmentListResponse>(
      businessBranchPath(
        `/appointment?client_id=${encodeURIComponent(clientId)}&from_date=${today}&to_date=${toDate}&size=20`
      )
    );
    // Phorest returns appointment times in the salon's LOCAL timezone (confirmed
    // empirically: a 12:45 PM booking is stored as "12:45:00"), so parse as
    // local — do NOT treat as UTC, or every time comes out hours early.
    // Only surface UPCOMING, still-BOOKED appointments (PAID = already
    // completed and can't be rescheduled/cancelled), soonest first, capped to a
    // handful so Erica doesn't read out a wall of history.
    const now = DateTime.now().setZone(SALON_TIMEZONE);
    const appointments = response._embedded?.appointments ?? [];
    return appointments
      .filter(
        (a) =>
          // Never surface another client's appointment, even if the API filter fails.
          (!a.clientId || a.clientId === clientId) &&
          a.activationState === 'ACTIVE' &&
          a.state === 'BOOKED'
      )
      .map((a) => ({
        a,
        start: DateTime.fromISO(`${a.appointmentDate}T${a.startTime}`, {
          zone: SALON_TIMEZONE,
        }),
      }))
      .filter(({ start }) => start >= now)
      .sort((x, y) => x.start.toMillis() - y.start.toMillis())
      .slice(0, 5)
      .map(({ a, start }) => ({
        appointmentId: a.appointmentId,
        serviceName: a.serviceName ?? 'Appointment',
        date: start.toISODate()!,
        timeDisplay: start.toFormat('h:mm a'),
        startTimeRaw: a.startTime,
        endTimeRaw: a.endTime ?? a.startTime,
      }));
  },

  async addAppointmentNote(appointmentId: string, note: string): Promise<void> {
    try {
      await phorestFetch(
        businessBranchPath(`/appointment/${appointmentId}/note`),
        {
          method: 'POST',
          body: JSON.stringify({ text: note }),
          expectEmpty: true,
        }
      );
    } catch (error) {
      logger.warn(
        { appointmentId, error: String(error) },
        'Failed to add appointment note — continuing'
      );
    }
  },

  async preloadClients(): Promise<void> {
    await loadClientPhoneIndex();
  },

  async getTodayAppointments(): Promise<AppointmentSummary[]> {
    const today = DateTime.now().setZone(SALON_TIMEZONE).toISODate()!;
    const response = await phorestFetch<AppointmentListResponse>(
      businessBranchPath(
        `/appointment?from_date=${today}&to_date=${today}&size=200`
      )
    );
    const appointments = response._embedded?.appointments ?? [];
    return appointments
      .filter(
        (a) =>
          a.activationState === 'ACTIVE' &&
          (a.state === 'BOOKED' || a.state === 'PAID')
      )
      .map((a) => {
        // Phorest times are salon-local, not UTC — parse as local.
        const startLocal = DateTime.fromISO(
          `${a.appointmentDate}T${a.startTime}`,
          { zone: SALON_TIMEZONE }
        );
        return {
          appointmentId: a.appointmentId,
          serviceName: a.serviceName ?? 'Appointment',
          date: startLocal.toISODate()!,
          timeDisplay: startLocal.toFormat('h:mm a'),
          startTimeRaw: a.startTime,
          endTimeRaw: a.endTime ?? a.startTime,
        };
      })
      .sort((a, b) => a.startTimeRaw.localeCompare(b.startTimeRaw));
  },
};
