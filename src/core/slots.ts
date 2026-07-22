import { DateTime } from 'luxon';

/**
 * Round a time UP to the next grid boundary (e.g. gridMin=15 → next quarter
 * hour). A time already on the grid is returned unchanged.
 */
export function ceilToGrid(dt: DateTime, gridMin: number): DateTime {
  const topOfHour = dt.startOf('hour');
  const minutesPast = dt.diff(topOfHour, 'minutes').minutes;
  const steps = Math.ceil(minutesPast / gridMin - 1e-9);
  return topOfHour.plus({ minutes: steps * gridMin });
}

/**
 * Snap raw Phorest availability starts onto a clean clock grid.
 *
 * WHY: Phorest computes availability as a rolling grid that RE-ANCHORS to the
 * END of every existing appointment, so after any booking the free starts come
 * back at odd minutes — e.g. an appointment ending at 2:43 yields 2:43, 2:58,
 * 3:13, 3:28… A salon should never offer "2:43 pm", so we snap each start UP to
 * the next grid boundary (default :00/:15/:30/:45) before offering it.
 *
 * WHY SNAP *UP* (never round to nearest / down): the staff is free FROM the raw
 * start onward, so any LATER time inside the same free block is also free.
 * Rounding down could name a time before the block opens (an unbookable/double-
 * book time). We only keep a snapped time when the free block is proven to reach
 * it: a slot that already sits on the grid is always safe; an off-grid slot is
 * kept only if a SUCCESSOR raw start exists within `gridMin` (i.e. the slot is
 * inside a contiguous run). That successor guarantees the block extends ≥ gridMin
 * past the raw start, and the snapped boundary never exceeds raw+gridMin, so the
 * service still fits before the next appointment. A lone off-grid slot at the
 * tail of a run sits right against the next appointment — its runway can't be
 * proven once snapped, so it's dropped rather than risk offering a colliding
 * time. Output is de-duplicated and chronologically sorted.
 */
export function snapSlotsToGrid(slots: DateTime[], gridMin = 15): DateTime[] {
  const sorted = [...slots]
    .filter((dt) => dt.isValid)
    .sort((a, b) => a.toMillis() - b.toMillis());
  const kept = new Map<number, DateTime>(); // key = epoch ms → natural de-dupe
  for (let i = 0; i < sorted.length; i++) {
    const raw = sorted[i]!;
    const snapped = ceilToGrid(raw, gridMin);
    if (snapped.toMillis() === raw.toMillis()) {
      kept.set(snapped.toMillis(), snapped); // already on the grid — always safe
      continue;
    }
    const next = sorted[i + 1];
    const hasRunway =
      next != null && next.diff(raw, 'minutes').minutes <= gridMin + 1e-6;
    if (hasRunway) kept.set(snapped.toMillis(), snapped);
    // else: lone off-grid tail slot against an appointment edge → drop it.
  }
  return [...kept.values()].sort((a, b) => a.toMillis() - b.toMillis());
}
