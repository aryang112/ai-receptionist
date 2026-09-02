import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import WebSocket from 'ws';
import { parseToolArgs } from '../realtime/toolSchemas.js';

// The OpenAI session constructor throws without a key; some import paths reach it.
process.env.OPENAI_REALTIME_API_KEY ||= 'test-key';

let TwilioRealtimeCall: typeof import('../realtime/twilioStream.js').TwilioRealtimeCall;

beforeAll(async () => {
  ({ TwilioRealtimeCall } = await import('../realtime/twilioStream.js'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/**
 * Build a call wired to a fake socket, with the OpenAI session stubbed out —
 * same pattern as twilioStream.silenceWatchdog.test.ts / vacation.test.ts.
 * callSid is deliberately left unset (empty string) and no Twilio creds are
 * configured in the test env, so endCallNow() takes its synchronous
 * "no REST client" fallback branch — no real Twilio API call happens here.
 */
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
    truncateActiveResponse: () => {},
    injectContext: () => {},
    requestResponse: () => {},
    close: () => {},
  };
  call.streamSid = 'STREAMSID';
  call.sessionReady = true;
  call.started = true;
  if (call.preAuthTimer) {
    clearTimeout(call.preAuthTimer);
    call.preAuthTimer = undefined;
  }
  return call;
}

// S1: end_call gained an optional `reason` ('done' | 'spam') so Erica can tag
// a declined spam/telemarketing call for the S2 blocklist. Handler-level
// tests (above the zod seam — see lessons.md F1) drive handleEndCall(rawArgs)
// directly, the same way the CT-1 clientId regression was caught.
describe('S1 — handleEndCall reason handling', () => {
  it('(a) handleEndCall({reason: "spam"}) tags the call outcome "spam" and still hangs up', async () => {
    vi.useFakeTimers();
    const call = buildCall();
    const res = await call.handleEndCall({ reason: 'spam' });
    expect(res).toMatchObject({ ending: true });
    call.sendAudioToTwilio('AA==', 'goodbye-response');
    call.markQueue = [];
    await vi.advanceTimersByTimeAsync(1);
    expect(call.closed).toBe(true);
    expect(call.outcome).toBe('spam');
  });

  it('(b) handleEndCall({}) leaves the default outcome path unchanged ("completed")', async () => {
    vi.useFakeTimers();
    const call = buildCall();
    const res = await call.handleEndCall({});
    expect(res).toMatchObject({ ending: true });
    call.sendAudioToTwilio('AA==', 'goodbye-response');
    call.markQueue = [];
    await vi.advanceTimersByTimeAsync(1);
    expect(call.closed).toBe(true);
    expect(call.outcome).toBe('completed');
  });

  it('handleEndCall(undefined) (no args at all) also falls through to the normal default path', async () => {
    vi.useFakeTimers();
    const call = buildCall();
    const res = await call.handleEndCall(undefined);
    expect(res).toMatchObject({ ending: true });
    call.sendAudioToTwilio('AA==', 'goodbye-response');
    call.markQueue = [];
    await vi.advanceTimersByTimeAsync(1);
    expect(call.outcome).toBe('completed');
  });

  it('an invalid/garbage reason never blocks the hangup — argless-by-design invariant preserved', async () => {
    vi.useFakeTimers();
    const call = buildCall();
    const res = await call.handleEndCall({ reason: 'not-a-real-reason' });
    expect(res).toMatchObject({ ending: true });
    call.sendAudioToTwilio('AA==', 'goodbye-response');
    call.markQueue = [];
    await vi.advanceTimersByTimeAsync(1);
    expect(call.closed).toBe(true);
    // Falls through as a normal hangup, exactly like handleEndCall({}).
    expect(call.outcome).toBe('completed');
  });
});

// (c) proves TOOL_DEFINITIONS and the zod TOOL_SCHEMAS stay mirror-images —
// a one-sided add would get silently stripped by zod's default strip mode
// (this is exactly the F1 regression class).
describe('S1 — zod TOOL_SCHEMAS mirrors end_call.reason (no silent strip)', () => {
  it('parseToolArgs keeps `reason` for a valid value', () => {
    const result = parseToolArgs('end_call', { reason: 'spam' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as { reason?: string }).reason).toBe('spam');
    }
  });

  it('parseToolArgs keeps the default (`reason` absent) shape working, argless call still valid', () => {
    const result = parseToolArgs('end_call', {});
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as { reason?: string }).reason).toBeUndefined();
    }
  });

  it('rejects a reason value outside the enum (proves this is a real enum, not a passthrough string)', () => {
    const result = parseToolArgs('end_call', { reason: 'nonsense' });
    expect(result.success).toBe(false);
  });
});
