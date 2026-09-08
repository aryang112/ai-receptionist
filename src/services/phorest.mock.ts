import { DateTime } from 'luxon';
import type {
  PhorestPort,
  Service,
  CustomerResult,
  AppointmentSummary,
} from './phorest.types.js';

function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.length === 11 && digits.startsWith('1')
    ? digits.slice(1)
    : digits;
}

// Pretend salon services. Kept representative on purpose so the service-matcher
// tests use the live "Brow Threading" name (a fake "Eyebrow Threading" entry
// masked the September 7 mismatch),
// two distinct wax services (so a bare "wax" query is genuinely ambiguous), a
// couple of tint/lift/lamination lines, and a $0 consult.
const services: Service[] = [
  { id: 'svc_brows', name: 'Brow Threading', price: 15, durationMin: 15 },
  {
    id: 'svc_fullface',
    name: 'Full Face Threading',
    price: 45,
    durationMin: 45,
  },
  { id: 'svc_lip', name: 'Lip Threading', price: 8, durationMin: 10 },
  { id: 'svc_brow_tint', name: 'Eyebrow Tinting', price: 20, durationMin: 20 },
  { id: 'svc_lash_lift', name: 'Lash Lift', price: 65, durationMin: 45 },
  { id: 'svc_brow_lam', name: 'Brow Lamination', price: 70, durationMin: 45 },
  { id: 'svc_leg_wax', name: 'Full Leg Wax', price: 55, durationMin: 40 },
  { id: 'svc_bikini_wax', name: 'Bikini Wax', price: 30, durationMin: 20 },
  {
    id: 'svc_microblading',
    name: 'Microblading Consult',
    price: 0,
    durationMin: 15,
  },
];

// export a fake implementation of the PhorestPort contract
export const mockPhorest: PhorestPort = {
  async listStaffNames() {
    return ['Richa'];
  },

  async listServices() {
    return services;
  },

  async getAvailability(_serviceId, date) {
    // return 3 fake time slots on the given date
    return [`${date}T13:20:00`, `${date}T13:50:00`, `${date}T14:20:00`];
  },

  // The trailing clientId mirrors the real client: when the caller is already a
  // known account (recognized by caller ID), the orchestrator passes it so we
  // book against that record directly instead of re-resolving by phone.
  async createAppointment(serviceId, startIso, customer, clientId?: string) {
    void clientId; // mock books the same regardless; signature parity is the point
    // generate a random ID for the appointment
    return { appointmentId: `appt_${Math.random().toString(36).slice(2, 8)}` };
  },

  async updateAppointment(appointmentId, newStartIso) {
    // just echo back the same ID
    return { appointmentId };
  },

  async cancelAppointment(appointmentId) {
    return { appointmentId, cancelled: true };
  },

  async lookupCustomerByPhone(phone: string): Promise<CustomerResult | null> {
    if (normalizePhone(phone) === '4432535169') {
      return {
        clientId: 'client_test',
        firstName: 'Jane',
        lastName: 'Smith',
        phone: '4432535169',
      };
    }
    return null;
  },

  async lookupCustomerByName(
    firstName: string,
    lastName: string
  ): Promise<CustomerResult[]> {
    if (firstName.toLowerCase() === 'jane') {
      return [
        { clientId: 'client_test', firstName: 'Jane', lastName: 'Smith' },
      ];
    }
    return [];
  },

  async listAppointments(_clientId: string): Promise<AppointmentSummary[]> {
    const today = DateTime.now().setZone('America/New_York').toISODate()!;
    return [
      {
        appointmentId: 'appt_mock_001',
        serviceName: 'Eyebrow Threading',
        date: today,
        timeDisplay: '2:00 PM',
        startTimeRaw: '14:00:00',
        endTimeRaw: '14:15:00',
      },
    ];
  },

  async addAppointmentNote(
    _appointmentId: string,
    _note: string
  ): Promise<void> {
    // no-op in mock
  },

  async getTodayAppointments(): Promise<AppointmentSummary[]> {
    const today = DateTime.now().setZone('America/New_York').toISODate()!;
    return [
      {
        appointmentId: 'appt_mock_001',
        serviceName: 'Eyebrow Threading',
        date: today,
        timeDisplay: '2:00 PM',
        startTimeRaw: '14:00:00',
        endTimeRaw: '14:15:00',
      },
      {
        appointmentId: 'appt_mock_002',
        serviceName: 'Eyebrow Tinting',
        date: today,
        timeDisplay: '2:15 PM',
        startTimeRaw: '14:15:00',
        endTimeRaw: '14:35:00',
      },
    ];
  },
};
