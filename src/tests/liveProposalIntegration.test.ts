import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { env } from '../config/env.js';
import { liveToolDefinitions } from '../realtime/twilioStream.js';

process.env.OPENAI_REALTIME_API_KEY ||= 'test-key';

let TwilioRealtimeCall: typeof import('../realtime/twilioStream.js').TwilioRealtimeCall;
beforeAll(async () => {
  ({ TwilioRealtimeCall } = await import('../realtime/twilioStream.js'));
});

const saved = { voice: env.VOICE_ENGINE, writes: env.PHOREST_WRITE_MODE };

afterEach(() => {
  env.VOICE_ENGINE = saved.voice;
  env.PHOREST_WRITE_MODE = saved.writes;
  vi.restoreAllMocks();
});

function buildLiveCall() {
  env.VOICE_ENGINE = 'live';
  env.PHOREST_WRITE_MODE = 'simulate';
  const socket: any = {
    readyState: WebSocket.OPEN,
    send: () => {},
    close: () => {},
    on: () => {},
  };
  const call: any = new TwilioRealtimeCall(socket);
  call.streamSid = 'S';
  call.callSid = 'CA_live_proposal';
  call.createSession('proposal_test');
  return call;
}

const booking = {
  serviceName: 'Lash Lift',
  serviceId: 'svc_lash_lift',
  date: '2026-10-01',
  time: '13:15',
  customer: { name: 'Test Caller' },
};

describe('Live proposal tool isolation and controller gate', () => {
  it('exposes only prepare/confirm action tools to Live and does not register raw writes', () => {
    const definitions = liveToolDefinitions().map((tool) => tool.name);
    expect(definitions).toEqual(
      expect.arrayContaining([
        'prepare_appointment_action',
        'confirm_appointment_action',
      ])
    );
    for (const rawWrite of [
      'book_appointment',
      'reschedule_appointment',
      'cancel_appointment',
    ]) {
      expect(definitions).not.toContain(rawWrite);
    }

    const call = buildLiveCall();
    const handlers = (call.session as any).toolHandlers as Map<
      string,
      (args: unknown) => Promise<unknown>
    >;
    expect(handlers.has('prepare_appointment_action')).toBe(true);
    expect(handlers.has('confirm_appointment_action')).toBe(true);
    expect(handlers.has('book_appointment')).toBe(false);
    expect(handlers.has('reschedule_appointment')).toBe(false);
    expect(handlers.has('cancel_appointment')).toBe(false);
  });

  it('keeps a Live action side-effect free until registered confirmation, then executes once', async () => {
    const call = buildLiveCall();
    const execute = vi
      .spyOn(call, 'handleBookAppointment')
      .mockResolvedValue({ appointmentId: 'sim_appt_live' });
    const handlers = (call.session as any).toolHandlers as Map<
      string,
      (args: unknown) => Promise<any>
    >;
    const proposal = await handlers.get('prepare_appointment_action')!({
      action: 'book',
      arguments: booking,
    });
    expect(proposal).toMatchObject({
      requiresConfirmation: true,
      simulated: true,
    });
    expect(execute).not.toHaveBeenCalled();

    const result = await handlers.get('confirm_appointment_action')!({
      proposalId: proposal.proposalId,
      confirmed: true,
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining(booking));
    expect(result).toEqual({ appointmentId: 'sim_appt_live', simulated: true });
  });

  it('rejects a registered proposal action after call closure before it can mutate', async () => {
    const call = buildLiveCall();
    const execute = vi
      .spyOn(call, 'handleBookAppointment')
      .mockResolvedValue({ appointmentId: 'sim_appt_live' });
    const handlers = (call.session as any).toolHandlers as Map<
      string,
      (args: unknown) => Promise<any>
    >;
    const proposal = await handlers.get('prepare_appointment_action')!({
      action: 'book',
      arguments: booking,
    });
    call.closed = true;

    await expect(
      handlers.get('confirm_appointment_action')!({
        proposalId: proposal.proposalId,
        confirmed: true,
      })
    ).resolves.toEqual({ error: 'The call has ended; no action was taken.' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('returns a simulated transfer outcome in voice test mode before any dial path', async () => {
    const call = buildLiveCall();

    await expect(call.handleTransferToOwner({})).resolves.toEqual({
      transferred: false,
      simulated: true,
      note: 'This is a test: no live transfer was placed. Offer to take a simulated message.',
    });
  });
});
