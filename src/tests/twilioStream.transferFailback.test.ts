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
import { logger } from '../core/logger.js';

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

/**
 * W11 (2026-09-19): simulate Erica actually SPEAKING the handoff line the
 * tool's result note asked for. A new outbound audio segment bumps
 * outboundAudioEpoch (twilioStream's onOutputSpeechStarted does exactly this
 * on Live) and holds liveOutputActive until it finishes playing.
 */
async function playHandoffLine(call: any, speakingMs = 1200): Promise<void> {
  call.outboundAudioEpoch += 1;
  call.liveOutputActive = true;
  await vi.advanceTimersByTimeAsync(speakingMs);
  call.liveOutputActive = false;
  // Let waitForPlaybackToDrain's 50 ms poll observe the silence.
  await vi.advanceTimersByTimeAsync(200);
}

// ────────────────────────────────────────────────────────────────────────────
// W11 (2026-09-19): SAY-THEN-DIAL IS A SERVER BINDING.
//
// Owner call CA7e755b5cafe1135986b4b14bf8c5a139: Erica said "I'm connecting
// you with Richa now" at +18s; the dial did not go out until +60.7s. The
// backend's response carried the handoff SENTENCE and no tool call, so nothing
// downstream was waiting on anything. The previous call failed in the opposite
// direction (message language, dialled anyway). transfer_to_owner is now
// called ALONE, its RESULT carries the line she speaks, and the SERVER holds
// the dial until that line has played — the handleEndCall/finishModelEndCall
// shape, which succeeded 3/3 on the same calls.
//
// These tests exist to hold BOTH failure directions shut at once:
//   A. dialing before she has spoken  → the caller is cut off mid-sentence
//   B. not dialing after she said she would → the defect above
// ────────────────────────────────────────────────────────────────────────────
describe('handleTransferToOwner — the handoff line is bound to the dial', () => {
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

  it('THE CORE FIX — returns the handoff note with NO dial, then dials once that line has played', async () => {
    const call = buildCall('CA_dial_action');
    call.publicHost = 'erica.up.railway.app';
    call.notifyOwnerSms = vi
      .fn()
      .mockResolvedValue({ queued: true, sid: 'SM_core' });

    const result = await call.handleTransferToOwner({
      reason: 'wants to speak with Richa',
    });

    // PHASE 1. The tool result IS the request for the one spoken line. It is
    // no longer `{transferred:true}` because nothing has been transferred yet.
    expect(result.connecting).toBe(true);
    expect(result.note).toMatch(/connecting them to Richa now/);
    expect(result.note).toMatch(/they may hear her phone ringing/);
    // Direction A held shut: not a single REST call before she speaks.
    expect(updateMock).not.toHaveBeenCalled();
    // …and the silence watchdog is ALREADY stood down (tickSilenceWatchdog
    // bails on `transferring`). This is the "are you still with me?" the
    // caller heard at +45s on the production call.
    expect(call.transferring).toBe(true);

    // Several seconds of her saying nothing yet: still no dial.
    await vi.advanceTimersByTimeAsync(3000);
    expect(updateMock).not.toHaveBeenCalled();

    // She starts the line. Mid-sentence is still NOT a dial (RT-6 drain).
    call.outboundAudioEpoch += 1;
    call.liveOutputActive = true;
    await vi.advanceTimersByTimeAsync(1500);
    expect(updateMock).not.toHaveBeenCalled();

    // She finishes. PHASE 2 — direction B held shut: the dial goes out.
    call.liveOutputActive = false;
    await vi.advanceTimersByTimeAsync(200);

    expect(callsMock).toHaveBeenCalledWith('CA_dial_action');
    expect(lastDialTwiml()).toBe(
      `<Response><Dial timeout="${env.TRANSFER_DIAL_TIMEOUT_S}" ` +
        `action="https://erica.up.railway.app/twilio/dial-status" method="POST">` +
        `${env.OWNER_PHONE}</Dial></Response>`
    );
    // Shorter than a typical carrier voicemail pickup (~20–25s) — that IS the
    // point of the timeout, so lock it in.
    expect(env.TRANSFER_DIAL_TIMEOUT_S).toBeLessThan(20);
    // The salon-side audit row is still written on the dial, not at tool time.
    expect(recordToolCallSpy).toHaveBeenCalledWith(
      'CA_dial_action',
      expect.objectContaining({ name: 'transfer_to_owner', ok: true })
    );
    expect(call.outcome).toBe('transferred');
  });

  it('CALLER SPEECH during the wait does NOT cancel the dial (the deliberate divergence from end_call)', async () => {
    const call = buildCall('CA_dial_bargein');
    call.publicHost = 'erica.up.railway.app';
    call.notifyOwnerSms = vi
      .fn()
      .mockResolvedValue({ queued: true, sid: 'SM_bargein' });

    await call.handleTransferToOwner({ reason: 'wants Richa' });
    expect(updateMock).not.toHaveBeenCalled();

    // "Okay" / "sure" / "thanks" over a one-moment line is the NORMAL sound of
    // a handoff — and a transfer is the thing the caller asked for. end_call
    // aborts on this; the transfer must not, or the 42-second defect is back.
    call.callerSpeechEpoch += 1;
    call.callerSpeaking = true;
    call.bargeInEpoch += 1;
    await vi.advanceTimersByTimeAsync(500);
    call.callerSpeaking = false;

    await playHandoffLine(call);

    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(lastDialTwiml()).toContain('<Dial');
    expect(call.outcome).toBe('transferred');
  });

  it('NO handoff audio inside the cap: dials anyway and says so in the log', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const call = buildCall('CA_dial_no_audio');
    call.publicHost = 'erica.up.railway.app';
    call.notifyOwnerSms = vi
      .fn()
      .mockResolvedValue({ queued: true, sid: 'SM_silent' });

    await call.handleTransferToOwner({ reason: 'wants Richa' });
    expect(updateMock).not.toHaveBeenCalled();

    // The backend never produced the line. Degrading to unexplained ringing is
    // acceptable; silently not dialing is the bug being fixed here.
    await vi.advanceTimersByTimeAsync(20000);

    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(lastDialTwiml()).toContain('<Dial');
    const warned = warnSpy.mock.calls.some((args) =>
      String(args[1] ?? '').includes('dialing anyway')
    );
    expect(warned).toBe(true);
    // Restore here, not in afterEach: vi.restoreAllMocks() would also wipe the
    // vi.mock() factory implementations at the top of this file.
    warnSpy.mockRestore();
  });

  it('the caller hangs up during the wait: no dial at all (never ring Richa for nobody)', async () => {
    const call = buildCall('CA_dial_gone');
    call.publicHost = 'erica.up.railway.app';
    call.notifyOwnerSms = vi.fn();

    await call.handleTransferToOwner({ reason: 'wants Richa' });
    call.closed = true;
    await vi.advanceTimersByTimeAsync(20000);

    expect(updateMock).not.toHaveBeenCalled();
    expect(call.notifyOwnerSms).not.toHaveBeenCalled();
    // Cleared, so a later fatal-error failover is not blocked by a dead flag.
    expect(call.transferring).toBe(false);
  });

  it('a failed redirect clears `transferring` and tells her to offer a message instead', async () => {
    const call = buildCall('CA_dial_boom');
    call.publicHost = 'erica.up.railway.app';
    call.notifyOwnerSms = vi.fn();
    updateMock.mockRejectedValueOnce(new Error('twilio said no'));

    await call.handleTransferToOwner({ reason: 'wants Richa' });
    await playHandoffLine(call);

    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(call.transferring).toBe(false);
    expect(call.outcome).toBe('none');
    // She already told the caller she was connecting them and the tool result
    // is long gone, so the bad news has to be injected.
    expect(call.session.injectContext).toHaveBeenCalledWith(
      expect.stringContaining('could not be placed')
    );
  });

  it('a successful handoff also texts Richa an FYI (voicemail pickups look "completed" — this is the salon-side trail)', async () => {
    const call = buildCall('CA_dial_fyi');
    call.publicHost = 'erica.up.railway.app';
    const notifyOwnerSms = vi
      .fn()
      .mockResolvedValue({ queued: true, sid: 'SM_failback' });
    call.notifyOwnerSms = notifyOwnerSms;

    await call.handleTransferToOwner({
      reason: 'wants to speak with Richa about a bridal party',
    });
    // Still nothing sent while the caller has heard nothing.
    expect(notifyOwnerSms).not.toHaveBeenCalled();

    await playHandoffLine(call);

    expect(notifyOwnerSms).toHaveBeenCalledTimes(1);
    expect(notifyOwnerSms.mock.calls[0]?.[0]).toMatch(
      /A caller called and was transferred to your phone/
    );
    expect(notifyOwnerSms.mock.calls[0]?.[0]).not.toMatch(/bridal party/);
  });

  it('with NO public host (old/edge session): byte-identical to the original bare <Dial>', async () => {
    const call = buildCall('CA_dial_bare');
    call.notifyOwnerSms = vi
      .fn()
      .mockResolvedValue({ queued: true, sid: 'SM_bare' });
    expect(call.publicHost).toBeUndefined();

    await call.handleTransferToOwner({ reason: 'group booking' });
    await playHandoffLine(call);

    // Never a half-configured action: no action attribute, no timeout.
    expect(lastDialTwiml()).toBe(
      `<Response><Dial>${env.OWNER_PHONE}</Dial></Response>`
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// W11: every pre-dial gate must still REFUSE, and must refuse without the
// handoff line. These gates return their own notes and are the reason the
// "connecting you" wording can live in the dial path's note at all — if any of
// them started returning `connecting:true`, a caller would be promised a
// connection during a closure or outside Richa's calling window.
// ────────────────────────────────────────────────────────────────────────────
describe('handleTransferToOwner — every gate still refuses before any dial', () => {
  let recordToolCallSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
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

  it.each([
    [
      'ambiguous "is Richa available?"',
      '2026-08-25T14:00:00-04:00',
      (call: any) => {
        call.transcript = [
          { role: 'caller', text: 'Is Richa available?', ts: Date.now() },
        ];
      },
      'clarificationRequired',
    ],
    [
      'failback — she already did not answer on this call',
      '2026-08-25T14:00:00-04:00',
      (call: any) => {
        call.transferFailback = true;
      },
      'messageRequired',
    ],
    [
      'active salon closure',
      '2026-09-05T16:00:00-04:00',
      () => {},
      'needDiscoveryRequired',
    ],
    [
      'outside the calling window',
      '2026-08-25T20:00:00-04:00',
      () => {},
      'messageRequired',
    ],
  ])('%s: no dial, no handoff line', async (_label, time, prime, flag) => {
    vi.setSystemTime(new Date(time));
    const call = buildCall('CA_gate');
    call.publicHost = 'erica.up.railway.app';
    call.notifyOwnerSms = vi.fn();
    prime(call);

    const result = await call.handleTransferToOwner({ reason: 'wants Richa' });

    expect(result[flag]).toBe(true);
    expect(result.connecting).toBeUndefined();
    expect(result.transferred).toBe(false);
    // The refusal note is the gate's OWN note, never the handoff line.
    expect(result.note).not.toMatch(/phone ringing/i);
    expect(call.transferring).toBe(false);

    // And nothing dials later either — a gate result schedules no finish.
    await vi.advanceTimersByTimeAsync(30000);
    expect(updateMock).not.toHaveBeenCalled();
    expect(call.notifyOwnerSms).not.toHaveBeenCalled();
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

describe('fatal failover respects owner transfer hours', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    updateMock.mockClear();
    env.TWILIO_ACCOUNT_SID = 'AC_test_failover';
    env.TWILIO_AUTH_TOKEN = 'test-token';
  });
  afterEach(() => vi.useRealTimers());
  it.each([
    ['2026-09-14T09:00:00-04:00', true],
    ['2026-09-14T19:59:00-04:00', true],
    ['2026-09-14T20:00:00-04:00', false],
    ['2026-09-14T23:00:00-04:00', false],
    ['2026-09-13T13:00:00-04:00', false],
    ['2026-12-25T13:00:00-05:00', false],
    ['2026-09-02T13:00:00-04:00', false],
  ])('uses the same cutoff for %s', async (time, permitted) => {
    vi.setSystemTime(new Date(time));
    const call = buildCall('CA_failover_hours');
    await call.failoverToOwner('test');
    const twiml = lastDialTwiml();
    expect(twiml.includes('<Dial>')).toBe(permitted);
    expect(twiml.includes('<Hangup/>')).toBe(!permitted);
  });
});
