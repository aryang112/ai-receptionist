import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import WebSocket from 'ws';

// The OpenAI session constructor throws without a key; some import paths reach it.
process.env.OPENAI_REALTIME_API_KEY ||= 'test-key';

let TwilioRealtimeCall: typeof import('../realtime/twilioStream.js').TwilioRealtimeCall;

beforeAll(async () => {
  ({ TwilioRealtimeCall } = await import('../realtime/twilioStream.js'));
});

/**
 * Minimal fake Twilio socket: reports OPEN and records every JSON frame the call
 * sends back to Twilio (media/mark/clear). No real network.
 */
function makeFakeSocket() {
  const sent: any[] = [];
  const socket: any = {
    readyState: WebSocket.OPEN,
    send: (data: string) => sent.push(JSON.parse(data)),
    close: () => {},
    on: () => {},
  };
  return { socket, sent };
}

/**
 * Build a call wired to a fake socket, with the OpenAI session stubbed out so we
 * exercise ONLY the Twilio-side orchestration (buffering, mark bookkeeping,
 * barge-in arming). appendTwilioAudio records the frames actually forwarded.
 */
function buildCall() {
  const { socket, sent } = makeFakeSocket();
  const call: any = new TwilioRealtimeCall(socket);
  const appended: string[] = [];
  call.session = {
    appendTwilioAudio: (p: string) => appended.push(p),
    truncateActiveResponse: vi.fn(),
    close: vi.fn(),
  };
  call.streamSid = 'STREAMSID';
  return { call, sent, appended };
}

function mediaEvent(payload: string, timestamp?: number) {
  return {
    event: 'media',
    media: { payload, ...(timestamp !== undefined ? { timestamp } : {}) },
  };
}

describe('RT-8 — early caller audio is buffered during the OpenAI handshake', () => {
  it('buffers pre-ready media and flushes it in order once the session is ready', () => {
    const { call, appended } = buildCall();
    // Session not ready yet — frames should be buffered, not dropped nor forwarded.
    call.handleMedia(mediaEvent('AAAA'));
    call.handleMedia(mediaEvent('BBBB'));
    expect(appended).toHaveLength(0);
    expect(call.pendingMedia).toEqual(['AAAA', 'BBBB']);

    // Session becomes ready and flushes — order preserved.
    call.sessionReady = true;
    call.flushPendingMedia();
    expect(appended).toEqual(['AAAA', 'BBBB']);
    expect(call.pendingMedia).toHaveLength(0);

    // Subsequent frames now pass straight through.
    call.handleMedia(mediaEvent('CCCC'));
    expect(appended).toEqual(['AAAA', 'BBBB', 'CCCC']);
  });

  it('caps the pre-ready buffer, and flushes only the ~300ms TAIL (2026-08-22 live fix)', () => {
    const { call, appended } = buildCall();
    for (let i = 0; i < 400; i++) call.handleMedia(mediaEvent(`f${i}`));
    // Memory bound unchanged: capped at PENDING_MEDIA_CAP (250) in the buffer.
    expect(call.pendingMedia).toHaveLength(250);
    call.sessionReady = true;
    call.flushPendingMedia();
    // Live fix: replaying the WHOLE handshake buffer fed stale ambient noise
    // to server VAD as a burst — phantom caller "turns" right after the
    // greeting on real calls. Only the last 15 frames (~300ms) are flushed,
    // preserving continuity for a caller actively mid-word at flush time.
    expect(appended).toHaveLength(15);
    expect(appended[0]).toBe('f235'); // the NEWEST tail, not the stale head
    expect(appended[14]).toBe('f249');
    expect(call.pendingMedia).toHaveLength(0);
  });
});

describe('RT-4 — barge-in stays armed through the whole audio tail', () => {
  it('does NOT disarm on response.done — only when Twilio finishes playing (mark queue drains)', () => {
    const { call } = buildCall();
    call.sessionReady = true;
    // Caller media clock advances (Twilio timestamps).
    call.latestMediaTimestamp = 1000;
    // Erica speaks two chunks — first chunk arms responseStartTimestamp, both push marks.
    call.sendAudioToTwilio('mu1');
    call.sendAudioToTwilio('mu2');
    expect(call.responseStartTimestamp).toBe(1000);
    expect(call.markQueue).toHaveLength(2);

    // OpenAI signals the response is done — but Twilio is still playing the tail.
    // RT-4: this must NOT reset the barge-in reference.
    call.handleResponseComplete();
    expect(call.responseStartTimestamp).toBe(1000);
    expect(call.markQueue).toHaveLength(2);
  });

  it('nulls responseStartTimestamp only once the mark queue drains to empty', async () => {
    const { call } = buildCall();
    call.sessionReady = true;
    call.latestMediaTimestamp = 500;
    call.sendAudioToTwilio('mu1');
    call.sendAudioToTwilio('mu2');
    call.handleResponseComplete();

    // First mark ack — one chunk still unplayed, so stay armed.
    await call.handleMessage(Buffer.from(JSON.stringify({ event: 'mark' })));
    expect(call.markQueue).toHaveLength(1);
    expect(call.responseStartTimestamp).toBe(500);

    // Final mark ack drains the queue — NOW barge-in disarms for the next turn.
    await call.handleMessage(Buffer.from(JSON.stringify({ event: 'mark' })));
    expect(call.markQueue).toHaveLength(0);
    expect(call.responseStartTimestamp).toBeNull();
  });

  it('interrupting DURING the tail (after response.done, before drain) truncates and clears', () => {
    const { call, sent } = buildCall();
    call.sessionReady = true;
    call.latestMediaTimestamp = 200;
    call.sendAudioToTwilio('mu1');
    call.sendAudioToTwilio('mu2');
    call.handleResponseComplete(); // tail still playing

    // Caller barges in mid-tail — the elapsed truncation point uses the live clock.
    call.latestMediaTimestamp = 640;
    call.handleBargeIn();
    expect(call.session.truncateActiveResponse).toHaveBeenCalledWith(440);
    // A Twilio `clear` was sent to flush the buffered tail audio.
    expect(sent.some((f) => f.event === 'clear')).toBe(true);
    // And state is reset so the next response re-arms cleanly.
    expect(call.markQueue).toHaveLength(0);
    expect(call.responseStartTimestamp).toBeNull();
  });
});
