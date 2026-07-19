import { describe, it, expect } from 'vitest';
import { suggestSlots, bookAppointment } from '../services/booking.js';

// NODE_ENV=test forces the mock Phorest (see services/phorest.ts) — never hits real Phorest.
describe('booking validation', () => {
  it('suggestSlots rejects missing fields (zod)', async () => {
    await expect(suggestSlots({} as any)).rejects.toMatchObject({
      issues: expect.any(Array),
    });
  });

  it('bookAppointment throws "Service not found" for an unknown service', async () => {
    await expect(
      bookAppointment({
        serviceName: 'non-existent',
        date: '2025-10-01',
        time: '12:00',
        customer: { name: 'Test Caller', phone: '5551234567' },
      }),
    ).rejects.toThrow('Service not found');
  });
});
