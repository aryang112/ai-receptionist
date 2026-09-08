import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import WebSocket from 'ws';
import { phorest } from '../services/phorest.js';

// Call-level simulation of the 2026-09-07 1:03 PM production call: the caller
// asks for "Eyebrow threading" (the live catalog's service is "Brow Threading")
// and Erica's suggest_availability tool must return TIMES — not notOffered
// with "Brow Threading" as a suggestion, which is what made her ask "do you
// mean Brow Threading?" three times.

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
    injectContext: vi.fn(),
    requestResponse: vi.fn(() => true),
    close: vi.fn(),
  };
  call.streamSid = 'S';
  return call;
}

const OPEN_TUESDAY = '2026-09-15'; // Tue 12–7 PM, after the September closure

describe('suggest_availability — caller phrasing vs catalog naming', () => {
  it.each([
    'Eyebrow threading',
    'eyebrows threading',
    'threading for my eyebrows',
  ])(
    '"%s" returns open times for Brow Threading (no notOffered/ambiguous round-trip)',
    async (serviceName) => {
      vi.spyOn(phorest, 'listServices').mockResolvedValue([
        { id: 'live_brow', name: 'Brow Threading', price: 15, durationMin: 15 },
      ]);
      const availability = vi
        .spyOn(phorest, 'getAvailability')
        .mockResolvedValue([
          `${OPEN_TUESDAY}T13:00:00`,
          `${OPEN_TUESDAY}T13:15:00`,
          `${OPEN_TUESDAY}T13:30:00`,
        ]);
      const call = buildCall();
      const res = await call.handleSuggestAvailability({
        serviceName,
        date: OPEN_TUESDAY,
      });
      expect(res.notOffered).toBeUndefined();
      expect(res.ambiguous).toBeUndefined();
      expect(res.slots?.length).toBeGreaterThan(0);
      expect(availability.mock.calls.every(([id]) => id === 'live_brow')).toBe(
        true
      );
    }
  );

  it('a genuinely unknown service still comes back notOffered with real alternatives', async () => {
    const call = buildCall();
    const res = await call.handleSuggestAvailability({
      serviceName: 'henna brows',
      date: OPEN_TUESDAY,
    });
    expect(res.notOffered).toBe(true);
    expect(Array.isArray(res.closest)).toBe(true);
  });
});
