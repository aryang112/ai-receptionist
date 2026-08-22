import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import WebSocket from 'ws';
import { phorest } from '../services/phorest.js';

// A1 (tasks/agent_queue.md): Phorest /booking with force_selected_time books
// whatever we send — a stale offeredSlots entry (caller dawdled, a walk-in
// took the slot, a concurrent call grabbed it) can silently double-book.
// handleBookAppointment/handleReschedule now re-validate availability FRESH,
// immediately before the write, via the extracted fetchOpenSlots() helper —
// the same fetch->snap->hours-filter pipeline handleSuggestAvailability uses.
// These are handler-level tests (drive handleBookAppointment/handleReschedule
// directly, ABOVE the zod seam) against the mock Phorest port.

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
    close: vi.fn(),
  };
  call.streamSid = 'S';
  call.callSid = 'CA_test';
  return call;
}

// 2025-10-01 is a Wednesday (12:00-19:00 per business.json) — same date the
// pre-existing F1/F2 booking tests use.
const BOOK_DATE = '2025-10-01';
// 2025-10-02 is a Thursday (12:00-19:00) — same date the pre-existing F6
// reschedule tests use.
const RESCHEDULE_DATE = '2025-10-02';

describe('A1 — book_appointment re-validates availability fresh before writing', () => {
  it('rejects a STALE offered slot that is no longer in the fresh availability, and does NOT write', async () => {
    // Fresh availability now only has 14:00 — 13:15 (the offered/chosen time)
    // was taken out from under us since it was offered.
    vi.spyOn(phorest, 'getAvailability').mockResolvedValue([
      `${BOOK_DATE}T14:00:00`,
    ]);
    const createSpy = vi.spyOn(phorest, 'createAppointment');
    const call = buildCall();
    // Simulate suggest_availability having offered 13:15 earlier this call.
    call.offeredSlots.set(`lash lift|${BOOK_DATE}`, new Set(['13:15']));

    const res = await call.handleBookAppointment({
      serviceName: 'Lash Lift',
      date: BOOK_DATE,
      time: '13:15',
      customer: { name: 'Jane Smith' },
    });

    expect(res.error).toMatch(/just taken|open times/i);
    expect(res.error).toContain('14:00');
    expect(createSpy).not.toHaveBeenCalled();
    // The stale cache entry is refreshed to reality so the model's very next
    // attempt validates against what's actually open now.
    expect(call.offeredSlots.get(`lash lift|${BOOK_DATE}`)).toEqual(
      new Set(['14:00'])
    );
  });

  it('books a slot that is STILL free on the fresh re-check', async () => {
    vi.spyOn(phorest, 'getAvailability').mockResolvedValue([
      `${BOOK_DATE}T13:15:00`,
      `${BOOK_DATE}T14:00:00`,
    ]);
    const createSpy = vi.spyOn(phorest, 'createAppointment');
    const call = buildCall();
    call.offeredSlots.set(`lash lift|${BOOK_DATE}`, new Set(['13:15']));

    const res = await call.handleBookAppointment({
      serviceName: 'Lash Lift',
      date: BOOK_DATE,
      time: '13:15',
      customer: { name: 'Jane Smith' },
    });

    expect(res.error).toBeUndefined();
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it('fails OPEN (still books) when the fresh availability fetch itself throws', async () => {
    vi.spyOn(phorest, 'getAvailability').mockRejectedValue(
      new Error('Phorest timeout')
    );
    const createSpy = vi.spyOn(phorest, 'createAppointment');
    const call = buildCall();
    call.offeredSlots.set(`lash lift|${BOOK_DATE}`, new Set(['13:15']));

    const res = await call.handleBookAppointment({
      serviceName: 'Lash Lift',
      date: BOOK_DATE,
      time: '13:15',
      customer: { name: 'Jane Smith' },
    });

    expect(res.error).toBeUndefined();
    expect(createSpy).toHaveBeenCalledTimes(1);
  });
});

describe('A1 — reschedule_appointment re-validates availability fresh before writing', () => {
  it('rejects a STALE offered slot on reschedule and does NOT write', async () => {
    // 13:00/14:00 (not 10/11) — RESCHEDULE_DATE's business hours are
    // 12:00-19:00, so the re-check's real hours filter needs in-hours times.
    vi.spyOn(phorest, 'getAvailability').mockResolvedValue([
      `${RESCHEDULE_DATE}T14:00:00`,
    ]);
    const updateSpy = vi.spyOn(phorest, 'updateAppointment');
    const call = buildCall();
    call.servedAppointmentIds.add('appt1');
    // A1: reschedule carries no serviceName — servedAppointmentServices is how
    // the re-check knows which service this appointment is for (populated
    // wherever servedAppointmentIds is, e.g. list_appointments/prefetch).
    call.servedAppointmentServices.set('appt1', 'Lash Lift');
    // Both offered per the pre-existing F6 gate — 13:00 was legitimately
    // offered, but is no longer free on the fresh check.
    call.offeredSlots.set(
      `lash lift|${RESCHEDULE_DATE}`,
      new Set(['13:00', '14:00'])
    );

    const res = await call.handleReschedule({
      appointmentId: 'appt1',
      date: RESCHEDULE_DATE,
      time: '13:00',
    });

    expect(res.error).toMatch(/just taken|open times/i);
    expect(res.error).toContain('14:00');
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('reschedules to a slot that is STILL free on the fresh re-check', async () => {
    vi.spyOn(phorest, 'getAvailability').mockResolvedValue([
      `${RESCHEDULE_DATE}T13:00:00`,
      `${RESCHEDULE_DATE}T14:00:00`,
    ]);
    const updateSpy = vi.spyOn(phorest, 'updateAppointment');
    const call = buildCall();
    call.servedAppointmentIds.add('appt1');
    call.servedAppointmentServices.set('appt1', 'Lash Lift');
    call.offeredSlots.set(
      `lash lift|${RESCHEDULE_DATE}`,
      new Set(['13:00', '14:00'])
    );

    const res = await call.handleReschedule({
      appointmentId: 'appt1',
      date: RESCHEDULE_DATE,
      time: '13:00',
    });

    expect(res.error).toBeUndefined();
    expect(updateSpy).toHaveBeenCalledTimes(1);
  });

  it('fails OPEN (still reschedules) when the fresh availability fetch itself throws', async () => {
    vi.spyOn(phorest, 'getAvailability').mockRejectedValue(
      new Error('Phorest timeout')
    );
    const updateSpy = vi.spyOn(phorest, 'updateAppointment');
    const call = buildCall();
    call.servedAppointmentIds.add('appt1');
    call.servedAppointmentServices.set('appt1', 'Lash Lift');
    call.offeredSlots.set(`lash lift|${RESCHEDULE_DATE}`, new Set(['10:00']));

    const res = await call.handleReschedule({
      appointmentId: 'appt1',
      date: RESCHEDULE_DATE,
      time: '10:00',
    });

    expect(res.error).toBeUndefined();
    expect(updateSpy).toHaveBeenCalledTimes(1);
  });

  it('fails OPEN when the appointment’s service is unknown to this call (no fresh re-check possible)', async () => {
    // Defensive branch: servedAppointmentIds has the ID (ownership guard
    // passes) but servedAppointmentServices was never populated for it — the
    // re-check can't run without knowing which service to ask about, so it
    // must not block a write the ownership/offered-slot gates already passed.
    const getAvailSpy = vi.spyOn(phorest, 'getAvailability');
    const updateSpy = vi.spyOn(phorest, 'updateAppointment');
    const call = buildCall();
    call.servedAppointmentIds.add('appt1');

    const res = await call.handleReschedule({
      appointmentId: 'appt1',
      date: RESCHEDULE_DATE,
      time: '10:00',
    });

    expect(res.error).toBeUndefined();
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(getAvailSpy).not.toHaveBeenCalled();
  });
});
