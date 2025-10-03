import { describe, it, expect } from 'vitest';
import { mockPhorest } from '../services/phorest.mock.js';

describe('phorest.mock', () => {
  it('listServices returns at least 2 services with required fields', async () => {
    const services = await mockPhorest.listServices();
    expect(Array.isArray(services)).toBe(true);
    expect(services.length).toBeGreaterThanOrEqual(2);

    const s = services[0];
    expect(s).toBeDefined(); // 👈 guard
    expect(s!.id).toBeDefined();
    expect(typeof s!.price).toBe('number');
    expect(typeof s!.durationMin).toBe('number');
  });

  it('getAvailability returns ISO slots for the given date', async () => {
    const date = '2025-10-01';
    const slots = await mockPhorest.getAvailability('svc_brows', date);
    expect(slots.length).toBeGreaterThan(0);
    // basic ISO sanity check
    for (const slot of slots) {
      expect(slot.startsWith(date + 'T')).toBe(true);
      expect(slot.length).toBeGreaterThanOrEqual(19); // "YYYY-MM-DDTHH:MM:SS"
    }
  });

  it('createAppointment returns an appointmentId', async () => {
    const res = await mockPhorest.createAppointment(
      'svc_brows',
      '2025-10-01T13:50:00',
      { name: 'Jane Doe', phone: '555-1234' }
    );
    expect(res).toHaveProperty('appointmentId');
    expect(typeof res.appointmentId).toBe('string');
    expect(res.appointmentId.length).toBeGreaterThan(4);
  });
});
