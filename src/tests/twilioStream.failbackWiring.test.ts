import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

process.env.OPENAI_REALTIME_API_KEY ||= 'test-key';
process.env.VOICE_ENGINE = 'live';
// No signed-token gate in this unit test — we drive the start event directly.
process.env.WS_AUTH_SECRET = '';

// The failback greeting was written and tested in isolation for months while
// the call site never passed greetingContext, so every failed-transfer caller
// got the new-call greeting. These tests cover the WIRING, not the renderer.
const buildLivePrompt = vi.fn((..._args: unknown[]) => 'LIVE PROMPT');
vi.mock('../voice/livePrompts.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../voice/livePrompts.js')>();
  return {
    ...actual,
    buildLivePrompt: (...args: unknown[]) => buildLivePrompt(...args),
    buildBackendPrompt: () => 'BACKEND PROMPT',
  };
});
vi.mock('../services/phorest.js', () => ({
  phorest: {
    listServices: vi.fn(async () => []),
    listAppointments: vi.fn(async () => []),
    findClientByPhone: vi.fn(async () => null),
  },
}));

let TwilioRealtimeCall: typeof import('../realtime/twilioStream.js').TwilioRealtimeCall;
let OpenAILiveSession: typeof import('../voice/liveSession.js').OpenAILiveSession;

beforeAll(async () => {
  ({ TwilioRealtimeCall } = await import('../realtime/twilioStream.js'));
  ({ OpenAILiveSession } = await import('../voice/liveSession.js'));
});

afterEach(() => {
  buildLivePrompt.mockClear();
  vi.restoreAllMocks();
});

async function startLiveCall(transferFailed: boolean) {
  const socket: any = {
    readyState: WebSocket.OPEN,
    send: vi.fn(),
    close: vi.fn(),
    on: vi.fn(),
  };
  const call: any = new TwilioRealtimeCall(socket);
  call.voiceEngine = 'live';
  if (call.preAuthTimer) {
    clearTimeout(call.preAuthTimer);
    call.preAuthTimer = undefined;
  }
  // Stand in for the real session so no OpenAI socket is opened, while keeping
  // the `instanceof OpenAILiveSession` branch that builds the Live prompt.
  call.createSession = () => {
    call.session = Object.create(OpenAILiveSession.prototype);
    Object.assign(call.session, {
      connect: vi.fn(async () => {}),
      configureSession: vi.fn(async () => {}),
      injectContext: vi.fn(),
      requestResponse: vi.fn(() => true),
      getCurrentResponseId: vi.fn(() => null),
      close: vi.fn(),
      setBackendContextNote: vi.fn(),
    });
  };
  await call.handleMessage(
    JSON.stringify({
      event: 'start',
      start: {
        streamSid: 'STREAMSIDFAILBACK',
        callSid: 'CA_wiring_test',
        customParameters: {
          from: '+12025550198',
          ...(transferFailed ? { transferFailed: '1' } : {}),
        },
      },
    })
  );
  return call;
}

describe('Live failback greeting wiring', () => {
  it('tells the speech model a transfer already rang out', async () => {
    await startLiveCall(true);
    expect(buildLivePrompt).toHaveBeenCalled();
    const context = buildLivePrompt.mock.calls[0]![2] as {
      greetingContext?: string;
    };
    expect(context.greetingContext).toBe('transfer_failback');
  });

  it('uses the new-call greeting on an ordinary first segment', async () => {
    await startLiveCall(false);
    expect(buildLivePrompt).toHaveBeenCalled();
    const context = buildLivePrompt.mock.calls[0]![2] as {
      greetingContext?: string;
    };
    expect(context.greetingContext).toBe('new_call');
  });
});
