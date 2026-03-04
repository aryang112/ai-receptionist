import type { PhorestPort, Service, SlotISO } from './phorest.types.js';
import { env } from '../config/env.js';
import { logger } from '../core/logger.js';

const REQUIRED_ENV = [
  'PHOREST_BASE_URL',
  'PHOREST_API_USERNAME',
  'PHOREST_API_SECRET',
  'PHOREST_BUSINESS_ID',
  'PHOREST_BRANCH_ID'
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

type ClientRecord = { clientId: string };

type ClientResponse = {
  _embedded?: { clients?: ClientRecord[] };
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
  price?: number;
  staffId: string;
  roomId?: string;
  machineId?: string;
  confirmed?: boolean;
  serviceId: string;
};

type AppointmentListResponse = {
  _embedded?: { appointments?: AppointmentResponse[] };
  page?: { number: number; totalPages: number };
};

type ServiceDetailResponse = ServiceRecord & { duration?: number; price?: number };

type RequestOptions = RequestInit & { expectEmpty?: boolean };

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
  const missing: RequiredKey[] = REQUIRED_ENV.filter(key => !env[key]);
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

async function phorestFetch<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
  assertEnv();
  const url = new URL(path, baseUrl());
  const headers = new Headers(options.headers);
  headers.set('Accept', 'application/json');
  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  headers.set(
    'Authorization',
    `Basic ${Buffer.from(`${env.PHOREST_API_USERNAME}:${env.PHOREST_API_SECRET}`).toString('base64')}`
  );

  const response = await fetch(url, { ...options, headers });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const redacted = text.slice(0, 500);
    logger.error(
      {
        msg: 'Phorest request failed',
        url: url.toString(),
        status: response.status,
        body: redacted
      },
      'Phorest request failed'
    );
    throw new PhorestHttpError(response.status, `Phorest request failed with ${response.status}`, redacted);
  }

  if (options.expectEmpty || response.status === 204) {
    return undefined as T;
  }

  if (response.headers.get('Content-Length') === '0') {
    return undefined as T;
  }

  return (await response.json()) as T;
}

let serviceCache: Map<string, ServiceDetailResponse> | null = null;
let staffCache: StaffRecord[] | null = null;

async function loadServices(): Promise<Map<string, ServiceDetailResponse>> {
  if (serviceCache) return serviceCache;

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
  return results;
}

async function loadService(serviceId: string): Promise<ServiceDetailResponse | undefined> {
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
    durationMin: typeof record.duration === 'number' ? record.duration : 0
  };
}

function ensureIsoWithSeconds(startIso: string): string {
  if (startIso.length === 0) {
    throw new Error('startIso required');
  }
  if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}$/.test(startIso)) {
    return `${startIso}:00`;
  }
  if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}$/.test(startIso)) {
    return startIso;
  }
  const date = new Date(startIso);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid ISO date provided: ${startIso}`);
  }
  return date.toISOString().replace(/\.[0-9]{3}Z$/, '');
}

function formatLocalTimePart(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid ISO date provided: ${iso}`);
  }
  return date.toISOString().slice(11, 19);
}

function addMinutes(startIso: string, minutes: number): string {
  const baseline = new Date(startIso);
  if (Number.isNaN(baseline.getTime())) {
    throw new Error(`Invalid ISO date provided: ${startIso}`);
  }
  baseline.setUTCMinutes(baseline.getUTCMinutes() + minutes);
  return baseline.toISOString().replace(/\.[0-9]{3}Z$/, '');
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

async function findClientByEmail(email: string): Promise<string | undefined> {
  const response = await phorestFetch<ClientResponse>(
    `api/business/${env.PHOREST_BUSINESS_ID}/client?email=${encodeURIComponent(email)}&size=1`
  );
  return response._embedded?.clients?.[0]?.clientId;
}

async function findClientByPhone(phone: string): Promise<string | undefined> {
  const response = await phorestFetch<ClientResponse>(
    `api/business/${env.PHOREST_BUSINESS_ID}/client?phone=${encodeURIComponent(phone)}&size=1`
  );
  return response._embedded?.clients?.[0]?.clientId;
}

async function createClient(customer: { name: string; phone?: string; email?: string }): Promise<string> {
  const { firstName, lastName } = splitName(customer.name);
  const payload = {
    firstName,
    lastName,
    email: customer.email?.trim() || undefined,
    mobile: sanitisePhone(customer.phone),
    creatingBranchId: env.PHOREST_BRANCH_ID
  };

  const response = await phorestFetch<ClientCreateResponse>(
    `api/business/${env.PHOREST_BUSINESS_ID}/client`,
    {
      method: 'POST',
      body: JSON.stringify(payload)
    }
  );
  if (!response.clientId) {
    throw new Error('Failed to create Phorest client');
  }
  return response.clientId;
}

async function getOrCreateClient(customer: { name: string; phone?: string; email?: string }): Promise<string> {
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

async function pickStaffId(serviceId: string, disqualified: string[] = []): Promise<string> {
  const staffList = await loadStaff();
  const allowed = staffList.filter(staff => {
    if (staff.archived) return false;
    if (staff.hideFromOnlineBookings) return false;
    if (staff.hideFromAppointmentScreen) return false;
    const disqualifiedServices = staff.disqualifiedServices ?? [];
    if (disqualified.includes(staff.staffId)) return false;
    return !disqualifiedServices.includes(serviceId);
  });

  const staffId = allowed[0]?.staffId;
  if (!staffId) {
    throw new Error('No eligible staff available for service');
  }
  return staffId;
}

async function fetchAppointment(appointmentId: string): Promise<AppointmentResponse | undefined> {
  const now = new Date();
  const updatedTo = now.toISOString();
  const updatedFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

  let page = 0;
  while (page < 10) {
    const response = await phorestFetch<AppointmentListResponse>(
      businessBranchPath(
        `/appointment?updated_from=${encodeURIComponent(updatedFrom)}&updated_to=${encodeURIComponent(updatedTo)}&size=100&page=${page}`
      )
    );

    const appointments = response._embedded?.appointments ?? [];
    const match = appointments.find(item => item.appointmentId === appointmentId);
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
    return Array.from(services.values()).map(normaliseService);
  },

  async getAvailability(serviceId: string, date: string): Promise<SlotISO[]> {
    const startTime = `${date}T00:00:00`;
    const endTime = `${date}T23:59:59`;

    const response = await phorestFetch<AvailabilityResponse>(
      businessBranchPath('/appointments/availability'),
      {
        method: 'POST',
        body: JSON.stringify({
          startTime,
          endTime,
          clientServiceSelections: [
            {
              serviceSelections: [
                {
                  serviceId
                }
              ]
            }
          ]
        })
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

    return Array.from(slotSet).sort();
  },

  async createAppointment(serviceId, startIso, customer) {
    const isoWithSeconds = ensureIsoWithSeconds(startIso);
    const service = await loadService(serviceId);
    if (!service) {
      throw new Error(`Service ${serviceId} not found in Phorest`);
    }

    const duration = service.duration ?? 0;
    const endIso = addMinutes(isoWithSeconds, duration);

    const clientId = await getOrCreateClient(customer);
    const staffId = await pickStaffId(serviceId, service.disqualifiedStaff ?? []);

    const payload = {
      clientId,
      clientAppointmentSchedules: [
        {
          clientId,
          serviceSchedules: [
            {
              serviceId,
              staffId,
              startTime: isoWithSeconds,
              endTime: endIso
            }
          ]
        }
      ]
    };

    const response = await phorestFetch<BookingResponse>(
      businessBranchPath('/booking?force_selected_time=true'),
      {
        method: 'POST',
        body: JSON.stringify(payload)
      }
    );

    const appointmentId = response.clientAppointmentSchedules?.[0]?.serviceSchedules?.[0]?.appointmentId;
    if (!appointmentId) {
      throw new Error('Phorest booking response missing appointmentId');
    }

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

    const isoWithSeconds = ensureIsoWithSeconds(newStartIso);
    const endIso = addMinutes(isoWithSeconds, service.duration ?? 0);

    const payload = {
      appointmentId,
      version: appointment.version,
      appointmentDate: isoWithSeconds.slice(0, 10),
      startTime: formatLocalTimePart(isoWithSeconds),
      endTime: formatLocalTimePart(endIso),
      price: appointment.price,
      staffId: appointment.staffId,
      roomId: appointment.roomId,
      machineId: appointment.machineId,
      confirmed: appointment.confirmed
    };

    await phorestFetch(
      businessBranchPath(`/appointment/${appointmentId}?force_selected_time=true`),
      {
        method: 'PUT',
        body: JSON.stringify(payload),
        expectEmpty: true
      }
    );

    return { appointmentId };
  },

  async cancelAppointment(appointmentId: string) {
    await phorestFetch(
      businessBranchPath(`/appointment/cancel?appointment_id=${encodeURIComponent(appointmentId)}`),
      {
        method: 'POST',
        expectEmpty: true
      }
    );

    return { appointmentId, cancelled: true as const };
  }
};
