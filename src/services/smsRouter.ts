// src/services/smsRouter.ts
//
// One number, four lanes. This is the single most important file in the SMS
// build, because every other component assumes it got the lane right.
//
//   owner        — Richa texting instructions in from her own phone
//   compliance   — STOP / START / HELP, carrier-mandated, always wins
//   review_reply — "Done!" in response to a review request we sent
//   booking      — everything else: a real conversation for Erica
//
// The classification is explicit and unit-tested rather than inferred by the
// model, because the two failure modes are both bad and both invisible:
// thanking someone who wanted an appointment, and trying to book someone who
// just said thanks.
import { env } from '../config/env.js';
import { SmsStore, type SmsLane, type SmsThread } from './smsStore.js';
import {
  detectComplianceKeyword,
  isUnambiguousStart,
  type ComplianceKeyword,
} from './smsCompliance.js';
import type { ReviewRequestLookup } from './reviewRequests.js';

/**
 * How long after a review request a bare acknowledgment still reads as a reply
 * to it. Beyond this, "thanks!" out of the blue is more likely the start of
 * something else, and the booking lane handles it gracefully anyway.
 */
export const REVIEW_REPLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How long a conversation stays "in progress". A reply inside this window
 * continues the existing thread with its history; outside it, the agent
 * re-introduces itself rather than resuming a conversation the customer has
 * long forgotten.
 */
export const ACTIVE_THREAD_WINDOW_MS = 72 * 60 * 60 * 1000;

/** iOS/Android tapback reactions arrive as text: `Loved "Hi Falon! ..."`. */
const TAPBACK_PREFIX =
  /^\s*(loved|liked|laughed at|emphasized|questioned|disliked)\s+[""“”]/i;

/** Words that mean the customer wants something done, not just acknowledging. */
const BOOKING_INTENT = [
  'book',
  'appointment',
  'appt',
  'schedule',
  'reschedule',
  'resched',
  'cancel',
  'move',
  'change',
  'available',
  'availability',
  'opening',
  'slot',
  'come in',
  'get in',
  'squeeze',
  'fit me',
  'time',
  'today',
  'tomorrow',
  'tonight',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
  'week',
  'am',
  'pm',
  'threading',
  'wax',
  'brow',
  'lash',
  'facial',
  'tint',
  'price',
  'how much',
  'cost',
  'open',
  'hours',
];

/** Pure-acknowledgment phrases seen in the real 57-message backlog. */
const ACK_PHRASES = [
  'done',
  'absolutely',
  'sure',
  'sure thing',
  'of course',
  'will do',
  'yes',
  'yep',
  'yup',
  'ok',
  'okay',
  'got it',
  'no problem',
  'np',
  'thanks',
  'thank you',
  'ty',
  'anytime',
  'happy to',
  'just did',
  'already did',
  'posted',
  'left one',
  'no',
];

function stripPunctuationAndEmoji(s: string): string {
  return (
    s
      .toLowerCase()
      // Strip emoji and pictographs so "Will do😘" reads as "will do".
      .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '')
      // Zero-width characters. iOS wraps a tapback emoji in U+200B, and JS
      // \s does NOT match it — without this, a pure "🤗" reaction strips to
      // two invisible characters instead of the empty string and is misread
      // as a real message. Found by the backlog-derived test, not by eye.
      .replace(/[​-‏﻿]/g, '')
      .replace(/[.!?,;:'"“”]+/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * True when a message carries no request — just warmth or confirmation.
 *
 * Conservative by design: anything containing booking intent is NOT an
 * acknowledgment, even if it also says "thanks". "Thanks! Can I come Thursday?"
 * must reach the booking lane.
 */
export function isAcknowledgment(body: string): boolean {
  if (TAPBACK_PREFIX.test(body)) return true;

  const clean = stripPunctuationAndEmoji(body);

  // An emoji-only reply ("🤗", "👍") strips to nothing — pure acknowledgment.
  if (clean.length === 0) return true;

  // Any explicit request disqualifies it, checked first and on word
  // boundaries so "am"/"pm" don't fire inside "amazing" or "improvement".
  const hasIntent = BOOKING_INTENT.some((w) =>
    new RegExp(`(^|\\s)${w.replace(/ /g, '\\s+')}(\\s|$)`, 'i').test(clean)
  );
  if (hasIntent) return false;

  // A long message is a conversation, not an acknowledgment, even without
  // keywords — it deserves the agent rather than a canned thank-you.
  if (clean.split(' ').length > 12) return false;

  return ACK_PHRASES.some(
    (p) =>
      clean === p ||
      clean.startsWith(p + ' ') ||
      clean.endsWith(' ' + p) ||
      clean.includes(' ' + p + ' ')
  );
}

export function isOwner(phone: string): boolean {
  const normalize = (p: string) =>
    p.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  const owner = env.OWNER_PHONE;
  return Boolean(owner) && normalize(phone) === normalize(owner);
}

export type RoutingDecision = {
  lane: SmsLane;
  thread: SmsThread;
  /** Set when lane === 'compliance'. */
  keyword?: ComplianceKeyword;
  /** True when the customer has opted out and we must send nothing at all. */
  suppressed: boolean;
  /** True when a booking thread is resuming with prior context. */
  resuming: boolean;
  /** Why this lane was chosen — recorded for the dashboard and for debugging
   *  a mis-route without replaying the model. */
  reason: string;
};

export async function routeInbound(
  from: string,
  body: string,
  lookupLastReviewRequest: ReviewRequestLookup
): Promise<RoutingDecision> {
  const thread = SmsStore.get(from);

  // 1. Richa's own phone is never a customer conversation.
  if (isOwner(from)) {
    return {
      lane: 'owner',
      thread,
      suppressed: false,
      resuming: false,
      reason: 'from owner phone',
    };
  }

  // 2. Carrier keywords outrank everything, including an open conversation.
  const keyword = detectComplianceKeyword(body);
  if (keyword === 'stop' || keyword === 'help') {
    return {
      lane: 'compliance',
      thread,
      keyword,
      suppressed: false,
      resuming: false,
      reason: `compliance keyword: ${keyword}`,
    };
  }
  // "yes" only means opt-in for a number that actually opted out; otherwise
  // it is ordinary agreement and belongs to the conversation.
  if (
    keyword === 'start' &&
    (thread.state === 'opted_out' || isUnambiguousStart(body))
  ) {
    return {
      lane: 'compliance',
      thread,
      keyword: 'start',
      suppressed: false,
      resuming: false,
      reason: 'compliance keyword: start',
    };
  }

  // 3. Opted out and not opting back in — record it, answer nothing.
  if (thread.state === 'opted_out') {
    return {
      lane: 'compliance',
      thread,
      keyword: null,
      suppressed: true,
      resuming: false,
      reason: 'opted out — no outbound permitted',
    };
  }

  // 4. A live conversation continues, even if the message looks like a bare
  //    "yes" — in context that is an answer to Erica's last question.
  const lastInbound = thread.lastOutboundAt ?? thread.lastInboundAt ?? 0;
  const conversationLive =
    (thread.state === 'active' || thread.state === 'awaiting_owner') &&
    Date.now() - lastInbound < ACTIVE_THREAD_WINDOW_MS;
  if (conversationLive) {
    return {
      lane: 'booking',
      thread,
      suppressed: false,
      resuming: true,
      reason: 'continuing an open conversation',
    };
  }

  // 5. A bare acknowledgment shortly after a review request is a reply to it.
  if (isAcknowledgment(body)) {
    const sentAt = await lookupLastReviewRequest(from);
    if (sentAt && Date.now() - sentAt < REVIEW_REPLY_WINDOW_MS) {
      return {
        lane: 'review_reply',
        thread,
        suppressed: false,
        resuming: false,
        reason: 'acknowledgment within the review-request window',
      };
    }
  }

  // 6. Everything else is a conversation for Erica.
  return {
    lane: 'booking',
    thread,
    suppressed: false,
    resuming: false,
    reason: 'new conversation',
  };
}
