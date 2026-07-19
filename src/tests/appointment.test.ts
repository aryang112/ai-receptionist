import { describe, it, expect } from 'vitest';
import { suggestSlots, bookAppointment } from '../services/booking.js';

// NODE_ENV=test forces the mock Phorest (see services/phorest.ts) — never hits real Phorest.
describe('booking service', () => {
  it('suggestSlots returns slots for a known service', async () => {
    const result = await suggestSlots({
      serviceName: 'Eyebrow',
      date: '2025-10-01',
    });
    // A bare "Eyebrow" phrase resolves via SERVICE_ALIASES to the threading
    // service the salon actually offers (see resolveService). Narrow the union
    // to the matched branch before reading .slots/.service.
    if ('slots' in result) {
      expect(Array.isArray(result.slots)).toBe(true);
      expect(result.slots.length).toBeGreaterThan(0);
      expect(result.service.name).toBe('Brow Threading');
    } else {
      throw new Error(
        'expected a slots result, got: ' + JSON.stringify(result)
      );
    }
  });

  it('bookAppointment returns an appointmentId', async () => {
    const result = await bookAppointment({
      serviceName: 'Eyebrow',
      date: '2025-10-01',
      time: '13:20',
      customer: { name: 'Alice' },
    });
    expect(result.appointment.appointmentId).toBeDefined();
  });
});
