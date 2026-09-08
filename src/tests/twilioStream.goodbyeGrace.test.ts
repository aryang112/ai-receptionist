import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import WebSocket from 'ws';

// C7b: gpt-realtime-2.1 can emit a tool-only end_call response. The handler
// must return its tool output first, let the post-tool farewell play, and only
// then let the server hang up. These tests lock the two-phase close itself,
// rather than relying on prompt wording.

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
    requestResponse: vi.fn(() => true),
    getCurrentResponseId: vi.fn(() => 'tool-response'),
    close: vi.fn(),
  };
  call.streamSid = 'S';
  if (call.preAuthTimer) {
    clearTimeout(call.preAuthTimer);
    call.preAuthTimer = undefined;
  }
  return call;
}

describe('waitForGoodbyeToStart', () => {
  it('resolves immediately when audio is already playing', async () => {
    const call = buildCall();
    call.outboundAudioEpoch = 1;
    await expect(call.waitForGoodbyeToStart(3000, 0)).resolves.toBe(true);
  });

  it('resolves as soon as the goodbye audio starts', async () => {
    vi.useFakeTimers();
    const call = buildCall();
    let resolved: boolean | undefined;
    const p = call.waitForGoodbyeToStart(3000, 0).then((started: boolean) => {
      resolved = started;
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(resolved).toBeUndefined(); // still waiting — no new audio yet
    call.outboundAudioEpoch = 1; // goodbye starts playing
    await vi.advanceTimersByTimeAsync(100);
    await p;
    expect(resolved).toBe(true);
  });

  it('gives up at the cap when no goodbye ever arrives', async () => {
    vi.useFakeTimers();
    const call = buildCall();
    const p = call.waitForGoodbyeToStart(3000, 0);
    await vi.advanceTimersByTimeAsync(3100);
    await expect(p).resolves.toBe(false);
  });
});

describe('C7b — deterministic two-phase model close', () => {
  it('wires function output → one response.create → fresh audio → Twilio mark drain → close', async () => {
    vi.useFakeTimers();
    const twilioSent: any[] = [];
    const socket: any = {
      readyState: WebSocket.OPEN,
      send: (data: string) => twilioSent.push(JSON.parse(data)),
      close: vi.fn(),
      on: () => {},
    };
    const call: any = new TwilioRealtimeCall(socket);
    if (call.preAuthTimer) {
      clearTimeout(call.preAuthTimer);
      call.preAuthTimer = undefined;
    }
    call.streamSid = 'S';
    call.createSession('goodbye-integration');

    const openAiSent: any[] = [];
    call.session.ws = {
      readyState: WebSocket.OPEN,
      send: (data: string) => openAiSent.push(JSON.parse(data)),
      close: vi.fn(),
      ping: () => {},
    };
    call.session.isConnected = true;

    await call.session.handleEvent({
      type: 'response.created',
      response: { id: 'resp_tool' },
    });
    await call.session.handleEvent({
      type: 'response.function_call_arguments.done',
      call_id: 'call_end',
      name: 'end_call',
      arguments: JSON.stringify({ reason: 'done' }),
    });

    expect(openAiSent.map((message) => message.type)).toEqual([
      'conversation.item.create',
    ]);
    const toolOutput = JSON.parse(openAiSent[0].item.output);
    expect(toolOutput).toMatchObject({ ending: true });
    expect(call.closed).toBe(false);

    await call.session.handleEvent({
      type: 'response.done',
      response: { id: 'resp_tool', status: 'completed' },
    });
    expect(openAiSent.map((message) => message.type)).toEqual([
      'conversation.item.create',
      'response.create',
    ]);
    await vi.advanceTimersByTimeAsync(1);

    await call.session.handleEvent({
      type: 'response.created',
      response: { id: 'resp_goodbye' },
    });
    await call.session.handleEvent({
      type: 'response.output_audio.delta',
      response_id: 'resp_goodbye',
      item_id: 'item_goodbye',
      delta: 'AA==',
    });
    expect(twilioSent.map((message) => message.event)).toEqual([
      'media',
      'mark',
    ]);

    await call.handleMessage(
      Buffer.from(JSON.stringify({ event: 'mark', streamSid: 'S' }))
    );
    await vi.advanceTimersByTimeAsync(100);

    expect(call.closed).toBe(true);
    expect(
      openAiSent.filter((message) => message.type === 'response.create')
    ).toHaveLength(1);
  });

  it('a tool-only end_call returns the farewell instruction before waiting, drains that audio, then closes', async () => {
    vi.useFakeTimers();
    const call = buildCall();
    const result = await call.handleEndCall({ reason: 'done' });

    expect(result).toMatchObject({ ending: true });
    expect(result.note).toMatch(
      /say exactly one short, warm, natural farewell/i
    );
    expect(result.note).toMatch(/call-control actions silent and internal/i);
    expect(call.closed).toBe(false);

    await vi.advanceTimersByTimeAsync(1); // scheduled closer starts waiting
    expect(call.transferring).toBe(false); // no close ownership until fresh audio
    call.sendAudioToTwilio('AA==', 'goodbye-response'); // post-tool farewell begins
    await vi.advanceTimersByTimeAsync(100);
    expect(call.closed).toBe(false); // still waiting for Twilio playback marks
    call.markQueue = [];
    await vi.advanceTimersByTimeAsync(100);

    expect(call.closed).toBe(true);
    expect(call.outcome).toBe('completed');
    expect(call.session.requestResponse).not.toHaveBeenCalled();
  });

  it('stale pre-tool audio cannot satisfy the farewell wait; fresh audio is drained before the no-REST fallback closes', async () => {
    vi.useFakeTimers();
    const call = buildCall();
    call.sendAudioToTwilio('OLD=', 'tool-response');

    const result = await call.handleEndCall({ reason: 'done' });
    expect(result.note).toMatch(
      /say exactly one short, warm, natural farewell/i
    );
    await vi.advanceTimersByTimeAsync(1);
    call.sendAudioToTwilio('TAIL=', 'tool-response');
    await vi.advanceTimersByTimeAsync(500);
    expect(call.closed).toBe(false);
    expect(call.session.injectContext).not.toHaveBeenCalled();
    expect(call.session.requestResponse).not.toHaveBeenCalled();

    call.sendAudioToTwilio('NEW=', 'goodbye-response');
    await vi.advanceTimersByTimeAsync(100);
    expect(call.closed).toBe(false);
    call.markQueue = [];
    await vi.advanceTimersByTimeAsync(100);
    expect(call.closed).toBe(true);
  });

  it('duplicate end_call invocations share one scheduled closer', async () => {
    vi.useFakeTimers();
    const call = buildCall();
    call.endCallNow = vi.fn().mockResolvedValue({ status: 'ended' });

    const first = await call.handleEndCall({ reason: 'done' });
    const second = await call.handleEndCall({ reason: 'done' });
    expect(first).toMatchObject({ ending: true });
    expect(second).toMatchObject({ ending: true });
    call.sendAudioToTwilio('AA==', 'goodbye-response');
    call.markQueue = [];
    await vi.advanceTimersByTimeAsync(1);
    expect(call.endCallNow).toHaveBeenCalledTimes(1);
  });

  it('caller speech before farewell audio aborts promptly and rolls back a spam tag', async () => {
    vi.useFakeTimers();
    const call = buildCall();
    call.outcome = 'info';
    call.greetingPlayedOut = true;

    await call.handleEndCall({ reason: 'spam' });
    await vi.advanceTimersByTimeAsync(1);
    call.handleCallerSpeechStarted();
    await vi.advanceTimersByTimeAsync(100);

    expect(call.closed).toBe(false);
    expect(call.transferring).toBe(false);
    expect(call.modelEndCallPending).toBe(false);
    expect(call.outcome).toBe('info');
    expect(call.session.injectContext).toHaveBeenCalledWith(
      expect.stringMatching(/caller started speaking again/i)
    );
  });

  it('rejects end_call immediately when the caller is already speaking', async () => {
    const call = buildCall();
    call.outcome = 'info';
    call.greetingPlayedOut = true;
    call.handleCallerSpeechStarted();

    const result = await call.handleEndCall({ reason: 'spam' });

    expect(result).toMatchObject({ aborted: true });
    expect(result.note).toMatch(/caller started speaking again/i);
    expect(call.modelEndCallPending).toBe(false);
    expect(call.outcome).toBe('info');
  });

  it('caller speech during farewell playback aborts the drain and keeps the call live', async () => {
    vi.useFakeTimers();
    const call = buildCall();
    call.greetingPlayedOut = true;

    await call.handleEndCall({ reason: 'done' });
    await vi.advanceTimersByTimeAsync(1);
    call.sendAudioToTwilio('AA==', 'goodbye-response');
    await vi.advanceTimersByTimeAsync(100);
    call.handleCallerSpeechStarted();
    await vi.advanceTimersByTimeAsync(100);

    expect(call.session.truncateActiveResponse).toHaveBeenCalled();
    expect(call.closed).toBe(false);
    expect(call.transferring).toBe(false);
    expect(call.modelEndCallPending).toBe(false);
  });

  it('does not close while another business tool is still in flight', async () => {
    const call = buildCall();
    call.toolCallsInFlight = 2; // this end_call plus one business tool

    const result = await call.handleEndCall({ reason: 'done' });

    expect(result).toMatchObject({ aborted: true });
    expect(result.note).toMatch(/requested action is still finishing/i);
    expect(call.modelEndCallPending).toBe(false);
  });

  it('fails open without issuing a collision-prone retry when no post-tool audio arrives', async () => {
    vi.useFakeTimers();
    const call = buildCall();

    await call.handleEndCall({ reason: 'done' });
    await vi.advanceTimersByTimeAsync(5100);

    expect(call.session.injectContext).not.toHaveBeenCalled();
    expect(call.session.requestResponse).not.toHaveBeenCalled();
    expect(call.closed).toBe(false);
    expect(call.transferring).toBe(false);
    expect(call.modelEndCallPending).toBe(false);
  });

  it('contains a rejected scheduled closer and rolls back spam instead of leaking an unhandled rejection', async () => {
    vi.useFakeTimers();
    const call = buildCall();
    call.outcome = 'info';
    call.endCallNow = vi.fn().mockRejectedValue(new Error('close failed'));

    await call.handleEndCall({ reason: 'spam' });
    call.sendAudioToTwilio('AA==', 'goodbye-response');
    call.markQueue = [];
    await vi.advanceTimersByTimeAsync(1);

    expect(call.outcome).toBe('info');
    expect(call.modelEndCallPending).toBe(false);
    expect(call.transferring).toBe(false);
    expect(call.closed).toBe(false);
  });
});
