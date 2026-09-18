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
      injectContext: vi.fn(() => Promise.resolve()),
      injectBackendContext: vi.fn(() => Promise.resolve()),
      // B1: requestGreeting is the thing under test on the failback path, so
      // it has to be a spy rather than the inherited prototype no-op.
      requestGreeting: vi.fn(() => true),
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

  // B1 (2026-09-17). Production call CAb66df4eb8f3d3c4eced28f85c457a6c2 opened
  // its failback segment with the FULL greeting including the recording
  // disclosure, 24s after Richa's phone was dialed, and the caller had to ask
  // for her a second time. The prompt context asserted above was already
  // correct on that call — the re-greeting came from our own code:
  // OpenAILiveSession.requestGreeting() appends "Greet the caller immediately
  // using the required greeting and recording disclosure in your
  // instructions", which is a later and more specific instruction than the
  // prompt's failback rule. So the server must not send that instruction at
  // all on a failback segment.
  it('never sends a greeting instruction on a failback segment, and drives the opening itself', async () => {
    const call = await startLiveCall(true);

    expect(call.session.requestGreeting).not.toHaveBeenCalled();
    expect(call.session.injectContext).toHaveBeenCalledTimes(1);
    const directive = call.session.injectContext.mock.calls[0][0] as string;
    expect(directive).toContain('rang out without her answering');
    expect(directive).toContain('no greeting and no recording notice to give');
    expect(directive).toContain('Do not greet');
    expect(directive).toContain('do not mention the recording');
    expect(directive).toContain('never offer to try her again');
    // The append is inert without something to trigger a turn — the same
    // pairing requestGreeting uses (instructions.append + commentary.append).
    expect(call.session.requestResponse).toHaveBeenCalled();
    // No new OpenAI field is introduced: both events are the ones already sent
    // on every production call. Pinned as a contract so a future "nicer" API
    // change here has to be validated against the live API first
    // (tasks/lessons.md — one unknown field hangs the call up instantly).
    expect(typeof OpenAILiveSession.prototype.injectContext).toBe('function');
    expect(typeof OpenAILiveSession.prototype.requestResponse).toBe('function');
  });

  it('still uses the ordinary greeting path on a first segment', async () => {
    const call = await startLiveCall(false);

    expect(call.session.requestGreeting).toHaveBeenCalledTimes(1);
    expect(call.session.injectContext).not.toHaveBeenCalled();
  });
});
