import { DateTime } from 'luxon';

/**
 * Visit grouping and joint placement.
 *
 * 2026-09-14 (the two-appointment reschedule call): Erica treated each
 * appointment as an independent job. She named only the soonest, moved one,
 * re-checked availability, discovered SHE had just filled the slot ("5:45 is
 * no longer open"), and narrated the whole thing to the caller. The unit of
 * work has to be the VISIT, decided in full before anything is written.
 *
 * OWNER RULE: togetherness is a property of the APPOINTMENTS, not of the day.
 * Two appointments five hours apart are two visits that share a date — never
 * move them as a pair. Adjacency only decides what Erica OFFERS; it never
 * decides what she changes without an explicit yes.
 */

/** Starts this close together are one sitting rather than two trips in. */
export const SAME_VISIT_GAP_MIN = 30;

export type VisitItem<T> = { at: DateTime; item: T };

/**
 * Split one day's appointments into sittings. Consecutive starts within
 * `maxGapMin` of each other belong to the same visit.
 */
export function clusterSameVisit<T>(
  entries: VisitItem<T>[],
  maxGapMin: number = SAME_VISIT_GAP_MIN
): T[][] {
  const sorted = [...entries]
    .filter((e) => e.at.isValid)
    .sort((a, b) => a.at.toMillis() - b.at.toMillis());
  const visits: T[][] = [];
  let current: T[] = [];
  let previous: DateTime | undefined;
  for (const entry of sorted) {
    const gap = previous
      ? entry.at.diff(previous, 'minutes').minutes
      : Infinity;
    if (previous && gap <= maxGapMin) {
      current.push(entry.item);
    } else {
      if (current.length) visits.push(current);
      current = [entry.item];
    }
    previous = entry.at;
  }
  if (current.length) visits.push(current);
  return visits;
}

/**
 * Place several services back-to-back inside ONE set of real availability.
 *
 * Every placed start must itself be a start Phorest returned — the same
 * contract as core/slots.ts. A service running `durationMin` from an offered
 * start does NOT prove the following minute is free (see the Loretta call), so
 * each subsequent item is verified against `available` rather than assumed.
 *
 * Returns up to `max` plans, nearest `preferred` first when given.
 */
export function planConsecutive(
  available: DateTime[],
  durationsMin: number[],
  preferred?: DateTime,
  max = 3
): DateTime[][] {
  if (!durationsMin.length) return [];
  const open = new Set(
    available.filter((dt) => dt.isValid).map((dt) => dt.toMillis())
  );
  const starts = [...available]
    .filter((dt) => dt.isValid)
    .sort((a, b) => a.toMillis() - b.toMillis());

  const plans: DateTime[][] = [];
  for (const start of starts) {
    const placed: DateTime[] = [];
    let cursor = start;
    let fits = true;
    for (let i = 0; i < durationsMin.length; i++) {
      if (!open.has(cursor.toMillis())) {
        fits = false;
        break;
      }
      placed.push(cursor);
      cursor = cursor.plus({ minutes: durationsMin[i] ?? 0 });
    }
    if (fits) plans.push(placed);
  }

  if (preferred?.isValid) {
    // Nearest the caller's request FIRST and kept that way — Erica offers one
    // plan, so the best must be plans[0]. Re-sorting chronologically here once
    // silently demoted the closest fit behind an earlier, worse one.
    plans.sort(
      (a, b) =>
        Math.abs(a[0]!.toMillis() - preferred.toMillis()) -
        Math.abs(b[0]!.toMillis() - preferred.toMillis())
    );
    // …but the runners-up must be REAL alternatives. Ranking purely by
    // distance returned 2:50 / 2:45 / 2:40 for a blocked 3 PM — three
    // overlapping versions of the same answer, and nothing on the far side of
    // the obstacle. Options may not overlap each other: successive starts sit
    // at least one whole visit apart, so the caller hears genuinely different
    // choices (2:50, or 3:25 if later suits them). Fewer real options beats
    // three near-duplicates.
    const spacingMin = Math.max(
      15,
      durationsMin.reduce((total, minutes) => total + (minutes || 0), 0)
    );
    const spread: DateTime[][] = [];
    for (const plan of plans) {
      if (spread.length >= max) break;
      const clashes = spread.some(
        (chosen) =>
          Math.abs(chosen[0]!.diff(plan[0]!, 'minutes').minutes) < spacingMin
      );
      if (!clashes) spread.push(plan);
    }
    return spread;
  }
  return plans.slice(0, max);
}
