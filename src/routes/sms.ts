// src/routes/sms.ts
//
// The inbound SMS webhook — the organ this product was missing.
//
// Before this route existed, the number's smsUrl pointed at Twilio's retired
// demo endpoint, so 57 real client replies were received and silently dropped.
// Every design choice below is shaped by that: nothing is allowed to fail
// quietly, and a message is persisted before anything else can go wrong.
import express from 'express';
import { twilioSignature } from '../middleware/twilioSignature.js';
import { env } from '../config/env.js';
import { logger } from '../core/logger.js';
import { SmsStore } from '../services/smsStore.js';
import { routeInbound, isAllowedForAgent } from '../services/smsRouter.js';
import { lookupLastReviewRequest } from '../services/reviewRequests.js';
import {
  HELP_REPLY,
  STOP_REPLY,
  START_REPLY,
} from '../services/smsCompliance.js';
import { sendClientSms } from '../services/smsSender.js';
import { sendOwnerSms } from '../services/ownerSms.js';
import { handleOwnerMessage } from '../services/smsOwner.js';
import { runSmsAgent } from '../services/smsAgent.js';
import { phorest } from '../services/phorest.js';

export const twilioSms = express.Router();

/**
 * One in-flight turn per phone. Two messages sent a second apart would
 * otherwise run two agent turns concurrently against the same thread and could
 * double-book. The second message is not dropped — it is appended to the
 * thread, so the turn already running sees it in history.
 */
const inFlight = new Set<string>();

/** Warm, honest, and cheap — a canned reply, not a model call. Someone who
 *  just said "Done!" does not need an LLM, and a generated reply here would be
 *  the one place we could accidentally say something wrong at zero benefit. */
const REVIEW_THANKS =
  'Thank you so much — that really does help the salon. See you next time!';

async function resolveIdentity(phone: string): Promise<void> {
  const thread = SmsStore.get(phone);
  if (thread.clientId) return;
  try {
    const customer = await phorest.lookupCustomerByPhone(phone);
    if (!customer) return;
    const name =
      [(customer as any).firstName, (customer as any).lastName]
        .filter(Boolean)
        .join(' ')
        .trim() || undefined;
    SmsStore.setIdentity(phone, (customer as any).clientId, name);
  } catch (err) {
    // A failed lookup means an unrecognized client, not a failed conversation.
    logger.warn(
      { err: (err as Error)?.message },
      'SMS identity lookup failed — continuing as a new client'
    );
  }
}

async function handleInbound(
  from: string,
  body: string,
  sid: string
): Promise<void> {
  const decision = await routeInbound(from, body, lookupLastReviewRequest);

  // Persist FIRST, always, on every lane including suppressed ones. If
  // everything below this line throws, we still have the customer's message.
  SmsStore.recordInbound(from, body, decision.lane, sid);

  // Taste-test gate. A non-empty allowlist means we are mid-test on the REAL
  // salon number: record everyone, answer only the testers. Compliance is
  // deliberately NOT gated — a STOP from any number must always be honoured,
  // test or not.
  if (decision.lane !== 'compliance' && !isAllowedForAgent(from)) {
    logger.info(
      { tail: from.slice(-4), lane: decision.lane },
      'SMS allowlist active — recorded, not answered'
    );
    return;
  }

  switch (decision.lane) {
    case 'owner': {
      const result = await handleOwnerMessage(body);
      if (result.clientMessage) {
        await sendClientSms(
          result.clientMessage.phone,
          result.clientMessage.body
        );
      }
      if (result.ownerReply) await sendOwnerSms(result.ownerReply);
      return;
    }

    case 'compliance': {
      if (decision.suppressed) return; // Opted out: record it, send nothing.
      if (decision.keyword === 'stop') {
        SmsStore.setState(from, 'opted_out');
        // force: the carrier expects this one confirmation to go out.
        await sendClientSms(from, STOP_REPLY, { force: true });
        return;
      }
      if (decision.keyword === 'start') {
        SmsStore.setState(from, 'idle');
        await sendClientSms(from, START_REPLY);
        return;
      }
      await sendClientSms(from, HELP_REPLY);
      return;
    }

    case 'review_reply':
      await sendClientSms(from, REVIEW_THANKS);
      return;

    case 'booking': {
      await resolveIdentity(from);
      SmsStore.setState(from, 'active');
      const thread = SmsStore.get(from);
      const result = await runSmsAgent(thread, body, decision.resuming);

      if (result.reply) {
        await sendClientSms(from, result.reply);
        return;
      }

      // The agent produced nothing usable. That is exactly when a human is
      // needed, so escalate rather than leaving the client on read.
      if (!result.escalated) {
        SmsStore.escalate(from, 'Erica could not compose a reply');
        await sendOwnerSms(
          [
            `Erica is stuck — #${thread.ref}`,
            `${thread.name || `…${from.slice(-4)}`}: "${body.slice(0, 140)}"`,
            '',
            `Reply "${thread.ref} <what to tell them>" and I'll send it.`,
          ].join('\n')
        );
        await sendClientSms(
          from,
          'Let me check on that and come right back to you.'
        );
      }
      return;
    }
  }
}

/**
 * Twilio's webhook. We acknowledge immediately and do the work off the request:
 * an agent turn involves an OpenAI call plus one or more Phorest calls, which
 * can exceed Twilio's ~15s webhook timeout. A timeout would make Twilio retry,
 * and a retried booking is a double booking.
 */
twilioSms.post('/sms', twilioSignature(), (req, res) => {
  const from = (req.body?.From || '').toString();
  const body = (req.body?.Body || '').toString();
  const sid = (req.body?.MessageSid || '').toString();

  // Empty 200 = "received, no immediate reply". The real reply is sent over
  // the REST API once the agent has finished.
  res.type('text/xml').send('<Response></Response>');

  if (!from) {
    logger.warn('Inbound SMS with no From — ignored');
    return;
  }

  // Kill switch. Still records the message — the whole point of this build is
  // that a client reply is never lost again, including while the lane is off.
  if (!env.SMS_ENABLED) {
    SmsStore.recordInbound(from, body, 'booking', sid);
    logger.info(
      { tail: from.slice(-4) },
      'SMS lane disabled (SMS_ENABLED!=true) — recorded, not answered'
    );
    return;
  }

  if (inFlight.has(from)) {
    // Record it so the running turn sees it, then stop. Not a dropped message.
    SmsStore.recordInbound(from, body, 'booking', sid);
    logger.info(
      { tail: from.slice(-4) },
      'SMS arrived while a turn was in flight — appended to thread'
    );
    return;
  }

  inFlight.add(from);
  void handleInbound(from, body, sid)
    .catch((err) => {
      logger.error(
        { err: (err as Error)?.message, tail: from.slice(-4) },
        '❌ inbound SMS handling failed'
      );
    })
    .finally(() => inFlight.delete(from));
});
