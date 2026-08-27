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

let TwilioRealtimeCall: typeof import('../realtime/twilioStream.js').TwilioRealtimeCall;
let CallStore: typeof import('../services/callStore.js').CallStore;

beforeAll(async () => {
  ({ TwilioRealtimeCall } = await import('../realtime/twilioStream.js'));
  ({ CallStore } = await import('../services/callStore.js'));
});

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

function buildCall() {
  const { socket } = makeFakeSocket();
  const call: any = new TwilioRealtimeCall(socket);
  call.session = {
    appendTwilioAudio: vi.fn(),
    truncateActiveResponse: vi.fn(),
    setAutoResponses: vi.fn(),
    requestResponse: vi.fn(() => true),
    injectContext: vi.fn(),
    close: vi.fn(),
  };
  call.streamSid = 'STREAM_watchdog';
  call.sessionReady = true;
  if (call.preAuthTimer) {
    clearTimeout(call.preAuthTimer);
    call.preAuthTimer = undefined;
  }
  return call;
}

function mediaEvent(payload = 'AAAA') {
  return { event: 'media', media: { payload } };
}

// Zombie-stream guard (2026-08-27): two live calls dropped at the carrier
// level without a Twilio 'stop' ever arriving — sessions lingered minutes
// past the real call end. Inbound frames are the liveness ground truth.
describe('media-inactivity watchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(CallStore, 'endCall').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('never fires while inbound frames keep flowing', () => {
    const call = buildCall();
    call.startMediaWatchdog();
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(2000);
      call.handleMedia(mediaEvent());
    }
    expect(call.closed).toBe(false);
    expect(call.endReason).toBeUndefined();
    call.cleanup();
  });

  it('tears the call down once frames stop, with the stream-died endReason', () => {
    const call = buildCall();
    call.startMediaWatchdog();
    call.handleMedia(mediaEvent());
    vi.advanceTimersByTime(15000);
    expect(call.closed).toBe(true);
    expect(call.endReason).toBe('stream died — inbound audio stopped');
  });

  it('fires even with a caller turn stuck open (the prod zombie signature)', () => {
    // The dropped prod call died MID-speech: callerSpeaking stayed true
    // forever, which permanently disarms the silence watchdog. The media
    // watchdog must not consult turn state — frames gone means call gone.
    const call = buildCall();
    call.callerSpeaking = true;
    call.startMediaWatchdog();
    vi.advanceTimersByTime(15000);
    expect(call.closed).toBe(true);
    expect(call.endReason).toBe('stream died — inbound audio stopped');
  });

  it('a normal hangup wins the endReason race and stops the watchdog', () => {
    const call = buildCall();
    call.startMediaWatchdog();
    call.setEndReasonOnce('caller hung up');
    call.cleanup();
    vi.advanceTimersByTime(60000);
    expect(call.endReason).toBe('caller hung up');
  });
});
