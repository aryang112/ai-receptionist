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

// The OpenAI session constructor throws without a key; some import paths reach it.
process.env.OPENAI_REALTIME_API_KEY ||= 'test-key';

let TwilioRealtimeCall: typeof import('../realtime/twilioStream.js').TwilioRealtimeCall;

beforeAll(async () => {
  ({ TwilioRealtimeCall } = await import('../realtime/twilioStream.js'));
});

/**
 * Build a call wired to a fake socket, with the OpenAI session stubbed out —
 * same pattern as twilioStream.silenceWatchdog.test.ts /
 * twilioStream.durationCap.test.ts. callSid is deliberately left unset (empty
 * string) so the NORMAL (non-vacation) transfer path hits its existing
 * "missing Twilio client or callSid" guard instead of placing a real Twilio
 * REST call — no network call happens in any of these tests.
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
    truncateActiveResponse: vi.fn(),
    injectContext: vi.fn(),
    requestResponse: vi.fn(),
    close: vi.fn(),
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

// business.json away closure: 2026-09-01 to 2026-09-09, reopens 2026-09-10.
describe('V1 — live transfer during away closure', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('away closure active: does not dial or synthesize a message from transfer intent', async () => {
    vi.setSystemTime(new Date('2026-09-05T16:00:00-04:00')); // inside 09-01..09-09

    const call = buildCall();
    const notifyOwnerSms = vi
      .fn()
      .mockResolvedValue({ queued: true, sid: 'SM_away' });
    call.notifyOwnerSms = notifyOwnerSms;
    const waitForPlaybackToDrain = vi.fn().mockResolvedValue(undefined);
    call.waitForPlaybackToDrain = waitForPlaybackToDrain;

    const result = await call.handleTransferToOwner({
      reason: 'wants a haircut consult',
    });

    expect(result).toEqual({
      transferred: false,
      messageRequired: true,
      note: expect.stringContaining('September 10'),
    });
    expect(result.note).toMatch(/leave_message_for_owner/);
    expect(notifyOwnerSms).not.toHaveBeenCalled();
    // No dial attempted: the drain-before-dial helper (only used by the real
    // dial path) never ran, and `transferring` (only set by the real dial
    // path) stays false — this call never touched calls().update().
    expect(waitForPlaybackToDrain).not.toHaveBeenCalled();
    expect(call.transferring).toBe(false);
    expect(call.outcome).toBe('none');
  });

  it('does not text even when caller identity is known until a real message uses the separate tool', async () => {
    vi.setSystemTime(new Date('2026-09-05T16:00:00-04:00'));

    const call = buildCall();
    call.clientNames.set('client-123', 'Priya');
    call.prefetch = {
      clientId: 'client-123',
      firstName: 'Priya',
      lastName: 'Sharma',
      appointments: null,
    };
    const notifyOwnerSms = vi
      .fn()
      .mockResolvedValue({ queued: true, sid: 'SM_known' });
    call.notifyOwnerSms = notifyOwnerSms;

    const result = await call.handleTransferToOwner({
      reason: 'question about a service',
    });

    expect(result).toMatchObject({
      transferred: false,
      messageRequired: true,
    });
    expect(notifyOwnerSms).not.toHaveBeenCalled();
  });

  it('never invokes the notification provider from the live-transfer tool', async () => {
    vi.setSystemTime(new Date('2026-09-05T16:00:00-04:00'));
    const call = buildCall();
    call.notifyOwnerSms = vi
      .fn()
      .mockResolvedValue({ queued: false, reason: 'failed' });

    const result = await call.handleTransferToOwner({
      reason: 'please ask Richa to call me',
    });

    expect(result).toMatchObject({
      transferred: false,
      messageRequired: true,
    });
    expect(call.notifyOwnerSms).not.toHaveBeenCalled();
    expect(result.note).not.toMatch(/passed it along/i);
  });

  it('vacation UPCOMING (starts in 10 days, not active yet): falls through to the normal transfer path', async () => {
    // 2026-08-22 is 10 days before the 09-01 vacation start.
    vi.setSystemTime(new Date('2026-08-22T13:00:00-04:00'));

    const call = buildCall();
    const notifyOwnerSms = vi
      .fn()
      .mockResolvedValue({ queued: true, sid: 'SM_upcoming' });
    call.notifyOwnerSms = notifyOwnerSms;

    // callSid is unset, so the NORMAL path's own guard fires — proving we
    // reached the normal code path, not the vacation short-circuit.
    const result = await call.handleTransferToOwner({ reason: 'wants Richa' });
    expect(result).toEqual({ error: 'Transfer unavailable' });
    expect(notifyOwnerSms).not.toHaveBeenCalled();
  });

  it('no vacation active or upcoming: falls through to the normal transfer path', async () => {
    vi.setSystemTime(new Date('2026-10-01T13:00:00-04:00')); // well after the vacation

    const call = buildCall();
    const notifyOwnerSms = vi
      .fn()
      .mockResolvedValue({ queued: true, sid: 'SM_later' });
    call.notifyOwnerSms = notifyOwnerSms;

    const result = await call.handleTransferToOwner({ reason: 'wants Richa' });
    expect(result).toEqual({ error: 'Transfer unavailable' });
    expect(notifyOwnerSms).not.toHaveBeenCalled();
  });
});
