// src/services/ownerSms.ts
//
// M4: extracted from twilioStream.ts's private `notifyOwnerSms` method — the
// same fire-and-forget, never-throw FYI-SMS-to-Richa plumbing, now callable
// from anywhere (the daily/weekly owner digest, in addition to
// twilioStream's two existing call sites: running-late FYI, vacation
// message). Behavior is byte-identical to the method it replaces.
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
 * Best-effort FYI text sent from the salon's own Twilio number. Never throws
 * — a failed SMS must not affect a live call or block a caller, and must not
 * take down the digest scheduler either. Defaults to `env.OWNER_PHONE`; the
 * digest scheduler passes an explicit recipient when `DIGEST_TO` lists more
 * than one number.
 */
export async function sendOwnerSms(body: string, to?: string): Promise<void> {
  try {
    const client = getTwilioClient();
    const recipient = to ?? env.OWNER_PHONE;
    if (!client || !env.TWILIO_NUMBER || !recipient) {
      logger.warn(
        { tool: 'owner_sms' },
        'Owner SMS skipped — Twilio not configured'
      );
      return;
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
  } catch (error) {
    logger.warn(
      { tool: 'owner_sms', error: String(error) },
      'Owner SMS failed — continuing'
    );
  }
}
