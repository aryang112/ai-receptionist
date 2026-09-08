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

let TwilioRealtimeCall: typeof import('../realtime/twilioStream.js').TwilioRealtimeCall;
let CallStore: typeof import('../services/callStore.js').CallStore;

beforeAll(async () => {
  ({ TwilioRealtimeCall } = await import('../realtime/twilioStream.js'));
  ({ CallStore } = await import('../services/callStore.js'));
});

/**
 * Build a call wired to a fake socket, with the OpenAI session stubbed out —
 * same pattern as twilioStream.silenceWatchdog.test.ts /
 * twilioStream.durationCap.test.ts. callSid is deliberately left unset (empty
 * string) so endCallNow() takes its "no REST client" fallback branch — no
 * real Twilio API call happens in these tests.
 */
function buildCall() {
  const socket: any = {
    readyState: WebSocket.OPEN,
    send: () => {},
    close: () => {},
    on: () => {},
  };
  const call: any = new TwilioRealtimeCall(socket);
  const injectContext = vi.fn();
  const requestResponse = vi.fn(() => true); // new contract: reports whether response.create fired
  call.session = {
    appendTwilioAudio: () => {},
    truncateActiveResponse: vi.fn(),
    injectContext,
    requestResponse,
    close: vi.fn(),
  };
  call.streamSid = 'STREAMSID';
  call.sessionReady = true;
  call.started = true;
  if (call.preAuthTimer) {
    clearTimeout(call.preAuthTimer);
    call.preAuthTimer = undefined;
  }
  return { call, injectContext, requestResponse };
}

describe('M1 — pushTranscriptEntry: interleaving + caps', () => {
  it('interleaves caller/erica entries in push (= ts) order', () => {
    const { call } = buildCall();
    call.pushTranscriptEntry('caller', 'I need a lash lift');
    call.pushTranscriptEntry('erica', 'Sure, what day works?');
    call.pushTranscriptEntry('caller', 'Tuesday');

    expect(call.transcript).toHaveLength(3);
    expect(call.transcript.map((e: any) => e.role)).toEqual([
      'caller',
      'erica',
      'caller',
    ]);
    expect(call.transcript.map((e: any) => e.text)).toEqual([
      'I need a lash lift',
      'Sure, what day works?',
      'Tuesday',
    ]);
    // ts is non-decreasing across the pushes.
    expect(call.transcript[1].ts).toBeGreaterThanOrEqual(call.transcript[0].ts);
    expect(call.transcript[2].ts).toBeGreaterThanOrEqual(call.transcript[1].ts);
  });

  it('ignores an empty-string transcript (nothing meaningful said)', () => {
    const { call } = buildCall();
    call.pushTranscriptEntry('caller', '');
    expect(call.transcript).toHaveLength(0);
  });

  it('caps at 200 entries, dropping the OLDEST first', () => {
    const { call } = buildCall();
    for (let i = 0; i < 205; i++) {
      call.pushTranscriptEntry(i % 2 === 0 ? 'caller' : 'erica', `msg${i}`);
    }
    expect(call.transcript).toHaveLength(200);
    // The 5 oldest (msg0..msg4) were dropped; msg5 is now the oldest survivor.
    expect(call.transcript[0].text).toBe('msg5');
    expect(call.transcript[199].text).toBe('msg204');
  });

  it('caps at ~16KB total, dropping the OLDEST first', () => {
    const { call } = buildCall();
    const big = 'a'.repeat(7000); // ~7KB of text per entry
    call.pushTranscriptEntry('caller', big + '-1'); // ~7KB total — under cap
    call.pushTranscriptEntry('erica', big + '-2'); // ~14KB total — still under cap
    expect(call.transcript).toHaveLength(2);
    call.pushTranscriptEntry('caller', big + '-3'); // ~21KB — over cap, drops oldest
    expect(call.transcript).toHaveLength(2);
    expect(call.transcript[0].text).toBe(big + '-2');
    expect(call.transcript[1].text).toBe(big + '-3');
    const bytes = Buffer.byteLength(JSON.stringify(call.transcript), 'utf8');
    expect(bytes).toBeLessThanOrEqual(16 * 1024);
  });
});

describe('M1 — accumulateUsage + estimateCostUsd', () => {
  it('sums usage across turns and counts turns', () => {
    const { call } = buildCall();
    call.accumulateUsage({
      inputTokens: 1000,
      outputTokens: 200,
      cachedTokens: 400,
      totalTokens: 1200,
    });
    call.accumulateUsage({
      inputTokens: 2000,
      outputTokens: 300,
      cachedTokens: 1000,
      totalTokens: 2300,
    });
    expect(call.usageAccum).toEqual({
      inputTokens: 3000,
      outputTokens: 500,
      cachedTokens: 1400,
      turns: 2,
    });
  });

  it('estimateCostUsd applies the cached discount and rounds to 4dp', () => {
    const { call } = buildCall();
    // (3000-1400)*32 + 1400*0.4 + 500*64, all /1e6 = 0.08376 -> rounds to 0.0838
    const cost = call.estimateCostUsd({
      inputTokens: 3000,
      outputTokens: 500,
      cachedTokens: 1400,
    });
    expect(cost).toBeCloseTo(0.0838, 10);
  });

  it('a call with 100% cached input costs less than the same tokens fully uncached', () => {
    const { call } = buildCall();
    const uncached = call.estimateCostUsd({
      inputTokens: 1000,
      outputTokens: 0,
      cachedTokens: 0,
    });
    const cached = call.estimateCostUsd({
      inputTokens: 1000,
      outputTokens: 0,
      cachedTokens: 1000,
    });
    expect(cached).toBeLessThan(uncached);
  });

  // ANALYTICS AUDIT FIX (2026-08-22, P1): text/audio modality cost split.
  it('accumulateUsage sums the text/audio modality split when turns report it', () => {
    const { call } = buildCall();
    call.accumulateUsage({
      inputTokens: 1000,
      outputTokens: 200,
      cachedTokens: 400,
      totalTokens: 1200,
      inputTextTokens: 700,
      inputAudioTokens: 300,
      outputTextTokens: 150,
      outputAudioTokens: 50,
      cachedTextTokens: 400,
      cachedAudioTokens: 0,
    });
    call.accumulateUsage({
      inputTokens: 2000,
      outputTokens: 300,
      cachedTokens: 1000,
      totalTokens: 2300,
      inputTextTokens: 1500,
      inputAudioTokens: 500,
      outputTextTokens: 250,
      outputAudioTokens: 50,
      cachedTextTokens: 900,
      cachedAudioTokens: 100,
    });
    expect(call.usageAccum).toEqual({
      inputTokens: 3000,
      outputTokens: 500,
      cachedTokens: 1400,
      turns: 2,
      inputTextTokens: 2200,
      inputAudioTokens: 800,
      outputTextTokens: 400,
      outputAudioTokens: 100,
      cachedTextTokens: 1300,
      cachedAudioTokens: 100,
    });
  });

  it('estimateCostUsd prices per modality when the text/audio split is present (mixed text+audio)', () => {
    const { call } = buildCall();
    // text: 1000 in (200 cached, 800 uncached), 300 out
    // audio: 500 in (100 cached, 400 uncached), 100 out
    // (800*4 + 200*0.4 + 400*32 + 100*0.4 + 300*24 + 100*64) / 1e6
    // = (3200 + 80 + 12800 + 40 + 7200 + 6400) / 1e6 = 29720/1e6 = 0.0297 (rounded 4dp)
    const cost = call.estimateCostUsd({
      inputTokens: 1500,
      outputTokens: 400,
      cachedTokens: 300,
      inputTextTokens: 1000,
      inputAudioTokens: 500,
      outputTextTokens: 300,
      outputAudioTokens: 100,
      cachedTextTokens: 200,
      cachedAudioTokens: 100,
    });
    expect(cost).toBeCloseTo(0.0297, 10);
  });

  it('estimateCostUsd falls back to the all-audio formula when the split is absent — never NaN, matches the pre-fix math', () => {
    const { call } = buildCall();
    // Identical inputs/expected output to the pre-fix "applies the cached
    // discount" case above — the fallback formula must be byte-identical.
    const cost = call.estimateCostUsd({
      inputTokens: 3000,
      outputTokens: 500,
      cachedTokens: 1400,
    });
    expect(cost).toBeCloseTo(0.0838, 10);
    expect(Number.isNaN(cost)).toBe(false);
  });

  it('estimateCostUsd falls back (never NaN) when the split is only PARTIALLY present', () => {
    const { call } = buildCall();
    // inputAudioTokens/outputAudioTokens missing — hasSplit requires all 4
    // top-level fields, so this must take the fallback path, not crash.
    const cost = call.estimateCostUsd({
      inputTokens: 1000,
      outputTokens: 200,
      cachedTokens: 100,
      inputTextTokens: 600,
      outputTextTokens: 150,
    });
    expect(Number.isNaN(cost)).toBe(false);
    expect(cost).toBeGreaterThan(0);
  });
});

describe('M1 — setEndReasonOnce: first reason wins', () => {
  it('sets the reason the first time', () => {
    const { call } = buildCall();
    call.setEndReasonOnce('duration cap');
    expect(call.endReason).toBe('duration cap');
  });

  it('does NOT overwrite an already-set reason', () => {
    const { call } = buildCall();
    call.setEndReasonOnce('duration cap');
    call.setEndReasonOnce('caller hung up');
    expect(call.endReason).toBe('duration cap');
  });
});

describe("M1 — Twilio 'stop' event records endReason", () => {
  it("records 'caller hung up' when nothing else set a reason first", async () => {
    const { call } = buildCall();
    call.startedAtMs = Date.now() - 5000;
    vi.spyOn(CallStore, 'endCall').mockImplementation(() => {});

    await call.handleMessage(
      Buffer.from(JSON.stringify({ event: 'stop', streamSid: 'STREAMSID' }))
    );

    expect(call.endReason).toBe('caller hung up');
    expect(call.closed).toBe(true);
    vi.restoreAllMocks();
  });

  it('does NOT overwrite a reason already set by an earlier hangup path (first-write-wins)', async () => {
    const { call } = buildCall();
    call.startedAtMs = Date.now() - 5000;
    vi.spyOn(CallStore, 'endCall').mockImplementation(() => {});
    call.setEndReasonOnce('duration cap');

    await call.handleMessage(
      Buffer.from(JSON.stringify({ event: 'stop', streamSid: 'STREAMSID' }))
    );

    expect(call.endReason).toBe('duration cap');
    vi.restoreAllMocks();
  });
});

describe('M1 — cleanup() persists usage, estCostUsd, endReason, and the transcript', () => {
  afterEach(() => vi.restoreAllMocks());

  it('attaches usage + estCostUsd + endReason to the end record, and writes a transcript record', () => {
    const { call } = buildCall();
    call.callSid = 'CA_m1_1';
    call.startedAtMs = Date.now() - 1000;
    const endCallSpy = vi
      .spyOn(CallStore, 'endCall')
      .mockImplementation(() => {});
    const recordTranscriptSpy = vi
      .spyOn(CallStore, 'recordTranscript')
      .mockImplementation(() => {});

    call.accumulateUsage({
      inputTokens: 1000,
      outputTokens: 200,
      cachedTokens: 400,
      totalTokens: 1200,
    });
    call.pushTranscriptEntry('caller', 'Hi');
    call.pushTranscriptEntry('erica', 'Hello!');
    call.setEndReasonOnce('caller confirmed done');
    call.outcome = 'booked';

    call.cleanup();

    expect(endCallSpy).toHaveBeenCalledTimes(1);
    const endArgs = endCallSpy.mock.calls[0]?.[1] as any;
    expect(endArgs.outcome).toBe('booked');
    expect(endArgs.endReason).toBe('caller confirmed done');
    expect(endArgs.usage).toEqual({
      inputTokens: 1000,
      outputTokens: 200,
      cachedTokens: 400,
      turns: 1,
    });
    // (1000-400)*32 + 400*0.4 + 200*64 = 19200 + 160 + 12800 = 32160 / 1e6 = 0.03216 -> 0.0322
    expect(endArgs.estCostUsd).toBeCloseTo(0.0322, 10);

    expect(recordTranscriptSpy).toHaveBeenCalledTimes(1);
    expect(recordTranscriptSpy).toHaveBeenCalledWith('CA_m1_1', [
      expect.objectContaining({ role: 'caller', text: 'Hi' }),
      expect.objectContaining({ role: 'erica', text: 'Hello!' }),
    ]);
  });

  it('omits usage/estCostUsd when no turn ever reported usage, and skips the transcript record when empty', () => {
    const { call } = buildCall();
    call.callSid = 'CA_m1_2';
    call.startedAtMs = Date.now() - 1000;
    const endCallSpy = vi
      .spyOn(CallStore, 'endCall')
      .mockImplementation(() => {});
    const recordTranscriptSpy = vi
      .spyOn(CallStore, 'recordTranscript')
      .mockImplementation(() => {});

    call.cleanup();

    expect(endCallSpy).toHaveBeenCalledTimes(1);
    const endArgs = endCallSpy.mock.calls[0]?.[1] as any;
    expect(endArgs.usage).toBeUndefined();
    expect(endArgs.estCostUsd).toBeUndefined();
    expect(endArgs.endReason).toBeUndefined();
    expect(recordTranscriptSpy).not.toHaveBeenCalled();
  });
});

describe('M1 — endReason for the silence-watchdog hangup path (fake timers)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("the silence-hangup path records endReason 'silence — no response after check-in'", () => {
    const { call } = buildCall();
    call.startedAtMs = Date.now() - 1000;
    const endCallSpy = vi
      .spyOn(CallStore, 'endCall')
      .mockImplementation(() => {});
    call.startSilenceWatchdog();

    vi.advanceTimersByTime(env.SILENCE_CHECKIN_MS); // check-in
    vi.advanceTimersByTime(env.SILENCE_HANGUP_MS); // goodbye requested
    vi.advanceTimersByTime(4000); // grace window elapses -> hangup

    expect(call.closed).toBe(true);
    expect(call.endReason).toBe('silence — no response after check-in');
    expect(endCallSpy).toHaveBeenCalledTimes(1);
    expect((endCallSpy.mock.calls[0]?.[1] as any).endReason).toBe(
      'silence — no response after check-in'
    );
  });
});

describe('M1 — endReason for the duration-cap hangup path (fake timers)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("the duration-cap hangup path records endReason 'duration cap'", () => {
    const { call } = buildCall();
    call.startedAtMs = Date.now() - 1000;
    const endCallSpy = vi
      .spyOn(CallStore, 'endCall')
      .mockImplementation(() => {});
    call.startDurationCap();

    const capMs = env.MAX_CALL_MINUTES * 60 * 1000;
    vi.advanceTimersByTime(capMs); // warning + goodbye
    vi.advanceTimersByTime(4000); // grace window elapses -> hangup

    expect(call.closed).toBe(true);
    expect(call.endReason).toBe('duration cap');
    expect(endCallSpy).toHaveBeenCalledTimes(1);
    expect((endCallSpy.mock.calls[0]?.[1] as any).endReason).toBe(
      'duration cap'
    );
  });
});
