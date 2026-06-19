import { describe, it, expect } from 'vitest';
import { DateTime } from 'luxon';
import { getHoursStatus } from '../core/hours.js';

// business.json: mon 12-17, tue-fri 12-19, sat 10-18, sun closed; closedDates incl 2025-12-25.
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
    const s = getHoursStatus('2025-12-25', at('2025-12-25T13:00'));
    expect(s.salonOpenThatDay).toBe(false);
    expect(s.closedRightNow).toBe(true); // today + closed all day
  });
});
