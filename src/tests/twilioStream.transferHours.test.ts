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

// Owner transfers use 9 AM–8 PM on working days. On days off or outside
// the window, offer the separate caller-authored message path without dialing.

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
  // callSid deliberately unset: the in-window dial branch then hits its
  // existing "missing Twilio client or callSid" guard instead of a real REST
  // call — reaching that guard IS the proof the dial branch was taken.
  return call;
}

describe('transfer_to_owner — transfer-window gate', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.each(['2026-09-13T13:00:00-04:00', '2026-12-25T13:00:00-05:00'])(
    'day off %s offers a message instead of dialing',
    async (time) => {
      vi.setSystemTime(new Date(time));
      const call = buildCall();
      call.notifyOwnerSms = vi.fn();
      const result = await call.handleTransferToOwner({
        reason: 'wants to speak with Richa',
      });
      expect(result).toMatchObject({
        transferred: false,
        messageRequired: true,
      });
      expect(call.notifyOwnerSms).not.toHaveBeenCalled();
    }
  );

  it('OUTSIDE WINDOW (Tue 8pm): no dial or synthesized SMS; requests a real message', async () => {
    vi.setSystemTime(new Date('2026-08-25T20:00:00-04:00'));
    const call = buildCall();
    const notifyOwnerSms = vi
      .fn()
      .mockResolvedValue({ queued: true, sid: 'SM_after_hours' });
    call.notifyOwnerSms = notifyOwnerSms;

    const result = await call.handleTransferToOwner({
      reason: 'wants to discuss a bridal package',
    });

    expect(result).toEqual({
      transferred: false,
      messageRequired: true,
      note: expect.stringContaining('leave_message_for_owner'),
    });
    expect(notifyOwnerSms).not.toHaveBeenCalled();
  });

  it('OUTSIDE WINDOW (Tue 7am, before 9): message path, no dial', async () => {
    vi.setSystemTime(new Date('2026-08-25T07:00:00-04:00'));
    const call = buildCall();
    const notifyOwnerSms = vi
      .fn()
      .mockResolvedValue({ queued: true, sid: 'SM_morning' });
    call.notifyOwnerSms = notifyOwnerSms;

    const result = await call.handleTransferToOwner({ reason: 'question' });

    expect(result.transferred).toBe(false);
    expect(result.messageRequired).toBe(true);
    expect(notifyOwnerSms).not.toHaveBeenCalled();
  });

  it('OPEN HOURS (Tue 2pm): proceeds to the dial branch (no message SMS)', async () => {
    vi.setSystemTime(new Date('2026-08-25T14:00:00-04:00'));
    const call = buildCall();
    const notifyOwnerSms = vi
      .fn()
      .mockResolvedValue({ queued: true, sid: 'SM_open' });
    call.notifyOwnerSms = notifyOwnerSms;

    const result = await call.handleTransferToOwner({
      reason: 'wants to speak with Richa',
    });

    // No REST client in tests → the dial branch's own guard returns this —
    // proof the handler chose to DIAL, not to take a message.
    expect(result).toEqual({ error: 'Transfer unavailable' });
    expect(notifyOwnerSms).not.toHaveBeenCalled();
  });

  it('AMBIGUOUS AVAILABILITY: asks appointment-versus-transfer before dialing', async () => {
    vi.setSystemTime(new Date('2026-08-25T14:00:00-04:00'));
    const call = buildCall();
    call.transcript = [
      {
        role: 'caller',
        text: 'Hey Erica, is Richard available?',
        ts: Date.now(),
      },
    ];
    const notifyOwnerSms = vi
      .fn()
      .mockResolvedValue({ queued: true, sid: 'SM_ambiguous' });
    call.notifyOwnerSms = notifyOwnerSms;

    const result = await call.handleTransferToOwner({
      reason: 'Caller requested to speak with Richa directly.',
    });

    expect(result).toEqual({
      transferred: false,
      clarificationRequired: true,
      note: expect.stringMatching(/appointment.*live connection/i),
    });
    expect(notifyOwnerSms).not.toHaveBeenCalled();
  });

  it('EXPLICIT CONNECTION: availability wording plus speak request still dials', async () => {
    vi.setSystemTime(new Date('2026-08-25T14:00:00-04:00'));
    const call = buildCall();
    call.transcript = [
      {
        role: 'caller',
        text: 'Is Richa available? I need to speak with her.',
        ts: Date.now(),
      },
    ];
    const notifyOwnerSms = vi
      .fn()
      .mockResolvedValue({ queued: true, sid: 'SM_explicit' });
    call.notifyOwnerSms = notifyOwnerSms;

    const result = await call.handleTransferToOwner({
      reason: 'Caller explicitly asked to speak with Richa.',
    });

    expect(result).toEqual({ error: 'Transfer unavailable' });
    expect(notifyOwnerSms).not.toHaveBeenCalled();
  });

  it('THE HOLLY FIX — Mon 11:46am (14 min before noon opening): DIALS', async () => {
    // Holly's actual call: Monday 2026-08-24, 11:46 AM — salon opens at
    // noon, so the old salon-hours gate blocked the dial and Erica had to
    // walk back her "let me get Richa" promise. Richa was demonstrably
    // awake (she was receiving the SMS messages).
    vi.setSystemTime(new Date('2026-08-24T11:46:00-04:00'));
    const call = buildCall();
    const notifyOwnerSms = vi
      .fn()
      .mockResolvedValue({ queued: true, sid: 'SM_holly' });
    call.notifyOwnerSms = notifyOwnerSms;

    const result = await call.handleTransferToOwner({
      reason: 'wants to speak with Richa',
    });

    expect(result).toEqual({ error: 'Transfer unavailable' });
    expect(notifyOwnerSms).not.toHaveBeenCalled();
  });

  it('SALON CLOSED but inside window (Tue 9:30am / Tue 7:59pm): DIALS', async () => {
    for (const time of [
      '2026-08-25T09:30:00-04:00', // before the salon opens at noon
      '2026-08-25T19:59:00-04:00', // after the salon closed at 7pm
    ]) {
      vi.setSystemTime(new Date(time));
      const call = buildCall();
      const notifyOwnerSms = vi
        .fn()
        .mockResolvedValue({ queued: true, sid: 'SM_closed' });
      call.notifyOwnerSms = notifyOwnerSms;

      const result = await call.handleTransferToOwner({ reason: 'question' });

      expect(result).toEqual({ error: 'Transfer unavailable' });
      expect(notifyOwnerSms).not.toHaveBeenCalled();
    }
  });
});
