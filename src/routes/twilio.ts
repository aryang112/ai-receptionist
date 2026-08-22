// src/routes/twilio.ts
import express from 'express';
import twilio from 'twilio';
import { twilioSignature } from '../middleware/twilioSignature.js';
import { issueStreamToken } from '../security/wsAuth.js';
import { logger } from '../core/logger.js';
import { isBlocked } from '../services/blocklist.js';
import { CallStore } from '../services/callStore.js';

const { VoiceResponse } = twilio.twiml;
export const twilioVoice = express.Router();

function deriveStreamUrl(req: express.Request) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const protoHeader = (
    req.headers['x-forwarded-proto'] ||
    req.protocol ||
    'https'
  ).toString();
  const protocol = protoHeader.includes('https') ? 'wss' : 'ws';
  return `${protocol}://${host}/twilio/stream`;
}

/**
 * Primary webhook: greet caller and open a Twilio media stream that routes
 * real-time audio through OpenAI Realtime.
 */
twilioVoice.post('/voice', twilioSignature(), (req, res) => {
  const streamUrl = deriveStreamUrl(req);
  const from = (req.body?.From || '').toString();
  const callSid = (req.body?.CallSid || '').toString();
  // S2: STIR/SHAKEN attestation, log-only this round — collected for a future
  // tuning pass, no blocking decision is made on it here.
  const stirVerstat = (req.body?.StirVerstat || '').toString();
  logger.info(
    {
      protocol: req.protocol,
      forwardedProto: req.headers['x-forwarded-proto'],
      streamUrl,
      stirVerstat: stirVerstat || undefined,
    },
    'Twilio /voice called'
  );

  // S2: a repeat-spam number (S1 tagged it 'spam' >= SPAM_BLOCK_THRESHOLD
  // times) gets rejected here — before ANY OpenAI Realtime session opens —
  // so a redialing robocaller costs ~$0 instead of a full call.
  if (from && isBlocked(from)) {
    logger.warn(
      { last4: from.slice(-4) },
      '🚫 blocked spam caller (…last4 only)'
    );
    CallStore.recordBlocked(callSid, from, stirVerstat || undefined);
    const rejectTwiml = new VoiceResponse();
    rejectTwiml.reject({ reason: 'rejected' });
    res.type('text/xml').send(rejectTwiml.toString());
    return;
  }

  // No Polly <Say> greeting here: Erica greets the caller herself over the
  // media stream (one consistent voice). The stream connects immediately;
  // openaiSession.requestGreeting() makes her speak first.
  const twiml = new VoiceResponse();
  const connect = twiml.connect();
  const stream = connect.stream({ url: streamUrl });
  // Pass the caller's number through so the stream handler can pre-fetch their
  // account/appointments before they even finish speaking (arrives in the
  // Twilio 'start' event as start.customParameters.from).
  if (from) stream.parameter({ name: 'from', value: from });
  // S2: also pass STIR/SHAKEN through so twilioStream.ts can record it
  // (log-only — see CallStore.startCall's stirVerstat field).
  if (stirVerstat) stream.parameter({ name: 'stir', value: stirVerstat });

  // Bind the media-stream WebSocket to this call with a short-lived signed
  // token (verified when the stream connects). Skipped in dev/test where no
  // secret is configured and issueStreamToken() returns "".
  if (callSid) {
    const token = issueStreamToken(callSid);
    if (token) stream.parameter({ name: 'token', value: token });
  }

  res.type('text/xml').send(twiml.toString());
});
