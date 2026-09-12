import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { phorest } from '../services/phorest.js';

process.env.OPENAI_REALTIME_API_KEY ||= 'test-key';

let TwilioRealtimeCall: typeof import('../realtime/twilioStream.js').TwilioRealtimeCall;

beforeAll(async () => {
  ({ TwilioRealtimeCall } = await import('../realtime/twilioStream.js'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function buildCall() {
  const sent: Array<Record<string, any>> = [];
  const socket: any = {
    readyState: WebSocket.OPEN,
    send: (data: string) => sent.push(JSON.parse(data)),
    close: vi.fn(),
    on: vi.fn(),
  };
  const call: any = new TwilioRealtimeCall(socket);
  call.session = {
    appendTwilioAudio: vi.fn(),
    truncateActiveResponse: vi.fn(),
    injectContext: vi.fn(),
    requestResponse: vi.fn(() => true),
    getCurrentResponseId: vi.fn(() => null),
    close: vi.fn(),
  };
  call.streamSid = 'STREAMSID';
  call.sessionReady = true;
  call.started = true;
  if (call.preAuthTimer) {
    clearTimeout(call.preAuthTimer);
    call.preAuthTimer = undefined;
  }
  return { call, sent };
}

describe('GPT-Live Twilio control boundaries', () => {
  it('preserves the continuous Live stream on barge-in', () => {
    const { call, sent } = buildCall();
    call.voiceEngine = 'live';
    call.liveOutputActive = true;
    call.markQueue = ['live-1'];
    call.responseStartTimestamp = 1_000;
    call.latestMediaTimestamp = 1_300;

    call.handleBargeIn();

    expect(call.bargeInEpoch).toBe(1);
    expect(call.session.truncateActiveResponse).not.toHaveBeenCalled();
    expect(sent.some((event) => event.event === 'clear')).toBe(false);
    expect(call.markQueue).toEqual(['live-1']);
    expect(call.responseStartTimestamp).toBe(1_000);
  });

  it('keeps Realtime truncation and Twilio clear behavior unchanged', () => {
    const { call, sent } = buildCall();
    call.voiceEngine = 'realtime';
    call.markQueue = ['responsePart'];
    call.responseStartTimestamp = 1_000;
    call.latestMediaTimestamp = 1_300;

    call.handleBargeIn();

    expect(call.bargeInEpoch).toBe(1);
    expect(call.session.truncateActiveResponse).toHaveBeenCalledWith(300);
    expect(sent).toContainEqual({ event: 'clear', streamSid: 'STREAMSID' });
    expect(call.markQueue).toEqual([]);
    expect(call.responseStartTimestamp).toBeNull();
  });

  it('replaces a timed-out LOADING caller lookup with a clean miss', async () => {
    vi.useFakeTimers();
    let resolveLookup!: (value: null) => void;
    vi.spyOn(phorest, 'lookupCustomerByPhone').mockReturnValue(
      new Promise((resolve) => (resolveLookup = resolve))
    );
    const { call } = buildCall();
    call.voiceEngine = 'live';
    call.sessionReady = false;

    const initialLookup = call.prepareCallerContext('+14435551234');
    await vi.advanceTimersByTimeAsync(700);
    await initialLookup;
    expect(call.pendingCallerContext).toContain('caller_id_match: LOADING');

    resolveLookup(null);
    await Promise.resolve();
    await Promise.resolve();

    expect(call.pendingCallerContext).toContain('caller_id_match: NONE');
    expect(call.pendingCallerContext).not.toContain('LOADING');
  });

  it('does not treat Live silence frames as a post-end_call goodbye segment', async () => {
    vi.useFakeTimers();
    const { call } = buildCall();
    call.voiceEngine = 'live';
    call.outboundAudioEpoch = 4;
    call.liveOutputActive = false;

    let resolved: boolean | undefined;
    const waiting = call
      .waitForGoodbyeToStart(1_000, 4, null, 0)
      .then((value: boolean) => {
        resolved = value;
      });

    // Live forwards continuous PCMU, including silence. The controller only
    // advances its epoch from the adapter's acoustic speech-start callback.
    call.sendAudioToTwilio(Buffer.alloc(160, 0xff).toString('base64'));
    await vi.advanceTimersByTimeAsync(100);
    expect(call.outboundAudioEpoch).toBe(4);
    expect(resolved).toBeUndefined();

    call.liveOutputActive = true;
    call.outboundAudioEpoch += 1;
    call.sendAudioToTwilio(Buffer.alloc(160, 0).toString('base64'));
    await vi.advanceTimersByTimeAsync(50);
    await waiting;

    expect(resolved).toBe(true);
  });
});

describe('GPT-Live native end_call', () => {
  function stageCurrentFarewell(call: any, active: boolean) {
    call.voiceEngine = 'live';
    call.lastCallerSpeechStoppedAt = Date.now() - 4_000;
    call.liveLastOutputStartedAt = Date.now();
    call.liveOutputActive = active;
    call.markQueue = active ? [] : ['live-1'];
  }

  it('aborts when no current farewell segment exists', async () => {
    const { call } = buildCall();
    call.voiceEngine = 'live';
    call.lastCallerSpeechStoppedAt = Date.now();
    call.liveLastOutputStartedAt = Date.now() - 1_000;

    const result = await call.handleEndCall({ reason: 'done' });

    expect(result).toMatchObject({ aborted: true });
    expect(call.modelEndCallPending).toBe(false);
    expect(call.session.requestResponse).not.toHaveBeenCalled();
    expect(call.closed).toBe(false);
  });

  it('drains the current farewell and closes without requesting a second response', async () => {
    vi.useFakeTimers();
    const { call } = buildCall();
    stageCurrentFarewell(call, false);

    const result = await call.handleEndCall({ reason: 'done' });
    expect(result).toMatchObject({ ending: true });
    expect(call.session.requestResponse).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(0);
    expect(call.transferring).toBe(true);
    await call.handleMessage(
      Buffer.from(JSON.stringify({ event: 'mark', mark: { name: 'live-1' } }))
    );
    await vi.advanceTimersByTimeAsync(50);

    expect(call.closed).toBe(true);
    expect(call.session.requestResponse).not.toHaveBeenCalled();
    expect(call.session.close).toHaveBeenCalledTimes(1);
  });

  it('aborts when the caller starts a new turn during farewell drain', async () => {
    vi.useFakeTimers();
    const { call } = buildCall();
    stageCurrentFarewell(call, true);

    await call.handleEndCall({ reason: 'done' });
    await vi.advanceTimersByTimeAsync(0);
    call.handleCallerSpeechStarted();
    call.handleCallerSpeechStopped();
    call.liveOutputActive = false;
    call.markQueue = [];
    await vi.advanceTimersByTimeAsync(50);

    expect(call.closed).toBe(false);
    expect(call.transferring).toBe(false);
    expect(call.modelEndCallPending).toBe(false);
    expect(call.liveOutputCommittedClosed).toBe(false);
  });

  it('leaves the call open when Live playback does not drain by the cap', async () => {
    vi.useFakeTimers();
    const { call } = buildCall();
    stageCurrentFarewell(call, true);

    await call.handleEndCall({ reason: 'done' });
    await vi.advanceTimersByTimeAsync(6_050);

    expect(call.closed).toBe(false);
    expect(call.transferring).toBe(false);
    expect(call.modelEndCallPending).toBe(false);
    expect(call.liveOutputCommittedClosed).toBe(false);
    expect(call.session.close).not.toHaveBeenCalled();
  });
});
