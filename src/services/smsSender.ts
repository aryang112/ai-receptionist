// src/services/smsSender.ts
//
// The single exit point for any message Erica sends a CLIENT. Everything that
// texts a customer goes through here so the opt-out check cannot be bypassed by
// a future call site that forgets it.
//
// Owner messages use ownerSms.ts instead — Richa is not a marketing recipient
// and must never be suppressed by a client's opt-out.
import twilio from 'twilio';
import { env } from '../config/env.js';
import { logger } from '../core/logger.js';
import { SmsStore } from './smsStore.js';
import { MAX_SMS_CHARS } from './smsAgent.js';

let client: ReturnType<typeof twilio> | null = null;
function getClient() {
  if (!client && env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN) {
    client = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
  }
  return client;
}

export type SendResult =
  | { sent: true; sid: string; simulated?: true }
  | { sent: false; reason: 'opted_out' | 'not_configured' | 'empty' | 'failed' };

/**
 * Text a client and record it on their thread.
 *
 * `force` exists for exactly one case: the confirmation that we have processed
 * a STOP. Carriers expect that one message to go out even though the number is
 * now suppressed. Nothing else may set it.
 */
export async function sendClientSms(
  phone: string,
  body: string,
  opts: { force?: boolean } = {}
): Promise<SendResult> {
  const text = (body || '').trim().slice(0, MAX_SMS_CHARS);
  if (!text) return { sent: false, reason: 'empty' };

  const thread = SmsStore.get(phone);
  if (thread.state === 'opted_out' && !opts.force) {
    logger.warn(
      { tail: phone.slice(-4) },
      '🚫 refused to text an opted-out number'
    );
    return { sent: false, reason: 'opted_out' };
  }

  // Mirror the voice product: in simulate mode we exercise the whole path,
  // record the message, and send nothing to a real handset.
  if (env.SMS_SEND_MODE === 'simulate') {
    SmsStore.recordOutbound(phone, text, 'SIM_SMS');
    logger.info(
      { tail: phone.slice(-4), chars: text.length },
      '🧪 SMS simulated (SMS_SEND_MODE=simulate)'
    );
    return { sent: true, sid: 'SIM_SMS', simulated: true };
  }

  const c = getClient();
  if (!c || !env.TWILIO_NUMBER) {
    logger.warn('SMS send skipped — Twilio not configured');
    return { sent: false, reason: 'not_configured' };
  }

  try {
    const message = await c.messages.create({
      body: text,
      from: env.TWILIO_NUMBER,
      to: phone,
    });
    SmsStore.recordOutbound(phone, text, message.sid);
    return { sent: true, sid: message.sid };
  } catch (err) {
    logger.error(
      { err: (err as Error)?.message, tail: phone.slice(-4) },
      'SMS send failed'
    );
    return { sent: false, reason: 'failed' };
  }
}
