// src/routes/twilio.ts
import express from 'express';
import twilio from 'twilio';
import { twilioSignature } from '../middleware/twilioSignature.js';
import { issueStreamToken } from '../security/wsAuth.js';
import { logger } from '../core/logger.js';

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
  logger.info(
    {
      protocol: req.protocol,
      forwardedProto: req.headers['x-forwarded-proto'],
      streamUrl,
    },
    'Twilio /voice called'
  );

  // No Polly <Say> greeting here: Erica greets the caller herself over the
  // media stream (one consistent voice). The stream connects immediately;
  // openaiSession.requestGreeting() makes her speak first.
  const twiml = new VoiceResponse();
  const connect = twiml.connect();
  const stream = connect.stream({ url: streamUrl });
  // Pass the caller's number through so the stream handler can pre-fetch their
  // account/appointments before they even finish speaking (arrives in the
  // Twilio 'start' event as start.customParameters.from).
  const from = (req.body?.From || '').toString();
  if (from) stream.parameter({ name: 'from', value: from });

  // Bind the media-stream WebSocket to this call with a short-lived signed
  // token (verified when the stream connects). Skipped in dev/test where no
  // secret is configured and issueStreamToken() returns "".
  const callSid = (req.body?.CallSid || '').toString();
  if (callSid) {
    const token = issueStreamToken(callSid);
    if (token) stream.parameter({ name: 'token', value: token });
  }

  res.type('text/xml').send(twiml.toString());
});
