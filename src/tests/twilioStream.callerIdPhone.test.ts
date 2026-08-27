import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import WebSocket from 'ws';
import { phorest } from '../services/phorest.js';

// MOBILE_REQUIRED fix (2026-08-27): a NEW caller who accepts "the number
// you're calling from is fine" never dictates digits, so the model passes no
// phone — Phorest then 400s client creation (seen live: two errors, then a
// transfer that rang Richa). The handler must attach the caller-ID number.

process.env.OPENAI_REALTIME_API_KEY ||= 'test-key';

let TwilioRealtimeCall: typeof import('../realtime/twilioStream.js').TwilioRealtimeCall;
beforeAll(async () => {
  ({ TwilioRealtimeCall } = await import('../realtime/twilioStream.js'));
});

afterEach(() => vi.restoreAllMocks());

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
  call.streamSid = 'S';
  return call;
}

const DATE = '2026-09-15'; // an open Tuesday, outside the vacation range

function mockOpenSlot() {
  vi.spyOn(phorest, 'getAvailability').mockResolvedValue([
    `${DATE}T13:00:00`,
  ]);
}

describe('new-client booking attaches the caller-ID phone', () => {
  it('no dictated phone + unrecognized caller → caller-ID number (normalized) is booked', async () => {
    mockOpenSlot();
    const createSpy = vi
      .spyOn(phorest, 'createAppointment')
      .mockResolvedValue({ appointmentId: 'APPT1' } as any);
    const call = buildCall();
    call.callerFrom = '+14435551234';
    const res = await call.handleBookAppointment({
      serviceName: 'Lash Lift',
      date: DATE,
      time: '13:00',
      customer: { name: 'Prashanna K C' },
    });
    expect(res.error).toBeUndefined();
    expect(createSpy).toHaveBeenCalledTimes(1);
    const customerArg = createSpy.mock.calls[0]![2] as { phone?: string };
    expect(customerArg.phone).toBe('4435551234');
  });

  it('a phone the caller dictated always wins over the caller ID', async () => {
    mockOpenSlot();
    const createSpy = vi
      .spyOn(phorest, 'createAppointment')
      .mockResolvedValue({ appointmentId: 'APPT2' } as any);
    const call = buildCall();
    call.callerFrom = '+14435551234';
    const res = await call.handleBookAppointment({
      serviceName: 'Lash Lift',
      date: DATE,
      time: '13:00',
      customer: { name: 'Prashanna K C', phone: '6673598522' },
    });
    expect(res.error).toBeUndefined();
    const customerArg = createSpy.mock.calls[0]![2] as { phone?: string };
    expect(customerArg.phone).toBe('6673598522');
  });

  it('anonymous caller (no caller ID) still books with no phone attached', async () => {
    mockOpenSlot();
    const createSpy = vi
      .spyOn(phorest, 'createAppointment')
      .mockResolvedValue({ appointmentId: 'APPT3' } as any);
    const call = buildCall();
    call.callerFrom = undefined;
    await call.handleBookAppointment({
      serviceName: 'Lash Lift',
      date: DATE,
      time: '13:00',
      customer: { name: 'Prashanna K C' },
    });
    const customerArg = createSpy.mock.calls[0]![2] as { phone?: string };
    expect(customerArg.phone).toBeUndefined();
  });
});
