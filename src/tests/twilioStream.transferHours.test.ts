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

// 2026-08-23 (Aryan-confirmed behavior): live transfers ring Richa's PERSONAL
// mobile, so they only happen while the salon is OPEN. After hours (and
// before opening / Sundays / closed dates), transfer_to_owner takes a message
// and texts it to her instead — same machinery as vacation mode. The fatal
// failover is deliberately NOT gated (tested implicitly by not touching it).

process.env.OPENAI_REALTIME_API_KEY ||= 'test-key';

let TwilioRealtimeCall: typeof import('../realtime/twilioStream.js').TwilioRealtimeCall;
beforeAll(async () => {
  ({ TwilioRealtimeCall } = await import('../realtime/twilioStream.js'));
});

function buildCall() {
  const socket: any = {
    readyState: WebSocket.OPEN,
    send: () => {},
    close: () => {},
    on: () => {},
  };
  const call: any = new TwilioRealtimeCall(socket);
  call.session = {
    appendTwilioAudio: () => {},
    truncateActiveResponse: vi.fn(),
    injectContext: vi.fn(),
    requestResponse: vi.fn(() => true),
    close: vi.fn(),
  };
  call.streamSid = 'STREAMSID';
  // callSid deliberately unset: the OPEN-hours dial branch then hits its
  // existing "missing Twilio client or callSid" guard instead of a real REST
  // call — reaching that guard IS the proof the dial branch was taken.
  return call;
}

describe('transfer_to_owner — after-hours gate', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('AFTER HOURS (Tue 9pm, not vacation): no dial — SMS message + {transferred:false}', async () => {
    vi.setSystemTime(new Date('2026-08-25T21:00:00-04:00'));
    const call = buildCall();
    const notifyOwnerSms = vi.fn().mockResolvedValue(undefined);
    call.notifyOwnerSms = notifyOwnerSms;

    const result = await call.handleTransferToOwner({
      reason: 'wants to discuss a bridal package',
    });

    expect(result).toEqual({
      transferred: false,
      note: expect.stringContaining('reopens'),
    });
    expect(notifyOwnerSms).toHaveBeenCalledTimes(1);
    expect(notifyOwnerSms.mock.calls[0]?.[0]).toMatch(/After-hours message/);
    expect(notifyOwnerSms.mock.calls[0]?.[0]).toMatch(/bridal package/);
  });

  it('OPEN HOURS (Tue 2pm): proceeds to the dial branch (no message SMS)', async () => {
    vi.setSystemTime(new Date('2026-08-25T14:00:00-04:00'));
    const call = buildCall();
    const notifyOwnerSms = vi.fn().mockResolvedValue(undefined);
    call.notifyOwnerSms = notifyOwnerSms;

    const result = await call.handleTransferToOwner({
      reason: 'wants to speak with Richa',
    });

    // No REST client in tests → the dial branch's own guard returns this —
    // proof the handler chose to DIAL, not to take a message.
    expect(result).toEqual({ error: 'Transfer unavailable' });
    expect(notifyOwnerSms).not.toHaveBeenCalled();
  });

  it('SUNDAY (closed all day): message path even at mid-day', async () => {
    vi.setSystemTime(new Date('2026-08-23T13:00:00-04:00'));
    const call = buildCall();
    const notifyOwnerSms = vi.fn().mockResolvedValue(undefined);
    call.notifyOwnerSms = notifyOwnerSms;

    const result = await call.handleTransferToOwner({ reason: 'question' });

    expect(result.transferred).toBe(false);
    expect(notifyOwnerSms).toHaveBeenCalledTimes(1);
  });
});
