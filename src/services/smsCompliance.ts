// src/services/smsCompliance.ts
//
// Carrier-mandated keyword handling. This is the one part of the SMS lane that
// is not a product decision — STOP must always work, on every lane, before any
// other logic runs, and it must be durable across restarts.
//
// Twilio's Messaging Service also handles these keywords at the carrier level.
// We handle them too, on purpose: the carrier stops delivery, but only OUR
// ledger stops Erica from composing a message in the first place, and only our
// ledger survives a number moving between services.

/** Exact-match opt-out keywords (the CTIA standard set). */
const STOP_WORDS = new Set([
  'stop',
  'stopall',
  'unsubscribe',
  'cancel',
  'end',
  'quit',
  'optout',
  'opt-out',
  'revoke',
]);

/** Exact-match opt-in keywords. */
const START_WORDS = new Set(['start', 'yes', 'unstop', 'optin', 'opt-in']);

/** Exact-match help keywords. */
const HELP_WORDS = new Set(['help', 'info']);

export type ComplianceKeyword = 'stop' | 'start' | 'help' | null;

/**
 * Normalize for keyword matching only: lowercase, strip punctuation and
 * surrounding whitespace.
 *
 * Deliberately EXACT-match on the whole message, not a substring search.
 * "Can you stop by earlier?" and "cancel my 3pm" are ordinary customer
 * messages — treating them as opt-outs would silently blacklist a client who
 * was trying to book. The carrier applies the same whole-message rule.
 */
function normalizeKeyword(body: string): string {
  return body
    .trim()
    .toLowerCase()
    .replace(/[.!?,;:'"]+$/g, '')
    .replace(/\s+/g, ' ');
}

export function detectComplianceKeyword(body: string): ComplianceKeyword {
  const n = normalizeKeyword(body);
  if (STOP_WORDS.has(n)) return 'stop';
  if (HELP_WORDS.has(n)) return 'help';
  // "yes" is a START keyword ONLY for a number that previously opted out.
  // For an active conversation it means "yes, book it" — the caller decides
  // by checking thread state before treating it as opt-in.
  if (START_WORDS.has(n)) return 'start';
  return null;
}

/**
 * `yes` is ambiguous: opt-in keyword for an opted-out number, plain agreement
 * for everyone else. Only these are unambiguous opt-ins.
 */
export function isUnambiguousStart(body: string): boolean {
  const n = normalizeKeyword(body);
  return n !== 'yes' && START_WORDS.has(n);
}

export const HELP_REPLY =
  "Richa's Threading: reply here to book, reschedule or cancel an appointment. " +
  'Call (410) 304-6449 for a person. Msg&data rates may apply. Reply STOP to opt out.';

export const STOP_REPLY =
  "You're unsubscribed from Richa's Threading texts and won't get any more. " +
  'Reply START to opt back in.';

export const START_REPLY =
  "You're opted back in to Richa's Threading texts. Reply STOP any time.";
