import { describe, it, expect } from 'vitest';
import { DateTime } from 'luxon';
import { clusterSameVisit, planConsecutive } from '../core/visits.js';

const at = (hhmm: string) =>
  DateTime.fromISO(`2026-09-15T${hhmm}:00`, { zone: 'America/New_York' });
const hhmm = (list: DateTime[]) => list.map((d) => d.toFormat('HH:mm'));

describe('clusterSameVisit', () => {
  it('treats back-to-back appointments as one visit', () => {
    const out = clusterSameVisit([
      { at: at('18:00'), item: 'lip' },
      { at: at('18:00'), item: 'brow' },
    ]);
    expect(out).toEqual([['lip', 'brow']]);
  });

  it('keeps a 12 PM and a 5 PM on the same day as SEPARATE visits', () => {
    // The owner's edge case: same date, but nobody sits in the chair for five
    // hours. Moving one must never drag the other along.
    const out = clusterSameVisit([
      { at: at('12:00'), item: 'noon' },
      { at: at('17:00'), item: 'evening' },
    ]);
    expect(out).toEqual([['noon'], ['evening']]);
  });

  it('splits a genuine gap but holds a short one together', () => {
    const out = clusterSameVisit([
      { at: at('17:00'), item: 'a' },
      { at: at('17:20'), item: 'b' },
      { at: at('19:00'), item: 'c' },
    ]);
    expect(out).toEqual([['a', 'b'], ['c']]);
  });
});

describe('planConsecutive', () => {
  // Real Phorest read for 2026-09-15 (5-minute booking interval). 17:30/17:35
  // are another client's appointment; 18:00 held two bookings.
  const REAL = [
    '17:00', '17:10', '17:15', '17:20', '17:25',
    '17:40', '17:45', '17:50', '17:55',
    '18:05', '18:10', '18:15', '18:20',
  ].map(at);

  it('places two 5-minute services back to back on real starts', () => {
    const plans = planConsecutive(REAL, [5, 5], at('17:45'), 1);
    expect(hhmm(plans[0]!)).toEqual(['17:45', '17:50']);
  });

  it('never places an item on a time Phorest did not return', () => {
    const plans = planConsecutive(REAL, [5, 5]);
    for (const plan of plans) {
      for (const slot of hhmm(plan)) {
        expect(hhmm(REAL)).toContain(slot);
      }
    }
  });

  it('rejects a start whose follow-on lands in someone else\'s appointment', () => {
    // 17:25 + 5 min = 17:30, which is NOT free (another client). A naive
    // "duration fits" check would allow it; every item must be a real start.
    const plans = planConsecutive(REAL, [5, 5]);
    expect(plans.map((p) => hhmm(p)[0])).not.toContain('17:25');
  });

  it('prefers plans nearest the requested time', () => {
    const plans = planConsecutive(REAL, [5, 5], at('18:05'), 1);
    expect(hhmm(plans[0]!)).toEqual(['18:05', '18:10']);
  });

  it('returns nothing when the visit cannot fit anywhere', () => {
    expect(planConsecutive([at('17:00')], [5, 5])).toEqual([]);
  });
});

describe('planConsecutive — option ordering', () => {
  const at2 = (hhmm: string) =>
    DateTime.fromISO(`2026-09-15T${hhmm}:00`, { zone: 'America/New_York' });
  const REAL2 = ['17:40', '17:45', '17:50', '17:55', '18:05'].map(at2);

  it('puts the plan nearest the requested time FIRST, not the earliest', () => {
    // Regression: the closest fit used to be demoted behind an earlier one by
    // a chronological re-sort, so Erica offered the wrong option.
    const plans = planConsecutive(REAL2, [10, 10], at2('17:45'), 3);
    expect(plans[0]!.map((d) => d.toFormat('HH:mm'))).toEqual([
      '17:45',
      '17:55',
    ]);
  });
});
