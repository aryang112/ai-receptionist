// src/services/smsOwner.ts
//
// The owner control channel: Richa texts instructions IN from her own phone and
// Erica carries them out on the client's thread.
//
// This closes the loop that would otherwise stall. The alternative designs both
// fail the same way — forwarding a client's message to Richa leaves her to type
// a reply from a number the client does not recognize, and a dashboard-only
// queue is a recurring owner action that decays (see the Fable audit rule).
// Here Richa does one thing, from her own phone, in one message, and Erica does
// the rest on the salon's number.
import { SmsStore, type SmsThread } from './smsStore.js';
import { runSmsAgent } from './smsAgent.js';
import { logger } from '../core/logger.js';

/**
 * A leading thread reference: "A7 tell her yes", "#A7 yes that's fine",
 * "a7: book her thursday".
 *
 * The ref must be at the START. A bare "yes" carries no ref and falls through
 * to the most recently escalated thread, which is what Richa means when she is
 * answering the text that just arrived.
 */
const REF_PREFIX = /^\s*#?([A-Za-z0-9]{2,4})\b[\s:,.-]*/;

export type OwnerCommand =
  | { kind: 'instruction'; thread: SmsThread; instruction: string }
  | { kind: 'no_open_threads' }
  | { kind: 'unknown_ref'; ref: string }
  | { kind: 'empty' };

/**
 * Work out which client thread Richa is answering, and what she wants said.
 *
 * Ambiguity is resolved toward doing nothing: if she references a thread we
 * cannot find, we tell her rather than guessing a different client. Sending
 * the wrong client the wrong answer is far worse than one extra round trip.
 */
export function parseOwnerCommand(body: string): OwnerCommand {
  const raw = body.trim();
  if (!raw) return { kind: 'empty' };

  const open = SmsStore.awaitingOwner();
  const match = REF_PREFIX.exec(raw);

  if (match) {
    // REF_PREFIX's capture group is mandatory (not inside `?` or an
    // alternation), so a successful match always captures it.
    const captured = match[1];
    if (captured === undefined) {
      throw new Error('REF_PREFIX matched without capturing its ref group');
    }
    const candidate = captured.toUpperCase();
    const byRef = SmsStore.byRef(candidate);
    if (byRef) {
      const instruction = raw.slice(match[0].length).trim();
      if (!instruction) return { kind: 'empty' };
      return { kind: 'instruction', thread: byRef, instruction };
    }
    // A token that LOOKS like a ref but matches nothing is only an error when
    // it plausibly was one. "OK book her friday" starts with "OK" — that is a
    // word, not a bad ref, so fall through to the default thread instead of
    // scolding her.
    const looksDeliberate = raw.startsWith('#');
    if (looksDeliberate) return { kind: 'unknown_ref', ref: candidate };
  }

  if (open.length === 0) return { kind: 'no_open_threads' };

  // No ref given: answer the most recent escalation — the one whose text she
  // is almost certainly replying to.
  const target = open[open.length - 1];
  if (target === undefined) {
    // Unreachable: the `open.length === 0` check above guarantees an element
    // exists here.
    return { kind: 'no_open_threads' };
  }
  return { kind: 'instruction', thread: target, instruction: raw };
}

export type OwnerHandlingResult = {
  /** What to text back to Richa. Null when nothing needs saying. */
  ownerReply: string | null;
  /** What to text the client, and on which thread. Null when no client
   *  message resulted. */
  clientMessage?: { phone: string; body: string } | undefined;
};

export async function handleOwnerMessage(
  body: string
): Promise<OwnerHandlingResult> {
  const command = parseOwnerCommand(body);

  switch (command.kind) {
    case 'empty':
      return {
        ownerReply:
          'I did not catch an instruction there. Reply with the code and what to tell them, e.g. "A7 we can do Thursday at 2".',
      };

    case 'no_open_threads':
      return {
        ownerReply:
          'Nothing is waiting on you right now — I have not had to escalate anything.',
      };

    case 'unknown_ref': {
      const open = SmsStore.awaitingOwner();
      const list = open.length
        ? ` Open right now: ${open.map((t) => '#' + t.ref).join(', ')}.`
        : ' Nothing is currently waiting on you.';
      return {
        ownerReply: `I do not have a conversation #${command.ref}.${list}`,
      };
    }

    case 'instruction': {
      const { thread, instruction } = command;
      const result = await runSmsAgent(thread, '', true, {
        ownerInstruction: instruction,
      });

      if (!result.reply) {
        // The agent could not turn her instruction into a client message. Say
        // so plainly rather than silently dropping it — this is exactly the
        // failure mode the whole build exists to remove.
        return {
          ownerReply: `I could not work out what to send from that. What should I tell ${thread.name || 'them'}? (#${thread.ref})`,
        };
      }

      SmsStore.resolveEscalation(thread.phone);
      const who = thread.name || `…${thread.phone.slice(-4)}`;
      logger.info(
        { ref: thread.ref, booked: result.booked },
        '✅ owner instruction applied'
      );
      return {
        ownerReply: `Sent to ${who}: "${result.reply}"${result.booked ? ' — and it is on the calendar.' : ''}`,
        clientMessage: { phone: thread.phone, body: result.reply },
      };
    }
  }
}
