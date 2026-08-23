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

/**
 * M2: mock the 'twilio' npm package's default export (the client factory) so
 * getTwilioClient() (twilioStream.ts, module-scope, memoized in `_twilioClient`)
 * returns a fully-controllable fake instead of constructing a REAL client from
 * this repo's live .env Twilio credentials. Without this, every test that
 * reaches startCallRecording() would fire an actual network request to
 * Twilio's REST API (confirmed live while writing this file — see the
 * twilioStream.greetingRace.test.ts fix in this same diff). Mirrors the
 * existing `vi.mock('../realtime/openaiSession.js', …)` pattern used
 * elsewhere in this suite for a different dependency.
 */
const recordingsCreateMock = vi.fn();
const callsMock = vi.fn(() => ({
  recordings: { create: recordingsCreateMock },
}));
const twilioClientMock = { calls: callsMock };
const twilioFactoryMock = vi.fn(() => twilioClientMock);
vi.mock('twilio', () => ({ default: twilioFactoryMock }));

let TwilioRealtimeCall: typeof import('../realtime/twilioStream.js').TwilioRealtimeCall;
let CallStore: typeof import('../services/callStore.js').CallStore;
let env: typeof import('../config/env.js').env;
let logger: typeof import('../core/logger.js').logger;

beforeAll(async () => {
  ({ TwilioRealtimeCall } = await import('../realtime/twilioStream.js'));
  ({ CallStore } = await import('../services/callStore.js'));
  ({ env } = await import('../config/env.js'));
  ({ logger } = await import('../core/logger.js'));
});

function buildCallWithClass(
  Cls: typeof TwilioRealtimeCall,
  callSid: string
) {
  const socket: any = {
    readyState: WebSocket.OPEN,
    send: () => {},
    close: () => {},
    on: () => {},
  };
  const call: any = new Cls(socket);
  call.callSid = callSid;
  // Same cleanup vacation.test.ts's buildCall() does — avoid the 10s
  // pre-auth timer firing (and closing the fake socket) mid-test.
  if (call.preAuthTimer) {
    clearTimeout(call.preAuthTimer);
    call.preAuthTimer = undefined;
  }
  return call;
}

function buildCall(callSid: string) {
  return buildCallWithClass(TwilioRealtimeCall, callSid);
}

describe('M2 — startCallRecording() (fire-and-forget dual-channel recording)', () => {
  let originalRecordCalls: string;
  let recordRecordingSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(() => {
    originalRecordCalls = env.RECORD_CALLS;
  });

  beforeEach(() => {
    env.RECORD_CALLS = 'true';
    recordingsCreateMock.mockReset();
    callsMock.mockClear();
    twilioFactoryMock.mockClear();
    recordRecordingSpy = vi
      .spyOn(CallStore, 'recordRecording')
      .mockImplementation(() => {});
  });

  afterEach(() => {
    env.RECORD_CALLS = originalRecordCalls;
    recordRecordingSpy.mockRestore();
  });

  it('enabled: creates a dual-channel recording via the Twilio REST client and persists the sid', async () => {
    recordingsCreateMock.mockResolvedValueOnce({ sid: 'REaaaa1111bbbb2222' });
    const call = buildCall('CA_enabled_test');

    // Fire-and-forget: the method itself returns void synchronously.
    expect(call.startCallRecording()).toBeUndefined();

    expect(callsMock).toHaveBeenCalledTimes(1);
    expect(callsMock).toHaveBeenCalledWith('CA_enabled_test');
    expect(recordingsCreateMock).toHaveBeenCalledTimes(1);
    expect(recordingsCreateMock).toHaveBeenCalledWith({
      recordingChannels: 'dual',
    });

    await vi.waitFor(() =>
      expect(recordRecordingSpy).toHaveBeenCalledTimes(1)
    );
    expect(recordRecordingSpy).toHaveBeenCalledWith(
      'CA_enabled_test',
      'REaaaa1111bbbb2222'
    );
  });

  it("RECORD_CALLS='false': never touches the Twilio client at all", async () => {
    env.RECORD_CALLS = 'false';
    const call = buildCall('CA_disabled_test');

    expect(() => call.startCallRecording()).not.toThrow();

    // Give any (unexpected) async work a chance to run before asserting.
    await Promise.resolve();
    expect(callsMock).not.toHaveBeenCalled();
    expect(recordingsCreateMock).not.toHaveBeenCalled();
    expect(recordRecordingSpy).not.toHaveBeenCalled();
  });

  it('recording API rejection: call proceeds unharmed — no throw, no persisted record, warns instead', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {
      /* silence expected warn */
    });
    recordingsCreateMock.mockRejectedValueOnce(new Error('Twilio 500'));
    const call = buildCall('CA_reject_test');

    expect(() => call.startCallRecording()).not.toThrow();

    await vi.waitFor(() =>
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ tool: 'record_call' }),
        '🎙️ recording start failed'
      )
    );
    expect(recordRecordingSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('no Twilio client (missing/empty creds): no throw, no client call, no persisted record', async () => {
    // The module-level `_twilioClient` singleton in the ALREADY-imported
    // twilioStream.js is memoized truthy from the earlier tests in this file
    // (real credentials live in this repo's .env), so testing the "no
    // client" branch requires a genuinely fresh module instance loaded with
    // empty Twilio credentials — vi.resetModules() + a scoped re-import,
    // restoring process.env afterward. The shared `twilioFactoryMock` must
    // NOT be invoked in this test (proving getTwilioClient() short-circuited
    // before ever calling `twilio(sid, token)`).
    const savedSid = process.env.TWILIO_ACCOUNT_SID;
    const savedToken = process.env.TWILIO_AUTH_TOKEN;
    process.env.TWILIO_ACCOUNT_SID = '';
    process.env.TWILIO_AUTH_TOKEN = '';
    vi.resetModules();
    try {
      const { TwilioRealtimeCall: FreshCall } = await import(
        '../realtime/twilioStream.js'
      );
      const { CallStore: FreshCallStore } = await import(
        '../services/callStore.js'
      );
      const { env: freshEnv } = await import('../config/env.js');
      expect(freshEnv.TWILIO_ACCOUNT_SID).toBe('');
      freshEnv.RECORD_CALLS = 'true';
      const freshRecordSpy = vi
        .spyOn(FreshCallStore, 'recordRecording')
        .mockImplementation(() => {});

      const call = buildCallWithClass(FreshCall, 'CA_no_client_test');
      expect(() => call.startCallRecording()).not.toThrow();

      await Promise.resolve();
      expect(twilioFactoryMock).not.toHaveBeenCalled();
      expect(callsMock).not.toHaveBeenCalled();
      expect(recordingsCreateMock).not.toHaveBeenCalled();
      expect(freshRecordSpy).not.toHaveBeenCalled();
      freshRecordSpy.mockRestore();
    } finally {
      process.env.TWILIO_ACCOUNT_SID = savedSid;
      process.env.TWILIO_AUTH_TOKEN = savedToken;
      vi.resetModules();
    }
  });
});
