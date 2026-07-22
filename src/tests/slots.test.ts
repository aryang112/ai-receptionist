import { describe, it, expect } from 'vitest';
import { DateTime } from 'luxon';
import { ceilToGrid, snapSlotsToGrid } from '../core/slots.js';

const ZONE = 'America/New_York';
const parse = (isos: string[]) =>
  isos.map((s) => DateTime.fromISO(s, { zone: ZONE }));
const hhmm = (dts: DateTime[]) => dts.map((d) => d.toFormat('HH:mm'));

describe('ceilToGrid', () => {
  it('rounds up to the next quarter hour, leaves on-grid times alone', () => {
    const at = (t: string) =>
      DateTime.fromISO(`2026-07-22T${t}`, { zone: ZONE });
    expect(ceilToGrid(at('14:43'), 15).toFormat('HH:mm')).toBe('14:45');
    expect(ceilToGrid(at('14:58'), 15).toFormat('HH:mm')).toBe('15:00');
    expect(ceilToGrid(at('14:00'), 15).toFormat('HH:mm')).toBe('14:00'); // clean stays
    expect(ceilToGrid(at('14:15'), 15).toFormat('HH:mm')).toBe('14:15'); // clean stays
    expect(ceilToGrid(at('14:01'), 30).toFormat('HH:mm')).toBe('14:30'); // 30-min grid
  });
});

describe('snapSlotsToGrid', () => {
  it('snaps the real Phorest re-anchored grid to clean clock times', () => {
    // Verbatim from the live tenant: Brow Threading, 2026-07-22. Phorest
    // re-anchors after an appt ending 14:43 and again after one near 18:30.
    const raw = parse([
      '2026-07-22T12:15:00-04:00',
      '2026-07-22T12:30:00-04:00',
      '2026-07-22T12:45:00-04:00',
      '2026-07-22T13:00:00-04:00',
      '2026-07-22T13:15:00-04:00',
      '2026-07-22T13:30:00-04:00',
      '2026-07-22T13:45:00-04:00',
      '2026-07-22T14:00:00-04:00',
      '2026-07-22T14:15:00-04:00',
      '2026-07-22T14:43:00-04:00',
      '2026-07-22T14:58:00-04:00',
      '2026-07-22T15:13:00-04:00',
      '2026-07-22T15:28:00-04:00',
      '2026-07-22T15:43:00-04:00',
      '2026-07-22T15:58:00-04:00',
      '2026-07-22T16:13:00-04:00',
      '2026-07-22T16:28:00-04:00',
      '2026-07-22T16:43:00-04:00',
      '2026-07-22T16:58:00-04:00',
      '2026-07-22T17:13:00-04:00',
      '2026-07-22T17:28:00-04:00',
      '2026-07-22T17:43:00-04:00',
      '2026-07-22T17:58:00-04:00',
      '2026-07-22T18:32:00-04:00',
      '2026-07-22T18:47:00-04:00',
    ]);

    const out = hhmm(snapSlotsToGrid(raw, 15));

    expect(out).toEqual([
      '12:15',
      '12:30',
      '12:45',
      '13:00',
      '13:15',
      '13:30',
      '13:45',
      '14:00',
      '14:15',
      '14:45',
      '15:00',
      '15:15',
      '15:30',
      '15:45',
      '16:00',
      '16:15',
      '16:30',
      '16:45',
      '17:00',
      '17:15',
      '17:30',
      '17:45',
      '18:45',
    ]);
    // No odd minutes survive.
    expect(
      out.every((t) => ['00', '15', '30', '45'].includes(t.slice(-2)))
    ).toBe(true);
    // The two lone tail slots (17:58, 18:47) — no successor within the grid —
    // are dropped rather than snapped into an unbookable time.
    expect(out).not.toContain('18:00');
    expect(out).not.toContain('19:00');
  });

  it('keeps an already-clean grid unchanged', () => {
    const raw = parse([
      '2026-07-22T12:00:00-04:00',
      '2026-07-22T12:15:00-04:00',
      '2026-07-22T12:30:00-04:00',
    ]);
    expect(hhmm(snapSlotsToGrid(raw, 15))).toEqual(['12:00', '12:15', '12:30']);
  });

  it('drops a lone off-grid slot whose runway cannot be proven', () => {
    // 14:43 has a successor 14:58 (within 15m) → snaps safely to 14:45.
    // 14:58 is the tail (next real slot is >15m away) → snapping to 15:00 could
    // collide with the next appointment, so it is dropped.
    const raw = parse([
      '2026-07-22T14:43:00-04:00',
      '2026-07-22T14:58:00-04:00',
      '2026-07-22T16:00:00-04:00',
    ]);
    expect(hhmm(snapSlotsToGrid(raw, 15))).toEqual(['14:45', '16:00']);
  });

  it('de-duplicates when an odd slot snaps onto an existing clean slot', () => {
    const raw = parse([
      '2026-07-22T14:58:00-04:00', // → 15:00 (successor 15:00 proves runway)
      '2026-07-22T15:00:00-04:00', // already 15:00 → de-dupes with the above
      '2026-07-22T15:13:00-04:00', // → 15:15 (successor 15:28 proves runway)
      '2026-07-22T15:28:00-04:00', // lone tail → dropped
    ]);
    expect(hhmm(snapSlotsToGrid(raw, 15))).toEqual(['15:00', '15:15']);
  });
});
