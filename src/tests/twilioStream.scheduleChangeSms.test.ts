import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { phorest } from '../services/phorest.js';
import type { AppointmentSummary } from '../services/phorest.types.js';

process.env.OPENAI_REALTIME_API_KEY ||= 'test-key';

let TwilioRealtimeCall: typeof import('../realtime/twilioStream.js').TwilioRealtimeCall;
beforeAll(async () => {
  ({ TwilioRealtimeCall } = await import('../realtime/twilioStream.js'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
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
    close: vi.fn(),
  };
  call.streamSid = 'S';
  call.callSid = 'CA_schedule_change';
  call.prefetch = {
    clientId: 'client-1',
    firstName: 'Priya',
    lastName: 'Shah',
    appointments: null,
  };
  call.clientNames.set('client-1', 'Priya Shah');
  call.notifyOwnerSms = vi
    .fn()
    .mockResolvedValue({ queued: true, sid: 'SM_background' });
  return call;
}

function appointment(
  date: string,
  appointmentId = 'appt-1'
): AppointmentSummary {
  return {
    appointmentId,
    serviceName: 'Eyebrow Threading',
    date,
    timeDisplay: '2:00 PM',
    startTimeRaw: '14:00:00',
    endTimeRaw: '14:15:00',
  };
}

async function surface(call: any, appt: AppointmentSummary) {
  vi.spyOn(phorest, 'listAppointments').mockResolvedValue([appt]);
  await call.handleListAppointments({ clientId: 'client-1' });
}

describe('schedule-change owner FYIs', () => {
  it('texts Richa in code when a closed-salon cancellation affects the next open day', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T17:00:00.000Z')); // 1 PM salon time; away/closed
    vi.spyOn(phorest, 'cancelAppointment').mockResolvedValue({
      appointmentId: 'appt-1',
      cancelled: true,
    });
    const call = buildCall();
    await surface(call, appointment('2026-09-10'));

    const result = await call.handleCancel({ appointmentId: 'appt-1' });

    expect(result).toEqual({ appointmentId: 'appt-1', cancelled: true });
    expect(result.note).toBeUndefined();
    expect(call.notifyOwnerSms).toHaveBeenCalledTimes(1);
    expect(call.notifyOwnerSms.mock.calls[0]?.[0]).toMatch(
      /Priya Shah cancelled their Eyebrow Threading on Thursday, September 10/
    );
  });

  it('texts Richa when a reschedule moves an appointment off the next open day', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T17:00:00.000Z'));
    vi.spyOn(phorest, 'getAvailability').mockResolvedValue([
      '2026-09-11T14:00:00',
    ]);
    vi.spyOn(phorest, 'updateAppointment').mockResolvedValue({
      appointmentId: 'appt-1',
    });
    const call = buildCall();
    await surface(call, appointment('2026-09-10'));

    const result = await call.handleReschedule({
      appointmentId: 'appt-1',
      date: '2026-09-11',
      time: '14:00',
    });

    expect(result.error).toBeUndefined();
    expect(result.note).toBeUndefined();
    expect(call.notifyOwnerSms).toHaveBeenCalledTimes(1);
    expect(call.notifyOwnerSms.mock.calls[0]?.[0]).toMatch(
      /rescheduled their Eyebrow Threading from Thursday, September 10 to Friday, September 11 at 2:00 PM/
    );
  });

  it('texts Richa when a reschedule moves an appointment onto the next open day', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T17:00:00.000Z'));
    vi.spyOn(phorest, 'getAvailability').mockResolvedValue([
      '2026-09-10T14:00:00',
    ]);
    vi.spyOn(phorest, 'updateAppointment').mockResolvedValue({
      appointmentId: 'appt-1',
    });
    const call = buildCall();
    await surface(call, appointment('2026-09-11'));

    await call.handleReschedule({
      appointmentId: 'appt-1',
      date: '2026-09-10',
      time: '14:00',
    });

    expect(call.notifyOwnerSms).toHaveBeenCalledTimes(1);
    expect(call.notifyOwnerSms.mock.calls[0]?.[0]).toMatch(
      /from Friday, September 11 to Thursday, September 10/
    );
  });

  it('uses the new date when the original served date is unavailable', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T17:00:00.000Z'));
    vi.spyOn(phorest, 'updateAppointment').mockResolvedValue({
      appointmentId: 'appt-1',
    });
    const call = buildCall();
    call.servedAppointmentIds.add('appt-1');

    await call.handleReschedule({
      appointmentId: 'appt-1',
      date: '2026-09-10',
      time: '14:00',
    });

    expect(call.notifyOwnerSms).toHaveBeenCalledTimes(1);
  });

  it('does not send an FYI when a closed-salon reschedule stays on later dates', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T17:00:00.000Z'));
    vi.spyOn(phorest, 'getAvailability').mockResolvedValue([
      '2026-09-12T14:00:00',
    ]);
    vi.spyOn(phorest, 'updateAppointment').mockResolvedValue({
      appointmentId: 'appt-1',
    });
    const call = buildCall();
    await surface(call, appointment('2026-09-11'));

    await call.handleReschedule({
      appointmentId: 'appt-1',
      date: '2026-09-12',
      time: '14:00',
    });

    expect(call.notifyOwnerSms).not.toHaveBeenCalled();
  });

  it.each([
    ['before opening', '2026-09-10T15:00:00.000Z'], // 11 AM salon time
    ['after closing', '2026-09-11T00:00:00.000Z'], // Sep 10, 8 PM salon time
  ])('texts for a same-day cancellation %s', async (_label, now) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    vi.spyOn(phorest, 'cancelAppointment').mockResolvedValue({
      appointmentId: 'appt-1',
      cancelled: true,
    });
    const call = buildCall();
    await surface(call, appointment('2026-09-10'));

    await call.handleCancel({ appointmentId: 'appt-1' });

    expect(call.notifyOwnerSms).toHaveBeenCalledTimes(1);
  });

  it('never sends the FYI unless the Phorest write succeeds', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T17:00:00.000Z'));

    const cancelCall = buildCall();
    await surface(cancelCall, appointment('2026-09-10'));
    vi.spyOn(phorest, 'cancelAppointment').mockRejectedValueOnce(
      new Error('cancel failed')
    );
    const cancelResult = await cancelCall.handleCancel({
      appointmentId: 'appt-1',
    });
    expect(cancelResult.error).toMatch(/cancel failed/);
    expect(cancelCall.notifyOwnerSms).not.toHaveBeenCalled();

    vi.restoreAllMocks();
    const rescheduleCall = buildCall();
    await surface(rescheduleCall, appointment('2026-09-10'));
    vi.spyOn(phorest, 'getAvailability').mockResolvedValue([
      '2026-09-11T14:00:00',
    ]);
    vi.spyOn(phorest, 'updateAppointment').mockRejectedValueOnce(
      new Error('reschedule failed')
    );
    const rescheduleResult = await rescheduleCall.handleReschedule({
      appointmentId: 'appt-1',
      date: '2026-09-11',
      time: '14:00',
    });
    expect(rescheduleResult.error).toMatch(/reschedule failed/);
    expect(rescheduleCall.notifyOwnerSms).not.toHaveBeenCalled();
  });

  it('does not send a background FYI for a later date or while the salon is open', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T17:00:00.000Z'));
    vi.spyOn(phorest, 'cancelAppointment').mockResolvedValue({
      appointmentId: 'appt-1',
      cancelled: true,
    });
    const closedCall = buildCall();
    await surface(closedCall, appointment('2026-09-11'));
    await closedCall.handleCancel({ appointmentId: 'appt-1' });
    expect(closedCall.notifyOwnerSms).not.toHaveBeenCalled();

    vi.setSystemTime(new Date('2026-09-10T18:00:00.000Z')); // 2 PM; open
    const openCall = buildCall();
    await surface(openCall, appointment('2026-09-10', 'appt-2'));
    await openCall.handleCancel({ appointmentId: 'appt-2' });
    expect(openCall.notifyOwnerSms).not.toHaveBeenCalled();
  });
});
