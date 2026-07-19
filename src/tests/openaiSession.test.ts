import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import WebSocket from 'ws';

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
