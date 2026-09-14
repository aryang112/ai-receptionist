// src/services/reviewRequests.ts
//
// "Did the review-automation system text this person a review request lately?"
//
// Why this exists: one Twilio number now carries three kinds of traffic —
// outbound review requests (sent by the salon-review-automation service, a
// different codebase with a different database), Erica's voice, and Erica's
// SMS. When someone replies "Done!" we must NOT open a booking conversation.
//
// We answer the question from Twilio's own message log rather than by reaching
// into the other service's database. That keeps the two systems decoupled: the
// review sender can change, move, or be rewritten and this still works, because
// the evidence is the message that was actually delivered.
import twilio from 'twilio';
import { env } from '../config/env.js';
import { logger } from '../core/logger.js';

/**
 * Phrases that identify one of our outbound review requests. Matched against
 * the body Twilio actually delivered, so this is resilient to the template
 * being re-worded around them — but it MUST be kept in step with
 * `sms-template.service.js` in salon-review-automation.
 */
const REVIEW_REQUEST_MARKERS = [
  'share a short review',
  'review about your visit',
  'leave us a review',
  'google review',
];

export function looksLikeReviewRequest(body: string): boolean {
  const n = body.toLowerCase();
  return REVIEW_REQUEST_MARKERS.some((m) => n.includes(m));
}

export type ReviewRequestLookup = (phone: string) => Promise<number | null>;

type CacheEntry = { sentAt: number | null; checkedAt: number };
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 10 * 60 * 1000;

let client: ReturnType<typeof twilio> | null = null;
function getClient() {
  if (!client && env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN) {
    client = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
  }
  return client;
}

/**
 * Epoch ms of the most recent review request we sent this number, or null.
 *
 * Fails OPEN (returns null) on any Twilio error. A lookup failure must not
 * block a customer's message — the cost of mis-routing a "Done!" into the
 * booking lane is one slightly odd reply; the cost of dropping the message is
 * another silent loss, which is the exact failure we are fixing.
 */
export const lookupLastReviewRequest: ReviewRequestLookup = async (phone) => {
  const hit = cache.get(phone);
  if (hit && Date.now() - hit.checkedAt < CACHE_TTL_MS) return hit.sentAt;

  const c = getClient();
  if (!c || !env.TWILIO_NUMBER) return null;

  try {
    const messages = await c.messages.list({
      to: phone,
      from: env.TWILIO_NUMBER,
      limit: 20,
    });
    let sentAt: number | null = null;
    for (const m of messages) {
      if (!looksLikeReviewRequest(m.body || '')) continue;
      const when = m.dateSent || m.dateCreated;
      const ts = when ? new Date(when).getTime() : null;
      if (ts && (sentAt === null || ts > sentAt)) sentAt = ts;
    }
    cache.set(phone, { sentAt, checkedAt: Date.now() });
    return sentAt;
  } catch (err) {
    logger.warn(
      { err: (err as Error)?.message, tail: phone.slice(-4) },
      'review-request lookup failed — routing as booking'
    );
    return null;
  }
};

export function __clearReviewRequestCache(): void {
  cache.clear();
}
