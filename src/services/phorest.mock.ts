import type { PhorestPort, Service } from './phorest.types.js';

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
  }
};
