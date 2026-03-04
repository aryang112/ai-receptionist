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

  it('lookupCustomerByPhone returns customer when found', async () => {
    const result = await mockPhorest.lookupCustomerByPhone('4432535169');
    expect(result).not.toBeNull();
    expect(result?.firstName).toBe('Jane');
    expect(result?.clientId).toBe('client_test');
  });

  it('lookupCustomerByPhone returns null for unknown phone', async () => {
    const result = await mockPhorest.lookupCustomerByPhone('0000000000');
    expect(result).toBeNull();
  });

  it('lookupCustomerByName returns array of matches', async () => {
    const results = await mockPhorest.lookupCustomerByName('Jane', 'Smith');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.clientId).toBe('client_test');
  });

  it('lookupCustomerByName returns empty array for unknown name', async () => {
    const results = await mockPhorest.lookupCustomerByName('Nobody', 'Here');
    expect(results).toHaveLength(0);
  });

  it('listAppointments returns upcoming appointments for a client', async () => {
    const appts = await mockPhorest.listAppointments('client_test');
    expect(appts.length).toBeGreaterThan(0);
    expect(appts[0]).toHaveProperty('appointmentId');
    expect(appts[0]).toHaveProperty('serviceName');
    expect(appts[0]).toHaveProperty('timeDisplay');
  });

  it('addAppointmentNote resolves without throwing', async () => {
    await expect(mockPhorest.addAppointmentNote('appt_001', 'running late')).resolves.toBeUndefined();
  });

  it('getTodayAppointments returns today\'s appointments', async () => {
    const appts = await mockPhorest.getTodayAppointments();
    expect(Array.isArray(appts)).toBe(true);
    expect(appts.length).toBeGreaterThan(0);
    expect(appts[0]).toHaveProperty('appointmentId');
  });
});
