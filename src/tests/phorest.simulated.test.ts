import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DateTime } from 'luxon';
import {
  resetSimulatedPhorestOverlay,
  simulatedWrites,
} from '../services/phorest.simulated.js';
import type { AppointmentSummary, PhorestPort } from '../services/phorest.types.js';

const today = DateTime.now().setZone('America/New_York').toISODate()!;

function summary(
  appointmentId: string,
  date = today,
  startTimeRaw = '10:00:00'
): AppointmentSummary {
  return {
    appointmentId,
    serviceName: 'Brow Threading',
    date,
    timeDisplay: '10:00 AM',
    startTimeRaw,
    endTimeRaw: '10:15:00',
  };
}

function realPort(): PhorestPort & {
  createAppointment: ReturnType<typeof vi.fn>;
  updateAppointment: ReturnType<typeof vi.fn>;
  cancelAppointment: ReturnType<typeof vi.fn>;
  addAppointmentNote: ReturnType<typeof vi.fn>;
  listAppointments: ReturnType<typeof vi.fn>;
  getTodayAppointments: ReturnType<typeof vi.fn>;
} {
  return {
    listServices: vi.fn().mockResolvedValue([
      { id: 'svc_brow', name: 'Brow Threading', price: 15, durationMin: 15 },
    ]),
    getAvailability: vi.fn().mockResolvedValue([]),
    createAppointment: vi.fn().mockResolvedValue({ appointmentId: 'real_write' }),
    updateAppointment: vi.fn().mockResolvedValue({ appointmentId: 'real_write' }),
    cancelAppointment: vi
      .fn()
      .mockResolvedValue({ appointmentId: 'real_write', cancelled: true }),
    lookupCustomerByPhone: vi.fn().mockResolvedValue(null),
    lookupCustomerByName: vi.fn().mockResolvedValue([]),
    listAppointments: vi.fn().mockResolvedValue([summary('real_appt')]),
    addAppointmentNote: vi.fn().mockResolvedValue(undefined),
    getTodayAppointments: vi.fn().mockResolvedValue([summary('real_appt')]),
    preloadClients: vi.fn().mockResolvedValue(undefined),
    listStaffNames: vi.fn().mockResolvedValue(['Richa']),
  };
}

describe('simulated Phorest write overlay', () => {
  beforeEach(() => {
    resetSimulatedPhorestOverlay();
  });

  it('never invokes real write, client-create, or note methods while creating a simulated client and booking', async () => {
    const real = realPort();
    const phorest = simulatedWrites(real);

    const created = await phorest.createAppointment(
      'svc_brow',
      `${today}T13:00:00`,
      { name: 'Sim Client', phone: '+1 (410) 555-1010', email: 'sim@example.test' }
    );

    expect(created).toEqual({ appointmentId: 'sim_appt_1' });
    expect(real.createAppointment).not.toHaveBeenCalled();
    expect(real.updateAppointment).not.toHaveBeenCalled();
    expect(real.cancelAppointment).not.toHaveBeenCalled();
    expect(real.addAppointmentNote).not.toHaveBeenCalled();

    // The generated client survives for subsequent calls in this process and
    // its simulated ID is never passed to any real read endpoint.
    await expect(phorest.lookupCustomerByPhone('4105551010')).resolves.toMatchObject({
      clientId: 'sim_client_1',
      firstName: 'Sim',
      lastName: 'Client',
    });
    await expect(phorest.lookupCustomerByName('Sim', 'Client')).resolves.toEqual([
      expect.objectContaining({ clientId: 'sim_client_1' }),
    ]);
    await expect(phorest.listAppointments('sim_client_1')).resolves.toEqual([
      expect.objectContaining({ appointmentId: 'sim_appt_1', timeDisplay: '1:00 PM' }),
    ]);
    expect(real.listAppointments).not.toHaveBeenCalled();
  });

  it('merges simulated bookings and simulated real-record mutations into calendar reads', async () => {
    const real = realPort();
    const phorest = simulatedWrites(real);

    await phorest.updateAppointment('real_appt', `${today}T11:30:00`);
    await expect(phorest.listAppointments('real_client', today)).resolves.toEqual([
      expect.objectContaining({
        appointmentId: 'real_appt',
        date: today,
        timeDisplay: '11:30 AM',
        startTimeRaw: '11:30:00',
        endTimeRaw: '11:45:00',
      }),
    ]);

    await phorest.cancelAppointment('real_appt');
    await expect(phorest.getTodayAppointments()).resolves.toEqual([]);
    expect(real.updateAppointment).not.toHaveBeenCalled();
    expect(real.cancelAppointment).not.toHaveBeenCalled();
  });

  it('keeps simulated client appointments writable and listable after an update, then hides them after cancel', async () => {
    const real = realPort();
    const phorest = simulatedWrites(real);
    const { appointmentId } = await phorest.createAppointment(
      'svc_brow',
      `${today}T13:00:00`,
      { name: 'Second Sim', phone: '4105552020' }
    );

    await phorest.updateAppointment(appointmentId, `${today}T14:30:00`);
    await expect(phorest.listAppointments('sim_client_1')).resolves.toEqual([
      expect.objectContaining({
        appointmentId,
        timeDisplay: '2:30 PM',
        startTimeRaw: '14:30:00',
        endTimeRaw: '14:45:00',
      }),
    ]);
    await expect(phorest.cancelAppointment(appointmentId)).resolves.toEqual({
      appointmentId,
      cancelled: true,
    });
    await expect(phorest.listAppointments('sim_client_1')).resolves.toEqual([]);
  });

  it('does not delegate unknown simulated IDs or notes to real side-effect methods', async () => {
    const real = realPort();
    const phorest = simulatedWrites(real);

    await phorest.addAppointmentNote('unknown_real_appt', 'test note');
    await phorest.addAppointmentNote('sim_missing', 'test note');
    await expect(
      phorest.updateAppointment('sim_missing', `${today}T14:00:00`)
    ).rejects.toThrow('Unknown simulated appointment');
    await expect(phorest.cancelAppointment('sim_missing')).rejects.toThrow(
      'Unknown simulated appointment'
    );
    await expect(phorest.listAppointments('sim_missing')).resolves.toEqual([]);

    expect(real.addAppointmentNote).not.toHaveBeenCalled();
    expect(real.updateAppointment).not.toHaveBeenCalled();
    expect(real.cancelAppointment).not.toHaveBeenCalled();
    expect(real.listAppointments).not.toHaveBeenCalled();
  });

  it('reset removes process-wide overlay data between comparison variants', async () => {
    const real = realPort();
    const first = simulatedWrites(real);
    await first.createAppointment('svc_brow', `${today}T13:00:00`, {
      name: 'Reset Me',
      phone: '4105553030',
    });
    resetSimulatedPhorestOverlay();

    const second = simulatedWrites(real);
    await expect(second.lookupCustomerByPhone('4105553030')).resolves.toBeNull();
    await expect(second.createAppointment('svc_brow', `${today}T13:00:00`, {
      name: 'Fresh Variant',
    })).resolves.toEqual({ appointmentId: 'sim_appt_1' });
  });
});
