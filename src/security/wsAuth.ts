import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';
import { logger } from '../core/logger.js';

let warnedNoSecret = false;

function sign(callSid: string, expiryMs: number): string {
  return createHmac('sha256', env.WS_AUTH_SECRET)
    .update(`${callSid}.${expiryMs}`)
    .digest('hex');
}

/**
 * Mint a short-lived signed token binding a Twilio media-stream WebSocket to the
 * callSid that opened it. Format: `${callSid}.${expiryMs}.${hmac}`.
 * With no secret configured (dev), returns "" — verify is permissive in that case.
 */
export function issueStreamToken(callSid: string): string {
  if (!env.WS_AUTH_SECRET) return '';
  const expiryMs = Date.now() + env.WS_TOKEN_TTL_SECONDS * 1000;
  return `${callSid}.${expiryMs}.${sign(callSid, expiryMs)}`;
}

/**
 * Verify a stream token: recompute the HMAC (timing-safe), reject if expired,
 * and — when expectedCallSid is given — reject if it doesn't match the token.
 * With no secret configured (dev), accepts everything but warns once.
 */
export function verifyStreamToken(
  token: string,
  expectedCallSid?: string
): boolean {
  if (!env.WS_AUTH_SECRET) {
    if (!warnedNoSecret) {
      warnedNoSecret = true;
      logger.warn(
        'WS_AUTH_SECRET is empty — accepting stream tokens without verification (dev only)'
      );
    }
    return true;
  }

  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [callSid, expiryStr, hmac] = parts as [string, string, string];

  const expiryMs = Number(expiryStr);
  if (!Number.isFinite(expiryMs) || Date.now() > expiryMs) return false;

  if (expectedCallSid !== undefined && expectedCallSid !== callSid) return false;

  const expected = sign(callSid, expiryMs);
  const a = Buffer.from(hmac);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
