import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

const maybeSendPostCallSummary = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ sent: false, reason: 'disabled' })
);

vi.mock('../services/postCallSummary.js', () => ({
  maybeSendPostCallSummary,
}));

let TwilioRealtimeCall: typeof import('../realtime/twilioStream.js').TwilioRealtimeCall;
let CallStore: typeof import('../services/callStore.js').CallStore;

beforeAll(async () => {
  ({ TwilioRealtimeCall } = await import('../realtime/twilioStream.js'));
  ({ CallStore } = await import('../services/callStore.js'));
});

function buildCall() {
  const socket: any = {
    readyState: WebSocket.OPEN,
    send: vi.fn(),
    close: vi.fn(),
    on: vi.fn(),
  };
  const call: any = new TwilioRealtimeCall(socket);
  call.session = { close: vi.fn() };
  call.callSid = 'CA_post_call_summary';
  call.callerFrom = '+14435555404';
  call.startedAtMs = Date.now() - 20_000;
  call.endReason = 'caller hung up';
  call.transcript = [
    { role: 'caller', text: 'Are walk-ins available?', ts: 1 },
    { role: 'erica', text: 'We reopen September 10.', ts: 2 },
  ];
  call.prefetch = {
    clientId: 'client-sneha',
    firstName: 'Sneha',
    lastName: 'A',
    appointments: null,
  };
  call.clientNames.set('client-sneha', 'Sneha A');
  if (call.preAuthTimer) {
    clearTimeout(call.preAuthTimer);
    call.preAuthTimer = undefined;
  }
  return call;
}

describe('TwilioRealtimeCall post-call summary handoff', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    maybeSendPostCallSummary.mockClear();
  });

  it('hands one immutable completed-call snapshot to the background notifier', async () => {
    vi.spyOn(CallStore, 'endCall').mockImplementation(() => {});
    vi.spyOn(CallStore, 'recordTranscript').mockImplementation(() => {});
    const call = buildCall();

    call.cleanup();

    await vi.waitFor(() =>
      expect(maybeSendPostCallSummary).toHaveBeenCalledTimes(1)
    );
    expect(maybeSendPostCallSummary).toHaveBeenCalledWith({
      callSid: 'CA_post_call_summary',
      callerPhone: '+14435555404',
      callerName: 'Sneha A',
      transcript: [
        { role: 'caller', text: 'Are walk-ins available?', ts: 1 },
        { role: 'erica', text: 'We reopen September 10.', ts: 2 },
      ],
      outcome: 'none',
      endReason: 'caller hung up',
    });

    // cleanup can be reached from both Twilio and OpenAI close events.
    call.cleanup();
    await Promise.resolve();
    expect(maybeSendPostCallSummary).toHaveBeenCalledTimes(1);
  });
});
