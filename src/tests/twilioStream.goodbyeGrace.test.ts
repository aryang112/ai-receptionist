import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import WebSocket from 'ws';

// Goodbye race fix (2026-08-27): the model may invoke end_call BEFORE
// generating its goodbye line — the 7:03 PM call hung up at :34.65 and the
// goodbye ("Take care…") was generated at :35.9, born into a dead call.
// endCallNow must give the post-tool response a window to start playing.

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
    call.markQueue = ['responsePart'];
    await expect(call.waitForGoodbyeToStart(3000)).resolves.toBeUndefined();
  });

  it('resolves as soon as the goodbye audio starts', async () => {
    vi.useFakeTimers();
    const call = buildCall();
    let resolved = false;
    const p = call.waitForGoodbyeToStart(3000).then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(resolved).toBe(false); // still waiting — no audio yet
    call.markQueue.push('responsePart'); // goodbye starts playing
    await vi.advanceTimersByTimeAsync(100);
    await p;
    expect(resolved).toBe(true);
  });

  it('gives up at the cap when no goodbye ever arrives', async () => {
    vi.useFakeTimers();
    const call = buildCall();
    let resolved = false;
    const p = call.waitForGoodbyeToStart(3000).then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(3100);
    await p;
    expect(resolved).toBe(true);
  });
});

describe("handleEndCall requests the goodbye grace; watchdog paths don't", () => {
  it('the end_call tool passes expectGoodbye: true to endCallNow', async () => {
    const call = buildCall();
    call.endCallNow = vi.fn().mockResolvedValue({ status: 'ended' });
    await call.handleEndCall({ reason: 'done' });
    expect(call.endCallNow).toHaveBeenCalledWith('caller confirmed done', {
      expectGoodbye: true,
    });
  });
});
