import { DateTime } from 'luxon';
import businessHours from '../config/business.json';

// business.json is the source of truth for hours (read-only here).
const TZ = businessHours.timezone || 'America/New_York';

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

function rangesForDate(date: DateTime): string[] {
  const iso = date.toISODate();
  if (iso && businessHours.closedDates.includes(iso)) return [];
  const key = WEEKDAY_KEYS[date.weekday];
  return (key ? businessHours.hours[key] : []) ?? [];
}

function atTime(date: DateTime, hhmm: string): DateTime {
  const [h, m] = hhmm.split(':').map(Number);
  return date.set({ hour: h ?? 0, minute: m ?? 0, second: 0, millisecond: 0 });
}
const rangeStart = (date: DateTime, range: string) => atTime(date, range.split('-')[0]!);
const rangeEnd = (date: DateTime, range: string) => atTime(date, range.split('-')[1]!);

function fmtTime(dt: DateTime): string {
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

/**
 * Compute open/closed context for a requested date so the receptionist can tell
 * "we're closed" apart from "we're fully booked". `now` is injectable for tests.
 */
export function getHoursStatus(dateISO: string, now: DateTime = DateTime.now()): HoursStatus {
  const nowDt = now.setZone(TZ);
  const date = DateTime.fromISO(dateISO, { zone: TZ }).startOf('day');
  const ranges = rangesForDate(date);
  const salonOpenThatDay = ranges.length > 0;
  const isToday = date.hasSame(nowDt, 'day');

  let closedRightNow = false;
  if (isToday) {
    closedRightNow = !salonOpenThatDay || nowDt >= rangeEnd(date, ranges[ranges.length - 1]!);
  }

  const hoursThatDay = salonOpenThatDay
    ? ranges.map((r) => `${fmtTime(rangeStart(date, r))} to ${fmtTime(rangeEnd(date, r))}`).join(', ')
    : 'Closed';

  // First opening datetime strictly in the future (scan up to 2 weeks).
  let nextOpen: string | null = null;
  for (let i = 0; i <= 14; i++) {
    const d = nowDt.plus({ days: i }).startOf('day');
    const r = rangesForDate(d);
    if (!r.length) continue;
    const open = rangeStart(d, r[0]!);
    if (open > nowDt) {
      const dayLabel = i === 0 ? 'today' : i === 1 ? 'tomorrow' : d.toFormat('cccc');
      nextOpen = `${dayLabel} at ${fmtTime(open)}`;
      break;
    }
  }

  return { salonOpenThatDay, hoursThatDay, isToday, closedRightNow, nextOpen };
}
