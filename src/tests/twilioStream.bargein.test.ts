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
 * Minimal fake Twilio socket: reports OPEN and records every JSON frame the call
 * sends back to Twilio (media/mark/clear). No real network.
 */
function makeFakeSocket() {
  const sent: any[] = [];
  const socket: any = {
    readyState: WebSocket.OPEN,
    send: (data: string) => sent.push(JSON.parse(data)),
    close: () => {},
    on: () => {},
  };
  return { socket, sent };
}

/**
 * Build a call wired to a fake socket, with the OpenAI session stubbed out so we
 * exercise ONLY the Twilio-side orchestration (buffering, mark bookkeeping,
 * barge-in arming). appendTwilioAudio records the frames actually forwarded.
 */
function buildCall() {
  const { socket, sent } = makeFakeSocket();
  const call: any = new TwilioRealtimeCall(socket);
  const appended: string[] = [];
  call.session = {
    appendTwilioAudio: (p: string) => appended.push(p),
    truncateActiveResponse: vi.fn(),
    close: vi.fn(),
  };
  call.streamSid = 'STREAMSID';
  // The constructor arms a ~5s pre-auth close timer; under fake timers a long
  // advance would fire it and close the fake socket mid-test (same clearing
  // the transferFailback tests do).
  if (call.preAuthTimer) {
    clearTimeout(call.preAuthTimer);
    call.preAuthTimer = undefined;
  }
  return { call, sent, appended };
}

function mediaEvent(payload: string, timestamp?: number) {
  return {
    event: 'media',
    media: { payload, ...(timestamp !== undefined ? { timestamp } : {}) },
  };
}

describe('RT-8 — early caller audio is buffered during the OpenAI handshake', () => {
  it('buffers pre-ready media and flushes it in order once the session is ready', () => {
    const { call, appended } = buildCall();
    // Session not ready yet — frames should be buffered, not dropped nor forwarded.
    call.handleMedia(mediaEvent('AAAA'));
    call.handleMedia(mediaEvent('BBBB'));
    expect(appended).toHaveLength(0);
    expect(call.pendingMedia).toEqual(['AAAA', 'BBBB']);

    // Session becomes ready and flushes — order preserved.
    call.sessionReady = true;
    call.flushPendingMedia();
    expect(appended).toEqual(['AAAA', 'BBBB']);
    expect(call.pendingMedia).toHaveLength(0);

    // Subsequent frames now pass straight through.
    call.handleMedia(mediaEvent('CCCC'));
    expect(appended).toEqual(['AAAA', 'BBBB', 'CCCC']);
  });

  it('caps the pre-ready buffer, and flushes only the ~300ms TAIL (2026-08-22 live fix)', () => {
    const { call, appended } = buildCall();
    for (let i = 0; i < 400; i++) call.handleMedia(mediaEvent(`f${i}`));
    // Memory bound unchanged: capped at PENDING_MEDIA_CAP (250) in the buffer.
    expect(call.pendingMedia).toHaveLength(250);
    call.sessionReady = true;
    call.flushPendingMedia();
    // Live fix: replaying the WHOLE handshake buffer fed stale ambient noise
    // to server VAD as a burst — phantom caller "turns" right after the
    // greeting on real calls. Only the last 15 frames (~300ms) are flushed,
    // preserving continuity for a caller actively mid-word at flush time.
    expect(appended).toHaveLength(15);
    expect(appended[0]).toBe('f235'); // the NEWEST tail, not the stale head
    expect(appended[14]).toBe('f249');
    expect(call.pendingMedia).toHaveLength(0);
  });
});

describe('RT-4 — barge-in stays armed through the whole audio tail', () => {
  it('does NOT disarm on response.done — only when Twilio finishes playing (mark queue drains)', () => {
    const { call } = buildCall();
    call.sessionReady = true;
    // Caller media clock advances (Twilio timestamps).
    call.latestMediaTimestamp = 1000;
    // Erica speaks two chunks — first chunk arms responseStartTimestamp, both push marks.
    call.sendAudioToTwilio('mu1');
    call.sendAudioToTwilio('mu2');
    expect(call.responseStartTimestamp).toBe(1000);
    expect(call.markQueue).toHaveLength(2);

    // OpenAI signals the response is done — but Twilio is still playing the tail.
    // RT-4: this must NOT reset the barge-in reference.
    call.handleResponseComplete();
    expect(call.responseStartTimestamp).toBe(1000);
    expect(call.markQueue).toHaveLength(2);
  });

  it('nulls responseStartTimestamp only once the mark queue drains to empty', async () => {
    const { call } = buildCall();
    call.sessionReady = true;
    call.latestMediaTimestamp = 500;
    call.sendAudioToTwilio('mu1');
    call.sendAudioToTwilio('mu2');
    call.handleResponseComplete();

    // First mark ack — one chunk still unplayed, so stay armed.
    await call.handleMessage(Buffer.from(JSON.stringify({ event: 'mark' })));
    expect(call.markQueue).toHaveLength(1);
    expect(call.responseStartTimestamp).toBe(500);

    // Final mark ack drains the queue — NOW barge-in disarms for the next turn.
    await call.handleMessage(Buffer.from(JSON.stringify({ event: 'mark' })));
    expect(call.markQueue).toHaveLength(0);
    expect(call.responseStartTimestamp).toBeNull();
  });

  it('interrupting DURING the tail (after response.done, before drain) truncates and clears', () => {
    const { call, sent } = buildCall();
    call.sessionReady = true;
    call.latestMediaTimestamp = 200;
    call.sendAudioToTwilio('mu1');
    call.sendAudioToTwilio('mu2');
    call.handleResponseComplete(); // tail still playing

    // Caller barges in mid-tail — the elapsed truncation point uses the live clock.
    call.latestMediaTimestamp = 640;
    call.handleBargeIn();
    expect(call.session.truncateActiveResponse).toHaveBeenCalledWith(440);
    // A Twilio `clear` was sent to flush the buffered tail audio.
    expect(sent.some((f) => f.event === 'clear')).toBe(true);
    // And state is reset so the next response re-arms cleanly.
    expect(call.markQueue).toHaveLength(0);
    expect(call.responseStartTimestamp).toBeNull();
  });
});

// 2026-08-24 (post-deploy test calls) + 2026-08-26 (rework local testing):
// the greeting plays to COMPLETION — owner decision. The old fixed 3s window
// still let a "hello" at second 4 chop the tail. Now speech_started must not
// truncate until the greeting's audio has fully played out (first mark-queue
// drain after the call's first audio chunk), with a hard 20s ceiling as a
// failsafe so a lost mark ack can never disarm barge-in for the whole call
// (the D-RT4 class). Caller-turn tracking stays live throughout.
describe('greeting plays to completion (barge-in suppressed until played out)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-24T20:00:00-04:00'));
  });
  afterEach(() => vi.useRealTimers());

  it('speech_started early in the greeting does NOT truncate or clear', () => {
    const { call, sent } = buildCall();
    call.sessionReady = true;
    call.latestMediaTimestamp = 100;
    call.sendAudioToTwilio('greet1'); // stamps firstAudioChunkAt
    call.sendAudioToTwilio('greet2');

    vi.advanceTimersByTime(1300); // Aryan's calls: trigger at ~1.3s
    call.handleCallerSpeechStarted();

    expect(call.session.truncateActiveResponse).not.toHaveBeenCalled();
    expect(sent.some((f) => f.event === 'clear')).toBe(false);
    // The caller turn is still tracked — watchdog semantics unaffected.
    expect(call.callerSpeaking).toBe(true);
    // Barge-in stays armed for the rest of the greeting playback.
    expect(call.responseStartTimestamp).toBe(100);
    expect(call.markQueue.length).toBeGreaterThan(0);
  });

  it('a "hello" LATE in the greeting (past the old 3s window) still does NOT truncate', () => {
    const { call, sent } = buildCall();
    call.sessionReady = true;
    call.latestMediaTimestamp = 100;
    call.sendAudioToTwilio('greet1');
    call.sendAudioToTwilio('greet2');

    vi.advanceTimersByTime(4500); // the exact live failure: "hello" at ~4.5s
    call.handleCallerSpeechStarted();

    expect(call.session.truncateActiveResponse).not.toHaveBeenCalled();
    expect(sent.some((f) => f.event === 'clear')).toBe(false);
  });

  it('after the greeting has PLAYED OUT (mark queue drained), speech truncates normally', async () => {
    const { call, sent } = buildCall();
    call.sessionReady = true;
    call.latestMediaTimestamp = 100;
    call.sendAudioToTwilio('greet1');
    call.sendAudioToTwilio('greet2');

    // Twilio acks both chunks — greeting playback finished.
    await call.handleMessage(Buffer.from(JSON.stringify({ event: 'mark' })));
    await call.handleMessage(Buffer.from(JSON.stringify({ event: 'mark' })));
    expect(call.greetingPlayedOut).toBe(true);

    // Erica speaks again (a normal turn); caller barge-in must work.
    call.sendAudioToTwilio('turn2');
    vi.advanceTimersByTime(500);
    call.latestMediaTimestamp = 600;
    call.handleCallerSpeechStarted();

    expect(call.session.truncateActiveResponse).toHaveBeenCalled();
    expect(sent.some((f) => f.event === 'clear')).toBe(true);
  });

  it('failsafe ceiling: if mark acks never drain, suppression ends at 20s', () => {
    const { call, sent } = buildCall();
    call.sessionReady = true;
    call.latestMediaTimestamp = 100;
    call.sendAudioToTwilio('greet1'); // never acked — queue never drains

    vi.advanceTimersByTime(20001);
    call.latestMediaTimestamp = 600;
    call.handleCallerSpeechStarted();

    expect(call.session.truncateActiveResponse).toHaveBeenCalledWith(500);
    expect(sent.some((f) => f.event === 'clear')).toBe(true);
  });

  it('no suppression before Erica has ever spoken (firstAudioChunkAt null)', () => {
    const { call } = buildCall();
    call.sessionReady = true;
    // No sendAudioToTwilio yet — handleBargeIn's own no-op guards apply, but
    // the guard itself must not throw or block the normal path.
    call.handleCallerSpeechStarted();
    expect(call.callerSpeaking).toBe(true);
  });
});
