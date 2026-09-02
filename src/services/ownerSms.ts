// src/services/ownerSms.ts
//
// M4: extracted from twilioStream.ts's private `notifyOwnerSms` method — the
// shared never-throw SMS-to-Richa plumbing, now callable from anywhere (the
// daily/weekly owner digest, background FYIs, and caller messages). Callers
// that need to speak about delivery inspect the explicit result; background
// senders remain free to fire-and-forget it.
//
// getTwilioClient() is intentionally its OWN small memoized instance here
// (mirrors twilioStream.ts's module-scope one exactly) rather than importing
// twilioStream's — twilioStream.ts still has four other call sites for its
// own client (recording, transfer dial, etc.) that are out of scope for this
// task; duplicating six lines here keeps this extraction to "the
// notifyOwnerSms delegation (and an import)" in twilioStream.ts, with zero
// risk to any of its other Twilio call sites.
import twilio from 'twilio';
import { env } from '../config/env.js';
import { logger } from '../core/logger.js';

let _twilioClient: ReturnType<typeof twilio> | null = null;
function getTwilioClient() {
  if (!_twilioClient && env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN) {
    _twilioClient = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
  }
  return _twilioClient;
}

/**
 * Best-effort text sent from the salon's own Twilio number. Never throws — a
 * failed SMS must not affect a live call or take down the digest scheduler.
 * The explicit result lets caller-message flows confirm delivery only after
 * Twilio accepted the message; background FYIs and digests may ignore it.
 * Defaults to `env.OWNER_PHONE`; the digest scheduler passes an explicit
 * recipient when `DIGEST_TO` lists more than one number.
 */
export type OwnerSmsResult =
  | { queued: true; sid: string; status?: string }
  | { queued: false; reason: 'not_configured' | 'failed' };

export async function sendOwnerSms(
  body: string,
  to?: string
): Promise<OwnerSmsResult> {
  try {
    const client = getTwilioClient();
    const recipient = to ?? env.OWNER_PHONE;
    if (!client || !env.TWILIO_NUMBER || !recipient) {
      logger.warn(
        { tool: 'owner_sms' },
        'Owner SMS skipped — Twilio not configured'
      );
      return { queued: false, reason: 'not_configured' };
    }
    const result = await client.messages.create({
      body,
      from: env.TWILIO_NUMBER,
      to: recipient,
    });
    logger.info(
      { tool: 'owner_sms', sid: result.sid, status: result.status },
      '📨 Owner SMS sent'
    );
    return { queued: true, sid: result.sid, status: result.status };
  } catch (error) {
    logger.warn(
      { tool: 'owner_sms', error: String(error) },
      'Owner SMS failed — continuing'
    );
    return { queued: false, reason: 'failed' };
  }
}
