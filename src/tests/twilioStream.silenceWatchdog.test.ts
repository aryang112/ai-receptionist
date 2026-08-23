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
 * same pattern as twilioStream.bargein.test.ts. Deliberately leaves callSid
 * unset (empty string) so endCallNow() takes its "no REST client" fallback
 * branch (a real Twilio client would exist from .env, but `!this.callSid` is
 * checked first) — no real Twilio API call happens in these tests.
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
  const requestResponse = vi.fn(() => true); // new contract: reports whether response.create fired
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

describe('G2 — silence watchdog', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('(a) checks in exactly once after SILENCE_CHECKIN_MS of mutual silence', () => {
    const { call, injectContext, requestResponse } = buildCall();
    call.startSilenceWatchdog();

    // Just under the threshold — no check-in yet.
    vi.advanceTimersByTime(env.SILENCE_CHECKIN_MS - 1000);
    expect(injectContext).not.toHaveBeenCalled();
    expect(requestResponse).not.toHaveBeenCalled();

    // Crossing the threshold fires the check-in.
    vi.advanceTimersByTime(2000);
    expect(injectContext).toHaveBeenCalledTimes(1);
    expect(requestResponse).toHaveBeenCalledTimes(1);
    expect(call.checkInFired).toBe(true);
  });

  it('(b) says a goodbye once SILENCE_HANGUP_MS after the check-in elapses, THEN hangs up ~4s later', () => {
    const { call, injectContext, requestResponse } = buildCall();
    call.startSilenceWatchdog();

    // Reach the check-in (1st injectContext/requestResponse pair).
    vi.advanceTimersByTime(env.SILENCE_CHECKIN_MS); // t=20000
    expect(injectContext).toHaveBeenCalledTimes(1);
    expect(call.closed).toBeFalsy();

    // Just under the post-check-in hangup threshold — no goodbye requested yet.
    vi.advanceTimersByTime(env.SILENCE_HANGUP_MS - 1000); // t=34000
    expect(injectContext).toHaveBeenCalledTimes(1);
    expect(call.closed).toBeFalsy();

    // Crossing it requests a warm goodbye (2nd injectContext/requestResponse
    // pair — conversation.item.create + response.create at the session
    // boundary) — the call is NOT torn down yet, it's in the grace window.
    vi.advanceTimersByTime(2000); // t=36000 (tick at 35000 fires within this)
    expect(injectContext).toHaveBeenCalledTimes(2);
    expect(requestResponse).toHaveBeenCalledTimes(2);
    expect(injectContext.mock.calls[1]?.[0]).toMatch(/goodbye/i);
    expect(call.closed).toBeFalsy();
    expect(call.silenceHangupInitiated).toBe(true);

    // Still within the ~4s grace window (goodbye requested at t=35000,
    // deadline t=39000) — still alive.
    vi.advanceTimersByTime(2000); // t=38000
    expect(call.closed).toBeFalsy();

    // Grace window elapses with no caller response — NOW it hangs up through
    // the shared endCallNow() path (its own markQueue drain + bargeInEpoch
    // check cover any goodbye audio still playing / a barge-in during it).
    vi.advanceTimersByTime(1500); // t=39500, past the 39000 deadline
    expect(call.closed).toBe(true);
    expect(call.outcome).toBe('completed');
    // The hangup itself doesn't inject any further speech.
    expect(injectContext).toHaveBeenCalledTimes(2);
  });

  it('caller speech during the post-goodbye grace window aborts the hangup — call continues', () => {
    const { call, injectContext, requestResponse } = buildCall();
    call.startSilenceWatchdog();

    // Reach the check-in, then the goodbye trigger.
    vi.advanceTimersByTime(env.SILENCE_CHECKIN_MS); // t=20000, check-in
    vi.advanceTimersByTime(env.SILENCE_HANGUP_MS); // t=35000, goodbye requested
    expect(injectContext).toHaveBeenCalledTimes(2);
    expect(call.silenceHangupInitiated).toBe(true);

    // Caller speaks partway through the ~4s grace window (e.g. the goodbye
    // audio was still generating/playing when they said something).
    vi.advanceTimersByTime(500); // t=35500
    call.handleCallerSpeechStarted();

    // Advance well past the original grace deadline (t=39000) — the timeout
    // callback sees lastActivityAt > goodbyeRequestedAt and aborts instead of
    // hanging up.
    vi.advanceTimersByTime(4500); // t=40000
    expect(call.closed).toBeFalsy();
    expect(call.silenceHangupInitiated).toBe(false);
    // No further goodbye/check-in speech was requested by the abort itself.
    expect(injectContext).toHaveBeenCalledTimes(2);
    expect(requestResponse).toHaveBeenCalledTimes(2);
    // The one-time "are you still there?" check-in stays used up regardless.
    expect(call.checkInFired).toBe(true);
  });

  it('(c) caller speech resets the clock — no check-in fires while activity continues', () => {
    const { call, injectContext, requestResponse } = buildCall();
    call.startSilenceWatchdog();

    // Get most of the way to the check-in threshold...
    vi.advanceTimersByTime(env.SILENCE_CHECKIN_MS - 1000);
    expect(injectContext).not.toHaveBeenCalled();

    // ...then the caller speaks. This is the real onSpeechStarted wiring
    // (stamps lastActivityAt, then runs the unmodified handleBargeIn()).
    call.handleCallerSpeechStarted();

    // The original 20s window would have elapsed by now, but the clock was
    // reset by the caller's speech — still no check-in.
    vi.advanceTimersByTime(1500);
    expect(injectContext).not.toHaveBeenCalled();
    expect(requestResponse).not.toHaveBeenCalled();

    // A full fresh window after the reset does still fire it.
    vi.advanceTimersByTime(env.SILENCE_CHECKIN_MS);
    expect(injectContext).toHaveBeenCalledTimes(1);
  });

  it('(d) the "are you still there?" check-in fires at most once per call', () => {
    const { call, injectContext, requestResponse } = buildCall();
    call.startSilenceWatchdog();

    // First silence window — check-in fires.
    vi.advanceTimersByTime(env.SILENCE_CHECKIN_MS);
    expect(injectContext).toHaveBeenCalledTimes(1);
    expect(requestResponse).toHaveBeenCalledTimes(1);

    // Caller responds ("yeah, I'm here") — breaks the silence, call continues.
    call.handleCallerSpeechStarted();
    expect(call.closed).toBeFalsy();

    // More silence passes, but stays under the post-check-in hangup
    // threshold (15s) — scoped deliberately so this test only exercises the
    // checkInFired latch, not the separate goodbye-then-hangup flow (covered
    // above). checkInFired is a permanent latch, so Erica must NOT ask "are
    // you still there?" a second time even as this silence accumulates.
    vi.advanceTimersByTime(env.SILENCE_HANGUP_MS - 1000);
    expect(injectContext).toHaveBeenCalledTimes(1);
    expect(requestResponse).toHaveBeenCalledTimes(1);
    expect(call.closed).toBeFalsy();
  });

  it('never fires while a tool call is in flight, even past both thresholds', () => {
    const { call, injectContext } = buildCall();
    call.startSilenceWatchdog();
    call.toolCallsInFlight = 1;

    vi.advanceTimersByTime(
      env.SILENCE_CHECKIN_MS + env.SILENCE_HANGUP_MS + 5000
    );
    expect(injectContext).not.toHaveBeenCalled();
    expect(call.closed).toBeFalsy();

    // Once the tool call resolves, the (already-elapsed) silence is caught on
    // the next tick.
    call.toolCallsInFlight = 0;
    vi.advanceTimersByTime(5000);
    expect(injectContext).toHaveBeenCalledTimes(1);
  });

  it('never fires while Erica is still speaking (markQueue non-empty)', () => {
    const { call, injectContext } = buildCall();
    call.startSilenceWatchdog();

    // Simulate Erica mid-response for well past the check-in threshold.
    call.markQueue = ['responsePart'];
    vi.advanceTimersByTime(env.SILENCE_CHECKIN_MS + 5000);
    expect(injectContext).not.toHaveBeenCalled();

    // She finishes; NOW the clock starts counting from here.
    call.markQueue = [];
    vi.advanceTimersByTime(env.SILENCE_CHECKIN_MS - 1000);
    expect(injectContext).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2000);
    expect(injectContext).toHaveBeenCalledTimes(1);
  });

  it('is inert before sessionReady (never fires pre-greeting)', () => {
    const { call, injectContext } = buildCall();
    call.sessionReady = false;
    call.startSilenceWatchdog();

    vi.advanceTimersByTime(
      env.SILENCE_CHECKIN_MS + env.SILENCE_HANGUP_MS + 5000
    );
    expect(injectContext).not.toHaveBeenCalled();
    expect(call.closed).toBeFalsy();
  });
});

describe('G2 — endCallNow is the single hangup path for end_call', () => {
  it('handleEndCall (normal goodbye) still returns { ended: true } via endCallNow', async () => {
    const { call } = buildCall();
    const res = await call.handleEndCall({});
    expect(res).toEqual({ ended: true });
    expect(call.closed).toBe(true);
  });
});
