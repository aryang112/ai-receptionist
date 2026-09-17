import { beforeEach, describe, expect, it, vi } from 'vitest';

// Regression coverage for the 2026-09-16 resolver fix (docs/AUDIT_REVIEW_2026-09-15.md
// §2.3): "brow and lip" silently matched "Brow Wax and Lip Wax" because that
// catalog entry's own name contains the filler word "and", while the
// threading bundle's "+" separator normalizes away to nothing. At a
// threading salon "brow and lip" means threading, never wax.
//
// Fixture mirrors the real catalog names that produced the bug (verified
// read-only via `scripts/list-services.ts` against production, 2026-09-16),
// isolated here (rather than reusing the shared mock catalog in
// phorest.mock.ts, which doesn't carry these bundle names) so this suite
// doesn't depend on — or risk perturbing — the shared fixture other suites use.
const { listServices } = vi.hoisted(() => ({ listServices: vi.fn() }));
vi.mock('../services/phorest.js', () => ({ phorest: { listServices } }));

import { resolveService } from '../services/booking.js';

const browWaxLipWax = {
  id: 'brow-wax-lip-wax',
  name: 'Brow Wax and Lip Wax',
  price: 23,
  durationMin: 10,
};
const browLipThread = {
  id: 'brow-lip-thread',
  name: 'Brow Thread + Lip Thread',
  price: 23,
  durationMin: 10,
};
const browLipChinThread = {
  id: 'brow-lip-chin-thread',
  name: 'Brow Thread + Lip Thread + Chin Thread',
  price: 34,
  durationMin: 15,
};
const lipThreading = {
  id: 'lip-threading',
  name: 'Lip Threading',
  price: 8,
  durationMin: 5,
};
const lipWaxing = {
  id: 'lip-waxing',
  name: 'Lip Waxing',
  price: 8,
  durationMin: 5,
};
const browThreading = {
  id: 'brow-threading',
  name: 'Brow Threading',
  price: 15,
  durationMin: 5,
};

const catalog = [
  browWaxLipWax,
  browLipThread,
  browLipChinThread,
  lipThreading,
  lipWaxing,
  browThreading,
];

beforeEach(() => {
  listServices.mockResolvedValue(catalog);
});

describe('resolveService — "brow and lip" never silently becomes wax', () => {
  it('"brow and lip" never silently becomes wax', async () => {
    const r = await resolveService('brow and lip');
    expect(r.kind).toBe('ambiguous');
    if (r.kind === 'ambiguous') {
      const names = r.candidates.map((s) => s.name);
      expect(names).toContain('Brow Wax and Lip Wax');
      expect(names).toContain('Brow Thread + Lip Thread');
      // The whole point of the fix: never a decisive "match" on the wax bundle.
    }
  });

  it('"eyebrows and upper lip" is ambiguous between the wax and threading bundles', async () => {
    const r = await resolveService('eyebrows and upper lip');
    expect(r.kind).toBe('ambiguous');
    if (r.kind === 'ambiguous') {
      const names = r.candidates.map((s) => s.name);
      expect(names).toContain('Brow Wax and Lip Wax');
      expect(names).toContain('Brow Thread + Lip Thread');
    }
  });

  it('"brow threading and upper lip" matches the 2-service threading bundle', async () => {
    const r = await resolveService('brow threading and upper lip');
    expect(r.kind).toBe('match');
    if (r.kind === 'match')
      expect(r.service.name).toBe('Brow Thread + Lip Thread');
  });

  it('"brow threading lip" matches the 2-service bundle, not the 3-service one (set coverage, not count)', async () => {
    const r = await resolveService('brow threading lip');
    expect(r.kind).toBe('match');
    if (r.kind === 'match')
      expect(r.service.name).toBe('Brow Thread + Lip Thread');
  });

  it('"upper lip threading" matches "Lip Threading" ("upper" is a droppable modifier)', async () => {
    const r = await resolveService('upper lip threading');
    expect(r.kind).toBe('match');
    if (r.kind === 'match') expect(r.service.name).toBe('Lip Threading');
  });

  it('"brow threading" alone still matches Brow Threading exactly (unaffected baseline)', async () => {
    const r = await resolveService('brow threading');
    expect(r.kind).toBe('match');
    if (r.kind === 'match') expect(r.service.name).toBe('Brow Threading');
  });

  it('a bare "lip" is still ambiguous across every lip-containing service', async () => {
    const r = await resolveService('lip');
    expect(r.kind).toBe('ambiguous');
  });

  it('the full 3-service bundle is still reachable when all three are named', async () => {
    const r = await resolveService(
      'brow threading lip threading chin threading'
    );
    expect(r.kind).toBe('match');
    if (r.kind === 'match')
      expect(r.service.name).toBe('Brow Thread + Lip Thread + Chin Thread');
  });

  // 2026-09-16 follow-up: TOKEN_SYNONYMS had no wax/waxing mapping, so the
  // query token "wax" was never present in "Lip Waxing" ({lip, waxing}) and
  // the fragment fell through to the wax bundle instead. Fixed by mapping
  // `waxing`/`waxed` -> `wax` (toward the shorter form, matching how bare
  // catalog names like "Bikini Wax"/"Arms Wax" already read).
  it('"lip wax" matches "Lip Waxing", not the wax bundle', async () => {
    const r = await resolveService('lip wax');
    expect(r.kind).toBe('match');
    if (r.kind === 'match') expect(r.service.name).toBe('Lip Waxing');
  });

  it('"lip waxing" matches "Lip Waxing"', async () => {
    const r = await resolveService('lip waxing');
    expect(r.kind).toBe('match');
    if (r.kind === 'match') expect(r.service.name).toBe('Lip Waxing');
  });
});
