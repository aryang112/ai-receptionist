import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import WebSocket from 'ws';
import { phorest } from '../services/phorest.js';

// The OpenAI session constructor throws without a key; the call constructor builds one.
process.env.OPENAI_REALTIME_API_KEY ||= 'test-key';

let TwilioRealtimeCall: typeof import('../realtime/twilioStream.js').TwilioRealtimeCall;
beforeAll(async () => {
  ({ TwilioRealtimeCall } = await import('../realtime/twilioStream.js'));
});

afterEach(() => vi.restoreAllMocks());

// Handler-level tests (ABOVE the zod validation seam) — this is exactly where
// F1/F2 slipped: the booking-layer contract tests sit below parseToolArgs, so a
// schema that strips clientId or an unconditional prefetch injection went
// unnoticed. These drive handleBookAppointment the way the model calls it.
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
    close: vi.fn(),
  };
  call.streamSid = 'S';
  call.callSid = 'CA_test';
  return call;
}

const MOM = {
  clientId: 'mom1',
  firstName: 'Mom',
  lastName: 'Smith',
  appointments: null,
  phone: '5551112222',
};

describe('F1 — book_appointment schema keeps clientId + allows name-only booking', () => {
  it('an explicit clientId survives zod validation and reaches createAppointment', async () => {
    const spy = vi.spyOn(phorest, 'createAppointment');
    const call = buildCall();
    const res = await call.handleBookAppointment({
      serviceName: 'Lash Lift',
      date: '2025-10-01',
      time: '13:20',
      clientId: 'c_explicit', // previously stripped by zod strip-mode
      customer: { name: 'Jane Smith' }, // no phone
    });
    expect(res.error).toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![3]).toBe('c_explicit');
  });

  it('a recognized caller books name-only (no phone) without a validation error', async () => {
    const spy = vi.spyOn(phorest, 'createAppointment');
    const call = buildCall();
    call.prefetch = { ...MOM };
    const res = await call.handleBookAppointment({
      serviceName: 'Lash Lift',
      date: '2025-10-01',
      time: '13:20',
      customer: { name: 'Mom Smith' }, // no phone, no clientId
    });
    expect(res.error).toBeUndefined();
    // prefetch clientId injected because the name matches the recognized account
    expect(spy.mock.calls[0]![3]).toBe('mom1');
  });
});

describe('F2 — prefetch clientId injection respects the given name (shared family phone)', () => {
  it('daughter on mom’s recognized phone giving her OWN name does NOT book under mom', async () => {
    const spy = vi.spyOn(phorest, 'createAppointment');
    const call = buildCall();
    call.prefetch = { ...MOM };
    const res = await call.handleBookAppointment({
      serviceName: 'Lash Lift',
      date: '2025-10-01',
      time: '13:20',
      customer: { name: 'Daughter Smith', phone: '5559998888' },
    });
    expect(res.error).toBeUndefined();
    // No clientId injected -> getOrCreateClient's name guard runs (not pinned to mom)
    expect(spy.mock.calls[0]![3]).toBeUndefined();
    // Her own phone flows through; mom's prefetch phone is NOT backfilled
    expect((spy.mock.calls[0]![2] as { phone?: string }).phone).toBe('5559998888');
  });

  it('a matching first name still books under the recognized account', async () => {
    const spy = vi.spyOn(phorest, 'createAppointment');
    const call = buildCall();
    call.prefetch = { ...MOM };
    await call.handleBookAppointment({
      serviceName: 'Lash Lift',
      date: '2025-10-01',
      time: '13:20',
      customer: { name: 'Mom Smith' },
    });
    expect(spy.mock.calls[0]![3]).toBe('mom1');
  });
});
