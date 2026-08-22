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

// A1 added a fresh-availability re-check immediately before every booking
// write (see tasks/agent_queue.md A1) — it calls phorest.getAvailability for
// the service+date and rejects a write whose time isn't in the freshly
// snapped/hours-filtered result. The F1/F2 tests below are about clientId
// injection, not availability, so they mock getAvailability to return a
// single grid-aligned slot ("13:15", a multiple of the 15-min SLOT_GRID_MIN
// default) that legitimately survives snapSlotsToGrid, and book that exact
// time — giving the new re-check real data to pass instead of accidentally
// exercising it. (The mock module's own default getAvailability — 13:20/
// 13:50/14:20 — deliberately does NOT survive snapping: none of those raw
// times sit on the 15-min grid and none has a same-grid successor to earn a
// snap-up, so every plain handleBookAppointment call needs its own override
// here rather than relying on the shared default.)
describe('F1 — book_appointment schema keeps clientId + allows name-only booking', () => {
  it('an explicit clientId survives zod validation and reaches createAppointment', async () => {
    vi.spyOn(phorest, 'getAvailability').mockResolvedValue([
      '2025-10-01T13:15:00',
    ]);
    const spy = vi.spyOn(phorest, 'createAppointment');
    const call = buildCall();
    const res = await call.handleBookAppointment({
      serviceName: 'Lash Lift',
      date: '2025-10-01',
      time: '13:15',
      clientId: 'c_explicit', // previously stripped by zod strip-mode
      customer: { name: 'Jane Smith' }, // no phone
    });
    expect(res.error).toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![3]).toBe('c_explicit');
  });

  it('a recognized caller books name-only (no phone) without a validation error', async () => {
    vi.spyOn(phorest, 'getAvailability').mockResolvedValue([
      '2025-10-01T13:15:00',
    ]);
    const spy = vi.spyOn(phorest, 'createAppointment');
    const call = buildCall();
    call.prefetch = { ...MOM };
    const res = await call.handleBookAppointment({
      serviceName: 'Lash Lift',
      date: '2025-10-01',
      time: '13:15',
      customer: { name: 'Mom Smith' }, // no phone, no clientId
    });
    expect(res.error).toBeUndefined();
    // prefetch clientId injected because the name matches the recognized account
    expect(spy.mock.calls[0]![3]).toBe('mom1');
  });
});

describe('F2 — prefetch clientId injection respects the given name (shared family phone)', () => {
  it('daughter on mom’s recognized phone giving her OWN name does NOT book under mom', async () => {
    vi.spyOn(phorest, 'getAvailability').mockResolvedValue([
      '2025-10-01T13:15:00',
    ]);
    const spy = vi.spyOn(phorest, 'createAppointment');
    const call = buildCall();
    call.prefetch = { ...MOM };
    const res = await call.handleBookAppointment({
      serviceName: 'Lash Lift',
      date: '2025-10-01',
      time: '13:15',
      customer: { name: 'Daughter Smith', phone: '5559998888' },
    });
    expect(res.error).toBeUndefined();
    // No clientId injected -> getOrCreateClient's name guard runs (not pinned to mom)
    expect(spy.mock.calls[0]![3]).toBeUndefined();
    // Her own phone flows through; mom's prefetch phone is NOT backfilled
    expect((spy.mock.calls[0]![2] as { phone?: string }).phone).toBe(
      '5559998888'
    );
  });

  it('a matching first name still books under the recognized account', async () => {
    vi.spyOn(phorest, 'getAvailability').mockResolvedValue([
      '2025-10-01T13:15:00',
    ]);
    const spy = vi.spyOn(phorest, 'createAppointment');
    const call = buildCall();
    call.prefetch = { ...MOM };
    await call.handleBookAppointment({
      serviceName: 'Lash Lift',
      date: '2025-10-01',
      time: '13:15',
      customer: { name: 'Mom Smith' },
    });
    expect(spy.mock.calls[0]![3]).toBe('mom1');
  });
});

describe('F6 — reschedule validates the new time against offered slots', () => {
  it('rejects a time we never offered for that date', async () => {
    const spy = vi.spyOn(phorest, 'updateAppointment');
    const call = buildCall();
    call.servedAppointmentIds.add('appt1');
    call.offeredSlots.set('lash lift|2025-10-02', new Set(['10:00', '11:00']));
    const res = await call.handleReschedule({
      appointmentId: 'appt1',
      date: '2025-10-02',
      time: '16:00', // never offered
    });
    expect(res.error).toMatch(/available|open times/i);
    expect(spy).not.toHaveBeenCalled();
  });

  it('allows a time that WAS offered for that date', async () => {
    const spy = vi.spyOn(phorest, 'updateAppointment');
    const call = buildCall();
    call.servedAppointmentIds.add('appt1');
    call.offeredSlots.set('lash lift|2025-10-02', new Set(['10:00', '11:00']));
    const res = await call.handleReschedule({
      appointmentId: 'appt1',
      date: '2025-10-02',
      time: '11:00',
    });
    expect(res.error).toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('falls open (allows) when no slots were offered for that date', async () => {
    const spy = vi.spyOn(phorest, 'updateAppointment');
    const call = buildCall();
    call.servedAppointmentIds.add('appt1');
    const res = await call.handleReschedule({
      appointmentId: 'appt1',
      date: '2025-10-02',
      time: '11:00',
    });
    expect(res.error).toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
