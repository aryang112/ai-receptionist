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

// AUDIT FIX (2026-09-01): the "FYI Richa after a closed-hours schedule
// change" rule used to be a PROMPT instruction to call transfer_to_owner —
// which live-dials her cell whenever the salon is closed but her transfer
// window is open (Sunday daytime, Monday before noon). It is now a
// deterministic server-side text sent by the cancel/reschedule handlers
// themselves, and only while the salon is closed.

process.env.OPENAI_REALTIME_API_KEY ||= 'test-key';

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

beforeAll(async () => {
  ({ TwilioRealtimeCall } = await import('../realtime/twilioStream.js'));
  ({ CallStore } = await import('../services/callStore.js'));
});

function buildCall() {
  const socket = {
    readyState: WebSocket.OPEN,
    send: () => {},
    close: () => {},
    on: () => {},
  } as any;
  const call: any = new TwilioRealtimeCall(socket);
  call.session = {
    appendTwilioAudio: () => {},
    truncateActiveResponse: vi.fn(),
    injectContext: vi.fn(),
    requestResponse: vi.fn(() => true),
    close: vi.fn(),
  };
  call.streamSid = 'STREAMSID';
  call.callSid = 'CA_fyi';
  call.callerFrom = '+14105551234';
  if (call.preAuthTimer) {
    clearTimeout(call.preAuthTimer);
    call.preAuthTimer = undefined;
  }
  // The appointment was surfaced on this call (ownership guard).
  call.servedAppointmentIds.add('APPT1');
  call.servedAppointmentServices.set('APPT1', 'Brow Threading');
  call.notifyOwnerSms = vi.fn().mockResolvedValue(undefined);
  return call;
}

describe('closed-hours FYI text to Richa (server-side, never a dial)', () => {
  let recordToolCallSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    recordToolCallSpy = vi
      .spyOn(CallStore, 'recordToolCall')
      .mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    recordToolCallSpy.mockRestore();
  });

  it('Sunday 10:30 AM (salon closed, transfer window OPEN): a cancel texts Richa — no transfer involved', async () => {
    vi.setSystemTime(new Date('2026-08-23T10:30:00-04:00')); // Sunday
    const call = buildCall();

    const result = await call.handleCancel({ appointmentId: 'APPT1' });

    expect(result).toEqual({ appointmentId: 'APPT1', cancelled: true });
    expect(call.notifyOwnerSms).toHaveBeenCalledTimes(1);
    const body = call.notifyOwnerSms.mock.calls[0]![0] as string;
    expect(body).toMatch(/while the salon is closed/);
    expect(body).toMatch(/cancelled their Brow Threading/);
    // The caller's number rides along so Richa can actually follow up.
    expect(body).toMatch(/\(410\) 555-1234/);
  });

  it('Sunday 10:30 AM: a reschedule texts Richa with the new time', async () => {
    vi.setSystemTime(new Date('2026-08-23T10:30:00-04:00'));
    const call = buildCall();
    // The A1 fresh re-check fails open on a Phorest error — not under test here.
    call.fetchOpenSlots = vi.fn().mockRejectedValue(new Error('phorest down'));

    await call.handleReschedule({
      appointmentId: 'APPT1',
      date: '2026-08-25',
      time: '13:00',
    });

    expect(call.notifyOwnerSms).toHaveBeenCalledTimes(1);
    expect(call.notifyOwnerSms.mock.calls[0]![0]).toMatch(
      /moved their Brow Threading to 2026-08-25 at 13:00/
    );
  });

  it('Tuesday 2 PM (salon OPEN): no FYI text', async () => {
    vi.setSystemTime(new Date('2026-08-25T14:00:00-04:00'));
    const call = buildCall();

    await call.handleCancel({ appointmentId: 'APPT1' });

    expect(call.notifyOwnerSms).not.toHaveBeenCalled();
  });
});
