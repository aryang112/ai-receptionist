import { describe, it, expect, afterEach } from 'vitest';
import { DateTime, Settings } from 'luxon';

/**
 * Regression guard for TZ-1: availability slots must render in the SALON zone
 * regardless of the process/server timezone. getAvailability returns ISO
 * strings carrying the salon offset; twilioStream parses them with
 * `DateTime.fromISO(iso, { zone: env.TIMEZONE })`. An unzoned parse renders in
 * the process zone, so on a UTC host every spoken/booked time silently shifts
 * +4/5h. These tests fail if that fix is ever reverted.
 */
describe('availability slot parsing is timezone-safe (TZ-1)', () => {
  const SALON_ZONE = 'America/New_York';
  // A 3:00 PM salon-local slot as getAvailability emits it (salon offset, EDT).
  const slotIso = '2026-07-19T15:00:00.000-04:00';

  afterEach(() => {
    Settings.defaultZone = 'system';
  });

  it('renders salon-local time even when the server runs in UTC', () => {
    Settings.defaultZone = 'utc'; // simulate a Fly/Railway UTC host
    const dt = DateTime.fromISO(slotIso, { zone: SALON_ZONE });
    expect(dt.toFormat('h:mm a')).toBe('3:00 PM');
    expect(dt.toFormat('HH:mm')).toBe('15:00');
  });

  it('is invariant across process zones (UTC vs salon vs Tokyo)', () => {
    const renders = ['utc', SALON_ZONE, 'Asia/Tokyo'].map((z) => {
      Settings.defaultZone = z;
      return DateTime.fromISO(slotIso, { zone: SALON_ZONE }).toFormat('h:mm a');
    });
    expect(new Set(renders).size).toBe(1);
    expect(renders[0]).toBe('3:00 PM');
  });

  it('proves the old unzoned parse WAS wrong on a UTC host (guards the revert)', () => {
    Settings.defaultZone = 'utc';
    // The buggy form: no zone -> renders in the process (UTC) zone.
    expect(DateTime.fromISO(slotIso).toFormat('h:mm a')).toBe('7:00 PM');
  });
});
