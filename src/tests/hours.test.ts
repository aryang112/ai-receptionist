import { describe, it, expect } from 'vitest';
import { DateTime } from 'luxon';
import {
  getHoursStatus,
  getActiveOrUpcomingVacation,
  isOpenNow,
} from '../core/hours.js';

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
