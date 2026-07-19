import { describe, it, expect } from 'vitest';
import { resolveService, findServiceByName } from '../services/booking.js';

// NOTE: no vi.mock here — under NODE_ENV=test, booking.ts's `phorest` is the
// real mock adapter (src/services/phorest.mock.ts). Its catalog is enriched on
// purpose (two brow-threading names, two distinct waxes, tint/lift/lamination
// lines) so these cover the LIVE-verified matcher traps against a realistic
// catalog rather than a hand-tuned three-item stub.

describe('resolveService — live-verified traps (against the mock catalog)', () => {
  it('"wax" is AMBIGUOUS, not a silent pick (two distinct waxes)', async () => {
    const r = await resolveService('wax');
    expect(r.kind).toBe('ambiguous');
    if (r.kind === 'ambiguous') {
      const names = r.candidates.map((s) => s.name).sort();
      expect(names).toEqual(['Bikini Wax', 'Full Leg Wax']);
    }
  });

  it('"eyebrows" -> Brow Threading (not a tint / permanent-makeup line)', async () => {
    const r = await resolveService('eyebrows');
    expect(r.kind).toBe('match');
    if (r.kind === 'match') expect(r.service.name).toBe('Brow Threading');
  });

  it('"brows" -> Brow Threading', async () => {
    const r = await resolveService('brows');
    expect(r.kind).toBe('match');
    if (r.kind === 'match') expect(r.service.name).toBe('Brow Threading');
  });

  it('"lash lamination" -> Lash Lift (alias still resolves)', async () => {
    const r = await resolveService('lash lamination');
    expect(r.kind).toBe('match');
    if (r.kind === 'match') expect(r.service.name).toBe('Lash Lift');
  });

  it('a clearly-unknown service -> notOffered', async () => {
    const r = await resolveService('helicopter ride');
    expect(r.kind).toBe('notOffered');
  });

  it('exact full-name query stays decisive even when the fragment recurs', async () => {
    // "Lip Threading" is fully named -> match, despite "threading" living in
    // several other service names.
    const r = await resolveService('lip threading');
    expect(r.kind).toBe('match');
    if (r.kind === 'match') expect(r.service.name).toBe('Lip Threading');
  });

  it('a leading menu prefix is stripped ("5) Bikini Wax")', async () => {
    const r = await resolveService('5) Bikini Wax');
    expect(r.kind).toBe('match');
    if (r.kind === 'match') expect(r.service.name).toBe('Bikini Wax');
  });

  it('findServiceByName collapses ambiguous/notOffered to undefined', async () => {
    expect(await findServiceByName('wax')).toBeUndefined();
    expect(await findServiceByName('helicopter ride')).toBeUndefined();
    expect((await findServiceByName('lip threading'))?.name).toBe(
      'Lip Threading'
    );
  });

  // F4 — spec-mandated cases the defects swarm skipped.
  it('"micro blading" (split compound) resolves to Microblading, not a dead end', async () => {
    const r = await resolveService('micro blading');
    expect(r.kind).toBe('match');
    if (r.kind === 'match') expect(r.service.name).toMatch(/microblading/i);
  });

  it('"massage" (not offered here) -> notOffered', async () => {
    const r = await resolveService('massage');
    expect(r.kind).toBe('notOffered');
  });

  it('never returns more than 3 ambiguous candidates ("threading")', async () => {
    const r = await resolveService('threading');
    if (r.kind === 'ambiguous') {
      expect(r.candidates.length).toBeLessThanOrEqual(3);
    }
  });
});
