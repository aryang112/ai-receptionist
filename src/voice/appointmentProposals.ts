import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { parseToolArgs } from '../realtime/toolSchemas.js';

const prepareSchema = z.object({
  action: z.enum(['book', 'reschedule', 'cancel']),
  arguments: z.record(z.string(), z.unknown()),
});
const confirmSchema = z.object({
  proposalId: z.string(),
  confirmed: z.literal(true),
});
const tools = {
  book: 'book_appointment',
  reschedule: 'reschedule_appointment',
  cancel: 'cancel_appointment',
} as const;
export type AppointmentAction = keyof typeof tools;

/** Call-scoped proposals. Preparation never runs a write handler. A replacement
 * invalidates the prior proposal; retries share one execution. Caller consent
 * remains model-relayed; the controller supplies the mode and write safeguards.
 */
export class AppointmentProposals {
  private current?: {
    id: string;
    action: AppointmentAction;
    args: Record<string, unknown>;
    summary: string;
    result?: Promise<unknown>;
  };
  private outcomeUncertain = false;
  private confirmationPending = false;
  constructor(
    private readonly execute: (
      action: AppointmentAction,
      args: unknown
    ) => Promise<unknown>,
    private readonly allowed: () => boolean,
    private readonly simulated: () => boolean = () => true
  ) {}

  private unavailable() {
    return { error: 'Appointment actions are unavailable.' };
  }

  private uncertain() {
    return {
      error:
        'The previous appointment action may have completed. Do not retry or prepare another action during this call.',
      outcomeUncertain: true,
    };
  }

  private pending() {
    return {
      error:
        'The previous appointment action is still being confirmed. Wait for its result before changing details.',
      actionPending: true,
    };
  }

  private finalizeResult(result: unknown, simulated: boolean): unknown {
    const output: Record<string, unknown> =
      result !== null && typeof result === 'object'
        ? { ...(result as Record<string, unknown>) }
        : { result };
    if (!simulated && output.outcomeUncertain === true) {
      this.outcomeUncertain = true;
      return this.uncertain();
    }
    return simulated ? { ...output, simulated: true } : output;
  }

  prepare(input: unknown) {
    if (!this.allowed()) return this.unavailable();
    if (this.outcomeUncertain) return this.uncertain();
    if (this.confirmationPending) return this.pending();
    const parsed = prepareSchema.safeParse(input);
    if (!parsed.success)
      return {
        error: 'Provide an appointment action and its complete arguments.',
      };
    const validation = parseToolArgs(
      tools[parsed.data.action],
      parsed.data.arguments
    );
    if (!validation.success) return { error: validation.error };
    const args = validation.data as Record<string, unknown>;
    const summary =
      parsed.data.action === 'book'
        ? `Book ${args.serviceName} on ${args.date} at ${args.time}`
        : parsed.data.action === 'reschedule'
          ? `Move the selected appointment to ${args.date} at ${args.time}`
          : 'Cancel the selected appointment';
    const proposal = {
      id: randomUUID(),
      action: parsed.data.action,
      args: structuredClone(args),
      summary,
    };
    this.current = proposal;
    return {
      proposalId: proposal.id,
      action: proposal.action,
      summary,
      ...(this.simulated() ? { simulated: true } : {}),
      requiresConfirmation: true,
      note: 'Read back the exact service, date and time (including the selected existing appointment for changes). Wait for the caller to approve before confirming. A change of details requires a new proposal.',
    };
  }
  async confirm(input: unknown): Promise<unknown> {
    if (!this.allowed()) return this.unavailable();
    const parsed = confirmSchema.safeParse(input);
    const p = this.current;
    // A duplicate confirm of the same dispatched proposal receives its cached
    // outcome, even after an uncertain real write latched this call.
    if (parsed.success && p && p.id === parsed.data.proposalId && p.result) {
      return p.result;
    }
    if (this.outcomeUncertain) return this.uncertain();
    if (!parsed.success || !p || p.id !== parsed.data.proposalId)
      return {
        error:
          'This proposal is missing or superseded. Prepare the current details and obtain approval again.',
      };
    const simulated = this.simulated();
    this.confirmationPending = true;
    p.result ??= Promise.resolve()
      .then(() => this.execute(p.action, structuredClone(p.args)))
      .then((result) => this.finalizeResult(result, simulated))
      .catch(() => {
        if (!simulated) {
          this.outcomeUncertain = true;
          return this.uncertain();
        }
        throw new Error('Appointment action failed.');
      })
      .finally(() => {
        this.confirmationPending = false;
      });
    return p.result;
  }
}
