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
let CallStore: typeof import('../services/callStore.js').CallStore;

beforeAll(async () => {
  ({ TwilioRealtimeCall } = await import('../realtime/twilioStream.js'));
  ({ CallStore } = await import('../services/callStore.js'));
});

/** Mirrors TRANSCRIPT_GRACE_MS in twilioStream.ts (module-private). */
const GRACE_MS = 1500;

/**
 * Build a call wired to a fake socket, with the OpenAI session stubbed out —
 * same pattern as twilioStream.m1.test.ts / twilioStream.silenceWatchdog.test.ts.
 */
function buildCall() {
  const socket: any = {
    readyState: WebSocket.OPEN,
    send: () => {},
    close: () => {},
    on: () => {},
  };
  const call: any = new TwilioRealtimeCall(socket);
  const sessionClose = vi.fn();
  call.session = {
    appendTwilioAudio: () => {},
    truncateActiveResponse: vi.fn(),
    injectContext: vi.fn(),
    requestResponse: vi.fn(() => true),
    close: sessionClose,
  };
  call.streamSid = 'STREAMSID';
  call.sessionReady = true;
  call.started = true;
  if (call.preAuthTimer) {
    clearTimeout(call.preAuthTimer);
    call.preAuthTimer = undefined;
  }
  return { call, sessionClose };
}

function spyStore() {
  const endCall = vi.spyOn(CallStore, 'endCall').mockImplementation(() => {});
  const recordTranscript = vi
    .spyOn(CallStore, 'recordTranscript')
    .mockImplementation(() => {});
  return { endCall, recordTranscript };
}

/**
 * 2026-08-24 — the Holly bug: caller-side transcription is ASYNC, so a caller
 * who hangs up right after finishing a sentence had that sentence dropped —
 * cleanup() closed the OpenAI socket before
 * conversation.item.input_audio_transcription.completed arrived.
 */
describe('Holly fix — transcript grace window at cleanup()', () => {
  const originalTranscription = env.OPENAI_INPUT_TRANSCRIPTION;

  beforeEach(() => {
    env.OPENAI_INPUT_TRANSCRIPTION = 'gpt-4o-mini-transcribe';
    vi.useFakeTimers();
  });
  afterEach(() => {
    env.OPENAI_INPUT_TRANSCRIPTION = originalTranscription;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('(a) a caller turn that JUST closed defers the transcript record + session close, and a late caller entry still lands in it', () => {
    const { call, sessionClose } = buildCall();
    const { endCall, recordTranscript } = spyStore();
    call.callSid = 'CA_grace_a';
    call.startedAtMs = Date.now() - 21_000;

    call.pushTranscriptEntry('erica', 'Of course — what happened?');
    // The caller finishes her 21s message: VAD commits the turn…
    call.handleCallerSpeechStopped();
    // …and she hangs up 300ms later, before the transcription comes back.
    vi.advanceTimersByTime(300);
    call.cleanup();

    // End record is written immediately; transcript + session close are held.
    expect(endCall).toHaveBeenCalledTimes(1);
    expect(recordTranscript).not.toHaveBeenCalled();
    expect(sessionClose).not.toHaveBeenCalled();

    // The in-flight transcription lands during the grace window.
    vi.advanceTimersByTime(800);
    call.pushTranscriptEntry('caller', 'I need to move my appointment');
    expect(recordTranscript).not.toHaveBeenCalled();

    vi.advanceTimersByTime(GRACE_MS);
    expect(recordTranscript).toHaveBeenCalledTimes(1);
    expect(recordTranscript.mock.calls[0]?.[0]).toBe('CA_grace_a');
    expect(recordTranscript.mock.calls[0]?.[1]).toEqual([
      expect.objectContaining({ role: 'erica' }),
      expect.objectContaining({
        role: 'caller',
        text: 'I need to move my appointment',
      }),
    ]);
    expect(sessionClose).toHaveBeenCalledTimes(1);
  });

  it('(a2) an OPEN caller turn at hangup gets the same grace (VAD commits it on close)', () => {
    const { call, sessionClose } = buildCall();
    const { endCall, recordTranscript } = spyStore();
    call.callSid = 'CA_grace_a2';
    call.startedAtMs = Date.now() - 10_000;
    // speech_started seen, speech_stopped never arrived — the caller was still
    // mid-sentence when the line dropped.
    call.callerSpeaking = true;

    call.cleanup();
    expect(endCall).toHaveBeenCalledTimes(1);
    expect(recordTranscript).not.toHaveBeenCalled();

    call.pushTranscriptEntry('caller', 'never mind, I will call back');
    vi.advanceTimersByTime(GRACE_MS);

    expect(recordTranscript).toHaveBeenCalledTimes(1);
    expect(recordTranscript.mock.calls[0]?.[1]).toEqual([
      expect.objectContaining({ text: 'never mind, I will call back' }),
    ]);
    expect(sessionClose).toHaveBeenCalledTimes(1);
  });

  it('(b) no recent caller speech → transcript written and session closed SYNCHRONOUSLY (unchanged behavior)', () => {
    const { call, sessionClose } = buildCall();
    const { endCall, recordTranscript } = spyStore();
    call.callSid = 'CA_grace_b';
    call.startedAtMs = Date.now() - 5000;
    call.pushTranscriptEntry('erica', 'Thanks for calling!');

    call.cleanup();

    expect(endCall).toHaveBeenCalledTimes(1);
    expect(recordTranscript).toHaveBeenCalledTimes(1);
    expect(sessionClose).toHaveBeenCalledTimes(1);

    // No deferred second write.
    vi.advanceTimersByTime(GRACE_MS * 4);
    expect(recordTranscript).toHaveBeenCalledTimes(1);
    expect(sessionClose).toHaveBeenCalledTimes(1);
  });

  it('(b2) a caller turn that closed LONG ago (> the in-flight window) gets no grace', () => {
    const { call, sessionClose } = buildCall();
    const { recordTranscript } = spyStore();
    call.callSid = 'CA_grace_b2';
    call.startedAtMs = Date.now() - 60_000;
    call.lastCallerSpeechStoppedAt = Date.now() - 10_000;
    call.pushTranscriptEntry('caller', 'that works, thanks');

    call.cleanup();

    expect(recordTranscript).toHaveBeenCalledTimes(1);
    expect(sessionClose).toHaveBeenCalledTimes(1);
  });

  it("(b3) with OPENAI_INPUT_TRANSCRIPTION='off' even a just-closed turn gets no grace (no caller transcripts exist)", () => {
    env.OPENAI_INPUT_TRANSCRIPTION = 'off';
    const { call, sessionClose } = buildCall();
    const { recordTranscript } = spyStore();
    call.callSid = 'CA_grace_b3';
    call.startedAtMs = Date.now() - 5000;
    call.handleCallerSpeechStopped();
    call.pushTranscriptEntry('erica', 'See you Tuesday!');

    call.cleanup();

    expect(recordTranscript).toHaveBeenCalledTimes(1);
    expect(sessionClose).toHaveBeenCalledTimes(1);
  });

  it('(c) the grace never inflates the end record — endedAt/durationMs are stamped at cleanup time', () => {
    const { call } = buildCall();
    const { endCall } = spyStore();
    call.callSid = 'CA_grace_c';
    const startedAtMs = Date.now();
    call.startedAtMs = startedAtMs;

    // 30s of call, then the caller finishes a turn and hangs up.
    vi.advanceTimersByTime(30_000);
    call.handleCallerSpeechStopped();
    const hangupAt = Date.now();

    call.cleanup();

    expect(endCall).toHaveBeenCalledTimes(1);
    const endArgs = endCall.mock.calls[0]?.[1] as any;
    expect(endArgs.endedAt).toBe(hangupAt);
    expect(endArgs.durationMs).toBe(30_000);

    // Riding out the grace window must not re-write or extend the end record.
    vi.advanceTimersByTime(GRACE_MS * 2);
    expect(endCall).toHaveBeenCalledTimes(1);
    expect((endCall.mock.calls[0]?.[1] as any).durationMs).toBe(30_000);
  });

  it('(d) a transcript that is EMPTY at cleanup but gains its first entry during the grace still gets recorded', () => {
    const { call, sessionClose } = buildCall();
    const { recordTranscript } = spyStore();
    call.callSid = 'CA_grace_d';
    call.startedAtMs = Date.now() - 8000;
    call.handleCallerSpeechStopped();

    call.cleanup();
    expect(call.transcript).toHaveLength(0);
    expect(recordTranscript).not.toHaveBeenCalled();

    call.pushTranscriptEntry('caller', 'do you do brow threading on Sundays');
    vi.advanceTimersByTime(GRACE_MS);

    expect(recordTranscript).toHaveBeenCalledTimes(1);
    expect(recordTranscript.mock.calls[0]?.[1]).toEqual([
      expect.objectContaining({
        role: 'caller',
        text: 'do you do brow threading on Sundays',
      }),
    ]);
    expect(sessionClose).toHaveBeenCalledTimes(1);
  });

  it('(e) a transcript still empty when the grace expires writes NO transcript record, but does close the session', () => {
    const { call, sessionClose } = buildCall();
    const { recordTranscript } = spyStore();
    call.callSid = 'CA_grace_e';
    call.startedAtMs = Date.now() - 8000;
    call.handleCallerSpeechStopped();

    call.cleanup();
    vi.advanceTimersByTime(GRACE_MS);

    expect(recordTranscript).not.toHaveBeenCalled();
    expect(sessionClose).toHaveBeenCalledTimes(1);
  });

  it('(f) the transcript record is written AT MOST ONCE — a re-entrant cleanup during the grace is a no-op', () => {
    const { call, sessionClose } = buildCall();
    const { endCall, recordTranscript } = spyStore();
    call.callSid = 'CA_grace_f';
    call.startedAtMs = Date.now() - 8000;
    call.handleCallerSpeechStopped();

    call.cleanup();
    // e.g. OpenAI drops on its own mid-grace → onClose → failoverToOwner →
    // cleanup() again. The `closed` guard must swallow it.
    call.cleanup();
    call.pushTranscriptEntry('caller', 'hello?');
    vi.advanceTimersByTime(GRACE_MS * 3);

    expect(endCall).toHaveBeenCalledTimes(1);
    expect(recordTranscript).toHaveBeenCalledTimes(1);
    expect(sessionClose).toHaveBeenCalledTimes(1);
  });

  it('(g) a socket that closed before Twilio "start" writes neither an end nor a transcript record', () => {
    const { call } = buildCall();
    const { endCall, recordTranscript } = spyStore();
    call.callSid = '';
    call.startedAtMs = null;
    call.callerSpeaking = true;

    call.cleanup();
    call.pushTranscriptEntry('caller', 'ghost turn');
    vi.advanceTimersByTime(GRACE_MS * 2);

    expect(endCall).not.toHaveBeenCalled();
    expect(recordTranscript).not.toHaveBeenCalled();
  });
});
