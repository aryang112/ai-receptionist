import { DateTime } from 'luxon';
import businessHours from '../config/business.json';

// business.json is the source of truth for hours (read-only here).
const TZ = businessHours.timezone || 'America/New_York';

// One business.json entry drives everything (V1): a vacation range closes the
// salon for booking/availability purposes without touching weekday hours or
// closedDates. Defensive default — older business.json snapshots (or a
// reverted edit) may not have this key at all.
type Vacation = { from: string; to: string; note?: string };
const VACATIONS: Vacation[] =
  (businessHours as { vacations?: Vacation[] }).vacations ?? [];

// luxon weekday: 1=Mon .. 7=Sun
const WEEKDAY_KEYS: Record<number, keyof typeof businessHours.hours> = {
  1: 'mon',
  2: 'tue',
  3: 'wed',
  4: 'thu',
  5: 'fri',
  6: 'sat',
  7: 'sun',
};

/** ISO string compare is safe here — both sides are YYYY-MM-DD. */
function isOnVacation(iso: string): boolean {
  return VACATIONS.some((v) => v.from <= iso && iso <= v.to);
}

function rangesForDate(date: DateTime): string[] {
  const iso = date.toISODate();
  if (iso && businessHours.closedDates.includes(iso)) return [];
  if (iso && isOnVacation(iso)) return [];
  const key = WEEKDAY_KEYS[date.weekday];
  return (key ? businessHours.hours[key] : []) ?? [];
}

function atTime(date: DateTime, hhmm: string): DateTime {
  const [h, m] = hhmm.split(':').map(Number);
  return date.set({ hour: h ?? 0, minute: m ?? 0, second: 0, millisecond: 0 });
}
const rangeStart = (date: DateTime, range: string) =>
  atTime(date, range.split('-')[0]!);
const rangeEnd = (date: DateTime, range: string) =>
  atTime(date, range.split('-')[1]!);

// H1: exported so twilioStream.ts's prompt HOURS-block formatter reuses the
// exact same 12-hour rendering instead of a second copy that could drift.
export function fmtTime(dt: DateTime): string {
  return dt.minute === 0 ? dt.toFormat('h a') : dt.toFormat('h:mm a');
}

export type HoursStatus = {
  /** Salon operates at all on the requested calendar date (false = closed weekday or closed date). */
  salonOpenThatDay: boolean;
  /** Human label of that day's hours, e.g. "12 PM to 7 PM", or "Closed". */
  hoursThatDay: string;
  /** Requested date is today. */
  isToday: boolean;
  /** Requested date is today AND we are already past closing (or closed all day). */
  closedRightNow: boolean;
  /** Next time the salon opens, e.g. "tomorrow at 12 PM" / "Saturday at 10 AM". */
  nextOpen: string | null;
};

/** Opening and closing instants for a date, or null if the salon is closed that day. */
export function getOpenClose(
  dateISO: string
): { open: DateTime; close: DateTime } | null {
  const date = DateTime.fromISO(dateISO, { zone: TZ }).startOf('day');
  const ranges = rangesForDate(date);
  if (!ranges.length) return null;
  return {
    open: rangeStart(date, ranges[0]!),
    close: rangeEnd(date, ranges[ranges.length - 1]!),
  };
}

/**
 * Compute open/closed context for a requested date so the receptionist can tell
 * "we're closed" apart from "we're fully booked". `now` is injectable for tests.
 */
export function getHoursStatus(
  dateISO: string,
  now: DateTime = DateTime.now()
): HoursStatus {
  const nowDt = now.setZone(TZ);
  const date = DateTime.fromISO(dateISO, { zone: TZ }).startOf('day');
  const ranges = rangesForDate(date);
  const salonOpenThatDay = ranges.length > 0;
  const isToday = date.hasSame(nowDt, 'day');

  let closedRightNow = false;
  if (isToday) {
    closedRightNow =
      !salonOpenThatDay || nowDt >= rangeEnd(date, ranges[ranges.length - 1]!);
  }

  const hoursThatDay = salonOpenThatDay
    ? ranges
        .map(
          (r) =>
            `${fmtTime(rangeStart(date, r))} to ${fmtTime(rangeEnd(date, r))}`
        )
        .join(', ')
    : 'Closed';

  // First opening datetime strictly in the future (scan up to 2 weeks).
  let nextOpen: string | null = null;
  for (let i = 0; i <= 14; i++) {
    const d = nowDt.plus({ days: i }).startOf('day');
    const r = rangesForDate(d);
    if (!r.length) continue;
    const open = rangeStart(d, r[0]!);
    if (open > nowDt) {
      const dayLabel =
        i === 0 ? 'today' : i === 1 ? 'tomorrow' : d.toFormat('cccc');
      nextOpen = `${dayLabel} at ${fmtTime(open)}`;
      break;
    }
  }

  return { salonOpenThatDay, hoursThatDay, isToday, closedRightNow, nextOpen };
}

export type ActiveOrUpcomingVacation = {
  from: string;
  to: string;
  /** First calendar day the salon reopens (day after `to`). */
  reopenISO: string;
};

/**
 * The vacation that's either ACTIVE today, or starts within the next 14 days
 * — else null. `now` is injectable for tests (same pattern as getHoursStatus).
 * NOTE: getHoursStatus's own `nextOpen` scan only looks 14 days ahead, so a
 * vacation LONGER than 14 days would make `nextOpen` come back null while
 * it's active — a known, documented limitation, not fixed here (V1 only
 * needs to cover the ~9-day Richa vacation).
 */
export function getActiveOrUpcomingVacation(
  now: DateTime = DateTime.now()
): ActiveOrUpcomingVacation | null {
  const nowDt = now.setZone(TZ);
  const todayISO = nowDt.toISODate();
  if (!todayISO || !VACATIONS.length) return null;

  const toResult = (v: Vacation): ActiveOrUpcomingVacation => {
    const reopen = DateTime.fromISO(v.to, { zone: TZ }).plus({ days: 1 });
    return { from: v.from, to: v.to, reopenISO: reopen.toISODate() ?? v.to };
  };

  const active = VACATIONS.find((v) => v.from <= todayISO && todayISO <= v.to);
  if (active) return toResult(active);

  const upcoming = VACATIONS.find((v) => {
    const startsIn = DateTime.fromISO(v.from, { zone: TZ })
      .startOf('day')
      .diff(nowDt.startOf('day'), 'days').days;
    return startsIn > 0 && startsIn <= 14;
  });
  return upcoming ? toResult(upcoming) : null;
}
