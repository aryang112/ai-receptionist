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

  it('coalesces concurrent confirms to exactly one simulated mutation', async () => {
    let release!: () => void;
    const mutation = new Promise<void>((resolve) => {
      release = resolve;
    });
    const execute = vi.fn(async () => {
      await mutation;
      return { appointmentId: 'sim_appt_1' };
    });
    const proposals = new AppointmentProposals(execute, () => true);
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
    release();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { appointmentId: 'sim_appt_1', simulated: true },
      { appointmentId: 'sim_appt_1', simulated: true },
    ]);
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
      error: 'Simulated appointment actions are unavailable.',
    });
    expect(proposals.prepare({ action: 'book', arguments: booking })).toEqual({
      error: 'Simulated appointment actions are unavailable.',
    });
    expect(execute).not.toHaveBeenCalled();
  });
});
