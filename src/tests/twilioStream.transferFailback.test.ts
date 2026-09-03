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

// Live-transfer no-answer fallback (2026-08-24). Today's <Dial> had neither a
// timeout nor an action: a no-answer dumped the caller into Richa's PERSONAL
// voicemail (a message the salon never sees), and a busy/failed dial hung up
// on them outright because nothing followed the <Dial>. The fix is a timed
// dial with an action callback (POST /twilio/dial-status) that reconnects the
// caller to a fresh Erica session — and that failback session must never dial
// Richa again.

process.env.OPENAI_REALTIME_API_KEY ||= 'test-key';

// Mock the 'twilio' package's default export (the client factory) so
// getTwilioClient() returns a controllable fake instead of building a REAL
// client from this repo's live .env credentials — same pattern (and same
// reason) as twilioStream.recording.test.ts.
const updateMock = vi.fn().mockResolvedValue({});
const recordingsCreateMock = vi.fn().mockResolvedValue({ sid: 'RE_test' });
const callsMock = vi.fn(() => ({
  update: updateMock,
  recordings: { create: recordingsCreateMock },
}));
vi.mock('twilio', () => ({ default: vi.fn(() => ({ calls: callsMock })) }));

// Drive the REAL Twilio 'start' handler without opening a network WebSocket
// to OpenAI (mirrors twilioStream.greetingRace.test.ts).
vi.mock('../realtime/openaiSession.js', () => ({
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
}));

let TwilioRealtimeCall: typeof import('../realtime/twilioStream.js').TwilioRealtimeCall;
let CallStore: typeof import('../services/callStore.js').CallStore;
let env: typeof import('../config/env.js').env;
let issueStreamToken: typeof import('../security/wsAuth.js').issueStreamToken;

beforeAll(async () => {
  ({ TwilioRealtimeCall } = await import('../realtime/twilioStream.js'));
  ({ CallStore } = await import('../services/callStore.js'));
  ({ env } = await import('../config/env.js'));
  ({ issueStreamToken } = await import('../security/wsAuth.js'));
});

function makeFakeSocket() {
  return {
    readyState: WebSocket.OPEN,
    send: () => {},
    close: () => {},
    on: () => {},
  } as any;
}

function buildCall(callSid: string) {
  const call: any = new TwilioRealtimeCall(makeFakeSocket());
  call.session = {
    appendTwilioAudio: () => {},
    truncateActiveResponse: vi.fn(),
    injectContext: vi.fn(),
    requestResponse: vi.fn(() => true),
    close: vi.fn(),
  };
  call.streamSid = 'STREAMSID';
  call.callSid = callSid;
  if (call.preAuthTimer) {
    clearTimeout(call.preAuthTimer);
    call.preAuthTimer = undefined;
  }
  return call;
}

/** The last TwiML string handed to the Twilio REST redirect. */
function lastDialTwiml(): string {
  const call = updateMock.mock.calls[updateMock.mock.calls.length - 1];
  return (call?.[0] as { twiml: string }).twiml;
}

describe('handleTransferToOwner — timed dial with a dial-status action', () => {
  let recordToolCallSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    // Tuesday 2 PM: inside Richa's transfer window, so the handler reaches
    // the dial branch (see twilioStream.transferHours.test.ts).
    vi.setSystemTime(new Date('2026-08-25T14:00:00-04:00'));
    updateMock.mockClear().mockResolvedValue({});
    callsMock.mockClear();
    recordToolCallSpy = vi
      .spyOn(CallStore, 'recordToolCall')
      .mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    recordToolCallSpy.mockRestore();
  });

  it('with a known public host: <Dial> carries the timeout and the absolute action URL', async () => {
    const call = buildCall('CA_dial_action');
    call.publicHost = 'erica.up.railway.app';

    const result = await call.handleTransferToOwner({
      reason: 'wants to speak with Richa',
    });

    expect(result).toEqual({ transferred: true });
    expect(callsMock).toHaveBeenCalledWith('CA_dial_action');
    expect(lastDialTwiml()).toBe(
      `<Response><Dial timeout="${env.TRANSFER_DIAL_TIMEOUT_S}" ` +
        `action="https://erica.up.railway.app/twilio/dial-status" method="POST">` +
        `${env.OWNER_PHONE}</Dial></Response>`
    );
    // Shorter than a typical carrier voicemail pickup (~20–25s) — that IS the
    // point of the timeout, so lock it in.
    expect(env.TRANSFER_DIAL_TIMEOUT_S).toBeLessThan(20);
  });

  it('a successful handoff also texts Richa an FYI (voicemail pickups look "completed" — this is the salon-side trail)', async () => {
    const call = buildCall('CA_dial_fyi');
    call.publicHost = 'erica.up.railway.app';
    const notifyOwnerSms = vi
      .fn()
      .mockResolvedValue({ queued: true, sid: 'SM_failback' });
    call.notifyOwnerSms = notifyOwnerSms;

    const result = await call.handleTransferToOwner({
      reason: 'wants to speak with Richa about a bridal party',
    });

    expect(result).toEqual({ transferred: true });
    expect(notifyOwnerSms).toHaveBeenCalledTimes(1);
    expect(notifyOwnerSms.mock.calls[0]?.[0]).toMatch(
      /A caller called and was transferred to your phone/
    );
    expect(notifyOwnerSms.mock.calls[0]?.[0]).not.toMatch(/bridal party/);
  });

  it('with NO public host (old/edge session): byte-identical to the original bare <Dial>', async () => {
    const call = buildCall('CA_dial_bare');
    expect(call.publicHost).toBeUndefined();

    const result = await call.handleTransferToOwner({
      reason: 'group booking',
    });

    expect(result).toEqual({ transferred: true });
    // Never a half-configured action: no action attribute, no timeout.
    expect(lastDialTwiml()).toBe(
      `<Response><Dial>${env.OWNER_PHONE}</Dial></Response>`
    );
  });
});

describe('handleTransferToOwner — a failback segment never dials again', () => {
  let recordToolCallSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    // Deliberately INSIDE the transfer window and outside any vacation: the
    // only thing stopping the dial must be the failback flag itself.
    vi.setSystemTime(new Date('2026-08-25T14:00:00-04:00'));
    updateMock.mockClear().mockResolvedValue({});
    callsMock.mockClear();
    recordToolCallSpy = vi
      .spyOn(CallStore, 'recordToolCall')
      .mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    recordToolCallSpy.mockRestore();
  });

  it('offers the separate message path without dialing or synthesizing an SMS', async () => {
    const call = buildCall('CA_failback_msg');
    call.transferFailback = true;
    call.publicHost = 'erica.up.railway.app';
    const notifyOwnerSms = vi
      .fn()
      .mockResolvedValue({ queued: true, sid: 'SM_transfer_fyi' });
    call.notifyOwnerSms = notifyOwnerSms;

    const result = await call.handleTransferToOwner({
      reason: 'asking about a bridal package',
    });

    expect(result).toEqual({
      transferred: false,
      messageRequired: true,
      note: expect.stringContaining('leave_message_for_owner'),
    });
    // The whole point: no second dial, at any hour.
    expect(updateMock).not.toHaveBeenCalled();
    expect(notifyOwnerSms).not.toHaveBeenCalled();
    // The note must tell the model the truth without claiming a message exists.
    expect(result.note).toMatch(/rang out on this call/);
    expect(call.outcome).toBe('none');
    expect(recordToolCallSpy).toHaveBeenCalledWith(
      'CA_failback_msg',
      expect.objectContaining({
        name: 'transfer_to_owner',
        ok: false,
        error: 'Owner already did not answer',
      })
    );
  });
});

describe('failback session start — no duplicate start/recording rows', () => {
  let startCallSpy: ReturnType<typeof vi.spyOn>;
  let endCallSpy: ReturnType<typeof vi.spyOn>;
  let originalRecordCalls: string;

  beforeEach(() => {
    originalRecordCalls = env.RECORD_CALLS;
    env.RECORD_CALLS = 'true';
    recordingsCreateMock.mockClear();
    callsMock.mockClear();
    startCallSpy = vi
      .spyOn(CallStore, 'startCall')
      .mockImplementation(() => {});
    endCallSpy = vi.spyOn(CallStore, 'endCall').mockImplementation(() => {});
  });

  afterEach(() => {
    env.RECORD_CALLS = originalRecordCalls;
    startCallSpy.mockRestore();
    endCallSpy.mockRestore();
  });

  async function driveStart(customParameters: Record<string, string>) {
    const call: any = new TwilioRealtimeCall(makeFakeSocket());
    const callSid = customParameters.__callSid ?? 'CA_failback_start';
    delete customParameters.__callSid;
    await call.handleMessage(
      Buffer.from(
        JSON.stringify({
          event: 'start',
          start: {
            streamSid: 'STREAM_failback',
            callSid,
            customParameters: {
              token: issueStreamToken(callSid),
              ...customParameters,
            },
          },
        })
      )
    );
    return call;
  }

  it('transferFailed=1: skips CallStore.startCall AND the second recording, but still sets startedAtMs', async () => {
    const call = await driveStart({
      transferFailed: '1',
      host: 'erica.up.railway.app',
    });

    // The callSid already has a start row and a LIVE recording from segment 1.
    expect(startCallSpy).not.toHaveBeenCalled();
    expect(recordingsCreateMock).not.toHaveBeenCalled();
    // Instance state is untouched — durations/cleanup still work.
    expect(call.startedAtMs).toBeTypeOf('number');
    expect(call.transferFailback).toBe(true);
    expect(call.publicHost).toBe('erica.up.railway.app');

    call.cleanup();
    expect(endCallSpy).toHaveBeenCalledTimes(1);
  });

  it('a normal (non-failback) start still writes the start row and starts recording', async () => {
    const call = await driveStart({
      __callSid: 'CA_normal_start',
      host: 'erica.up.railway.app',
    });

    expect(startCallSpy).toHaveBeenCalledTimes(1);
    expect(recordingsCreateMock).toHaveBeenCalledTimes(1);
    expect(call.transferFailback).toBe(false);

    call.cleanup();
  });

  it('a malformed host parameter is dropped rather than templated into TwiML', async () => {
    const call = await driveStart({
      __callSid: 'CA_bad_host',
      host: 'evil.com"><Say>pwned</Say><Dial>+15550000000',
    });

    expect(call.publicHost).toBeUndefined();

    call.cleanup();
  });
});
