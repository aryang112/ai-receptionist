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

/**
 * W7 (2026-09-17) — the three review-gate findings against `54ed3d2`, all on
 * the Live hangup path. These need a REAL REST close, not the no-client
 * fallback: `endCallNow`'s early "Cannot hang up via REST — closing stream
 * only" branch fires whenever `callSid` is empty (as it is in
 * goodbyeGrace/liveIntegration's harness) and short-circuits BEFORE the
 * playback drain and both content gates. So this file mocks the twilio
 * package (same pattern as twilioStream.transferFailback.test.ts) and sets a
 * callSid, which is the only way the production ordering
 * drain -> gates -> REST hangup is actually exercised.
 *
 * F2 — `farewellAudioConfirmed` accepted ANY fresh acoustic segment as proof
 *      the farewell was spoken. `waitForGoodbyeToStart` proves a new segment
 *      STARTED, never its content (and on Live the response-id half of that
 *      check is inert — liveSession.ts:424 returns null). So the backend
 *      calling end_call on "okay, thanks" while the talking model answers
 *      "Was there anything else I can help with?" produced a REST hangup
 *      immediately after asking the caller a question.
 * F3 — the no-audio close passed no `modelRequestedClose`, so the
 *      "Live playback drain timed out; call left open" abort did not apply and
 *      the hangup fired with `liveOutputActive` still true — audio cut
 *      mid-sentence.
 * F4 — `54ed3d2` changed no-audio from fail-open to close. On reason:'spam'
 *      that is a wordless click on a caller the backend may have mis-tagged.
 */

process.env.OPENAI_REALTIME_API_KEY ||= 'test-key';

const updateMock = vi.fn().mockResolvedValue({});
const callsMock = vi.fn(() => ({
  update: updateMock,
  recordings: { create: vi.fn().mockResolvedValue({ sid: 'RE_test' }) },
}));
vi.mock('twilio', () => ({ default: vi.fn(() => ({ calls: callsMock })) }));

let TwilioRealtimeCall: typeof import('../realtime/twilioStream.js').TwilioRealtimeCall;
let isOpenQuestionText: typeof import('../realtime/twilioStream.js').isOpenQuestionText;

beforeAll(async () => {
  ({ TwilioRealtimeCall, isOpenQuestionText } = await import(
    '../realtime/twilioStream.js'
  ));
});

beforeEach(() => {
  updateMock.mockClear();
  callsMock.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function buildLiveCall() {
  const socket: any = {
    readyState: WebSocket.OPEN,
    send: () => {},
    close: vi.fn(),
    on: () => {},
  };
  const call: any = new TwilioRealtimeCall(socket);
  call.session = {
    appendTwilioAudio: () => {},
    truncateActiveResponse: vi.fn(),
    injectContext: vi.fn(),
    requestResponse: vi.fn(() => true),
    // Live's real value (liveSession.ts:424). The response-id half of
    // waitForGoodbyeToStart is therefore inert on Live — audio-epoch only.
    getCurrentResponseId: vi.fn(() => null),
    close: vi.fn(),
  };
  call.streamSid = 'STREAMSID';
  call.callSid = 'CAw7closecontentgate0000000000000';
  call.sessionReady = true;
  call.started = true;
  call.voiceEngine = 'live';
  // Caller finished speaking 4s ago; Erica has said nothing that looks like a
  // farewell, so end_call takes the ask-for-one path, not "already spoken".
  call.lastCallerSpeechStoppedAt = Date.now() - 4_000;
  call.liveLastOutputStartedAt = Date.now() - 3_000;
  call.liveOutputActive = false;
  call.markQueue = [];
  if (call.preAuthTimer) {
    clearTimeout(call.preAuthTimer);
    call.preAuthTimer = undefined;
  }
  return call;
}

/** The post-tool turn: a fresh acoustic segment plus its output transcript. */
function speakFreshSegment(call: any, text: string) {
  call.outboundAudioEpoch += 1;
  call.liveOutputActive = true;
  call.liveClosingText.push({ ts: Date.now(), text });
}

function finishPlayback(call: any) {
  call.liveOutputActive = false;
  call.markQueue = [];
}

describe('isOpenQuestionText — the F2 negative gate', () => {
  it('flags a turn that handed the caller back the floor', () => {
    expect(
      isOpenQuestionText('Was there anything else I can help with today?')
    ).toBe(true);
    expect(isOpenQuestionText('Anything else?')).toBe(true);
    expect(isOpenQuestionText('What time works for you?')).toBe(true);
    // No question mark, but still an offer, so still not a close.
    expect(isOpenQuestionText('Let me know if there is anything else.')).toBe(
      true
    );
  });

  it('does NOT flag real closes, including one with a mid-string question', () => {
    expect(isOpenQuestionText('See you soon!')).toBe(false);
    expect(isOpenQuestionText('Take care.')).toBe(false);
    expect(isOpenQuestionText('Thanks for calling, have a great day!')).toBe(
      false
    );
    // Trailing-only is deliberate: a mid-string "?" is ordinary in a wrap-up,
    // and flagging it would strand the caller on a silent open line.
    expect(isOpenQuestionText('Sound good? See you Saturday!')).toBe(false);
    expect(isOpenQuestionText('')).toBe(false);
    expect(isOpenQuestionText('   ')).toBe(false);
  });
});

describe('W7/F2 — fresh post-tool audio is not proof the farewell was spoken', () => {
  it('refuses to hang up when the post-tool turn asked the caller a question', async () => {
    vi.useFakeTimers();
    const call = buildLiveCall();

    const result = await call.handleEndCall({ reason: 'done' });
    expect(result).toMatchObject({ ending: true });
    await vi.advanceTimersByTimeAsync(1); // scheduled closer starts waiting

    // The talking model ignores the farewell request and offers more help
    // instead. Fresh audio IS confirmed — this is exactly the evidence
    // `farewellAudioConfirmed` trusted.
    speakFreshSegment(call, 'Was there anything else I can help with today?');
    await vi.advanceTimersByTimeAsync(50);
    expect(call.closed).toBe(false);

    finishPlayback(call);
    await vi.advanceTimersByTimeAsync(200);

    // The caller was just asked a question. The line must still be up.
    expect(call.closed).toBe(false);
    expect(updateMock).not.toHaveBeenCalled();
    // And the close must not hold ownership of the call: `transferring` back
    // down is what lets the silence watchdog (and a later end_call) close it.
    expect(call.transferring).toBe(false);
    expect(call.modelEndCallPending).toBe(false);
    expect(call.endReason).toBeUndefined();
  });

  it('still closes on a real farewell phrased outside FAREWELL_PATTERNS', async () => {
    vi.useFakeTimers();
    const call = buildLiveCall();

    await call.handleEndCall({ reason: 'done' });
    await vi.advanceTimersByTimeAsync(1);
    // `54ed3d2`'s whole point: "See you soon!" is a close even though the
    // precision-first pattern does not recognise it. The negative gate must
    // not undo that.
    speakFreshSegment(call, ' See you soon!');
    await vi.advanceTimersByTimeAsync(50);
    finishPlayback(call);
    await vi.advanceTimersByTimeAsync(200);

    expect(call.closed).toBe(true);
    expect(updateMock).toHaveBeenCalledWith({ status: 'completed' });
  });

  it('closes when the turn contains a recognised farewell after an offer', async () => {
    vi.useFakeTimers();
    const call = buildLiveCall();

    await call.handleEndCall({ reason: 'done' });
    await vi.advanceTimersByTimeAsync(1);
    speakFreshSegment(call, 'Anything else? No? Okay — bye!');
    await vi.advanceTimersByTimeAsync(50);
    finishPlayback(call);
    await vi.advanceTimersByTimeAsync(200);

    expect(call.closed).toBe(true);
  });

  it('ignores the PRE-tool "anything else?" that produced the close', async () => {
    vi.useFakeTimers();
    const call = buildLiveCall();
    // The offer Erica made before the caller said "no thanks, that's all" —
    // it sits in the same rolling buffer. Reading it would abort every single
    // normal hangup, which is why the window is post-request only.
    call.liveClosingText = [
      { ts: Date.now(), text: 'Anything else I can help you with?' },
    ];
    await vi.advanceTimersByTimeAsync(10);

    await call.handleEndCall({ reason: 'done' });
    await vi.advanceTimersByTimeAsync(1);
    speakFreshSegment(call, ' Sounds good, see you then!');
    await vi.advanceTimersByTimeAsync(50);
    finishPlayback(call);
    await vi.advanceTimersByTimeAsync(200);

    expect(call.closed).toBe(true);
  });
});

describe('W7/F3 — the no-audio close must never cut live audio', () => {
  it('aborts instead of hanging up over playback that is still running', async () => {
    vi.useFakeTimers();
    const call = buildLiveCall();
    // One continuous output segment that began BEFORE the tool call and is
    // still running: the output gate needs 600ms of quiet to split segments
    // (liveSession.ts:136-141), so the audio epoch never bumps and
    // waitForGoodbyeToStart times out while Erica is mid-sentence.
    call.liveOutputActive = true;
    call.markQueue = ['live-1'];

    await call.handleEndCall({ reason: 'done' });
    // 5s goodbye wait + 6s playback drain, both timing out.
    await vi.advanceTimersByTimeAsync(12_000);

    expect(call.closed).toBe(false);
    expect(updateMock).not.toHaveBeenCalled();
    expect(call.transferring).toBe(false);
    expect(call.liveOutputCommittedClosed).toBe(false);
  });

  it('closes on the same path once playback has actually finished', async () => {
    vi.useFakeTimers();
    const call = buildLiveCall();

    await call.handleEndCall({ reason: 'done' });
    // No farewell audio ever arrives and nothing is playing — `54ed3d2`'s
    // fix for the ~39s silent open line (CA625dda08…) must survive F3.
    await vi.advanceTimersByTimeAsync(12_000);

    expect(call.closed).toBe(true);
    expect(updateMock).toHaveBeenCalledWith({ status: 'completed' });
  });
});

describe('W7/F4 — a spam close with no spoken decline stays open', () => {
  it('does not hang up wordlessly on a caller who may be mis-tagged', async () => {
    vi.useFakeTimers();
    const call = buildLiveCall();
    call.outcome = 'info';

    const result = await call.handleEndCall({ reason: 'spam' });
    expect(result).toMatchObject({ ending: true });
    await vi.advanceTimersByTimeAsync(12_000);

    expect(call.closed).toBe(false);
    expect(updateMock).not.toHaveBeenCalled();
    // Outcome stays rolled back and no endReason is written, so the admin
    // sweep's `spam` flag (admin.ts computeFlags: outcome === 'spam' ||
    // reason.includes('spam')) cannot fire on a call that was never tagged.
    expect(call.outcome).toBe('info');
    expect(call.endReason).toBeUndefined();
    expect(call.modelEndCallPending).toBe(false);
    expect(call.transferring).toBe(false);
  });

  it('closes a spam call once the decline is actually spoken', async () => {
    vi.useFakeTimers();
    const call = buildLiveCall();
    call.outcome = 'info';

    await call.handleEndCall({ reason: 'spam' });
    await vi.advanceTimersByTimeAsync(1);
    speakFreshSegment(call, 'Sorry, we are not interested. Goodbye.');
    await vi.advanceTimersByTimeAsync(50);
    finishPlayback(call);
    await vi.advanceTimersByTimeAsync(200);

    expect(call.closed).toBe(true);
    expect(call.outcome).toBe('spam');
    expect(call.endReason).toBe('spam decline');
  });

  it('leaves the reason:"done" no-audio close (54ed3d2) intact', async () => {
    vi.useFakeTimers();
    const call = buildLiveCall();

    await call.handleEndCall({ reason: 'done' });
    await vi.advanceTimersByTimeAsync(12_000);

    expect(call.closed).toBe(true);
    expect(call.endReason).toBe('caller confirmed done');
  });
});
