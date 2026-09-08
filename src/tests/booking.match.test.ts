import { describe, it, expect } from 'vitest';
import { resolveService, findServiceByName } from '../services/booking.js';

// NOTE: no vi.mock here — under NODE_ENV=test, booking.ts's `phorest` is the
// real mock adapter (src/services/phorest.mock.ts). Its catalog mirrors the
// LIVE naming ("Brow Threading", never "Eyebrow Threading"), two distinct
// waxes, tint/lift/lamination lines and a $0 consult, so these cover the
// live-verified matcher traps against a realistic catalog rather than a
// hand-tuned three-item stub.

async function matched(phrase: string): Promise<string | undefined> {
  const r = await resolveService(phrase);
  return r.kind === 'match' ? r.service.name : undefined;
}

describe('resolveService — live-verified traps', () => {
  it('"wax" is AMBIGUOUS, not a silent pick (two distinct waxes)', async () => {
    const r = await resolveService('wax');
    expect(r.kind).toBe('ambiguous');
    if (r.kind === 'ambiguous') {
      const names = r.candidates.map((s) => s.name).sort();
      expect(names).toEqual(['Bikini Wax', 'Full Leg Wax']);
    }
  });

  it('a clearly-unknown service -> notOffered', async () => {
    expect((await resolveService('helicopter ride')).kind).toBe('notOffered');
    expect((await resolveService('massage')).kind).toBe('notOffered');
  });

  it('exact full-name query stays decisive even when the fragment recurs', async () => {
    // "Lip Threading" is fully named -> match, despite "threading" living in
    // several other service names.
    expect(await matched('lip threading')).toBe('Lip Threading');
  });

  it('a leading menu prefix is stripped ("5) Bikini Wax")', async () => {
    expect(await matched('5) Bikini Wax')).toBe('Bikini Wax');
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
    expect(await matched('micro blading')).toMatch(/microblading/i);
  });

  it('never returns more than 3 ambiguous candidates ("threading")', async () => {
    const r = await resolveService('threading');
    expect(r.kind).toBe('ambiguous');
    if (r.kind === 'ambiguous') {
      expect(r.candidates.length).toBeLessThanOrEqual(3);
    }
  });
});

// 2026-09-07 production loss: a caller said "eyebrow threading" three times and
// got "do you mean Brow Threading?" three times, because the catalog says
// "Brow" and the matcher required every spoken word to appear in the name.
describe('resolveService — spoken variants of catalog words (TOKEN_SYNONYMS)', () => {
  it.each([
    ['eyebrow threading', 'Brow Threading'],
    ['Eyebrows threading', 'Brow Threading'],
    ['eyebrow', 'Brow Threading'],
    ['eyebrows', 'Brow Threading'],
    ['brows', 'Brow Threading'],
    ['brow', 'Brow Threading'],
    ['eyebrow tinting', 'Eyebrow Tinting'],
    ['brow tint', 'Eyebrow Tinting'],
    ['eyebrow lamination', 'Brow Lamination'],
    ['brow laminate', 'Brow Lamination'],
    ['eyelash lift', 'Lash Lift'],
    ['lash lamination', 'Lash Lift'], // a different service name -> SERVICE_ALIASES
    ['eyelash laminations', 'Lash Lift'],
    ['full leg waxing', 'Full Leg Wax'],
    ['brow lami', 'Brow Lamination'], // TikTok shorthand
    ['lash perm', 'Lash Lift'], // the older name for a lift
    ['brow perm', 'Brow Lamination'],
  ])('%s -> %s', async (phrase, expected) => {
    expect(await matched(phrase)).toBe(expected);
  });
});

describe('resolveService — filler words around the service (catalog-vocabulary filter)', () => {
  it.each([
    ['do my brows', 'Brow Threading'],
    ['get my brows done', 'Brow Threading'],
    ['can I get my eyebrows threaded', 'Brow Threading'],
    ['I want a lash lift please', 'Lash Lift'],
    ['book me a bikini wax', 'Bikini Wax'],
    ['just the lip threading', 'Lip Threading'],
    ['threading for my eyebrows', 'Brow Threading'], // word order
    ['tint my brows', 'Eyebrow Tinting'],
  ])('%s -> %s', async (phrase, expected) => {
    expect(await matched(phrase)).toBe(expected);
  });

  it('never widens a partial match by dropping words ("leg cut" is not Full Leg Wax)', async () => {
    // "cut" is in no catalog name; what remains ("leg") only PARTIALLY names a
    // service, so the filter must not turn it into a booking.
    const r = await resolveService('leg cut');
    expect(r.kind).not.toBe('match');
  });
});
