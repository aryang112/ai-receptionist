import { describe, it, expect, afterEach } from 'vitest';
import { DateTime } from 'luxon';
import {
  getHoursStatus,
  getActiveOrUpcomingVacation,
  getVacationForDate,
  isOpenNow,
  isWithinTransferWindow,
} from '../core/hours.js';
import { env } from '../config/env.js';

// business.json: mon 12-17, tue-fri 12-19, sat 10-18, sun closed; closedDates incl 2026-12-25.
// vacations: 2026-09-01 to 2026-09-09 (Richa away), reopens 2026-09-10 (Thu).
// 2026-06-18 is a Thursday, -19 Fri, -20 Sat, -21 Sun.
const at = (iso: string) => DateTime.fromISO(iso, { zone: 'America/New_York' });

describe('getHoursStatus', () => {
  it('after closing today -> closedRightNow (the 8pm "fully booked" bug)', () => {
    const s = getHoursStatus('2026-06-18', at('2026-06-18T20:00')); // Thu 8pm, closes 7pm
    expect(s.salonOpenThatDay).toBe(true);
    expect(s.closedRightNow).toBe(true);
    expect(s.hoursThatDay).toBe('12 PM to 7 PM');
    expect(s.nextOpen).toMatch(/tomorrow/);
  });

  it('during open hours -> open, not closed', () => {
    const s = getHoursStatus('2026-06-18', at('2026-06-18T13:00'));
    expect(s.salonOpenThatDay).toBe(true);
    expect(s.closedRightNow).toBe(false);
  });

  it('closed weekday (Sunday) -> closed that whole day, not "fully booked"', () => {
    const s = getHoursStatus('2026-06-21', at('2026-06-18T13:00'));
    expect(s.salonOpenThatDay).toBe(false);
    expect(s.closedRightNow).toBe(false); // it isn't today
    expect(s.hoursThatDay).toBe('Closed');
  });

  it('closed date -> closed even on a normal weekday', () => {
    const s = getHoursStatus('2026-12-25', at('2026-12-25T13:00'));
    expect(s.salonOpenThatDay).toBe(false);
    expect(s.closedRightNow).toBe(true); // today + closed all day
  });
});

describe('vacations (V1)', () => {
  it('a date inside the vacation range is closed, like a closedDate', () => {
    const s = getHoursStatus('2026-09-03', at('2026-08-22T13:00')); // Thursday, would normally be open 12-7
    expect(s.salonOpenThatDay).toBe(false);
    expect(s.hoursThatDay).toBe('Closed');
  });

  it('the first vacation day and the last vacation day are both closed (inclusive range)', () => {
    expect(
      getHoursStatus('2026-09-01', at('2026-08-22T13:00')).salonOpenThatDay
    ).toBe(false);
    expect(
      getHoursStatus('2026-09-09', at('2026-08-22T13:00')).salonOpenThatDay
    ).toBe(false);
  });

  it('the day after the vacation reopens normally', () => {
    // 2026-09-10 is a Thursday -> thu hours 12:00-19:00, untouched by the vacation.
    const s = getHoursStatus('2026-09-10', at('2026-08-22T13:00'));
    expect(s.salonOpenThatDay).toBe(true);
    expect(s.hoursThatDay).toBe('12 PM to 7 PM');
  });

  it('nextOpen names the DATE when the next opening is a week or more away (2026-09-01 audit)', () => {
    // Tue Sep 1 inside the closure: the bare label "Thursday" would point at
    // THIS Thursday (Sep 3, itself closed). The real reopen is Thu Sep 10.
    const s = getHoursStatus('2026-09-01', at('2026-09-01T17:00'));
    expect(s.nextOpen).toBe('Thursday, September 10 at 12 PM');
    // Within the coming week a bare weekday stays (no regression): Fri Sep 4
    // → Thu Sep 10 is 6 days out, the nearest Thursday.
    expect(getHoursStatus('2026-09-04', at('2026-09-04T17:00')).nextOpen).toBe(
      'Thursday at 12 PM'
    );
  });

  it('getVacationForDate covers ANY closure date, with the reopen day', () => {
    expect(getVacationForDate('2026-09-03')).toEqual({
      from: '2026-09-01',
      to: '2026-09-09',
      reopenISO: '2026-09-10',
    });
    expect(getVacationForDate('2026-09-10')).toBeNull();
    expect(getVacationForDate('2026-08-31')).toBeNull();
  });

  it('a day before the vacation is unaffected', () => {
    // 2026-08-31 is a Monday -> mon hours 12:00-17:00.
    const s = getHoursStatus('2026-08-31', at('2026-08-22T13:00'));
    expect(s.salonOpenThatDay).toBe(true);
  });

  it('getActiveOrUpcomingVacation: active when "now" falls inside the range', () => {
    const v = getActiveOrUpcomingVacation(at('2026-09-05T12:00'));
    expect(v).toEqual({
      from: '2026-09-01',
      to: '2026-09-09',
      reopenISO: '2026-09-10',
    });
  });

  it('getActiveOrUpcomingVacation: upcoming when it starts within the next 14 days', () => {
    // 2026-08-22 is 10 days before 2026-09-01.
    const v = getActiveOrUpcomingVacation(at('2026-08-22T09:00'));
    expect(v).toEqual({
      from: '2026-09-01',
      to: '2026-09-09',
      reopenISO: '2026-09-10',
    });
  });

  it('getActiveOrUpcomingVacation: null when it is neither active nor starting within 14 days', () => {
    // 2026-08-10 is 22 days before 2026-09-01.
    const v = getActiveOrUpcomingVacation(at('2026-08-10T09:00'));
    expect(v).toBeNull();
  });

  it('getActiveOrUpcomingVacation: null once the vacation is fully over and not upcoming again', () => {
    const v = getActiveOrUpcomingVacation(at('2026-09-15T09:00'));
    expect(v).toBeNull();
  });
});

describe('isOpenNow (after-hours transfer gate, 2026-08-23)', () => {
  it('true during open hours on a normal weekday', () => {
    // Tuesday 2026-08-25, tue hours 12:00-19:00
    expect(isOpenNow(at('2026-08-25T14:00'))).toBe(true);
  });
  it('false after closing, before opening, on Sundays, and on vacation days', () => {
    expect(isOpenNow(at('2026-08-25T21:00'))).toBe(false); // after close
    expect(isOpenNow(at('2026-08-25T09:00'))).toBe(false); // before open
    expect(isOpenNow(at('2026-08-23T13:00'))).toBe(false); // Sunday
    expect(isOpenNow(at('2026-09-03T13:00'))).toBe(false); // vacation Thursday
  });
});

// 2026-08-24 (the Holly call): the transfer gate is Richa's waking hours,
// not the salon's opening hours — her cell rings, not the front desk.
describe('isWithinTransferWindow (human transfer window, 2026-08-24)', () => {
  const savedStart = env.TRANSFER_WINDOW_START;
  const savedEnd = env.TRANSFER_WINDOW_END;
  afterEach(() => {
    env.TRANSFER_WINDOW_START = savedStart;
    env.TRANSFER_WINDOW_END = savedEnd;
  });

  it('default 09:00–21:00: boundaries are start-inclusive, end-exclusive', () => {
    expect(isWithinTransferWindow(at('2026-08-25T08:59'))).toBe(false);
    expect(isWithinTransferWindow(at('2026-08-25T09:00'))).toBe(true);
    expect(isWithinTransferWindow(at('2026-08-25T20:59'))).toBe(true);
    expect(isWithinTransferWindow(at('2026-08-25T21:00'))).toBe(false);
  });

  it('ignores the salon calendar — the Holly regression cases', () => {
    // Sunday 11:46 AM (salon closed all day) — Holly's actual call time.
    expect(isWithinTransferWindow(at('2026-08-23T11:46'))).toBe(true);
    // Weekday 9:30 AM, salon not open until noon.
    expect(isWithinTransferWindow(at('2026-08-25T09:30'))).toBe(true);
    // Weekday 8 PM: salon closed at 7, but Richa still takes calls.
    expect(isWithinTransferWindow(at('2026-08-25T20:00'))).toBe(true);
    // Christmas (a closedDate) mid-day: her phone may still ring.
    expect(isWithinTransferWindow(at('2026-12-25T13:00'))).toBe(true);
    // Late night is out regardless of anything else.
    expect(isWithinTransferWindow(at('2026-08-25T22:30'))).toBe(false);
  });

  it('env-tunable window is honored', () => {
    env.TRANSFER_WINDOW_START = '10:00';
    env.TRANSFER_WINDOW_END = '18:00';
    expect(isWithinTransferWindow(at('2026-08-25T09:30'))).toBe(false);
    expect(isWithinTransferWindow(at('2026-08-25T17:59'))).toBe(true);
    expect(isWithinTransferWindow(at('2026-08-25T18:00'))).toBe(false);
  });

  it('garbage window values fall back to the 09:00/21:00 defaults', () => {
    env.TRANSFER_WINDOW_START = 'not-a-time';
    env.TRANSFER_WINDOW_END = '25:99';
    expect(isWithinTransferWindow(at('2026-08-25T08:59'))).toBe(false);
    expect(isWithinTransferWindow(at('2026-08-25T09:00'))).toBe(true);
    expect(isWithinTransferWindow(at('2026-08-25T20:59'))).toBe(true);
    expect(isWithinTransferWindow(at('2026-08-25T21:00'))).toBe(false);
  });
});
