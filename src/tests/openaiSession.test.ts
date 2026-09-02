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

// The constructor throws without an API key; set one before importing env/session.
process.env.OPENAI_REALTIME_API_KEY = 'test-key';

let OpenAIRealtimeSession: typeof import('../realtime/openaiSession.js').OpenAIRealtimeSession;

beforeAll(async () => {
  ({ OpenAIRealtimeSession } = await import('../realtime/openaiSession.js'));
});

/**
 * A minimal fake WebSocket good enough for isOpen()/sendRaw(): it reports OPEN
 * and records every JSON message sent. No real network.
 */
function makeFakeWs() {
  const sent: any[] = [];
  const ws = {
    readyState: WebSocket.OPEN,
    send: (data: string) => sent.push(JSON.parse(data)),
    ping: () => {},
    close: () => {},
    on: () => {},
    once: () => {},
    removeAllListeners: () => {},
  };
  return { ws, sent };
}

/** Build a session wired to a fake open socket, with spy handlers. */
function buildSession(handlers: Record<string, any> = {}) {
  const session: any = new OpenAIRealtimeSession(handlers);
  const { ws, sent } = makeFakeWs();
  session.ws = ws;
  session.isConnected = true;
  return { session, sent };
}

/** Fire the private async event handler and await its completion. */
async function fire(session: any, event: any) {
  await session.handleEvent(event);
}

const types = (sent: any[]) => sent.map((m) => m.type);

describe('RT-2 response.create collision avoidance', () => {
  it('sends response.create immediately when no response is active', async () => {
    const { session, sent } = buildSession();
    // No active response.
    session.sendToolResult('call_1', { ok: true });
    expect(types(sent)).toEqual([
      'conversation.item.create',
      'response.create',
    ]);
  });

  it('defers response.create while a response is active, then drains exactly one on response.done', async () => {
    const { session, sent } = buildSession();
    await fire(session, {
      type: 'response.created',
      response: { id: 'resp_1' },
    });
    session.sendToolResult('call_1', { ok: true });
    // Only the function output went out — response.create was deferred.
    expect(types(sent)).toEqual(['conversation.item.create']);
    expect(session.pendingResponseCreate).toBe(true);

    await fire(session, {
      type: 'response.done',
      response: { id: 'resp_1', status: 'completed' },
    });
    // Exactly one response.create drained after done.
    expect(types(sent)).toEqual([
      'conversation.item.create',
      'response.create',
    ]);
    expect(session.pendingResponseCreate).toBe(false);
  });
});

describe('C7b response identity for post-tool farewell gating', () => {
  it('forwards the audio response id and advances/resets the current response id', async () => {
    const onAudioChunk = vi.fn();
    const { session } = buildSession({ onAudioChunk });

    await fire(session, {
      type: 'response.created',
      response: { id: 'resp_tool' },
    });
    expect(session.getCurrentResponseId()).toBe('resp_tool');

    await fire(session, {
      type: 'response.output_audio.delta',
      response_id: 'resp_tool',
      item_id: 'item_audio',
      delta: 'AA==',
    });
    expect(onAudioChunk).toHaveBeenCalledExactlyOnceWith(
      'AA==',
      'item_audio',
      'resp_tool'
    );

    await fire(session, {
      type: 'response.done',
      response: { id: 'resp_tool', status: 'completed' },
    });
    expect(session.getCurrentResponseId()).toBeNull();

    await fire(session, {
      type: 'response.created',
      response: { id: 'resp_goodbye' },
    });
    expect(session.getCurrentResponseId()).toBe('resp_goodbye');
  });
});

describe('RT-3 error classification', () => {
  it('softens a lone application error (no onError, session stays alive)', async () => {
    const onError = vi.fn();
    const { session } = buildSession({ onError });
    // Session already acknowledged.
    session.awaitingSessionAck = false;
    await fire(session, { type: 'error', error: { message: 'benign glitch' } });
    expect(onError).not.toHaveBeenCalled();
  });

  it('escalates when the error arrives before the session is acknowledged', async () => {
    const onError = vi.fn();
    const { session } = buildSession({ onError });
    session.awaitingSessionAck = true; // set by configureSession()
    await fire(session, {
      type: 'error',
      error: { message: 'invalid session field' },
    });
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('escalates once when 3 errors arrive within 10s (circuit breaker)', async () => {
    const onError = vi.fn();
    const { session } = buildSession({ onError });
    session.awaitingSessionAck = false;
    await fire(session, { type: 'error', error: { message: 'e1' } });
    await fire(session, { type: 'error', error: { message: 'e2' } });
    await fire(session, { type: 'error', error: { message: 'e3' } });
    expect(onError).toHaveBeenCalledTimes(1);
    // A fourth error does not re-escalate.
    await fire(session, { type: 'error', error: { message: 'e4' } });
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('clears the session-ack window on session.updated', async () => {
    const { session } = buildSession();
    session.awaitingSessionAck = true;
    await fire(session, { type: 'session.updated', session: {} });
    expect(session.awaitingSessionAck).toBe(false);
  });
});

describe('RT-5 failed-response retry', () => {
  beforeEach(() => vi.useFakeTimers());

  it('schedules exactly one retry response.create on a failed response', async () => {
    const { session, sent } = buildSession();
    await fire(session, {
      type: 'response.created',
      response: { id: 'resp_1' },
    });
    await fire(session, {
      type: 'response.done',
      response: { id: 'resp_1', status: 'failed' },
    });
    // Nothing sent yet — retry is deferred.
    expect(types(sent)).toEqual([]);
    vi.advanceTimersByTime(2100);
    expect(types(sent)).toEqual(['response.create']);
    vi.useRealTimers();
  });

  it('does NOT retry on a cancelled response (barge-in)', async () => {
    const { session, sent } = buildSession();
    await fire(session, {
      type: 'response.created',
      response: { id: 'resp_1' },
    });
    await fire(session, {
      type: 'response.done',
      response: { id: 'resp_1', status: 'cancelled' },
    });
    vi.advanceTimersByTime(11000);
    expect(types(sent)).toEqual([]);
    vi.useRealTimers();
  });
});

describe('B2 stale RT-5 retry cleared on new caller speech', () => {
  beforeEach(() => vi.useFakeTimers());

  it('clears a pending failed-response retry when the caller starts speaking again, so it never fires', async () => {
    const { session, sent } = buildSession();
    await fire(session, {
      type: 'response.created',
      response: { id: 'resp_1' },
    });
    await fire(session, {
      type: 'response.done',
      response: { id: 'resp_1', status: 'failed' },
    });
    // Retry scheduled but not yet fired.
    expect(types(sent)).toEqual([]);

    // Caller speaks again (e.g. switches intent) before the retry timer
    // elapses — this must invalidate the pending retry (B2).
    await fire(session, {
      type: 'input_audio_buffer.speech_started',
      item_id: 'item_new',
    });

    // Advance well past when the stale retry would have fired (max delay is
    // capped at 10s in scheduleFailedRetry).
    vi.advanceTimersByTime(11000);
    expect(types(sent)).toEqual([]);
    vi.useRealTimers();
  });
});

describe('B3 TPM retry-budget cap', () => {
  beforeEach(() => vi.useFakeTimers());

  it('caps consecutive retries at 2 — a third consecutive failure schedules no retry', async () => {
    const { session, sent } = buildSession();

    // Failure #1 -> retry #1 scheduled and fires (within the cap).
    await fire(session, {
      type: 'response.created',
      response: { id: 'resp_1' },
    });
    await fire(session, {
      type: 'response.done',
      response: { id: 'resp_1', status: 'failed' },
    });
    vi.advanceTimersByTime(2100);
    expect(types(sent)).toEqual(['response.create']);

    // Failure #2 (the retry's own response also fails) -> retry #2 scheduled
    // and fires (still within the cap of 2).
    await fire(session, {
      type: 'response.created',
      response: { id: 'resp_2' },
    });
    await fire(session, {
      type: 'response.done',
      response: { id: 'resp_2', status: 'failed' },
    });
    vi.advanceTimersByTime(2100);
    expect(types(sent)).toEqual(['response.create', 'response.create']);

    // Failure #3 — the 3rd consecutive failure — exceeds the cap: budget
    // exhausted, no third retry scheduled.
    await fire(session, {
      type: 'response.created',
      response: { id: 'resp_3' },
    });
    await fire(session, {
      type: 'response.done',
      response: { id: 'resp_3', status: 'failed' },
    });
    vi.advanceTimersByTime(11000);
    expect(types(sent)).toEqual(['response.create', 'response.create']);
    vi.useRealTimers();
  });

  it('a successful response resets the cap — failures after a success retry again', async () => {
    const { session, sent } = buildSession();

    // Two consecutive failures, right at the cap boundary — both retry. Each
    // retry is allowed to actually fire (advance past its delay) before the
    // next failure, since scheduleFailedRetry supersedes any still-pending
    // timer rather than stacking them.
    await fire(session, {
      type: 'response.created',
      response: { id: 'resp_1' },
    });
    await fire(session, {
      type: 'response.done',
      response: { id: 'resp_1', status: 'failed' },
    });
    vi.advanceTimersByTime(2100);
    await fire(session, {
      type: 'response.created',
      response: { id: 'resp_2' },
    });
    await fire(session, {
      type: 'response.done',
      response: { id: 'resp_2', status: 'failed' },
    });
    vi.advanceTimersByTime(2100);
    expect(types(sent)).toEqual(['response.create', 'response.create']);
    sent.length = 0;

    // A successful response resets the streak.
    await fire(session, {
      type: 'response.created',
      response: { id: 'resp_3' },
    });
    await fire(session, {
      type: 'response.done',
      response: { id: 'resp_3', status: 'completed' },
    });

    // Two MORE consecutive failures after the success both retry again — if
    // the cap hadn't reset, the second of these would be the streak's 4th
    // consecutive failure and would be blocked.
    await fire(session, {
      type: 'response.created',
      response: { id: 'resp_4' },
    });
    await fire(session, {
      type: 'response.done',
      response: { id: 'resp_4', status: 'failed' },
    });
    vi.advanceTimersByTime(2100);
    await fire(session, {
      type: 'response.created',
      response: { id: 'resp_5' },
    });
    await fire(session, {
      type: 'response.done',
      response: { id: 'resp_5', status: 'failed' },
    });
    vi.advanceTimersByTime(11000);
    expect(types(sent)).toEqual(['response.create', 'response.create']);
    vi.useRealTimers();
  });

  it('speech_started also resets the cap', async () => {
    const { session, sent } = buildSession();

    // Two consecutive failures, right at the cap boundary — both retry. Each
    // retry is allowed to actually fire before the next failure (see the
    // "success resets the cap" test above for why).
    await fire(session, {
      type: 'response.created',
      response: { id: 'resp_1' },
    });
    await fire(session, {
      type: 'response.done',
      response: { id: 'resp_1', status: 'failed' },
    });
    vi.advanceTimersByTime(2100);
    await fire(session, {
      type: 'response.created',
      response: { id: 'resp_2' },
    });
    await fire(session, {
      type: 'response.done',
      response: { id: 'resp_2', status: 'failed' },
    });
    vi.advanceTimersByTime(2100);
    expect(types(sent)).toEqual(['response.create', 'response.create']);
    sent.length = 0;

    // New caller speech resets the streak (it also clears any pending
    // retry timer — B2 — but that's not what's under test here).
    await fire(session, {
      type: 'input_audio_buffer.speech_started',
      item_id: 'item_new',
    });

    // Two more consecutive failures after speech_started both retry again —
    // if the cap hadn't reset, the second would be blocked.
    await fire(session, {
      type: 'response.created',
      response: { id: 'resp_3' },
    });
    await fire(session, {
      type: 'response.done',
      response: { id: 'resp_3', status: 'failed' },
    });
    vi.advanceTimersByTime(2100);
    await fire(session, {
      type: 'response.created',
      response: { id: 'resp_4' },
    });
    await fire(session, {
      type: 'response.done',
      response: { id: 'resp_4', status: 'failed' },
    });
    vi.advanceTimersByTime(11000);
    expect(types(sent)).toEqual(['response.create', 'response.create']);
    vi.useRealTimers();
  });
});

describe('RT-7 stray-delta gating after barge-in', () => {
  it('drops audio deltas carrying the cancelled response id, then re-arms on next response.created', async () => {
    const onAudioChunk = vi.fn();
    const { session } = buildSession({ onAudioChunk });
    await fire(session, {
      type: 'response.created',
      response: { id: 'resp_1' },
    });
    // Simulate an assistant item speaking, then a barge-in truncate.
    session.activeItemId = 'item_1';
    session.truncateActiveResponse(120);
    expect(session.cancelledResponseId).toBe('resp_1');

    // Stray buffered delta for the cancelled response → dropped.
    await fire(session, {
      type: 'response.output_audio.delta',
      delta: 'AAAA',
      response_id: 'resp_1',
      item_id: 'item_1',
    });
    expect(onAudioChunk).not.toHaveBeenCalled();

    // Next response clears the guard; its deltas play normally.
    await fire(session, {
      type: 'response.created',
      response: { id: 'resp_2' },
    });
    expect(session.cancelledResponseId).toBeNull();
    await fire(session, {
      type: 'response.output_audio.delta',
      delta: 'BBBB',
      response_id: 'resp_2',
      item_id: 'item_2',
    });
    expect(onAudioChunk).toHaveBeenCalledTimes(1);
  });
});

describe('RT-1 onClose contract', () => {
  it('exposes onClose in the handlers and stores it', () => {
    const onClose = vi.fn();
    const session: any = new OpenAIRealtimeSession({ onClose });
    expect(session.handlers.onClose).toBe(onClose);
  });
});

describe('RT-9 call-tagged logging', () => {
  it('accepts a callTag without altering handler behavior', () => {
    const onAudioChunk = vi.fn();
    const session: any = new OpenAIRealtimeSession({
      callTag: 'abcd1234',
      onAudioChunk,
    });
    // callTag is consumed into the child logger, not leaked into handlers.
    expect(session.handlers.onAudioChunk).toBe(onAudioChunk);
    expect((session.handlers as any).callTag).toBeUndefined();
  });
});

describe('G2 requestResponse — guarded response creation for out-of-band triggers', () => {
  it('sends response.create when the session is open and no response is active', () => {
    const { session, sent } = buildSession();
    session.requestResponse();
    expect(types(sent)).toEqual(['response.create']);
  });

  it('does NOT send response.create while a response is already active (RT-2/RT-3 guard)', async () => {
    const { session, sent } = buildSession();
    await fire(session, {
      type: 'response.created',
      response: { id: 'resp_1' },
    });
    session.requestResponse();
    expect(types(sent)).toEqual([]);
  });

  it('is a silent no-op when the socket is not open', () => {
    const session: any = new OpenAIRealtimeSession({});
    // Never connected — isOpen() is false.
    expect(() => session.requestResponse()).not.toThrow();
  });
});

describe('M1 — onUserTranscript / onAssistantTranscript / onUsage handler wiring', () => {
  it('fires onUserTranscript with the transcript text on the USER SAID event', async () => {
    const onUserTranscript = vi.fn();
    const { session } = buildSession({ onUserTranscript });
    await fire(session, {
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'I need a lash lift Tuesday',
    });
    expect(onUserTranscript).toHaveBeenCalledExactlyOnceWith(
      'I need a lash lift Tuesday'
    );
  });

  it('does NOT fire onUserTranscript when the event carries no transcript string', async () => {
    const onUserTranscript = vi.fn();
    const { session } = buildSession({ onUserTranscript });
    await fire(session, {
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: undefined,
    });
    expect(onUserTranscript).not.toHaveBeenCalled();
  });

  it('fires onAssistantTranscript on both ERICA SAID event name variants', async () => {
    const onAssistantTranscript = vi.fn();
    const { session } = buildSession({ onAssistantTranscript });
    await fire(session, {
      type: 'response.audio_transcript.done',
      transcript: 'Sure, Tuesday at 2pm works!',
    });
    await fire(session, {
      type: 'response.output_audio_transcript.done',
      transcript: 'Anything else I can help with?',
    });
    expect(onAssistantTranscript).toHaveBeenCalledTimes(2);
    expect(onAssistantTranscript).toHaveBeenNthCalledWith(
      1,
      'Sure, Tuesday at 2pm works!'
    );
    expect(onAssistantTranscript).toHaveBeenNthCalledWith(
      2,
      'Anything else I can help with?'
    );
  });

  it('fires onAssistantTranscript with an empty string when transcript is missing (matches the existing log fallback)', async () => {
    const onAssistantTranscript = vi.fn();
    const { session } = buildSession({ onAssistantTranscript });
    await fire(session, {
      type: 'response.audio_transcript.done',
      transcript: undefined,
    });
    expect(onAssistantTranscript).toHaveBeenCalledExactlyOnceWith('');
  });

  it('fires onUsage with the same numbers as the 📊 turn tokens log, applying the ?? 0 fallbacks', async () => {
    const onUsage = vi.fn();
    const { session } = buildSession({ onUsage });
    await fire(session, {
      type: 'response.done',
      response: {
        id: 'resp_1',
        status: 'completed',
        usage: {
          input_tokens: 500,
          output_tokens: 120,
          total_tokens: 620,
          input_token_details: { cached_tokens: 300 },
        },
      },
    });
    expect(onUsage).toHaveBeenCalledExactlyOnceWith({
      inputTokens: 500,
      outputTokens: 120,
      cachedTokens: 300,
      totalTokens: 620,
    });
  });

  it('does NOT fire onUsage when the response carries no usage field', async () => {
    const onUsage = vi.fn();
    const { session } = buildSession({ onUsage });
    await fire(session, {
      type: 'response.done',
      response: { id: 'resp_1', status: 'completed' },
    });
    expect(onUsage).not.toHaveBeenCalled();
  });

  // ANALYTICS AUDIT FIX (2026-08-22, P1): text/audio modality split.
  it('fires onUsage WITH the text/audio modality split when the response carries input_token_details/output_token_details', async () => {
    const onUsage = vi.fn();
    const { session } = buildSession({ onUsage });
    await fire(session, {
      type: 'response.done',
      response: {
        id: 'resp_1',
        status: 'completed',
        usage: {
          input_tokens: 1500,
          output_tokens: 400,
          total_tokens: 1900,
          input_token_details: {
            cached_tokens: 300,
            text_tokens: 1000,
            audio_tokens: 500,
            cached_tokens_details: { text_tokens: 200, audio_tokens: 100 },
          },
          output_token_details: { text_tokens: 300, audio_tokens: 100 },
        },
      },
    });
    expect(onUsage).toHaveBeenCalledExactlyOnceWith({
      inputTokens: 1500,
      outputTokens: 400,
      cachedTokens: 300,
      totalTokens: 1900,
      inputTextTokens: 1000,
      inputAudioTokens: 500,
      outputTextTokens: 300,
      outputAudioTokens: 100,
      cachedTextTokens: 200,
      cachedAudioTokens: 100,
    });
  });

  it('fires onUsage WITHOUT split fields when input_token_details/output_token_details are absent (defensive — no crash, no fabricated 0s)', async () => {
    const onUsage = vi.fn();
    const { session } = buildSession({ onUsage });
    await fire(session, {
      type: 'response.done',
      response: {
        id: 'resp_1',
        status: 'completed',
        usage: { input_tokens: 500, output_tokens: 120, total_tokens: 620 },
      },
    });
    // Exact match — no inputTextTokens/inputAudioTokens/etc keys at all when
    // the API response didn't include them (matches the OLD exact-shape
    // test above, proving the fix is fully backward compatible).
    expect(onUsage).toHaveBeenCalledExactlyOnceWith({
      inputTokens: 500,
      outputTokens: 120,
      cachedTokens: 0,
      totalTokens: 620,
    });
  });
});

describe('M1 — configureSession session.update payload (OPENAI_INPUT_TRANSCRIPTION env gate)', () => {
  const originalTranscription = env.OPENAI_INPUT_TRANSCRIPTION;
  afterEach(() => {
    env.OPENAI_INPUT_TRANSCRIPTION = originalTranscription;
  });

  /** The exact pre-M1 audio.input shape — no `transcription` key at all. */
  function expectedAudioInputWithoutTranscription() {
    return {
      format: { type: 'audio/pcmu' },
      noise_reduction: { type: env.OPENAI_NOISE_REDUCTION },
      turn_detection: {
        type: 'server_vad',
        threshold: env.OPENAI_VAD_THRESHOLD,
        prefix_padding_ms: env.OPENAI_VAD_PREFIX_MS,
        silence_duration_ms: env.OPENAI_VAD_SILENCE_MS,
        // Greeting protection: server-side interrupt AND auto-created replies
        // start OFF; twilioStream re-enables both once the greeting has
        // played out (setAutoResponses — validated live 2026-08-26).
        interrupt_response: false,
        create_response: false,
      },
    };
  }

  it("OPENAI_INPUT_TRANSCRIPTION='off' (the default) sends a session.update payload BYTE-IDENTICAL to the pre-M1 shape — no transcription field anywhere", async () => {
    env.OPENAI_INPUT_TRANSCRIPTION = 'off';
    const { session, sent } = buildSession();
    await session.configureSession({ instructions: 'INSTRUCTIONS', tools: [] });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      type: 'session.update',
      session: {
        type: 'realtime',
        model: env.OPENAI_REALTIME_MODEL,
        output_modalities: ['audio'],
        instructions: 'INSTRUCTIONS',
        tools: [],
        truncation: { type: 'retention_ratio', retention_ratio: 0.8 },
        audio: {
          input: expectedAudioInputWithoutTranscription(),
          output: {
            format: { type: 'audio/pcmu' },
            voice: env.OPENAI_REALTIME_VOICE,
          },
        },
      },
    });
    // Belt-and-suspenders: assert the key itself is absent, not just falsy.
    expect(
      Object.prototype.hasOwnProperty.call(
        sent[0].session.audio.input,
        'transcription'
      )
    ).toBe(false);
  });

  it("OPENAI_INPUT_TRANSCRIPTION='gpt-4o-mini-transcribe' adds EXACTLY one new nested field (audio.input.transcription) — everything else unchanged", async () => {
    env.OPENAI_INPUT_TRANSCRIPTION = 'gpt-4o-mini-transcribe';
    const { session, sent } = buildSession();
    await session.configureSession({ instructions: 'INSTRUCTIONS', tools: [] });

    const audioInput = sent[0].session.audio.input;
    expect(audioInput.transcription).toEqual({
      model: 'gpt-4o-mini-transcribe',
    });
    const { transcription, ...rest } = audioInput;
    expect(rest).toEqual(expectedAudioInputWithoutTranscription());
  });
});

describe('VAD turn boundaries — onSpeechStarted / onSpeechStopped wiring', () => {
  it('fires onSpeechStopped when the VAD closes the caller turn (mirrors onSpeechStarted)', async () => {
    const onSpeechStarted = vi.fn();
    const onSpeechStopped = vi.fn();
    const { session } = buildSession({ onSpeechStarted, onSpeechStopped });

    await fire(session, {
      type: 'input_audio_buffer.speech_started',
      item_id: 'item_1',
    });
    expect(onSpeechStarted).toHaveBeenCalledTimes(1);
    // The turn is still OPEN — a caller mid-monologue emits nothing further
    // until they pause, so this handler must NOT have run yet.
    expect(onSpeechStopped).not.toHaveBeenCalled();

    await fire(session, { type: 'input_audio_buffer.speech_stopped' });
    expect(onSpeechStopped).toHaveBeenCalledTimes(1);
    expect(onSpeechStarted).toHaveBeenCalledTimes(1);
  });
});
