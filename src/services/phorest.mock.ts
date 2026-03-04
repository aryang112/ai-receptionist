import { DateTime } from 'luxon';
import type { PhorestPort, Service, CustomerResult, AppointmentSummary } from './phorest.types.js';

function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

// pretend salon services
const services: Service[] = [
  { id: 'svc_brows', name: 'Eyebrow Threading', price: 15, durationMin: 15 },
  { id: 'svc_fullface', name: 'Full Face Threading', price: 45, durationMin: 45 }
];

// export a fake implementation of the PhorestPort contract
export const mockPhorest: PhorestPort = {
  async listServices() {
    return services;
  },

  async getAvailability(_serviceId, date) {
    // return 3 fake time slots on the given date
    return [
      `${date}T13:20:00`,
      `${date}T13:50:00`,
      `${date}T14:20:00`
    ];
  },

  async createAppointment(serviceId, startIso, customer) {
    // generate a random ID for the appointment
    return { appointmentId: `appt_${Math.random().toString(36).slice(2,8)}` };
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
      return { clientId: 'client_test', firstName: 'Jane', lastName: 'Smith', phone: '4432535169' };
    }
    return null;
  },

  async lookupCustomerByName(firstName: string, lastName: string): Promise<CustomerResult[]> {
    if (firstName.toLowerCase() === 'jane') {
      return [{ clientId: 'client_test', firstName: 'Jane', lastName: 'Smith' }];
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
        startTimeRaw: '19:00:00',
        endTimeRaw: '19:15:00',
      }
    ];
  },

  async addAppointmentNote(_appointmentId: string, _note: string): Promise<void> {
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
        startTimeRaw: '19:00:00',
        endTimeRaw: '19:15:00',
      },
      {
        appointmentId: 'appt_mock_002',
        serviceName: 'Eyebrow Tinting',
        date: today,
        timeDisplay: '2:15 PM',
        startTimeRaw: '19:15:00',
        endTimeRaw: '19:35:00',
      }
    ];
  }
};
