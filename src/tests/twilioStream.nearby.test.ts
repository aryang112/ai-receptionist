import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Settings } from 'luxon';
import { TwilioRealtimeCall } from '../realtime/twilioStream.js';
import { phorest } from '../services/phorest.js';
import { CallStore } from '../services/callStore.js';
import { env } from '../config/env.js';

const full = {
  id: 'full',
  name: 'Micro Blading/ Shading',
  price: 500,
  durationMin: 240,
};
const clock = Settings.now;
function call() {
  return Object.assign(Object.create(TwilioRealtimeCall.prototype), {
    closed: false,
    offeredSlots: new Map(),
    callSid: 'CA_nearby_test',
  }) as any;
}
function query(c: any, extra = {}) {
  return c.handleSuggestAvailability({
    serviceName: 'eyebrow tattoo',
    date: '2026-09-10',
    ...extra,
  });
}
beforeEach(() => {
  Settings.now = () => Date.parse('2026-09-10T12:00:00-04:00');
  vi.spyOn(CallStore, 'recordToolCall').mockImplementation(() => {});
  vi.spyOn(phorest, 'listServices').mockResolvedValue([full]);
  vi.spyOn(phorest, 'getAvailability').mockResolvedValue([]);
});
afterEach(() => {
  Settings.now = clock;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('nearby dates through the real availability handler', () => {
  it('keeps an available requested day to one read and preserves ordinary slot selection', async () => {
    vi.mocked(phorest.getAvailability).mockResolvedValue([
      '2026-09-10T15:00:00-04:00',
    ]);
    const res = await query(call());
    expect(res.slots).toEqual([{ time: '3:00 PM', value: '15:00' }]);
    expect(res.alternativeDates).toBeUndefined();
    expect(phorest.getAvailability).toHaveBeenCalledTimes(1);
  });
  it('preserves the explicit-date opt-out across tool argument validation', async () => {
    const res = await query(call(), { searchNearby: false });
    expect(res.note).toContain('Respect the caller');
    expect(res.note).not.toContain('offer another day');
    expect(res.alternativeDates).toBeUndefined();
    expect(phorest.getAvailability).toHaveBeenCalledTimes(1);
  });
  it('returns real alternatives, skips Sunday, fits all four hours, and caps choices', async () => {
    vi.mocked(phorest.getAvailability).mockImplementation(async (_id, date) =>
      date === '2026-09-10'
        ? []
        : ['12:00', '13:00', '14:00', '15:00', '16:00'].map(
            (time) => `${date}T${time}:00-04:00`
          )
    );
    const c = call();
    const res = await query(c);
    expect(res.service).toBe(full.name);
    expect(res.alternativeDates.map((d: any) => d.date)).toEqual([
      '2026-09-11',
      '2026-09-12',
      '2026-09-14',
    ]);
    expect(res.alternativeDates[2].slots).toEqual([
      { time: '12:00 PM', value: '12:00' },
      { time: '1:00 PM', value: '13:00' },
    ]);
    expect(res.alternativeDates.every((d: any) => d.slots.length <= 3)).toBe(
      true
    );
    expect(
      vi
        .mocked(phorest.getAvailability)
        .mock.calls.every(
          ([id, date]) => id === 'full' && date !== '2026-09-13'
        )
    ).toBe(true);
    expect(c.offeredSlots.get('micro blading/ shading|2026-09-11')).toEqual(
      new Set(res.alternativeDates[0].slots.map((s: any) => s.value))
    );
    expect(res.note).toContain('Offer two or three');
  });
  it('uses the canonical tattoo service for cached alternatives after a closed requested day', async () => {
    vi.mocked(phorest.getAvailability).mockImplementation(async (_id, date) => [
      `${date}T12:00:00-04:00`,
    ]);
    const c = call();
    const res = await query(c, { date: '2026-09-13' });
    expect(res.salonOpenThatDay).toBe(false);
    expect(res.note).toContain('never call a closed day fully booked');
    expect(phorest.getAvailability).not.toHaveBeenCalledWith(
      'full',
      '2026-09-13'
    );
    expect(c.offeredSlots.get('micro blading/ shading|2026-09-14')).toEqual(
      new Set(['12:00'])
    );
    expect(c.offeredSlots.has('eyebrow tattoo|2026-09-14')).toBe(false);
  });
  it('keeps nearby times close to the requested time instead of only the earliest', async () => {
    vi.mocked(phorest.getAvailability).mockImplementation(async (_id, date) =>
      date === '2026-09-10'
        ? []
        : ['12:00', '12:30', '13:00', '13:30', '14:00', '14:30', '15:00'].map(
            (time) => `${date}T${time}:00-04:00`
          )
    );
    const res = await query(call(), { preferredTime: '15:00' });
    expect(res.alternativeDates[0].slots.map((s: any) => s.value)).toEqual([
      '14:00',
      '14:30',
      '15:00',
    ]);
  });
  it('stops at the configurable calendar horizon when everything is full', async () => {
    const res = await query(call());
    expect(res.alternativeDates).toEqual([]);
    expect(res.nearbySearch).toMatchObject({
      through: '2026-09-17',
      incomplete: false,
    });
    expect(phorest.getAvailability).toHaveBeenCalledTimes(7); // initial + six open dates
    expect(res.note).toContain('look farther ahead');
  });
  it('does not turn a failed nearby read into a fully-booked claim', async () => {
    vi.mocked(phorest.getAvailability).mockImplementation(async (_id, date) => {
      if (date === '2026-09-11') throw new Error('provider unavailable');
      return date === '2026-09-12' ? [`${date}T12:00:00-04:00`] : [];
    });
    const res = await query(call());
    expect(res.error).toBeUndefined();
    expect(res.alternativeDates.map((d: any) => d.date)).toEqual([
      '2026-09-12',
    ]);
    expect(res.nearbySearch.failedDates).toEqual(['2026-09-11']);
    expect(res.nearbySearch.incomplete).toBe(true);
  });
  it('explains uncertainty when all nearby reads fail', async () => {
    vi.mocked(phorest.getAvailability)
      .mockResolvedValueOnce([])
      .mockRejectedValue(new Error('timeout'));
    const res = await query(call());
    expect(res.note).toContain('Do not call them full');
    expect(res.nearbySearch.incomplete).toBe(true);
  });
  it('does not start nearby reads if the requested-day read itself failed', async () => {
    vi.mocked(phorest.getAvailability).mockRejectedValue(new Error('timeout'));
    const res = await query(call());
    expect(res.error).toBeDefined();
    expect(phorest.getAvailability).toHaveBeenCalledTimes(1);
  });
  it('does not search for an unresolved service or a past date', async () => {
    const res = await query(call(), { serviceName: 'lip tattoo' });
    expect(res.notOffered).toBe(true);
    expect(phorest.getAvailability).not.toHaveBeenCalled();
    expect(
      (await query(call(), { date: '2026-09-09' })).alternativeDates
    ).toBeUndefined();
    expect(phorest.getAvailability).not.toHaveBeenCalled();
  });
  it('returns quick partial results at the deadline with no late cache mutation', async () => {
    vi.useFakeTimers();
    let finish!: (slots: string[]) => void;
    vi.mocked(phorest.getAvailability).mockImplementation(async (_id, date) => {
      if (date === '2026-09-10') return [];
      if (date === '2026-09-11') return [`${date}T12:00:00-04:00`];
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const c = call();
    const pending = query(c);
    await vi.advanceTimersByTimeAsync(env.NEARBY_AVAILABILITY_BUDGET_MS);
    const res = await pending;
    expect(res.alternativeDates.map((d: any) => d.date)).toEqual([
      '2026-09-11',
    ]);
    expect(res.nearbySearch.incomplete).toBe(true);
    const snapshot = [...c.offeredSlots.keys()];
    finish(['2026-09-12T12:00:00-04:00']);
    await vi.advanceTimersByTimeAsync(1);
    expect([...c.offeredSlots.keys()]).toEqual(snapshot);
    expect(phorest.getAvailability).toHaveBeenCalledTimes(3);
  });
  it('bounds concurrent reads to two and stops publishing when a caller disconnects', async () => {
    let active = 0,
      peak = 0;
    const c = call();
    vi.mocked(phorest.getAvailability).mockImplementation(async (_id, date) => {
      if (date === '2026-09-10') return [];
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      c.closed = true;
      return [`${date}T12:00:00-04:00`];
    });
    const res = await query(c);
    expect(peak).toBe(2);
    expect(res.alternativeDates).toBeUndefined();
    expect([...c.offeredSlots.keys()]).toEqual([
      'micro blading/ shading|2026-09-10',
    ]);
  });
  it('rechecks an offered alternative before booking and rejects a newly taken slot', async () => {
    vi.mocked(phorest.getAvailability).mockImplementation(async (_id, date) =>
      date === '2026-09-10' ? [] : [`${date}T12:00:00-04:00`]
    );
    const c = call();
    await query(c);
    vi.mocked(phorest.getAvailability).mockResolvedValue([
      '2026-09-11T13:00:00-04:00',
    ]);
    const write = vi.spyOn(phorest, 'createAppointment');
    const res = await c.handleBookAppointment({
      serviceName: full.name,
      date: '2026-09-11',
      time: '12:00',
      customer: { name: 'Test Caller' },
    });
    expect(res.error).toMatch(/just taken|open times/i);
    expect(write).not.toHaveBeenCalled();
  });
});
