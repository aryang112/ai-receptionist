import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import WebSocket from 'ws';
import { phorest } from '../services/phorest.js';

// 2026-09-14 (the Loretta call): Erica offered 5:30 PM for a real client's
// booked slot. Root cause was snapSlotsToGrid, which ceil-rounded Phorest's
// real free starts onto :00/:15/:30/:45 and then BOOKED the rounded value.
// Phorest anchors its availability grid to appointment ENDS, so the gaps
// between free starts are other people's appointments — rounding up walks
// straight into one. Threading is a 5-minute service, so a 5-minute shift is
// a whole appointment's width.
//
// These tests lock the contract: Erica may CHOOSE which real times to read
// out; she may never MOVE one.

process.env.OPENAI_REALTIME_API_KEY ||= 'test-key';

let TwilioRealtimeCall: typeof import('../realtime/twilioStream.js').TwilioRealtimeCall;
beforeAll(async () => {
  ({ TwilioRealtimeCall } = await import('../realtime/twilioStream.js'));
});
afterEach(() => vi.restoreAllMocks());

function buildCall() {
  const socket: any = {
    readyState: WebSocket.OPEN,
    send: () => {},
    close: () => {},
    on: () => {},
  };
  const call: any = new TwilioRealtimeCall(socket);
  call.session = {
    appendTwilioAudio: () => {},
    truncateActiveResponse: vi.fn(),
    close: vi.fn(),
  };
  call.streamSid = 'S';
  call.callSid = 'CA_test_slots';
  return call;
}

// A Wednesday with 12:00–19:00 hours per business.json.
const DATE = '2025-10-01';

// Verbatim shape of a real Phorest read for 2026-09-15 after the salon's
// "Booking slots" interval was set to 5 minutes. 17:30/17:35 are ABSENT
// because another client is in that slot; 18:00 is ABSENT because two
// appointments already sit there.
const REAL_STARTS = [
  '17:00', '17:10', '17:15', '17:20', '17:25',
  '17:40', '17:45', '17:50', '17:55',
  '18:05', '18:10', '18:15', '18:20', '18:25',
  '18:30', '18:35', '18:40', '18:45', '18:50', '18:55',
];
const OCCUPIED = ['17:30', '17:35', '18:00', '17:05'];

function mockAvailability() {
  vi.spyOn(phorest, 'getAvailability').mockResolvedValue(
    REAL_STARTS.map((hhmm) => `${DATE}T${hhmm}:00`)
  );
}

describe('offered times must be real Phorest starts', () => {
  it('never offers a time Phorest did not return (the Loretta regression)', async () => {
    mockAvailability();
    const call = buildCall();
    const result = await call.handleSuggestAvailability({
      serviceName: 'Lash Lift',
      date: DATE,
    });
    const offered = result.slots.map((s: any) => s.value);
    expect(offered.length).toBeGreaterThan(0);
    for (const value of offered) {
      expect(REAL_STARTS).toContain(value);
    }
    for (const taken of OCCUPIED) {
      expect(offered).not.toContain(taken);
    }
  });

  it('leads with quarter-hour times when the day has them', async () => {
    mockAvailability();
    const call = buildCall();
    const result = await call.handleSuggestAvailability({
      serviceName: 'Lash Lift',
      date: DATE,
    });
    const offered = result.slots.map((s: any) => s.value);
    for (const value of offered) {
      expect(Number(value.split(':')[1]) % 15).toBe(0);
    }
    // 17:30 and 18:00 are quarter hours but OCCUPIED — they must not appear.
    expect(offered).not.toContain('17:30');
    expect(offered).not.toContain('18:00');
  });

  it('falls back to real off-grid times when no quarter hour is free, and frames them as fitting the caller in', async () => {
    vi.spyOn(phorest, 'getAvailability').mockResolvedValue(
      ['17:05', '17:20', '17:35', '17:50'].map((t) => `${DATE}T${t}:00`)
    );
    const call = buildCall();
    const result = await call.handleSuggestAvailability({
      serviceName: 'Lash Lift',
      date: DATE,
    });
    const offered = result.slots.map((s: any) => s.value);
    expect(offered.length).toBeGreaterThan(0);
    for (const value of offered) {
      expect(['17:05', '17:20', '17:35', '17:50']).toContain(value);
    }
    expect(result.note).toMatch(/fit (them|the caller) in|squeeze/i);
  });

  it('honours an exact requested time even when it is off-grid', async () => {
    mockAvailability();
    const call = buildCall();
    const result = await call.handleSuggestAvailability({
      serviceName: 'Lash Lift',
      date: DATE,
      preferredTime: '18:10',
    });
    const offered = result.slots.map((s: any) => s.value);
    expect(offered).toContain('18:10');
  });
});
