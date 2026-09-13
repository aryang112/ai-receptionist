import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import express from 'express';
import request from 'supertest';
import { env } from '../config/env.js';
import { phorest } from '../services/phorest.js';
import {
  TwilioRealtimeCall,
  liveToolDefinitions,
} from '../realtime/twilioStream.js';
import { twilioVoice } from '../routes/twilio.js';
import { voiceTestStatus } from '../voice/testControl.js';

const old = {
  mode: env.PHOREST_WRITE_MODE,
  engine: env.VOICE_ENGINE,
  sms: env.OWNER_SMS_MODE,
  transfers: env.OWNER_TRANSFER_MODE,
};
const booking = {
  serviceName: 'Brow Threading',
  serviceId: 'svc_brows',
  date: '2026-10-01',
  time: '13:15',
  customer: { name: 'Test Caller' },
};
function call() {
  const c: any = new TwilioRealtimeCall({
    readyState: WebSocket.OPEN,
    send() {},
    close() {},
    on() {},
  } as any);
  c.callSid = 'CA_live_real_contract';
  c.callerFrom = '+12025550198';
  c.session = { close: vi.fn() };
  return c;
}
beforeEach(() => {
  env.PHOREST_WRITE_MODE = 'real';
  env.VOICE_ENGINE = 'live';
  env.OWNER_SMS_MODE = 'simulate';
  env.OWNER_TRANSFER_MODE = 'simulate';
});
afterEach(() => {
  env.PHOREST_WRITE_MODE = old.mode;
  env.VOICE_ENGINE = old.engine;
  env.OWNER_SMS_MODE = old.sms;
  env.OWNER_TRANSFER_MODE = old.transfers;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('Live real appointment boundary', () => {
  it('admits an unlisted direct caller while retaining prepare/confirm tools', async () => {
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use('/twilio', twilioVoice);
    const r = await request(app)
      .post('/twilio/voice')
      .set('Host', 'example.test')
      .type('form')
      .send({ From: '+12025550199', CallSid: 'CA_public_real' });
    expect(r.text).toContain('<Stream');
    expect(r.text).not.toContain('<Reject');
    expect(voiceTestStatus()).toMatchObject({
      writes: 'real',
      callerAccess: 'all',
      ownerNotifications: 'simulate',
      ownerTransfers: 'simulate',
    });
    const names = liveToolDefinitions().map((t) => t.name);
    expect(names).toContain('prepare_appointment_action');
    expect(names).toContain('confirm_appointment_action');
    expect(names).not.toContain('book_appointment');
    expect(names).not.toContain('cancel_appointment');
    expect(names).not.toContain('reschedule_appointment');
  });
  it('real controller executes only after proposal approval and does not label it simulated', async () => {
    const c = call();
    c.handleBookAppointment = vi
      .fn()
      .mockResolvedValue({ appointmentId: 'real_1' });
    const p = c.proposals.prepare({ action: 'book', arguments: booking });
    expect(p.simulated).not.toBe(true);
    expect(c.handleBookAppointment).not.toHaveBeenCalled();
    const result = await c.proposals.confirm({
      proposalId: p.proposalId,
      confirmed: true,
    });
    expect(result).toEqual({ appointmentId: 'real_1' });
    expect(c.handleBookAppointment).toHaveBeenCalledTimes(1);
  });
  it('does not read appointments for a guessed or name-only client ID', async () => {
    const c = call();
    c.clientNames.set('other', 'Other Caller');
    const read = vi.spyOn(phorest, 'listAppointments');
    expect(await c.handleListAppointments({ clientId: 'other' })).toMatchObject(
      { error: expect.stringMatching(/phone/) }
    );
    expect(read).not.toHaveBeenCalled();
  });
  it('binds a phone lookup to subsequent appointment reads', async () => {
    const c = call();
    vi.spyOn(phorest, 'lookupCustomerByPhone').mockResolvedValue({
      clientId: 'c1',
      firstName: 'Test',
      lastName: 'Caller',
    });
    const read = vi.spyOn(phorest, 'listAppointments').mockResolvedValue([]);
    await c.handleLookupCustomer({ phone: '2025550198' });
    expect(
      (await c.handleListAppointments({ clientId: 'c1' })).error
    ).toBeUndefined();
    expect(read).toHaveBeenCalledWith('c1');
  });
  it('does not write a guessed client ID', async () => {
    const c = call();
    const write = vi.spyOn(phorest, 'createAppointment');
    expect(
      await c.handleBookAppointment({ ...booking, clientId: 'other' })
    ).toMatchObject({ error: expect.stringMatching(/phone/) });
    expect(write).not.toHaveBeenCalled();
  });
  it('does not write after a failed fresh availability check', async () => {
    const c = call();
    vi.spyOn(phorest, 'getAvailability').mockRejectedValue(
      new Error('read timed out')
    );
    const write = vi.spyOn(phorest, 'createAppointment');
    expect(await c.handleBookAppointment(booking)).toMatchObject({
      error: expect.stringMatching(/No appointment was booked/),
    });
    expect(write).not.toHaveBeenCalled();
  });
  it('does not reschedule after a failed fresh availability check', async () => {
    const c = call();
    c.servedAppointmentIds.add('a1');
    c.servedAppointmentServices.set('a1', 'Brow Threading');
    vi.spyOn(phorest, 'getAvailability').mockRejectedValue(
      new Error('read timed out')
    );
    const write = vi.spyOn(phorest, 'updateAppointment');
    expect(
      await c.handleReschedule({
        appointmentId: 'a1',
        date: booking.date,
        time: booking.time,
      })
    ).toMatchObject({
      error: expect.stringMatching(/No appointment was moved/),
    });
    expect(write).not.toHaveBeenCalled();
  });
  it('passes a dispatched write uncertainty to the proposal latch', async () => {
    const c = call();
    c.prefetch = {
      clientId: 'c1',
      firstName: 'Test',
      lastName: 'Caller',
      appointments: [],
    };
    vi.spyOn(phorest, 'getAvailability').mockResolvedValue([
      `${booking.date}T13:15:00`,
    ]);
    vi.spyOn(phorest, 'createAppointment').mockRejectedValue(
      Object.assign(new Error('Write unverified'), { outcomeUncertain: true })
    );
    const p = c.proposals.prepare({ action: 'book', arguments: booking });
    expect(
      await c.proposals.confirm({ proposalId: p.proposalId, confirmed: true })
    ).toMatchObject({ outcomeUncertain: true });
    expect(c.prefetch.appointments).toBeNull();
    expect(
      c.proposals.prepare({
        action: 'book',
        arguments: { ...booking, time: '14:00' },
      })
    ).toMatchObject({ outcomeUncertain: true });
  });
  it('real appointments do not implicitly enable owner transfers or SMS', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-14T13:00:00-04:00'));
    const c = call();
    expect(
      await c.handleTransferToOwner({ reason: 'wants to speak with Richa' })
    ).toMatchObject({
      simulated: true,
      transferred: false,
      wouldTransfer: true,
    });
    expect(
      await c.handleLiveMessage({ message: 'Please call me back.' })
    ).toMatchObject({ simulated: true, messageAccepted: true });
  });
});
