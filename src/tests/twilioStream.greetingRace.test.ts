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

/**
 * A2: mock the OpenAI Realtime session module so the REAL Twilio 'start'
 * handler in twilioStream.ts can be driven end-to-end (auth gate → connect →
 * configureSession → greeting → flush) without opening a real network
 * WebSocket to OpenAI. connect()/configureSession() resolve immediately;
 * requestGreeting/appendTwilioAudio are spies whose relative invocation
 * order is exactly what this test proves.
 *
 * This is the "narrower ordering test" fallback the A2 spec allows when
 * driving the real handler proves too entangled for a bare stub — here it
 * turned out driving the real handler WAS feasible by mocking just this one
 * module (openaiSession.ts is otherwise never touched by A2's fix), so this
 * test exercises the production 'start' case directly rather than a
 * hand-rolled re-implementation of its ordering.
 */
vi.mock('../realtime/openaiSession.js', () => {
  return {
    OpenAIRealtimeSession: vi.fn().mockImplementation(function (this: any) {
      this.connect = vi.fn().mockResolvedValue(undefined);
      this.configureSession = vi.fn().mockResolvedValue(undefined);
      this.registerTool = vi.fn();
      this.requestGreeting = vi.fn();
      this.appendTwilioAudio = vi.fn();
      this.injectContext = vi.fn();
      this.requestResponse = vi.fn();
      this.truncateActiveResponse = vi.fn();
      this.close = vi.fn();
    }),
  };
});

let TwilioRealtimeCall: typeof import('../realtime/twilioStream.js').TwilioRealtimeCall;
let OpenAIRealtimeSession: any;
let CallStore: typeof import('../services/callStore.js').CallStore;
let issueStreamToken: typeof import('../security/wsAuth.js').issueStreamToken;

beforeAll(async () => {
  ({ TwilioRealtimeCall } = await import('../realtime/twilioStream.js'));
  ({ OpenAIRealtimeSession } = await import('../realtime/openaiSession.js'));
  ({ CallStore } = await import('../services/callStore.js'));
  ({ issueStreamToken } = await import('../security/wsAuth.js'));
});

function makeFakeSocket() {
  const socket: any = {
    readyState: WebSocket.OPEN,
    send: () => {},
    close: () => {},
    on: () => {},
  };
  return socket;
}

function mediaEvent(payload: string, timestamp: string) {
  return Buffer.from(
    JSON.stringify({ event: 'media', media: { payload, timestamp } })
  );
}

describe('A2 — greeting race: pre-buffered media must not suppress the greeting', () => {
  let startCallSpy: ReturnType<typeof vi.spyOn>;
  let endCallSpy: ReturnType<typeof vi.spyOn>;

  // M2: this test drives the REAL 'start' handler with a real (but
  // nonexistent) callSid, and this repo's .env carries real Twilio
  // credentials — so without this, M2's fire-and-forget recording call would
  // fire an actual network request to Twilio's REST API on every test run.
  // Disabling RECORD_CALLS for this describe block's scope keeps the test
  // hermetic; M2's own behavior (enabled/disabled/no-client/rejection) is
  // covered by twilioStream.recording.test.ts.
  const originalRecordCalls = env.RECORD_CALLS;

  beforeEach(() => {
    vi.useFakeTimers();
    env.RECORD_CALLS = 'false';
    // Avoid real file writes from CallStore during the 'start'/cleanup paths
    // — same pattern as twilioStream.blocklist.test.ts. Scoped .mockRestore()
    // (not vi.restoreAllMocks()) — a blanket restoreAllMocks() would also
    // reset the plain vi.fn() OpenAIRealtimeSession mock above (for a mock
    // not created via spyOn, .mockRestore() behaves like .mockReset() and
    // wipes its mockImplementation, breaking every test after the first).
    startCallSpy = vi
      .spyOn(CallStore, 'startCall')
      .mockImplementation(() => {});
    endCallSpy = vi.spyOn(CallStore, 'endCall').mockImplementation(() => {});
    // Reset constructor call history so `mock.instances[0]` always refers to
    // THIS test's call, not a prior test's.
    OpenAIRealtimeSession.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    env.RECORD_CALLS = originalRecordCalls;
    startCallSpy.mockRestore();
    endCallSpy.mockRestore();
  });

  it('requestGreeting() fires BEFORE any pre-buffered caller audio is flushed to the session', async () => {
    const call: any = new TwilioRealtimeCall(makeFakeSocket());

    const callSid = 'CA_greeting_race';
    const streamSid = 'STREAM_greeting_race';

    // Caller audio arrives WHILE the OpenAI handshake would still be in
    // flight (session not ready yet, pre-'start') — handleMedia buffers it.
    await call.handleMessage(mediaEvent('PRE1', '100'));
    await call.handleMessage(mediaEvent('PRE2', '120'));
    expect(call.pendingMedia).toEqual(['PRE1', 'PRE2']);

    // Real signed token (WS_AUTH_SECRET is set in this repo's .env) bound to
    // the same callSid the 'start' event carries, so the auth gate passes
    // exactly as it would for a real Twilio stream.
    const token = issueStreamToken(callSid);

    await call.handleMessage(
      Buffer.from(
        JSON.stringify({
          event: 'start',
          start: { streamSid, callSid, customParameters: { token } },
        })
      )
    );

    // No `from` customParameter was sent, so prepareCallerContext short-
    // circuits immediately (no Phorest call) — the 'start' case runs to
    // completion synchronously-enough for the single `await` above to drain it.
    expect(OpenAIRealtimeSession).toHaveBeenCalledTimes(1);
    const session = OpenAIRealtimeSession.mock.instances[0];

    expect(session.requestGreeting).toHaveBeenCalledTimes(1);
    expect(session.appendTwilioAudio).toHaveBeenCalledTimes(2);
    expect(session.appendTwilioAudio).toHaveBeenNthCalledWith(1, 'PRE1');
    expect(session.appendTwilioAudio).toHaveBeenNthCalledWith(2, 'PRE2');

    // The actual A2 assertion: requestGreeting's response.create is sent
    // BEFORE the buffered pre-greeting audio is flushed to the session — so
    // server_vad's create_response:true can no longer race a flushed "hello?"
    // into creating the FIRST response ahead of the greeting.
    const greetOrder = session.requestGreeting.mock.invocationCallOrder[0];
    const firstFlushOrder =
      session.appendTwilioAudio.mock.invocationCallOrder[0];
    expect(greetOrder).toBeLessThan(firstFlushOrder);

    call.cleanup();
  });

  it('no buffered media: requestGreeting still fires normally (no regression for the common case)', async () => {
    const call: any = new TwilioRealtimeCall(makeFakeSocket());
    const callSid = 'CA_greeting_normal';
    const streamSid = 'STREAM_greeting_normal';
    const token = issueStreamToken(callSid);

    await call.handleMessage(
      Buffer.from(
        JSON.stringify({
          event: 'start',
          start: { streamSid, callSid, customParameters: { token } },
        })
      )
    );

    const session = OpenAIRealtimeSession.mock.instances[0];
    expect(session.requestGreeting).toHaveBeenCalledTimes(1);
    expect(session.appendTwilioAudio).not.toHaveBeenCalled();

    call.cleanup();
  });
});
