import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAILiveSession } from '../voice/liveSession.js';
import { MuLawSpeechGate, muLawRms } from '../voice/mulawAudio.js';

class FakeWebSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  readonly sent: Array<Record<string, any>> = [];

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    this.readyState = WebSocket.CLOSED;
  }

  open(): void {
    this.readyState = WebSocket.OPEN;
    this.emit('open');
  }

  serverEvent(event: Record<string, unknown>): void {
    this.emit('message', Buffer.from(JSON.stringify(event)));
  }
}

function buildSession(
  options: Partial<ConstructorParameters<typeof OpenAILiveSession>[0]> = {}
) {
  const socket = new FakeWebSocket();
  const session = new OpenAILiveSession({
    apiKey: 'test-key',
    backendModel: 'gpt-5.6-terra',
    webSocketFactory: () => socket as unknown as WebSocket,
    ...options,
  });
  return { session, socket };
}

async function connect(session: OpenAILiveSession, socket: FakeWebSocket) {
  const pending = session.connect();
  socket.open();
  await pending;
}

async function configure(
  session: OpenAILiveSession,
  socket: FakeWebSocket,
  config: Parameters<OpenAILiveSession['configureSession']>[0] = {
    liveInstructions: 'Live prompt',
    backendInstructions: 'Backend prompt',
    tools: [],
  }
) {
  const pending = session.configureSession(config);
  socket.serverEvent({
    type: 'session.started',
    session: {
      model: 'gpt-live-1',
      store: false,
      audio: { output: { voice: 'marin' } },
      delegation: { responses: { model: 'gpt-5.6-terra' } },
    },
  });
  await pending;
}

async function fire(
  session: OpenAILiveSession,
  event: Record<string, unknown>
) {
  await (session as any).handleEvent(event);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('GPT-Live session lifecycle and configuration', () => {
  it('starts with the validated privacy, telephony, voice, and backend shape', async () => {
    const { session, socket } = buildSession();
    await connect(session, socket);

    const tool = {
      type: 'function' as const,
      name: 'get_hours',
      description: 'Get hours.',
      parameters: { type: 'object' },
    };
    const pending = session.configureSession({
      liveInstructions: 'Live prompt',
      backendInstructions: 'Backend prompt',
      tools: [tool],
    });
    const start = socket.sent[socket.sent.length - 1];

    expect(start).toEqual({
      type: 'session.start',
      event_id: expect.stringMatching(/^session_start_/),
      session: {
        model: 'gpt-live-1',
        store: false,
        instructions: 'Live prompt',
        audio: {
          format: { type: 'audio/pcmu', rate: 8000 },
          output: { voice: 'marin' },
        },
        delegation: {
          type: 'responses',
          responses: {
            model: 'gpt-5.6-terra',
            instructions: 'Backend prompt',
            tools: [tool],
            tool_choice: 'auto',
          },
        },
      },
    });

    socket.serverEvent({ type: 'session.started', session: {} });
    await pending;
  });

  it('omits backend effort by default and includes an explicitly supplied effort', async () => {
    const first = buildSession();
    await connect(first.session, first.socket);
    const firstPending = first.session.configureSession({
      instructions: 'Both',
    });
    expect(
      first.socket.sent[0]?.session.delegation.responses.reasoning
    ).toBeUndefined();
    first.socket.serverEvent({ type: 'session.started', session: {} });
    await firstPending;

    const second = buildSession({ backendEffort: 'low' });
    await connect(second.session, second.socket);
    const secondPending = second.session.configureSession({
      instructions: 'Both',
    });
    expect(
      second.socket.sent[0]?.session.delegation.responses.reasoning
    ).toEqual({ effort: 'low' });
    second.socket.serverEvent({ type: 'session.started', session: {} });
    await secondPending;
  });

  it('updates frontend context and resends the full backend config with delegation.type', async () => {
    const { session, socket } = buildSession();
    await connect(session, socket);
    await configure(session, socket);
    socket.sent.length = 0;

    const pending = session.injectContext('Caller is a recognized client.');
    await Promise.resolve();
    expect(socket.sent[0]).toMatchObject({
      type: 'session.instructions.append',
      delegation_id: null,
      content: 'Caller is a recognized client.',
    });
    expect(socket.sent[1]).toMatchObject({
      type: 'session.update',
      session: {
        delegation: {
          type: 'responses',
          responses: {
            model: 'gpt-5.6-terra',
            instructions: expect.stringContaining(
              'Caller is a recognized client.'
            ),
          },
        },
      },
    });
    socket.serverEvent({ type: 'session.updated', session: {} });
    await pending;
  });

  it('keeps full caller/account context backend-only', async () => {
    const { session, socket } = buildSession();
    await connect(session, socket);
    await configure(session, socket);
    socket.sent.length = 0;

    const privateNote = `Recognized account: ${'private details '.repeat(120)}`;
    const pending = session.injectBackendContext(privateNote);
    await Promise.resolve();

    expect(socket.sent).toHaveLength(1);
    expect(socket.sent[0]).toMatchObject({
      type: 'session.update',
      session: {
        delegation: {
          type: 'responses',
          responses: {
            instructions: expect.stringContaining(privateNote.trim()),
          },
        },
      },
    });
    expect(
      socket.sent.some((event) => event.type === 'session.instructions.append')
    ).toBe(false);
    socket.serverEvent({ type: 'session.updated', session: {} });
    await pending;
  });

  it('waits for session.closed and reports confirmed final cumulative usage', async () => {
    const onLiveUsage = vi.fn();
    const { session, socket } = buildSession({ onLiveUsage });
    await connect(session, socket);
    await configure(session, socket);
    socket.serverEvent({
      type: 'session.usage.updated',
      usage: { seconds: 12 },
      context_window: { usage_ratio: 0.42 },
    });

    const closing = session.close();
    expect(socket.sent[socket.sent.length - 1]?.type).toBe('session.close');
    socket.serverEvent({
      type: 'session.closed',
      reason: 'close_requested',
      usage: { seconds: 13 },
    });
    await closing;

    expect(onLiveUsage).toHaveBeenLastCalledWith({
      voiceSeconds: 13,
      contextWindowUsageRatio: 0.42,
      closeReason: 'close_requested',
      final: true,
      finalConfirmed: true,
    });
  });

  it('bounds the session.start acknowledgment wait', async () => {
    vi.useFakeTimers();
    const { session, socket } = buildSession({ startupTimeoutMs: 25 });
    await connect(session, socket);

    const pending = session.configureSession({ instructions: 'Both prompts' });
    const rejection = expect(pending).rejects.toThrow(
      'session.start acknowledgment timed out'
    );
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
  });

  it('closes locally before session.started without sending an invalid session.close', async () => {
    const { session, socket } = buildSession();
    await connect(session, socket);

    await session.close();

    expect(socket.sent).toEqual([]);
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });

  it('rejects an in-flight start waiter and closes locally during handshake cleanup', async () => {
    const { session, socket } = buildSession();
    await connect(session, socket);
    const configuring = session.configureSession({ instructions: 'Both' });
    const rejection = expect(configuring).rejects.toThrow(
      'closed before session.started'
    );
    expect(socket.sent.map((event) => event.type)).toEqual(['session.start']);

    await session.close();

    await rejection;
    expect(socket.sent.map((event) => event.type)).toEqual(['session.start']);
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });

  it('sends close once and suppresses late tool output after the close command', async () => {
    vi.useFakeTimers();
    const { session, socket } = buildSession({ closeTimeoutMs: 25 });
    await connect(session, socket);
    await configure(session, socket);
    socket.sent.length = 0;

    let resolveTool!: (value: unknown) => void;
    session.registerTool(
      'slow_tool',
      () => new Promise((resolve) => (resolveTool = resolve))
    );
    await fire(session, {
      type: 'response.event',
      delegation_id: 'deleg_close',
      event: {
        type: 'response.output_item.done',
        response_id: 'resp_close',
        item: {
          type: 'function_call',
          call_id: 'call_slow',
          name: 'slow_tool',
          arguments: '{}',
        },
      },
    });
    await fire(session, {
      type: 'response.event',
      delegation_id: 'deleg_close',
      event: {
        type: 'response.completed',
        response: { id: 'resp_close', output: [] },
      },
    });

    const firstClose = session.close();
    const secondClose = session.close();
    expect(firstClose).toBe(secondClose);
    await vi.advanceTimersByTimeAsync(25);
    expect(socket.sent.map((event) => event.type)).toEqual(['session.close']);

    resolveTool({ ok: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(socket.sent.map((event) => event.type)).toEqual(['session.close']);

    socket.serverEvent({ type: 'session.closed', reason: 'close_requested' });
    await firstClose;
  });
});

describe('continuous audio and transcript mapping', () => {
  it('treats mu-law energy transitions as activity, with hysteresis', () => {
    const gate = new MuLawSpeechGate({
      speechFramesToStart: 2,
      quietFramesToStop: 2,
    });
    const silence = Buffer.alloc(160, 0xff).toString('base64');
    const speech = Buffer.alloc(160, 0x00).toString('base64');
    expect(muLawRms(silence)).toBe(0);
    expect(muLawRms(speech)).toBeGreaterThan(200);
    expect(gate.process(speech)).toBeUndefined();
    expect(gate.process(speech)).toBe('started');
    expect(gate.process(silence)).toBeUndefined();
    expect(gate.process(silence)).toBe('stopped');
  });

  it('forwards paced silence but emits output activity only around speech', async () => {
    vi.useFakeTimers();
    const callbackOrder: string[] = [];
    const onAudioChunk = vi.fn(() => callbackOrder.push('audio'));
    const onOutputSpeechStarted = vi.fn(() => callbackOrder.push('start'));
    const onOutputSpeechStopped = vi.fn(() => callbackOrder.push('stop'));
    const { session, socket } = buildSession({
      onAudioChunk,
      onOutputSpeechStarted,
      onOutputSpeechStopped,
    });
    await connect(session, socket);
    await configure(session, socket);

    const speech = Buffer.alloc(160, 0x00).toString('base64');
    const silence = Buffer.alloc(160, 0xff).toString('base64');
    await fire(session, { type: 'session.output_audio.delta', delta: speech });
    for (let index = 0; index < 30; index += 1) {
      await fire(session, {
        type: 'session.output_audio.delta',
        delta: silence,
      });
      await vi.advanceTimersByTimeAsync(20);
    }

    expect(onAudioChunk).toHaveBeenCalledTimes(31);
    expect(onOutputSpeechStarted).toHaveBeenCalledTimes(1);
    expect(onOutputSpeechStopped).toHaveBeenCalledTimes(1);
    expect(callbackOrder[0]).toBe('start');
    expect(callbackOrder[1]).toBe('audio');
    expect(callbackOrder.slice(-2)).toEqual(['audio', 'stop']);
  });

  it('preserves time-ranged transcript fragments without claiming final turns', async () => {
    const onInputTranscriptFragment = vi.fn();
    const onOutputTranscriptFragment = vi.fn();
    const onTextDelta = vi.fn();
    const onUserTranscript = vi.fn();
    const onAssistantTranscript = vi.fn();
    const { session } = buildSession({
      onInputTranscriptFragment,
      onOutputTranscriptFragment,
      onTextDelta,
      onUserTranscript,
      onAssistantTranscript,
    });

    await fire(session, {
      type: 'session.input_transcript.delta',
      delta: 'Thurs',
      start_ms: 120,
      end_ms: 310,
    });
    await fire(session, {
      type: 'session.output_transcript.delta',
      delta: 'Sure.',
      start_ms: 400,
      end_ms: 610,
    });

    expect(onInputTranscriptFragment).toHaveBeenCalledWith({
      delta: 'Thurs',
      startMs: 120,
      endMs: 310,
    });
    expect(onOutputTranscriptFragment).toHaveBeenCalledWith({
      delta: 'Sure.',
      startMs: 400,
      endMs: 610,
    });
    expect(onTextDelta).toHaveBeenCalledWith('Sure.');
    expect(onUserTranscript).not.toHaveBeenCalled();
    expect(onAssistantTranscript).not.toHaveBeenCalled();
  });

  it('preserves a 420 ms speech burst above the soft queue target', async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const onAudioChunk = vi.fn();
    const { session, socket } = buildSession({ onError, onAudioChunk });
    await connect(session, socket);
    await configure(session, socket);
    socket.sent.length = 0;

    const speech = Buffer.alloc(21 * 160, 0x00);
    await fire(session, {
      type: 'session.output_audio.delta',
      delta: speech.toString('base64'),
    });
    await vi.advanceTimersByTimeAsync(400);

    expect(onError).not.toHaveBeenCalled();
    expect(socket.sent.some((event) => event.type === 'session.close')).toBe(
      false
    );
    expect(
      Buffer.concat(
        onAudioChunk.mock.calls.map(([frame]) => Buffer.from(frame, 'base64'))
      )
    ).toEqual(speech);
  });

  it('reassembles arbitrary delta fragments into byte-exact 20 ms frames', async () => {
    vi.useFakeTimers();
    const onAudioChunk = vi.fn();
    const { session, socket } = buildSession({ onAudioChunk });
    await connect(session, socket);
    await configure(session, socket);

    const audio = Buffer.from(
      Array.from({ length: 3 * 160 }, (_, index) => index % 251)
    );
    const fragments = [
      audio.subarray(0, 79),
      audio.subarray(79, 80),
      audio.subarray(80, 241),
      audio.subarray(241),
    ];

    await fire(session, {
      type: 'session.output_audio.delta',
      delta: fragments[0]!.toString('base64'),
    });
    await fire(session, {
      type: 'session.output_audio.delta',
      delta: fragments[1]!.toString('base64'),
    });
    expect(onAudioChunk).not.toHaveBeenCalled();

    for (const fragment of fragments.slice(2)) {
      await fire(session, {
        type: 'session.output_audio.delta',
        delta: fragment.toString('base64'),
      });
    }
    await vi.advanceTimersByTimeAsync(40);

    expect(onAudioChunk).toHaveBeenCalledTimes(3);
    expect(
      Buffer.concat(
        onAudioChunk.mock.calls.map(([frame]) => Buffer.from(frame, 'base64'))
      )
    ).toEqual(audio);
    expect((session as any).outputRemainder).toHaveLength(0);
  });

  it('keeps 150 seconds of output anchored across consistently late wakes', () => {
    const onAudioChunk = vi.fn();
    const { session } = buildSession({ onAudioChunk });
    const internals = session as any;
    const frame = Buffer.alloc(160, 0x00).toString('base64');
    let now = 0;
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => now);

    internals.nextOutputAt = 0;
    for (let wake = 0; wake < 1_500; wake += 1) {
      internals.outputQueue.push(frame, frame, frame, frame, frame);
      // Each callback arrives 80 ms behind the oldest frame's deadline. Five
      // due frames must catch up without moving the underlying audio clock.
      now = wake * 100 + 80;
      internals.drainOneOutputFrame();
      clearTimeout(internals.outputTimer);
      internals.outputTimer = undefined;
      expect(internals.outputQueue).toHaveLength(0);
    }

    expect(onAudioChunk).toHaveBeenCalledTimes(7_500);
    expect(internals.nextOutputAt).toBe(150_000);
    internals.stopOutputPacer();
    nowSpy.mockRestore();
  });

  it('limits one overdue catch-up wake to five frames', () => {
    const onAudioChunk = vi.fn();
    const { session } = buildSession({ onAudioChunk });
    const internals = session as any;
    const frame = Buffer.alloc(160, 0x00).toString('base64');
    const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(200);

    internals.nextOutputAt = 0;
    internals.outputQueue.push(frame, frame, frame, frame, frame, frame);
    internals.drainOneOutputFrame();

    expect(onAudioChunk).toHaveBeenCalledTimes(5);
    expect(internals.outputQueue).toHaveLength(1);
    expect(internals.nextOutputAt).toBe(100);
    internals.stopOutputPacer();
    nowSpy.mockRestore();
  });

  it('fails once when speech exceeds the five-second hard queue bound', async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const { session, socket } = buildSession({ onError });
    await connect(session, socket);
    await configure(session, socket);
    socket.sent.length = 0;

    await fire(session, {
      type: 'session.output_audio.delta',
      delta: Buffer.alloc(252 * 160, 0x00).toString('base64'),
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('5s outbound queue bound'),
      })
    );
    expect((session as any).outputQueue).toHaveLength(0);
    expect(
      socket.sent.filter((event) => event.type === 'session.close')
    ).toHaveLength(1);

    await fire(session, {
      type: 'session.output_audio.delta',
      delta: Buffer.alloc(160, 0x00).toString('base64'),
    });
    expect(onError).toHaveBeenCalledTimes(1);

    socket.serverEvent({ type: 'session.closed', reason: 'close_requested' });
    await Promise.resolve();
  });

  it('clears a partial-frame remainder on close and emits no late audio', async () => {
    const onAudioChunk = vi.fn();
    const { session, socket } = buildSession({ onAudioChunk });
    await connect(session, socket);
    await configure(session, socket);

    await fire(session, {
      type: 'session.output_audio.delta',
      delta: Buffer.alloc(79, 0x00).toString('base64'),
    });
    expect((session as any).outputRemainder).toHaveLength(79);
    expect(onAudioChunk).not.toHaveBeenCalled();

    const closing = session.close();
    expect((session as any).outputRemainder).toHaveLength(0);
    expect((session as any).outputQueue).toHaveLength(0);
    expect((session as any).outputTimer).toBeUndefined();

    await fire(session, {
      type: 'session.output_audio.delta',
      delta: Buffer.alloc(81, 0x00).toString('base64'),
    });
    expect(onAudioChunk).not.toHaveBeenCalled();

    socket.serverEvent({ type: 'session.closed', reason: 'close_requested' });
    await closing;
  });
});

describe('nested Responses tool protocol', () => {
  it('submits every completed tool result before exactly one continuation', async () => {
    const { session, socket } = buildSession();
    await connect(session, socket);
    await configure(session, socket);
    socket.sent.length = 0;

    let resolveHours!: (value: unknown) => void;
    let resolvePrice!: (value: unknown) => void;
    session.registerTool(
      'hours',
      () => new Promise((resolve) => (resolveHours = resolve))
    );
    session.registerTool(
      'price',
      () => new Promise((resolve) => (resolvePrice = resolve))
    );

    await fire(session, {
      type: 'response.event',
      delegation_id: 'deleg_1',
      event: { type: 'response.created', response: { id: 'resp_1' } },
    });
    for (const item of [
      {
        type: 'function_call',
        call_id: 'call_hours',
        name: 'hours',
        arguments: '{"day":"Saturday"}',
      },
      {
        type: 'function_call',
        call_id: 'call_price',
        name: 'price',
        arguments: '{"service":"brows"}',
      },
    ]) {
      await fire(session, {
        type: 'response.event',
        delegation_id: 'deleg_1',
        event: { type: 'response.output_item.done', item },
      });
    }
    await fire(session, {
      type: 'response.event',
      delegation_id: 'deleg_1',
      event: {
        type: 'response.completed',
        response: { id: 'resp_1', output: [] },
      },
    });
    expect(socket.sent).toEqual([]);

    resolvePrice({ price: 12 });
    await Promise.resolve();
    expect(socket.sent).toEqual([]);
    resolveHours({ hours: '10 to 6' });
    await vi.waitFor(() => expect(socket.sent).toHaveLength(3));

    expect(socket.sent.map((event) => event.type)).toEqual([
      'response.item.create',
      'response.item.create',
      'response.create',
    ]);
    expect(socket.sent[0]?.item.call_id).toBe('call_hours');
    expect(socket.sent[1]?.item.call_id).toBe('call_price');
    expect(socket.sent[2]).not.toHaveProperty('delegation_id');

    await fire(session, {
      type: 'response.event',
      delegation_id: 'deleg_1',
      event: {
        type: 'response.completed',
        response: { id: 'resp_1', output: [] },
      },
    });
    expect(socket.sent).toHaveLength(3);
  });

  it('reports backend usage once per response id through Live usage only', async () => {
    const onLiveUsage = vi.fn();
    const onUsage = vi.fn();
    const { session } = buildSession({ onLiveUsage, onUsage });
    const completed = {
      type: 'response.event',
      delegation_id: 'deleg_1',
      event: {
        type: 'response.completed',
        response: {
          id: 'resp_1',
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            total_tokens: 120,
            input_tokens_details: { cached_tokens: 40 },
          },
        },
      },
    };
    await fire(session, completed);
    await fire(session, completed);

    expect(onLiveUsage).toHaveBeenCalledExactlyOnceWith({
      backendUsage: {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        cachedTokens: 40,
        inputTextTokens: 100,
        outputTextTokens: 20,
        cachedTextTokens: 40,
      },
      responseId: 'resp_1',
      final: false,
      finalConfirmed: false,
    });
    expect(onUsage).not.toHaveBeenCalled();
  });

  it('does not manufacture response completion from a backend completion', async () => {
    const onResponseComplete = vi.fn();
    const { session, socket } = buildSession({ onResponseComplete });
    await fire(session, {
      type: 'response.event',
      delegation_id: 'deleg_1',
      event: {
        type: 'response.completed',
        response: { id: 'resp_no_tools', output: [] },
      },
    });

    expect(onResponseComplete).not.toHaveBeenCalled();
    expect(socket.sent).toEqual([]);
  });
});

describe('greeting and compatibility behavior', () => {
  it('uses pattern B and retries commentary exactly once when speech is absent', async () => {
    vi.useFakeTimers();
    const { session, socket } = buildSession({
      greetingRetryMs: 50,
      greetingTimeoutMs: 100,
    });
    await connect(session, socket);
    await configure(session, socket);
    socket.sent.length = 0;

    expect(session.requestGreeting()).toBe(true);
    expect(socket.sent.map((event) => event.type)).toEqual([
      'session.instructions.append',
      'session.commentary.append',
    ]);
    await vi.advanceTimersByTimeAsync(50);
    expect(socket.sent.map((event) => event.type)).toEqual([
      'session.instructions.append',
      'session.commentary.append',
      'session.commentary.append',
    ]);
  });

  it('reports a failed greeting and closes after the bounded retry window', async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const { session, socket } = buildSession({
      onError,
      greetingRetryMs: 50,
      greetingTimeoutMs: 100,
    });
    await connect(session, socket);
    await configure(session, socket);
    socket.sent.length = 0;

    session.requestGreeting();
    await vi.advanceTimersByTimeAsync(100);

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('greeting produced no speech'),
      })
    );
    expect(socket.sent.some((event) => event.type === 'session.close')).toBe(
      true
    );
  });

  it('uses commentary for timeout/goodbye nudges and keeps Realtime operations explicit no-ops', async () => {
    const { session, socket } = buildSession();
    await connect(session, socket);
    await configure(session, socket);
    socket.sent.length = 0;

    expect(session.requestResponse()).toBe(true);
    session.setAutoResponses(true);
    session.truncateActiveResponse(300);

    expect(socket.sent).toHaveLength(1);
    expect(socket.sent[0]).toMatchObject({
      type: 'session.commentary.append',
      delegation_id: null,
    });
    expect(session.getCurrentResponseId()).toBeNull();
  });
});
