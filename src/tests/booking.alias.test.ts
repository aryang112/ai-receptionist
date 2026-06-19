import { describe, it, expect, vi } from 'vitest';

// Control the catalog so we can assert the synonym aliases resolve to the
// real service names (e.g. "lash lamination" -> our "Lash Lift").
vi.mock('../services/phorest.js', () => ({
  phorest: {
    listServices: async () => [
      { id: 's1', name: 'Lash Lift', price: 150, durationMin: 75 },
      { id: 's2', name: 'Brow Lamination', price: 70, durationMin: 60 },
      { id: 's3', name: 'Brow Threading', price: 15, durationMin: 5 },
    ],
  },
}));

import { findServiceByName } from '../services/booking.js';

describe('findServiceByName synonym aliases', () => {
  it('maps "lash lamination" -> Lash Lift', async () => {
    expect((await findServiceByName('lash lamination'))?.name).toBe('Lash Lift');
  });
  it('maps "eyelash lift" -> Lash Lift', async () => {
    expect((await findServiceByName('eyelash lift'))?.name).toBe('Lash Lift');
  });
  it('maps "eyebrow lamination" -> Brow Lamination', async () => {
    expect((await findServiceByName('eyebrow lamination'))?.name).toBe('Brow Lamination');
  });
  it('still matches a direct service name', async () => {
    expect((await findServiceByName('Brow Threading'))?.name).toBe('Brow Threading');
  });
});
