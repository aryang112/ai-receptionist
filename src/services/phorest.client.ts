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
  duration?: number; // minutes; used to derive end when endTime is absent (F10a)
};

type AppointmentListResponse = {
  _embedded?: { appointments?: AppointmentResponse[] };
  page?: { number: number; totalPages: number };
};

type ServiceDetailResponse = ServiceRecord & {
  duration?: number;
  price?: number;
};

type RequestOptions = RequestInit & {
  expectEmpty?: boolean;
  // Whether a network/timeout/5xx failure may be safely retried. Defaults to
  // (method === 'GET') — i.e. idempotent reads only. NON-idempotent writes
  // (booking POST, client POST, appointment PUT, cancel POST) must pass false /
  // leave it default-false: a timed-out write that actually succeeded server-side
  // would DOUBLE-BOOK / duplicate a client if we retried it. Read-only POSTs
  // (availability) may opt back in with retriable: true.
  retriable?: boolean;
};

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
  const { expectEmpty, retriable, ...init } = options;
  // Only idempotent requests may be retried. Default: GETs. Any write must opt
  // out (default-false for non-GET) to avoid a duplicate on a timed-out-but-
  // -succeeded write.
  const method = (init.method ?? 'GET').toUpperCase();
  const canRetry = retriable ?? method === 'GET';
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  headers.set(
    'Authorization',
    `Basic ${Buffer.from(`${env.PHOREST_API_USERNAME}:${env.PHOREST_API_SECRET}`).toString('base64')}`
  );

  // Up to 2 attempts: retry once on a network/timeout error or a 5xx — but ONLY
  // for idempotent requests (canRetry). Never retry a 4xx (deterministic client
  // error). Never retry a write (a timed-out booking may have succeeded).
  const maxAttempts = canRetry ? 2 : 1;
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const response = await fetch(url, {
        ...init,
        headers,
        signal: init.signal ?? AbortSignal.timeout(PHOREST_TIMEOUT_MS),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        const redacted = text.slice(0, 500);
        if (response.status >= 500 && canRetry && attempt === 0) {
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
      // Network error or timeout (AbortError) — retry once for reads, then give
      // up. Writes are never retried (canRetry === false) to avoid a duplicate.
      lastError = error;
      if (canRetry && attempt === 0) {
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
// When the current index finished loading (epoch ms). Drives the TTL refresh.
let clientPhoneIndexAt = 0;
// Guards against firing overlapping background reloads.
let clientPhoneIndexReloading = false;
// Set when a client-list page failed (post-retry) during an index build, so the
// index is missing some clients (a caller on a dropped page won't be recognized
// → risk of a duplicate profile at booking). Warned about once per process to
// avoid log spam; behavior is otherwise unchanged.
let clientIndexIncomplete = false;
let clientIndexIncompleteWarned = false;

// A model response can issue the same booking call more than once before the
// first client lookup/create finishes. Keep client identity resolution
// single-flight per confirmed appointment subject, then retain the successful
// result briefly so a near-sequential repeat cannot create a second profile.
// Pending entries are never evicted; resolved entries are both TTL- and
// LRU-bounded, while uncertain entries stay fail-closed and periodically reconcile.
const CLIENT_RESOLUTION_TTL_MS = 10 * 60 * 1000;
// A client-create transport failure may have committed at Phorest even though
// Erica never received the response. Retry authoritative reads after this
// interval, but never issue another create while the outcome remains unknown.
const CLIENT_RESOLUTION_UNCERTAIN_RECONCILE_MS = 30 * 1000;
const CLIENT_RESOLUTION_MAX_SUCCESSFUL = 256;
type ClientResolutionEntry = {
  promise: Promise<string>;
  state: 'pending' | 'resolved' | 'uncertain';
  expiresAt: number;
};
const clientResolutionCache = new Map<string, ClientResolutionEntry>();

// The client list changes slowly, but a long-running process must not serve a
// stale phone index forever (a client added today would never resolve). After
// this window we trigger a background reload — never blocking a live call.
const CLIENT_INDEX_TTL_MS = env.CLIENT_INDEX_TTL_HOURS * 60 * 60 * 1000;

async function buildClientPhoneIndex(): Promise<Map<string, ClientRecord>> {
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

  let pageFailed = false;
  const fetchPage = (page: number) =>
    phorestFetch<ClientResponse>(clientPath(page)).catch((err) => {
      pageFailed = true;
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

  // If any page dropped, flag the index as incomplete (warn once). We still
  // serve what we have — a partial index is better than none — but a caller on
  // a missing page won't resolve, so the risk of a duplicate profile at booking
  // is knowable rather than silent.
  clientIndexIncomplete = pageFailed;
  if (pageFailed && !clientIndexIncompleteWarned) {
    clientIndexIncompleteWarned = true;
    logger.warn(
      { pages: totalPages },
      'Client phone index INCOMPLETE — at least one page failed after retry; some callers may not be recognized'
    );
  }

  logger.info(
    { clientCount: index.size, pages: totalPages, incomplete: pageFailed },
    'Client phone index loaded'
  );
  return index;
}

// True when the last-built client phone index dropped at least one page and so
// is missing some clients. Exposed for observability/health checks; the booking
// path is unchanged (we still serve the partial index).
export function isClientIndexIncomplete(): boolean {
  return clientIndexIncomplete;
}

// Fire-and-forget refresh: rebuilds the index off the request path and swaps it
// in atomically once ready. Never awaited by a caller, so a live lookup keeps
// serving the current (stale) index until the fresh one is ready.
function refreshClientPhoneIndexInBackground(): void {
  if (clientPhoneIndexReloading) return;
  clientPhoneIndexReloading = true;
  void buildClientPhoneIndex()
    .then((index) => {
      clientPhoneIndex = index;
      clientPhoneIndexAt = Date.now();
    })
    .catch((err) => {
      // Keep serving the existing index; try again on the next stale lookup.
      logger.warn(
        { err: String(err) },
        'Background client index refresh failed — keeping current index'
      );
    })
    .finally(() => {
      clientPhoneIndexReloading = false;
    });
}

async function loadClientPhoneIndex(): Promise<Map<string, ClientRecord>> {
  if (clientPhoneIndex) {
    // Serve the current index immediately; refresh in the background if stale.
    if (Date.now() - clientPhoneIndexAt >= CLIENT_INDEX_TTL_MS) {
      refreshClientPhoneIndexInBackground();
    }
    return clientPhoneIndex;
  }
  if (clientPhoneIndexLoading) return clientPhoneIndexLoading;

  clientPhoneIndexLoading = (async () => {
    try {
      const index = await buildClientPhoneIndex();
      clientPhoneIndex = index;
      clientPhoneIndexAt = Date.now();
      return index;
    } finally {
      // ALWAYS clear the in-flight promise — success OR failure. If a single
      // boot-time load rejected (a Phorest blip) and we left the rejected
      // promise cached, every later lookup AND booking (getOrCreateClient ->
      // findClientRecordByPhone) would keep re-throwing that same failure for
      // the life of the process. Clearing it lets the next call retry cleanly.
      clientPhoneIndexLoading = null;
    }
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

  try {
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
  } catch (err) {
    // A TTL-EXPIRED refresh that fails must not blow up mid-call: prices/services
    // change rarely, so a slightly-stale catalog is far better than throwing at
    // the caller. Serve the copy we still hold (warn once per failure); only a
    // TRULY cold cache (never loaded) re-throws.
    if (serviceCache) {
      // F9: back off before retrying — otherwise EVERY get_prices/availability
      // call during a Phorest outage re-attempts a full (2x4s) refresh, i.e.
      // ~8s of dead air per tool call. Push serviceCacheAt forward so we serve
      // the stale copy for ~60s before trying again.
      const REFRESH_BACKOFF_MS = 60_000;
      serviceCacheAt = Date.now() - SERVICE_CACHE_TTL_MS + REFRESH_BACKOFF_MS;
      logger.warn(
        { err: String(err) },
        'Service catalog refresh failed — serving stale cached copy (retry in ~60s)'
      );
      return serviceCache;
    }
    throw err;
  }
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

// US numbers never start with 0 (NANP area codes are 2–9), so leading zeros
// are always a formatting artifact (UI national notation / typed prefix) —
// strip them, then strip a leading country 1: we store and match on the bare
// 10-digit number (Aryan's convention, 2026-08-27).
function sanitisePhone(phone?: string) {
  if (!phone) return undefined;
  let digits = phone.replace(/[^0-9]/g, '').replace(/^0+/, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  return digits || undefined;
}

function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '').replace(/^0+/, '');
  return digits.length === 11 && digits.startsWith('1')
    ? digits.slice(1)
    : digits;
}

function normalizeIdentityText(value: string): string {
  return value.trim().normalize('NFKC').replace(/\s+/g, ' ').toLowerCase();
}

function normalizeEmail(email?: string): string | undefined {
  const normalized = email ? normalizeIdentityText(email) : '';
  return normalized || undefined;
}

type ConfirmedClientSubject = {
  firstName: string;
  lastName: string;
  fullName: string;
  email?: string;
  phone?: string;
};

function confirmedClientSubject(customer: {
  name: string;
  phone?: string;
  email?: string;
}): ConfirmedClientSubject | undefined {
  const nameParts = customer.name
    .trim()
    .normalize('NFKC')
    .split(/\s+/)
    .filter(Boolean);
  if (nameParts.length < 2) return undefined;

  const firstName = nameParts[0]!;
  const lastName = nameParts.slice(1).join(' ');
  const email = normalizeEmail(customer.email);
  const sanitizedPhone = sanitisePhone(customer.phone);
  const phone = sanitizedPhone?.length === 10 ? sanitizedPhone : undefined;
  if (!email && !phone) return undefined;

  return {
    firstName,
    lastName,
    fullName: normalizeIdentityText(nameParts.join(' ')),
    ...(email ? { email } : {}),
    ...(phone ? { phone } : {}),
  };
}

function clientMatchesConfirmedSubject(
  client: ClientRecord,
  subject: ConfirmedClientSubject
): boolean {
  return clientConfirmedContactScore(client, subject) > 0;
}

function clientConfirmedContactScore(
  client: ClientRecord,
  subject: ConfirmedClientSubject
): number {
  const clientName = normalizeIdentityText(
    `${client.firstName ?? ''} ${client.lastName ?? ''}`
  );
  if (clientName !== subject.fullName) return 0;

  const emailMatches =
    subject.email !== undefined &&
    normalizeEmail(client.email) === subject.email;
  const phoneMatches =
    subject.phone !== undefined &&
    normalizePhone(client.mobile ?? '') === subject.phone;
  return Number(emailMatches) + Number(phoneMatches);
}

class AmbiguousClientMatchError extends Error {
  constructor() {
    super('Multiple Phorest clients match the confirmed caller identity');
    this.name = 'AmbiguousClientMatchError';
  }
}

function pickConfirmedClientRecord(
  clients: ClientRecord[],
  subject: ConfirmedClientSubject
): ClientRecord | undefined {
  const matches = clients
    .map((client) => ({
      client,
      score: clientConfirmedContactScore(client, subject),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score);
  if (matches.length === 0) return undefined;

  const bestScore = matches[0]!.score;
  const bestMatches = matches.filter(
    (candidate) => candidate.score === bestScore
  );
  if (bestMatches.length > 1) {
    logger.warn(
      {
        matchCount: bestMatches.length,
        candidateCount: matches.length,
        contactMatchCount: bestScore,
      },
      'Multiple Phorest clients ambiguously match the confirmed caller identity'
    );
    throw new AmbiguousClientMatchError();
  }
  return bestMatches[0]!.client;
}

async function findClientRecordByEmail(
  subject: ConfirmedClientSubject,
  options: RequestOptions = {}
): Promise<ClientRecord | undefined> {
  if (!subject.email) return undefined;
  const response = await phorestFetch<ClientResponse>(
    `api/business/${env.PHOREST_BUSINESS_ID}/client?email=${encodeURIComponent(subject.email)}&size=50`,
    options
  );
  return pickConfirmedClientRecord(response._embedded?.clients ?? [], subject);
}

async function findClientRecordByPhone(
  phone: string
): Promise<ClientRecord | undefined> {
  const normalized = normalizePhone(phone);
  if (!normalized || normalized.length < 7) return undefined;
  const index = await loadClientPhoneIndex();
  return index.get(normalized);
}

// The name query is only a way to narrow the provider read. A result is never
// trusted by name alone: the returned record must also carry the confirmed
// email and/or phone for this appointment subject.
async function findClientRecordByConfirmedName(
  subject: ConfirmedClientSubject,
  options: RequestOptions = {}
): Promise<ClientRecord | undefined> {
  const response = await phorestFetch<ClientResponse>(
    `api/business/${env.PHOREST_BUSINESS_ID}/client?firstName=${encodeURIComponent(subject.firstName)}&lastName=${encodeURIComponent(subject.lastName)}&size=50`,
    options
  );
  return pickConfirmedClientRecord(response._embedded?.clients ?? [], subject);
}

// Direct provider reads used before a create and after an ambiguous create
// failure. Unlike the process phone index, these reads can observe a client
// that Phorest committed moments ago.
async function findAuthoritativeClientRecord(
  subject: ConfirmedClientSubject,
  options: RequestOptions = {}
): Promise<ClientRecord | undefined> {
  if (subject.email) {
    const byEmail = await findClientRecordByEmail(subject, options);
    if (byEmail) return byEmail;
  }
  if (subject.phone) {
    return findClientRecordByConfirmedName(subject, options);
  }
  return undefined;
}

function rememberClientRecordInPhoneIndex(client: ClientRecord): void {
  if (!clientPhoneIndex || !client.mobile) return;
  const phone = normalizePhone(client.mobile);
  if (phone && phone.length >= 7 && !clientPhoneIndex.has(phone)) {
    // Shared/family numbers deliberately keep their original index owner.
    // Subject-specific resolution is retained separately in the result cache.
    clientPhoneIndex.set(phone, client);
  }
}

class ClientCreateOutcomeUncertainError extends Error {
  constructor() {
    super(
      'Phorest client-create outcome is uncertain; an immediate retry is blocked'
    );
    this.name = 'ClientCreateOutcomeUncertainError';
  }
}

function isAmbiguousClientCreateFailure(error: unknown): boolean {
  // A deterministic 4xx means Phorest rejected the request. Transport errors,
  // timeouts, malformed success responses, and 5xx responses may have happened
  // after the provider committed the client.
  return !(error instanceof PhorestHttpError) || error.status >= 500;
}

const CLIENT_CREATE_RECONCILE_ATTEMPTS = 3;
const CLIENT_CREATE_RECONCILE_DELAY_MS = 100;
const CLIENT_CREATE_RECONCILE_TIMEOUT_MS = 2500;

async function reconcileClientCreate(customer: {
  name: string;
  phone?: string;
  email?: string;
}): Promise<ClientRecord | undefined> {
  const subject = confirmedClientSubject(customer);
  if (!subject) return undefined;
  const deadlineAt = Date.now() + CLIENT_CREATE_RECONCILE_TIMEOUT_MS;
  const deadlineSignal = AbortSignal.timeout(
    CLIENT_CREATE_RECONCILE_TIMEOUT_MS
  );

  for (
    let attempt = 0;
    attempt < CLIENT_CREATE_RECONCILE_ATTEMPTS;
    attempt += 1
  ) {
    if (deadlineSignal.aborted || Date.now() >= deadlineAt) break;
    try {
      const record = await findAuthoritativeClientRecord(subject, {
        // The loop owns retry timing. A shared deadline prevents three nested
        // read retries from turning one caller-facing tool into ~24s of silence.
        retriable: false,
        signal: deadlineSignal,
      });
      if (record) {
        rememberClientRecordInPhoneIndex(record);
        return record;
      }
    } catch (error) {
      logger.warn(
        { attempt: attempt + 1, err: String(error) },
        'Client-create reconciliation read failed'
      );
    }

    if (
      attempt + 1 < CLIENT_CREATE_RECONCILE_ATTEMPTS &&
      !deadlineSignal.aborted &&
      Date.now() < deadlineAt
    ) {
      await new Promise<void>((resolve) =>
        setTimeout(
          resolve,
          Math.min(
            CLIENT_CREATE_RECONCILE_DELAY_MS,
            Math.max(0, deadlineAt - Date.now())
          )
        )
      );
    }
  }
  return undefined;
}

async function createClient(customer: {
  name: string;
  phone?: string;
  email?: string;
}): Promise<string> {
  const { firstName, lastName } = splitName(customer.name);
  const phone = sanitisePhone(customer.phone);
  const email = customer.email?.trim();
  const payload = {
    firstName,
    lastName,
    ...(email ? { email } : {}),
    ...(phone ? { mobile: phone } : {}),
    creatingBranchId: env.PHOREST_BRANCH_ID,
  };

  let response: ClientCreateResponse;
  try {
    response = await phorestFetch<ClientCreateResponse>(
      `api/business/${env.PHOREST_BUSINESS_ID}/client`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    );
    if (!response.clientId) {
      throw new Error('Phorest client create returned no clientId');
    }
  } catch (error) {
    if (!isAmbiguousClientCreateFailure(error)) throw error;
    const reconciled = await reconcileClientCreate(customer);
    if (reconciled) return reconciled.clientId;
    throw new ClientCreateOutcomeUncertainError();
  }

  // Keep the in-memory phone index hot: a caller who books a new profile and
  // calls back in the same process should resolve instantly without a re-scan.
  // F5: NEVER overwrite an existing entry. On a shared/family number the A5
  // guard creates a second profile (e.g. the daughter) that carries the same
  // phone; overwriting would make the original owner's (mom's) next call
  // prefetch the wrong person. First writer for a number wins.
  rememberClientRecordInPhoneIndex({
    clientId: response.clientId,
    firstName,
    lastName,
    ...(phone ? { mobile: phone } : {}),
    ...(email ? { email } : {}),
  });

  return response.clientId;
}

async function getOrCreateClientUncached(customer: {
  name: string;
  phone?: string;
  email?: string;
}): Promise<string> {
  const subject = confirmedClientSubject(customer);
  if (subject?.email) {
    const existing = await findClientRecordByEmail(subject);
    if (existing) {
      rememberClientRecordInPhoneIndex(existing);
      return existing.clientId;
    }
  }

  const { firstName: wantFirst } = splitName(customer.name);

  const phone = sanitisePhone(customer.phone);
  if (phone) {
    const record = await findClientRecordByPhone(phone);
    if (record) {
      // Only reuse the phone match if the caller's name is consistent with the
      // record. On a SHARED/FAMILY number, blindly reusing the phone owner books
      // the wrong person (name silently discarded) — and the booking is then
      // invisible to a later "when's my appointment?" under the real name. If
      // a confirmed full name does NOT match, fall through to an authoritative
      // subject lookup, then create a fresh profile.
      if (subject && clientMatchesConfirmedSubject(record, subject)) {
        return record.clientId;
      }

      // Preserve the pre-existing best-effort behavior for an unconfirmed
      // single-component name, but never apply it to a confirmed full name.
      if (!subject) {
        const recFirst = normalizeIdentityText(record.firstName ?? '');
        const provided = normalizeIdentityText(wantFirst);
        if (!provided || provided === 'guest' || recFirst === provided) {
          return record.clientId;
        }
      }
    }

    if (subject) {
      const authoritative = await findClientRecordByConfirmedName(subject);
      if (authoritative) {
        rememberClientRecordInPhoneIndex(authoritative);
        return authoritative.clientId;
      }
    }
  }

  return createClient(customer);
}

function normalizedClientSubjectKey(customer: {
  name: string;
  phone?: string;
  email?: string;
}): string | undefined {
  const subject = confirmedClientSubject(customer);
  if (!subject) return undefined;

  // Phone + confirmed full name is the canonical appointment subject. Optional
  // email must not split two parallel payloads for the same caller into
  // separate client creates. Email is the fallback only when no phone exists.
  if (subject.phone) return `phone-name:${subject.phone}:${subject.fullName}`;
  if (subject.email) return `email-name:${subject.email}:${subject.fullName}`;
  return undefined;
}

function pruneClientResolutionCache(now: number): void {
  for (const [key, entry] of clientResolutionCache) {
    if (entry.state === 'resolved' && entry.expiresAt <= now) {
      clientResolutionCache.delete(key);
    }
  }

  let successfulCount = 0;
  for (const entry of clientResolutionCache.values()) {
    if (entry.state === 'resolved') successfulCount += 1;
  }
  if (successfulCount <= CLIENT_RESOLUTION_MAX_SUCCESSFUL) return;

  // Map iteration is insertion order. Cache hits and successful settlements
  // are moved to the end, so deleting from the front gives us a small LRU.
  for (const [key, entry] of clientResolutionCache) {
    if (entry.state !== 'resolved') continue;
    clientResolutionCache.delete(key);
    successfulCount -= 1;
    if (successfulCount <= CLIENT_RESOLUTION_MAX_SUCCESSFUL) break;
  }
}

function trackClientResolution(
  subjectKey: string,
  promise: Promise<string>
): Promise<string> {
  const entry: ClientResolutionEntry = {
    promise,
    state: 'pending',
    expiresAt: 0,
  };
  clientResolutionCache.set(subjectKey, entry);

  void promise.then(
    (clientId) => {
      // A missing/unknown outcome must never become a reusable binding.
      if (clientResolutionCache.get(subjectKey) !== entry) return;
      if (!clientId) {
        clientResolutionCache.delete(subjectKey);
        return;
      }
      entry.state = 'resolved';
      entry.expiresAt = Date.now() + CLIENT_RESOLUTION_TTL_MS;
      clientResolutionCache.delete(subjectKey);
      clientResolutionCache.set(subjectKey, entry);
      pruneClientResolutionCache(Date.now());
    },
    (error) => {
      if (clientResolutionCache.get(subjectKey) !== entry) return;
      if (error instanceof ClientCreateOutcomeUncertainError) {
        entry.state = 'uncertain';
        // This is the next time a retry may perform authoritative reads. It is
        // not an expiry into another create attempt.
        entry.expiresAt = Date.now() + CLIENT_RESOLUTION_UNCERTAIN_RECONCILE_MS;
        clientResolutionCache.delete(subjectKey);
        clientResolutionCache.set(subjectKey, entry);
        return;
      }
      // Authoritative rejections and read failures are safe to retry. Only a
      // possibly committed client create is latched as uncertain.
      clientResolutionCache.delete(subjectKey);
    }
  );

  return promise;
}

async function reconcileUncertainClient(customer: {
  name: string;
  phone?: string;
  email?: string;
}): Promise<string> {
  const reconciled = await reconcileClientCreate(customer);
  if (reconciled) return reconciled.clientId;
  throw new ClientCreateOutcomeUncertainError();
}

function getOrCreateClient(customer: {
  name: string;
  phone?: string;
  email?: string;
}): Promise<string> {
  const subjectKey = normalizedClientSubjectKey(customer);
  if (!subjectKey) return getOrCreateClientUncached(customer);

  const now = Date.now();
  pruneClientResolutionCache(now);
  const cached = clientResolutionCache.get(subjectKey);
  if (cached) {
    if (cached.state === 'uncertain' && cached.expiresAt <= now) {
      // Once a create may have committed, every later attempt is read-only.
      // Replace the rejected latch with one shared reconciliation promise;
      // absence is still uncertainty and can never authorize another POST.
      return trackClientResolution(
        subjectKey,
        reconcileUncertainClient(customer)
      );
    }
    // Touch every hit. Pending calls share the exact same work, resolved calls
    // retain recently used identities, and uncertain calls reuse the same
    // explicit failure instead of issuing a second create.
    clientResolutionCache.delete(subjectKey);
    clientResolutionCache.set(subjectKey, cached);
    return cached.promise;
  }

  return trackClientResolution(subjectKey, getOrCreateClientUncached(customer));
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

// Scan one updated_from..updated_to window (paged) for a specific appointment.
async function scanAppointmentWindow(
  appointmentId: string,
  updatedFrom: string,
  updatedTo: string
): Promise<AppointmentResponse | undefined> {
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

async function fetchAppointment(
  appointmentId: string
): Promise<AppointmentResponse | undefined> {
  // Fast path: fetch the single appointment by ID directly (1 round-trip).
  // GATED OFF by default: on this tenant GET /appointment/{id} ALWAYS 404s, so
  // the direct call is pure mid-call latency + a guaranteed error before we fall
  // back to the scan. Flip PHOREST_DIRECT_GET_APPT=true only on a tenant where
  // the direct GET actually resolves.
  if (env.PHOREST_DIRECT_GET_APPT) {
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
  }

  // Scan appointments UPDATED in the last ~60 days as two sequential windows.
  // Phorest caps a single updated range at 31 days, so one 30-day window would
  // miss anything last touched 5+ weeks ago (a long-standing booking being
  // rescheduled). Two 30-day windows widen the reach without breaching the cap.
  const now = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;
  const windows: Array<[string, string]> = [
    [new Date(now - 30 * DAY_MS).toISOString(), new Date(now).toISOString()],
    [
      new Date(now - 60 * DAY_MS).toISOString(),
      new Date(now - 30 * DAY_MS).toISOString(),
    ],
  ];

  for (const [updatedFrom, updatedTo] of windows) {
    const match = await scanAppointmentWindow(
      appointmentId,
      updatedFrom,
      updatedTo
    );
    if (match) return match;
  }

  return undefined;
}

export const realPhorest: PhorestPort = {
  async listStaffNames(): Promise<string[]> {
    const staff = await loadStaff();
    return staff
      .filter((s) => !s.archived)
      .map((s) => (s.firstName || '').trim())
      .filter(Boolean);
  },

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
        // Availability is a read-only query despite being a POST — safe to retry.
        retriable: true,
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

  async createAppointment(serviceId, startIso, customer, clientId?: string) {
    const service = await loadService(serviceId);
    if (!service) {
      throw new Error(`Service ${serviceId} not found in Phorest`);
    }

    const start = parseSalonDateTime(startIso);
    const end = start.plus({ minutes: service.duration ?? 0 });

    // If the caller is a KNOWN account (recognized by caller ID) the orchestrator
    // hands us their clientId directly — book against it and SKIP the phone/name
    // resolution entirely. This is the deterministic fix for the "recognized
    // caller" path: no phone needed, no duplicate profile, no wrong-record match.
    // Only when no clientId is supplied do we resolve by email/phone/name.
    const [resolvedClientId, staffId] = await Promise.all([
      clientId ? Promise.resolve(clientId) : getOrCreateClient(customer),
      pickStaffId(serviceId, service.disqualifiedStaff ?? []),
    ]);

    const payload = {
      clientId: resolvedClientId,
      // Create the booking ACTIVE, not as a RESERVED/held hold. Phorest's
      // booking lifecycle is ACTIVE|RESERVED|CANCELED; a RESERVED booking can
      // render as a white, uneditable block in the Phorest calendar. (If a
      // tenant ever forces RESERVED-on-create, follow with POST
      // .../booking/{bookingId}/activate using response.bookingId.)
      bookingStatus: 'ACTIVE',
      clientAppointmentSchedules: [
        {
          clientId: resolvedClientId,
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
    const startDate = DateTime.fromISO(
      fromDate ?? DateTime.now().setZone(SALON_TIMEZONE).toISODate()!,
      { zone: SALON_TIMEZONE }
    );
    // Phorest requires both from_date and to_date AND caps a single request at
    // 31 days ("Max date range allowed is 31 days"). A single 30-day window
    // hides appointments 5+ weeks out — the caller then hears "no upcoming
    // appointments" and gets offered a DUPLICATE booking. Cover ~60 days with
    // two sequential <=30-day windows and concatenate the results.
    const windows: Array<[string, string]> = [
      [startDate.toISODate()!, startDate.plus({ days: 30 }).toISODate()!],
      [
        startDate.plus({ days: 30 }).toISODate()!,
        startDate.plus({ days: 60 }).toISODate()!,
      ],
    ];

    // CRITICAL: the param is snake_case `client_id`. The camelCase `clientId`
    // is silently IGNORED by Phorest and returns EVERY client's appointments
    // (a privacy leak + wrong-client reschedule/cancel risk). We also re-filter
    // by clientId client-side as defense-in-depth.
    const raw: AppointmentResponse[] = [];
    const seen = new Set<string>();
    for (const [from, to] of windows) {
      const response = await phorestFetch<AppointmentListResponse>(
        businessBranchPath(
          `/appointment?client_id=${encodeURIComponent(clientId)}&from_date=${from}&to_date=${to}&size=20`
        )
      );
      for (const a of response._embedded?.appointments ?? []) {
        // Windows share a boundary day — dedupe by appointmentId.
        if (seen.has(a.appointmentId)) continue;
        seen.add(a.appointmentId);
        raw.push(a);
      }
    }

    // Phorest returns appointment times in the salon's LOCAL timezone (confirmed
    // empirically: a 12:45 PM booking is stored as "12:45:00"), so parse as
    // local — do NOT treat as UTC, or every time comes out hours early.
    // Only surface still-BOOKED appointments (PAID = already completed and can't
    // be rescheduled/cancelled), soonest first, capped to a handful so Erica
    // doesn't read out a wall of history.
    const now = DateTime.now().setZone(SALON_TIMEZONE);
    // Grace so an ALREADY-STARTED appointment stays visible: the #1 running-late
    // call ("it's 3:05, my 3:00 appt") and same-day post-start cancels must NOT
    // return empty. Keep anything whose END is still in the future, and — as a
    // fallback for missing/parse-failed end times — anything that started within
    // the last 120 minutes.
    const graceStart = now.minus({ minutes: 120 });
    return raw
      .filter(
        (a) =>
          // Never surface another client's appointment, even if the API filter fails.
          (!a.clientId || a.clientId === clientId) &&
          a.activationState === 'ACTIVE' &&
          a.state === 'BOOKED'
      )
      .map((a) => {
        const start = DateTime.fromISO(`${a.appointmentDate}T${a.startTime}`, {
          zone: SALON_TIMEZONE,
        });
        // F10a: when the API omits endTime, derive it from the service duration
        // (fallback 60m) rather than collapsing to startTime — otherwise a
        // still-running appointment (especially a long one) looks 0-length and
        // is wrongly dropped by the "end >= now" filter.
        const end = a.endTime
          ? DateTime.fromISO(`${a.appointmentDate}T${a.endTime}`, {
              zone: SALON_TIMEZONE,
            })
          : start.plus({ minutes: a.duration ?? 60 });
        return { a, start, end };
      })
      .filter(
        ({ start, end }) =>
          // Keep if the appointment hasn't finished yet (end in the future),
          // or (fallback) it started within the grace window.
          (end.isValid && end >= now) || start >= graceStart
      )
      .sort((x, y) => x.start.toMillis() - y.start.toMillis())
      .slice(0, 5)
      .map(({ a, start, end }) => ({
        appointmentId: a.appointmentId,
        serviceName: a.serviceName ?? 'Appointment',
        date: start.toISODate()!,
        timeDisplay: start.toFormat('h:mm a'),
        startTimeRaw: a.startTime,
        endTimeRaw: a.endTime ?? end.toFormat('HH:mm:ss'),
      }));
  },

  async addAppointmentNote(appointmentId: string, note: string): Promise<void> {
    try {
      // Phorest's note endpoint takes `serviceNote` — `text` 400s
      // ("serviceNote must not be empty"), verified live 2026-08-19.
      await phorestFetch(
        businessBranchPath(`/appointment/${appointmentId}/note`),
        {
          method: 'POST',
          body: JSON.stringify({ serviceNote: note }),
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
