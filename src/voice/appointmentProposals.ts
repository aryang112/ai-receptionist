import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { parseToolArgs } from '../realtime/toolSchemas.js';

const prepareSchema = z.object({
  action: z.enum(['book', 'reschedule', 'cancel']),
  arguments: z.record(z.string(), z.unknown()),
});
const confirmSchema = z.object({ proposalId: z.string(), confirmed: z.literal(true) });
const tools = { book: 'book_appointment', reschedule: 'reschedule_appointment', cancel: 'cancel_appointment' } as const;
export type AppointmentAction = keyof typeof tools;

/** Call-scoped, simulated-only proposals. Preparation never runs a write handler.
 * A replacement invalidates the prior proposal; retries share one execution.
 * Caller consent remains model-relayed in this pilot, not transcript-proven.
 */
export class AppointmentProposals {
  private current?: { id: string; action: AppointmentAction; args: Record<string, unknown>; summary: string; result?: Promise<unknown> };
  constructor(private readonly execute: (action: AppointmentAction, args: unknown) => Promise<unknown>, private readonly allowed: () => boolean) {}
  prepare(input: unknown) {
    if (!this.allowed()) return { error: 'Simulated appointment actions are unavailable.' };
    const parsed = prepareSchema.safeParse(input);
    if (!parsed.success) return { error: 'Provide an appointment action and its complete arguments.' };
    const validation = parseToolArgs(tools[parsed.data.action], parsed.data.arguments);
    if (!validation.success) return { error: validation.error };
    const args = validation.data as Record<string, unknown>;
    const summary = parsed.data.action === 'book'
      ? `Book ${args.serviceName} on ${args.date} at ${args.time}`
      : parsed.data.action === 'reschedule'
        ? `Move the selected appointment to ${args.date} at ${args.time}`
        : 'Cancel the selected appointment';
    const proposal = { id: randomUUID(), action: parsed.data.action, args: structuredClone(args), summary };
    this.current = proposal;
    return { proposalId: proposal.id, action: proposal.action, summary, simulated: true, requiresConfirmation: true,
      note: 'Read back the exact service, date and time (including the selected existing appointment for changes). Wait for the caller to approve before confirming. A change of details requires a new proposal.' };
  }
  async confirm(input: unknown): Promise<unknown> {
    if (!this.allowed()) return { error: 'Simulated appointment actions are unavailable.' };
    const parsed = confirmSchema.safeParse(input);
    const p = this.current;
    if (!parsed.success || !p || p.id !== parsed.data.proposalId) return { error: 'This proposal is missing or superseded. Prepare the current details and obtain approval again.' };
    p.result ??= Promise.resolve().then(() => this.execute(p.action, structuredClone(p.args))).then((result) => ({ ...(result as object), simulated: true }));
    return p.result;
  }
}
