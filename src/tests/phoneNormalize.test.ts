import { describe, it, expect, beforeAll } from 'vitest';
import WebSocket from 'ws';

// Leading-zero hardening (2026-08-27): Aryan saw "00"-prefixed numbers on
// UI-created clients. NANP numbers never start with 0, so zeros are always
// junk — strip them (and a country 1) down to the bare 10 digits we store
// and match on.

process.env.OPENAI_REALTIME_API_KEY ||= 'test-key';

let TwilioRealtimeCall: typeof import('../realtime/twilioStream.js').TwilioRealtimeCall;
beforeAll(async () => {
  ({ TwilioRealtimeCall } = await import('../realtime/twilioStream.js'));
});

function buildCall(): any {
  const socket: any = {
    readyState: WebSocket.OPEN,
    send: () => {},
    close: () => {},
    on: () => {},
  };
  const call: any = new TwilioRealtimeCall(socket);
  if (call.preAuthTimer) {
    clearTimeout(call.preAuthTimer);
    call.preAuthTimer = undefined;
  }
  return call;
}

describe('normalizePhone — leading zeros and country 1 stripped to bare 10', () => {
  const cases: Array<[string, string | undefined]> = [
    ['004432535169', '4432535169'],
    ['0014432535169', '4432535169'],
    ['+14432535169', '4432535169'],
    ['14432535169', '4432535169'],
    ['4432535169', '4432535169'],
    ['(443) 253-5169', '4432535169'],
    ['0443253516', undefined], // 9 digits after the junk zero — unusable
    ['', undefined],
  ];
  it.each(cases)('%s → %s', (input, expected) => {
    const call = buildCall();
    expect(call.normalizePhone(input)).toBe(expected);
    call.cleanup?.();
  });
});
