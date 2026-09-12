import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { parseToolArgs } from '../realtime/toolSchemas.js';
import { phorest } from '../services/phorest.js';

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
  call.callSid = 'CA_service_id';
  return call;
}

const DATE = '2025-10-01';

describe('canonical serviceId controller seam', () => {
  it('survives Zod and uses the canonical ID for availability despite an ambiguous serviceName', async () => {
    const parsed = parseToolArgs('suggest_availability', {
      serviceName: 'wax',
      serviceId: 'svc_lash_lift',
      date: DATE,
    });
    expect(parsed).toMatchObject({
      success: true,
      data: expect.objectContaining({ serviceId: 'svc_lash_lift' }),
    });

    const availability = vi
      .spyOn(phorest, 'getAvailability')
      .mockResolvedValue([`${DATE}T13:15:00`]);
    const result = await buildCall().handleSuggestAvailability({
      serviceName: 'wax',
      serviceId: 'svc_lash_lift',
      date: DATE,
    });

    expect(result).toMatchObject({ service: 'Lash Lift' });
    expect(availability).toHaveBeenCalledWith('svc_lash_lift', DATE);
  });

  it('uses the canonical ID for the fresh check and the actual booking despite an ambiguous serviceName', async () => {
    const availability = vi
      .spyOn(phorest, 'getAvailability')
      .mockResolvedValue([`${DATE}T13:15:00`]);
    const create = vi
      .spyOn(phorest, 'createAppointment')
      .mockResolvedValue({ appointmentId: 'sim_appt_controller' });
    const result = await buildCall().handleBookAppointment({
      serviceName: 'wax',
      serviceId: 'svc_lash_lift',
      date: DATE,
      time: '13:15',
      customer: { name: 'Test Caller', phone: '4105550000' },
    });

    expect(result.error).toBeUndefined();
    expect(availability).toHaveBeenCalledWith('svc_lash_lift', DATE);
    expect(create).toHaveBeenCalledWith(
      'svc_lash_lift',
      `${DATE}T13:15:00`,
      { name: 'Test Caller', phone: '4105550000' },
      undefined
    );
  });

  it('rejects an unknown canonical ID without falling back to the name match or reaching availability/write', async () => {
    const availability = vi.spyOn(phorest, 'getAvailability');
    const create = vi.spyOn(phorest, 'createAppointment');
    const call = buildCall();

    const suggested = await call.handleSuggestAvailability({
      serviceName: 'Lash Lift',
      serviceId: 'svc_no_such_service',
      date: DATE,
    });
    const booked = await call.handleBookAppointment({
      serviceName: 'Lash Lift',
      serviceId: 'svc_no_such_service',
      date: DATE,
      time: '13:15',
      customer: { name: 'Test Caller' },
    });

    expect(suggested.error).toMatch(/unknown service id/i);
    expect(booked.error).toMatch(/unknown service id/i);
    expect(availability).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('keeps the legacy name-only service path working', async () => {
    const availability = vi
      .spyOn(phorest, 'getAvailability')
      .mockResolvedValue([`${DATE}T13:15:00`]);
    const result = await buildCall().handleSuggestAvailability({
      serviceName: 'Lash Lift',
      date: DATE,
    });

    expect(result).toMatchObject({ service: 'Lash Lift' });
    expect(availability).toHaveBeenCalledWith('svc_lash_lift', DATE);
  });
});
