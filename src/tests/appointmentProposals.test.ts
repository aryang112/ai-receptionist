import { describe, expect, it, vi } from 'vitest';
import { AppointmentProposals } from '../voice/appointmentProposals.js';

const booking = {
  serviceName: 'Lash Lift',
  serviceId: 'svc_lash_lift',
  date: '2026-10-01',
  time: '13:15',
  customer: { name: 'Test Caller' },
};

describe('AppointmentProposals', () => {
  it('prepares a validated proposal without executing a write', () => {
    const execute = vi.fn();
    const proposals = new AppointmentProposals(execute, () => true);

    const proposal = proposals.prepare({ action: 'book', arguments: booking });

    expect(proposal).toMatchObject({
      action: 'book',
      simulated: true,
      requiresConfirmation: true,
      summary: 'Book Lash Lift on 2026-10-01 at 13:15',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects unconfirmed and superseded proposals without a write', async () => {
    const execute = vi.fn().mockResolvedValue({ appointmentId: 'sim_appt_1' });
    const proposals = new AppointmentProposals(execute, () => true);
    const first = proposals.prepare({ action: 'book', arguments: booking }) as {
      proposalId: string;
    };
    const second = proposals.prepare({
      action: 'book',
      arguments: { ...booking, time: '14:00' },
    }) as { proposalId: string };

    await expect(
      proposals.confirm({ proposalId: second.proposalId, confirmed: false })
    ).resolves.toMatchObject({
      error: expect.stringMatching(/missing|superseded/i),
    });
    await expect(
      proposals.confirm({ proposalId: first.proposalId, confirmed: true })
    ).resolves.toMatchObject({
      error: expect.stringMatching(/missing|superseded/i),
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('prepares real-mode proposals without a mutation or simulated result', () => {
    const execute = vi.fn();
    const proposals = new AppointmentProposals(
      execute,
      () => true,
      () => false
    );

    const proposal = proposals.prepare({ action: 'book', arguments: booking });

    expect(proposal).toMatchObject({
      action: 'book',
      requiresConfirmation: true,
      summary: 'Book Lash Lift on 2026-10-01 at 13:15',
    });
    expect(proposal).not.toHaveProperty('simulated');
    expect(execute).not.toHaveBeenCalled();
  });

  it('coalesces concurrent real-mode confirms to exactly one mutation', async () => {
    let release!: () => void;
    const mutation = new Promise<void>((resolve) => {
      release = resolve;
    });
    const execute = vi.fn(async () => {
      await mutation;
      return { appointmentId: 'sim_appt_1' };
    });
    const proposals = new AppointmentProposals(
      execute,
      () => true,
      () => false
    );
    const proposal = proposals.prepare({
      action: 'book',
      arguments: booking,
    }) as {
      proposalId: string;
    };

    const first = proposals.confirm({
      proposalId: proposal.proposalId,
      confirmed: true,
    });
    const second = proposals.confirm({
      proposalId: proposal.proposalId,
      confirmed: true,
    });
    // confirm intentionally starts execution in a microtask, which gives both
    // callers the same cached promise before the mutation begins.
    await Promise.resolve();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(
      proposals.prepare({
        action: 'book',
        arguments: { ...booking, time: '14:00' },
      })
    ).toMatchObject({ actionPending: true });
    release();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { appointmentId: 'sim_appt_1' },
      { appointmentId: 'sim_appt_1' },
    ]);
    expect(
      proposals.prepare({
        action: 'book',
        arguments: { ...booking, time: '14:00' },
      })
    ).toMatchObject({ requiresConfirmation: true });
  });

  it('latches an uncertain real outcome and returns its cached result to a duplicate confirm', async () => {
    const execute = vi.fn().mockResolvedValue({
      appointmentId: 'appt_1',
      outcomeUncertain: true,
    });
    const proposals = new AppointmentProposals(
      execute,
      () => true,
      () => false
    );
    const proposal = proposals.prepare({
      action: 'book',
      arguments: booking,
    }) as {
      proposalId: string;
    };

    await expect(
      proposals.confirm({ proposalId: proposal.proposalId, confirmed: true })
    ).resolves.toMatchObject({ outcomeUncertain: true });
    await expect(
      proposals.confirm({ proposalId: proposal.proposalId, confirmed: true })
    ).resolves.toMatchObject({ outcomeUncertain: true });
    expect(execute).toHaveBeenCalledTimes(1);

    expect(
      proposals.prepare({
        action: 'book',
        arguments: { ...booking, time: '14:00' },
      })
    ).toMatchObject({ outcomeUncertain: true });
    await expect(
      proposals.confirm({ proposalId: 'another-proposal', confirmed: true })
    ).resolves.toMatchObject({ outcomeUncertain: true });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('latches a rejected real write as uncertain and does not retry it', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('network failed'));
    const proposals = new AppointmentProposals(
      execute,
      () => true,
      () => false
    );
    const proposal = proposals.prepare({
      action: 'book',
      arguments: booking,
    }) as {
      proposalId: string;
    };

    await expect(
      proposals.confirm({ proposalId: proposal.proposalId, confirmed: true })
    ).resolves.toMatchObject({ outcomeUncertain: true });
    await expect(
      proposals.confirm({ proposalId: proposal.proposalId, confirmed: true })
    ).resolves.toMatchObject({ outcomeUncertain: true });
    expect(
      proposals.prepare({
        action: 'book',
        arguments: { ...booking, time: '14:00' },
      })
    ).toMatchObject({ outcomeUncertain: true });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('allows a corrected real proposal after a known-safe error', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ error: 'That time is no longer available.' })
      .mockResolvedValueOnce({ appointmentId: 'appt_2' });
    const proposals = new AppointmentProposals(
      execute,
      () => true,
      () => false
    );
    const first = proposals.prepare({ action: 'book', arguments: booking }) as {
      proposalId: string;
    };

    await expect(
      proposals.confirm({ proposalId: first.proposalId, confirmed: true })
    ).resolves.toEqual({ error: 'That time is no longer available.' });
    const corrected = proposals.prepare({
      action: 'book',
      arguments: { ...booking, time: '14:00' },
    }) as { proposalId: string };
    await expect(
      proposals.confirm({ proposalId: corrected.proposalId, confirmed: true })
    ).resolves.toEqual({ appointmentId: 'appt_2' });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('disallows preparation and confirmation after the call closes', async () => {
    let callOpen = true;
    const execute = vi.fn().mockResolvedValue({ appointmentId: 'sim_appt_1' });
    const proposals = new AppointmentProposals(execute, () => callOpen);
    const proposal = proposals.prepare({
      action: 'book',
      arguments: booking,
    }) as {
      proposalId: string;
    };
    callOpen = false;

    await expect(
      proposals.confirm({ proposalId: proposal.proposalId, confirmed: true })
    ).resolves.toEqual({
      error: 'Appointment actions are unavailable.',
    });
    expect(proposals.prepare({ action: 'book', arguments: booking })).toEqual({
      error: 'Appointment actions are unavailable.',
    });
    expect(execute).not.toHaveBeenCalled();
  });
});
