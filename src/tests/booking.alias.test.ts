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

import { findServiceByName, resolveService } from '../services/booking.js';

describe('findServiceByName synonym aliases', () => {
  it('maps "lash lamination" -> Lash Lift', async () => {
    expect((await findServiceByName('lash lamination'))?.name).toBe(
      'Lash Lift'
    );
  });
  it('maps "eyelash lift" -> Lash Lift', async () => {
    expect((await findServiceByName('eyelash lift'))?.name).toBe('Lash Lift');
  });
  it('maps "eyebrow lamination" -> Brow Lamination', async () => {
    expect((await findServiceByName('eyebrow lamination'))?.name).toBe(
      'Brow Lamination'
    );
  });
  it('still matches a direct service name', async () => {
    expect((await findServiceByName('Brow Threading'))?.name).toBe(
      'Brow Threading'
    );
  });
  it('strips a leading menu prefix ("3) Brow Threading")', async () => {
    expect((await findServiceByName('3) Brow Threading'))?.name).toBe(
      'Brow Threading'
    );
  });
});

describe('resolveService aliases return a decisive match', () => {
  it.each([
    'Eyebrow threading',
    'eyebrows threading',
    'eyebrow thread',
    'eyebrows threaded',
    'threading for my eyebrows',
    'get my eyebrows threaded',
  ])('resolves %s to the live Brow Threading service', async (phrase) => {
    expect(await resolveService(phrase)).toMatchObject({
      kind: 'match',
      service: { id: 's3', name: 'Brow Threading' },
    });
  });

  it.each(['henna brows', 'brow henna', 'eyebrow tattoo', 'eyeball threading'])(
    'does not discard unknown treatment words in %s',
    async (phrase) => {
      expect(await resolveService(phrase)).toMatchObject({
        kind: 'notOffered',
      });
    }
  );

  it('"lash lamination" resolves (kind: match) to Lash Lift', async () => {
    const r = await resolveService('lash lamination');
    expect(r.kind).toBe('match');
    if (r.kind === 'match') expect(r.service.name).toBe('Lash Lift');
  });
});
