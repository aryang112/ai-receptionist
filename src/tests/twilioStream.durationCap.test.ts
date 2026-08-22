import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import WebSocket from 'ws';
import { env } from '../config/env.js';

// The OpenAI session constructor throws without a key; some import paths reach it.
process.env.OPENAI_REALTIME_API_KEY ||= 'test-key';

let TwilioRealtimeCall: typeof import('../realtime/twilioStream.js').TwilioRealtimeCall;

beforeAll(async () => {
  ({ TwilioRealtimeCall } = await import('../realtime/twilioStream.js'));
});

/**
 * Build a call wired to a fake socket, with the OpenAI session stubbed out —
 * same pattern as twilioStream.silenceWatchdog.test.ts. Deliberately leaves
 * callSid unset (empty string) so endCallNow() takes its "no REST client"
 * fallback branch (a real Twilio client would exist from .env, but
 * `!this.callSid` is checked first) — no real Twilio API call happens here.
 */
function buildCall() {
  const socket: any = {
    readyState: WebSocket.OPEN,
    send: () => {},
    close: () => {},
    on: () => {},
  };
  const call: any = new TwilioRealtimeCall(socket);
  const injectContext = vi.fn();
  const requestResponse = vi.fn();
  call.session = {
    appendTwilioAudio: () => {},
    truncateActiveResponse: vi.fn(),
    injectContext,
    requestResponse,
    close: vi.fn(),
  };
  call.streamSid = 'STREAMSID';
  call.sessionReady = true;
  // Mark authenticated (as the real Twilio "start" event handler would) so
  // the F7 pre-auth timer (10s) doesn't force-close the call out from under
  // these tests, which deliberately advance fake time well past 10s.
  call.started = true;
  if (call.preAuthTimer) {
    clearTimeout(call.preAuthTimer);
    call.preAuthTimer = undefined;
  }
  return { call, injectContext, requestResponse };
}

describe('G3 — max call duration cap', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const capMs = () => env.MAX_CALL_MINUTES * 60 * 1000;
  const warningMs = () => capMs() - 60000;

  it('(1) injects a background warning at cap - 60s, without requesting a response', () => {
    const { call, injectContext, requestResponse } = buildCall();
    call.startDurationCap();

    // Just under the warning threshold — nothing yet.
    vi.advanceTimersByTime(warningMs() - 1000);
    expect(injectContext).not.toHaveBeenCalled();

    // Crossing it fires the warning — context only, no response.create. This
    // must never interrupt a turn already in progress.
    vi.advanceTimersByTime(2000);
    expect(injectContext).toHaveBeenCalledTimes(1);
    expect(injectContext.mock.calls[0]?.[0]).toMatch(/time limit/i);
    expect(requestResponse).not.toHaveBeenCalled();
    expect(call.closed).toBeFalsy();
  });

  it('(2) says one goodbye at the cap, then hangs up after the grace window', () => {
    const { call, injectContext, requestResponse } = buildCall();
    call.startDurationCap();

    // Advancing the full cap crosses both the warning and the cap itself.
    vi.advanceTimersByTime(capMs());
    expect(injectContext).toHaveBeenCalledTimes(2); // warning, then goodbye
    expect(injectContext.mock.calls[1]?.[0]).toMatch(/goodbye/i);
    // Only the goodbye creates a response — the warning does not.
    expect(requestResponse).toHaveBeenCalledTimes(1);
    expect(call.closed).toBeFalsy(); // still in the post-goodbye grace window

    // Still within the ~4s grace window — not hung up yet.
    vi.advanceTimersByTime(3500);
    expect(call.closed).toBeFalsy();

    // Grace window elapses — NOW it hangs up through the shared endCallNow().
    vi.advanceTimersByTime(1000);
    expect(call.closed).toBe(true);
    expect(call.outcome).toBe('completed');
    // The hangup itself doesn't inject any further speech.
    expect(injectContext).toHaveBeenCalledTimes(2);
  });

  it('(3) an in-flight tool call at the cap defers the goodbye until it resolves', () => {
    const { call, injectContext, requestResponse } = buildCall();
    call.startDurationCap();
    call.toolCallsInFlight = 1;

    // The cap fires, but a tool is mid-flight — goodbye must wait. Only the
    // earlier warning has spoken so far.
    vi.advanceTimersByTime(capMs());
    expect(injectContext).toHaveBeenCalledTimes(1);
    expect(requestResponse).not.toHaveBeenCalled();
    expect(call.closed).toBeFalsy();

    // Tool still running a few seconds later — still deferred, well inside
    // the 15s ceiling.
    vi.advanceTimersByTime(5000);
    expect(injectContext).toHaveBeenCalledTimes(1);
    expect(call.closed).toBeFalsy();

    // Tool resolves — the next 500ms poll tick catches it and proceeds.
    call.toolCallsInFlight = 0;
    vi.advanceTimersByTime(500);
    expect(injectContext).toHaveBeenCalledTimes(2);
    expect(injectContext.mock.calls[1]?.[0]).toMatch(/goodbye/i);
    expect(requestResponse).toHaveBeenCalledTimes(1);
    expect(call.closed).toBeFalsy(); // now in the post-goodbye grace window

    vi.advanceTimersByTime(4000);
    expect(call.closed).toBe(true);
  });

  it('a tool call still in flight at the 15s ceiling no longer blocks the goodbye', () => {
    const { call, injectContext } = buildCall();
    call.startDurationCap();
    call.toolCallsInFlight = 1; // never resolves in this test

    vi.advanceTimersByTime(capMs());
    expect(injectContext).toHaveBeenCalledTimes(1); // warning only so far

    // Past the 15s ceiling — proceeds with the goodbye regardless.
    vi.advanceTimersByTime(15500);
    expect(injectContext).toHaveBeenCalledTimes(2);
    expect(injectContext.mock.calls[1]?.[0]).toMatch(/goodbye/i);
  });

  it('(4) a real outcome survives the cap hangup — not overwritten to "completed"', () => {
    const { call } = buildCall();
    call.startDurationCap();
    call.outcome = 'booked';

    vi.advanceTimersByTime(capMs());
    vi.advanceTimersByTime(4000); // past the post-goodbye grace window

    expect(call.closed).toBe(true);
    expect(call.outcome).toBe('booked');
  });
});
