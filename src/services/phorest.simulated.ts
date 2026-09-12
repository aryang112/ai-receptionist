import { DateTime } from 'luxon';
import { env } from '../config/env.js';
import type {
  AppointmentSummary,
  CustomerResult,
  PhorestPort,
  Service,
} from './phorest.types.js';

type SimulatedClient = CustomerResult;
type SimulatedAppointment = {
  clientId: string;
  summary: AppointmentSummary;
  cancelled: boolean;
  notes: string[];
};
type RealAppointmentOverlay = {
  cancelled?: boolean;
  newStartIso?: string;
  notes: string[];
};

const simulatedClients = new Map<string, SimulatedClient>();
const simulatedAppointments = new Map<string, SimulatedAppointment>();
const realAppointmentOverlays = new Map<string, RealAppointmentOverlay>();
let nextClientId = 1;
let nextAppointmentId = 1;

const SIMULATED_ID_PREFIX = 'sim_';

function isSimulatedId(id: string): boolean {
  return id.startsWith(SIMULATED_ID_PREFIX);
}

function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.length === 11 && digits.startsWith('1')
    ? digits.slice(1)
    : digits;
}

function splitName(name: string): { firstName: string; lastName: string } {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return {
    firstName: parts[0] ?? 'Guest',
    lastName: parts.slice(1).join(' '),
  };
}

function appointmentSummary(
  appointmentId: string,
  service: Service,
  startIso: string
): AppointmentSummary {
  const start = DateTime.fromISO(startIso, { zone: env.TIMEZONE });
  if (!start.isValid) throw new Error(`Invalid appointment start: ${startIso}`);
  const end = start.plus({ minutes: service.durationMin });
  return {
    appointmentId,
    serviceName: service.name,
    date: start.toISODate()!,
    timeDisplay: start.toFormat('h:mm a'),
    startTimeRaw: start.toFormat('HH:mm:ss'),
    endTimeRaw: end.toFormat('HH:mm:ss'),
  };
}

function moveSummary(
  current: AppointmentSummary,
  startIso: string
): AppointmentSummary {
  const start = DateTime.fromISO(startIso, { zone: env.TIMEZONE });
  if (!start.isValid) throw new Error(`Invalid appointment start: ${startIso}`);
  const originalStart = DateTime.fromISO(
    `${current.date}T${current.startTimeRaw}`,
    { zone: env.TIMEZONE }
  );
  const originalEnd = DateTime.fromISO(`${current.date}T${current.endTimeRaw}`, {
    zone: env.TIMEZONE,
  });
  const duration =
    originalStart.isValid && originalEnd.isValid
      ? Math.max(1, originalEnd.diff(originalStart, 'minutes').minutes)
      : 30;
  const end = start.plus({ minutes: duration });
  return {
    ...current,
    date: start.toISODate()!,
    timeDisplay: start.toFormat('h:mm a'),
    startTimeRaw: start.toFormat('HH:mm:ss'),
    endTimeRaw: end.toFormat('HH:mm:ss'),
  };
}

function overlayForRealAppointment(id: string): RealAppointmentOverlay {
  const existing = realAppointmentOverlays.get(id);
  if (existing) return existing;
  const created: RealAppointmentOverlay = { notes: [] };
  realAppointmentOverlays.set(id, created);
  return created;
}

function applyRealOverlay(summary: AppointmentSummary): AppointmentSummary | null {
  const overlay = realAppointmentOverlays.get(summary.appointmentId);
  if (!overlay || !overlay.cancelled) {
    return overlay?.newStartIso
      ? moveSummary(summary, overlay.newStartIso)
      : summary;
  }
  return null;
}

function simulatedAppointmentsForClient(
  clientId: string,
  fromDate: string
): AppointmentSummary[] {
  return [...simulatedAppointments.values()]
    .filter(
      (appointment) =>
        appointment.clientId === clientId &&
        !appointment.cancelled &&
        appointment.summary.date >= fromDate
    )
    .map((appointment) => appointment.summary);
}

/** Clear the process-wide comparison overlay between test variants. */
export function resetSimulatedPhorestOverlay(): void {
  simulatedClients.clear();
  simulatedAppointments.clear();
  realAppointmentOverlays.clear();
  nextClientId = 1;
  nextAppointmentId = 1;
}

/**
 * Wrap a read-only Phorest port with a process-wide simulated-write overlay.
 * The real port is never asked to create clients, appointments, notes, update,
 * or cancel. This makes the wrapper suitable for a live-read taste test.
 */
export function simulatedWrites(real: PhorestPort): PhorestPort {
  return {
    listServices: () => real.listServices(),
    getAvailability: (serviceId, date) => real.getAvailability(serviceId, date),
    listStaffNames: () => real.listStaffNames?.() ?? Promise.resolve([]),
    preloadClients: () => real.preloadClients?.() ?? Promise.resolve(),

    async createAppointment(serviceId, startIso, customer, clientId?) {
      let resolvedClientId = clientId;
      if (resolvedClientId?.startsWith(SIMULATED_ID_PREFIX)) {
        if (!simulatedClients.has(resolvedClientId)) {
          throw new Error(`Unknown simulated client: ${resolvedClientId}`);
        }
      } else if (!resolvedClientId) {
        const id = `sim_client_${nextClientId++}`;
        const { firstName, lastName } = splitName(customer.name);
        const phone = customer.phone ? normalizePhone(customer.phone) : undefined;
        simulatedClients.set(id, {
          clientId: id,
          firstName,
          lastName,
          ...(phone ? { phone } : {}),
          ...(customer.email?.trim() ? { email: customer.email.trim() } : {}),
        });
        resolvedClientId = id;
      }

      const service = (await real.listServices()).find(
        (candidate) => candidate.id === serviceId
      );
      if (!service) throw new Error(`Service ${serviceId} not found in Phorest`);
      const appointmentId = `sim_appt_${nextAppointmentId++}`;
      simulatedAppointments.set(appointmentId, {
        clientId: resolvedClientId,
        summary: appointmentSummary(appointmentId, service, startIso),
        cancelled: false,
        notes: [],
      });
      return { appointmentId };
    },

    async updateAppointment(appointmentId, newStartIso) {
      const simulated = simulatedAppointments.get(appointmentId);
      if (simulated) {
        if (simulated.cancelled) throw new Error(`Appointment ${appointmentId} is cancelled`);
        simulated.summary = moveSummary(simulated.summary, newStartIso);
        return { appointmentId };
      }
      if (isSimulatedId(appointmentId)) {
        throw new Error(`Unknown simulated appointment: ${appointmentId}`);
      }
      overlayForRealAppointment(appointmentId).newStartIso = newStartIso;
      return { appointmentId };
    },

    async cancelAppointment(appointmentId) {
      const simulated = simulatedAppointments.get(appointmentId);
      if (simulated) {
        simulated.cancelled = true;
        return { appointmentId, cancelled: true as const };
      }
      if (isSimulatedId(appointmentId)) {
        throw new Error(`Unknown simulated appointment: ${appointmentId}`);
      }
      overlayForRealAppointment(appointmentId).cancelled = true;
      return { appointmentId, cancelled: true as const };
    },

    async lookupCustomerByPhone(phone) {
      const normalized = normalizePhone(phone);
      const simulated = [...simulatedClients.values()].find(
        (client) => client.phone && normalizePhone(client.phone) === normalized
      );
      if (simulated) return simulated;
      return real.lookupCustomerByPhone(phone);
    },

    async lookupCustomerByName(firstName, lastName) {
      const normalizedFirst = firstName.trim().toLowerCase();
      const normalizedLast = lastName.trim().toLowerCase();
      const simulated = [...simulatedClients.values()].filter(
        (client) =>
          client.firstName.toLowerCase() === normalizedFirst &&
          client.lastName.toLowerCase() === normalizedLast
      );
      return [...simulated, ...(await real.lookupCustomerByName(firstName, lastName))];
    },

    async listAppointments(clientId, fromDate) {
      const minDate =
        fromDate ?? DateTime.now().setZone(env.TIMEZONE).toISODate()!;
      if (isSimulatedId(clientId)) {
        return simulatedClients.has(clientId)
          ? simulatedAppointmentsForClient(clientId, minDate)
          : [];
      }
      const realAppointments = await real.listAppointments(clientId, fromDate);
      return [
        ...realAppointments
          .map(applyRealOverlay)
          .filter(
            (appointment): appointment is AppointmentSummary =>
              appointment !== null && appointment.date >= minDate
          ),
        ...simulatedAppointmentsForClient(clientId, minDate),
      ].sort((a, b) =>
        `${a.date}T${a.startTimeRaw}`.localeCompare(`${b.date}T${b.startTimeRaw}`)
      );
    },

    async addAppointmentNote(appointmentId, note) {
      const simulated = simulatedAppointments.get(appointmentId);
      if (simulated) {
        simulated.notes.push(note);
        return;
      }
      // Notes are best-effort in the real adapter. Keep that no-throw shape for
      // unknown IDs too, while never forwarding a note to Phorest.
      if (isSimulatedId(appointmentId)) return;
      overlayForRealAppointment(appointmentId).notes.push(note);
    },

    async getTodayAppointments() {
      const today = DateTime.now().setZone(env.TIMEZONE).toISODate()!;
      const realAppointments = await real.getTodayAppointments();
      const simulated = [...simulatedAppointments.values()]
        .filter(
          (appointment) =>
            !appointment.cancelled && appointment.summary.date === today
        )
        .map((appointment) => appointment.summary);
      return [
        ...realAppointments
          .map(applyRealOverlay)
          .filter(
            (appointment): appointment is AppointmentSummary =>
              appointment !== null && appointment.date === today
          ),
        ...simulated,
      ].sort((a, b) => a.startTimeRaw.localeCompare(b.startTimeRaw));
    },
  };
}
