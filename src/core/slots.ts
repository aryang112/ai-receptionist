import { DateTime } from 'luxon';

/**
 * PRESENTATION ONLY — nothing in this file may ever MOVE a start time.
 *
 * 2026-09-14 (the Loretta call): the previous version of this module snapped
 * Phorest's real free starts UP onto a clean clock grid so Erica never had to
 * say "2:43 pm", and the snapped value was then both spoken AND booked. That
 * is unsound. Phorest re-anchors its availability grid to the END of every
 * existing appointment, so the GAPS between consecutive free starts are other
 * people's appointments. Rounding up walks into one. Threading services run
 * 5 minutes, so a 5-minute shift is a whole appointment's width — Erica
 * offered 5:30 PM for a slot another client was already sitting in.
 *
 * The salon's Phorest "Booking slots" interval is the right place to control
 * how tidy the source times are (set to 5 minutes on 2026-09-14). Here we only
 * CHOOSE which of the real starts to read out first.
 */

/** True when a real start already sits on the presentation grid. */
export function isOnGrid(dt: DateTime, gridMin: number): boolean {
  if (!Number.isFinite(gridMin) || gridMin <= 1) return true;
  return (dt.hour * 60 + dt.minute) % gridMin === 0;
}

/** Same test for an "HH:mm" value as carried in a tool result. */
export function isOnGridValue(value: string, gridMin: number): boolean {
  const [h, m] = value.split(':').map(Number);
  if (h == null || m == null || Number.isNaN(h) || Number.isNaN(m)) return true;
  if (!Number.isFinite(gridMin) || gridMin <= 1) return true;
  return (h * 60 + m) % gridMin === 0;
}

/**
 * Split real starts into the tidy ones we lead with (:00/:15/:30/:45 by
 * default) and the rest, which stay in reserve for a thin day or an exact
 * request. Both lists are de-duplicated and chronological. No start is
 * altered, dropped, or invented.
 */
export function partitionByGrid(
  slots: DateTime[],
  gridMin: number
): { onGrid: DateTime[]; offGrid: DateTime[] } {
  const seen = new Set<number>();
  const sorted = [...slots]
    .filter((dt) => dt.isValid)
    .sort((a, b) => a.toMillis() - b.toMillis())
    .filter((dt) => {
      if (seen.has(dt.toMillis())) return false;
      seen.add(dt.toMillis());
      return true;
    });
  return {
    onGrid: sorted.filter((dt) => isOnGrid(dt, gridMin)),
    offGrid: sorted.filter((dt) => !isOnGrid(dt, gridMin)),
  };
}
