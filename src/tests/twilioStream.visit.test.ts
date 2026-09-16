import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import WebSocket from 'ws';
import { phorest } from '../services/phorest.js';

// 2026-09-14, the two-appointment reschedule call. Erica named only the
// soonest appointment, moved it, re-checked availability, and told the caller
// "5:45 is no longer open" about a slot she had just filled herself.
// The unit of work is the VISIT, decided in full before anything is written.

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
  call.callSid = 'CA_test_visit';
  return call;
}

const DATE = '2025-10-01'; // Wednesday, 12:00–19:00
const CLIENT = 'client-1';
const REAL = [
  '17:00', '17:10', '17:15', '17:20', '17:25',
  '17:40', '17:45', '17:50', '17:55',
  '18:05', '18:10', '18:15', '18:20',
];

function mockSlots() {
  vi.spyOn(phorest, 'getAvailability').mockResolvedValue(
    REAL.map((t) => `${DATE}T${t}:00`)
  );
}

function mockAppointments(
  entries: { appointmentId: string; serviceName: string; timeDisplay: string }[]
) {
  vi.spyOn(phorest, 'listAppointments').mockResolvedValue(
    entries.map((e) => ({ ...e, date: DATE, clientId: CLIENT })) as any
  );
}

function result0Start(_call: any) {
  return '17:15';
}

const ONE_SITTING = [
  { appointmentId: 'appt-lip', serviceName: 'Lip Threading', timeDisplay: '6:00 PM' },
  { appointmentId: 'appt-brow', serviceName: 'Brow Threading', timeDisplay: '6:00 PM' },
];

describe('list_appointments names the whole sitting', () => {
  it('tells the model to name EVERY service when the soonest is one sitting', async () => {
    mockAppointments(ONE_SITTING);
    const call = buildCall();
    const result = await call.handleListAppointments({ clientId: CLIENT });
    expect(result.appointments).toHaveLength(2);
    expect(result.note).toMatch(/ONE sitting/i);
    expect(result.note).toMatch(/never just the first/i);
    expect(result.note).toMatch(/reschedule_visit/);
  });

  it('does NOT group a noon and an evening appointment on the same day', async () => {
    // The owner's edge case — same date, five hours apart, two separate trips.
    mockAppointments([
      { appointmentId: 'appt-noon', serviceName: 'Lip Threading', timeDisplay: '12:00 PM' },
      { appointmentId: 'appt-eve', serviceName: 'Brow Threading', timeDisplay: '5:00 PM' },
    ]);
    const call = buildCall();
    const result = await call.handleListAppointments({ clientId: CLIENT });
    expect(result.note).not.toMatch(/ONE sitting/i);
    expect(result.note).toMatch(/Lead with the soonest one/i);
  });
});

describe('reschedule_visit', () => {
  async function servedCall() {
    mockAppointments(ONE_SITTING);
    const call = buildCall();
    await call.handleListAppointments({ clientId: CLIENT });
    mockSlots();
    return call;
  }

  it('plans both services back-to-back on real starts, without writing', async () => {
    const write = vi.spyOn(phorest, 'updateAppointment');
    const call = await servedCall();
    const result = await call.handleRescheduleVisit({
      appointmentIds: ['appt-lip', 'appt-brow'],
      date: DATE,
      preferredTime: '17:45',
    });
    expect(result.planned).toBe(true);
    const first = result.options[0];
    // Mock catalog: Lip Threading is 10 min (the live one is 5), so brow
    // follows at 5:55 here and at 5:50 against the real catalog. Either way
    // the second service starts exactly when the first ends.
    expect(first.items.map((i: any) => i.time)).toEqual(['5:45 PM', '5:55 PM']);
    expect(write).not.toHaveBeenCalled();
    // The coaching must forbid the play-by-play that caused the bug.
    expect(result.note).toMatch(/single yes covering all/i);
    expect(result.note).toMatch(/Never describe the steps/i);
  });

  it('moves both in one confirmed step', async () => {
    const write = vi
      .spyOn(phorest, 'updateAppointment')
      .mockResolvedValue({ ok: true } as any);
    const call = await servedCall();
    await call.handleRescheduleVisit({
      appointmentIds: ['appt-lip', 'appt-brow'],
      date: DATE,
      preferredTime: '17:45',
    });
    const result = await call.handleRescheduleVisit({
      appointmentIds: ['appt-lip', 'appt-brow'],
      date: DATE,
      startTime: '17:45',
      confirmed: true,
    });
    expect(result.rescheduled).toBe(true);
    expect(result.moved).toEqual([
      { service: 'Lip Threading', time: '5:45 PM' },
      { service: 'Brow Threading', time: '5:55 PM' },
    ]);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('asks once if anything else is needed after the visit moves', async () => {
    vi.spyOn(phorest, 'updateAppointment').mockResolvedValue({ ok: true } as any);
    const call = await servedCall();
    await call.handleRescheduleVisit({
      appointmentIds: ['appt-lip', 'appt-brow'],
      date: DATE,
      preferredTime: '17:45',
    });
    const result = await call.handleRescheduleVisit({
      appointmentIds: ['appt-lip', 'appt-brow'],
      date: DATE,
      startTime: '17:45',
      confirmed: true,
    });
    // This note used to say "then stop", which forbade the follow-up question.
    expect(result.note).toMatch(/ask once if they need anything else/i);
    expect(result.note).not.toMatch(/then stop/i);
  });

  it('handles THREE appointments, not just two', async () => {
    mockAppointments([
      { appointmentId: 'a1', serviceName: 'Lip Threading', timeDisplay: '6:00 PM' },
      { appointmentId: 'a2', serviceName: 'Brow Threading', timeDisplay: '6:10 PM' },
      { appointmentId: 'a3', serviceName: 'Eyebrow Tinting', timeDisplay: '6:25 PM' },
    ]);
    const call = buildCall();
    await call.handleListAppointments({ clientId: CLIENT });
    mockSlots();
    const result = await call.handleRescheduleVisit({
      appointmentIds: ['a1', 'a2', 'a3'],
      date: DATE,
      preferredTime: '17:15',
    });
    expect(result.planned).toBe(true);
    expect(result.options[0].items).toHaveLength(3);
    // Each service starts exactly where the previous one ends, and every
    // placed start is a real Phorest start.
    for (const item of result.options[0].items) {
      const [h, m] = item.time.replace(/ (AM|PM)/, '').split(':').map(Number);
      const v = `${String(h + 12).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      expect(REAL).toContain(v);
    }
  });

  it('moves only the SUBSET the caller agreed to, leaving the rest alone', async () => {
    const write = vi
      .spyOn(phorest, 'updateAppointment')
      .mockResolvedValue({ ok: true } as any);
    mockAppointments([
      { appointmentId: 'a1', serviceName: 'Lip Threading', timeDisplay: '6:00 PM' },
      { appointmentId: 'a2', serviceName: 'Brow Threading', timeDisplay: '6:10 PM' },
      { appointmentId: 'a3', serviceName: 'Eyebrow Tinting', timeDisplay: '6:25 PM' },
    ]);
    const call = buildCall();
    await call.handleListAppointments({ clientId: CLIENT });
    mockSlots();
    await call.handleRescheduleVisit({
      appointmentIds: ['a1', 'a3'],
      date: DATE,
      preferredTime: '17:15',
    });
    const result = await call.handleRescheduleVisit({
      appointmentIds: ['a1', 'a3'],
      date: DATE,
      startTime: result0Start(call),
      confirmed: true,
    });
    expect(result.rescheduled).toBe(true);
    expect(result.moved).toHaveLength(2);
    // a2 was never named to the tool, so it must never be written.
    expect(write).toHaveBeenCalledTimes(2);
    const movedIds = write.mock.calls.map((c: any) => c[0]);
    expect(movedIds).not.toContain('a2');
  });

  it('tells the caller plainly when their requested time cannot hold the visit', async () => {
    mockAppointments(ONE_SITTING);
    const call = buildCall();
    await call.handleListAppointments({ clientId: CLIENT });
    mockSlots();
    // 17:30 is another client's appointment, so no plan can start there.
    const result = await call.handleRescheduleVisit({
      appointmentIds: ['appt-lip', 'appt-brow'],
      date: DATE,
      preferredTime: '17:30',
    });
    expect(result.planned).toBe(true);
    expect(result.requestedUnavailable).toBe('5:30 PM');
    expect(result.note).toMatch(/does not fit at 5:30 PM/);
    expect(result.note).toMatch(/never present an alternative as if it were/i);
    expect(result.options.map((o: any) => o.startTime)).not.toContain('17:30');
  });

  it('refuses appointments this call never surfaced', async () => {
    mockSlots();
    const call = buildCall();
    const result = await call.handleRescheduleVisit({
      appointmentIds: ['appt-unknown-a', 'appt-unknown-b'],
      date: DATE,
    });
    expect(result.error).toMatch(/pull up your appointments/i);
  });

  it('says so plainly when the visit cannot fit back-to-back', async () => {
    mockAppointments(ONE_SITTING);
    const call = buildCall();
    await call.handleListAppointments({ clientId: CLIENT });
    vi.spyOn(phorest, 'getAvailability').mockResolvedValue([`${DATE}T17:00:00`]);
    const result = await call.handleRescheduleVisit({
      appointmentIds: ['appt-lip', 'appt-brow'],
      date: DATE,
    });
    expect(result.planned).toBe(false);
    expect(result.note).toMatch(/never move part of the visit without asking/i);
  });
});
