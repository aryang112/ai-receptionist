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

/**
 * The public host Twilio reached us on ("erica.up.railway.app"), taken from
 * the same forwarded headers deriveStreamUrl uses. Also handed to the media
 * stream as a `host` parameter: twilioStream.ts's transfer handler has no
 * Express `req` of its own, so this is the only way it can build the absolute
 * action URL for the <Dial> callback (see handleTransferToOwner).
 */
function derivePublicHost(req: express.Request): string | undefined {
  const raw = req.headers['x-forwarded-host'] || req.headers.host;
  return raw === undefined ? undefined : String(raw);
}

function deriveStreamUrl(req: express.Request) {
  const host = derivePublicHost(req);
  const protoHeader = (
    req.headers['x-forwarded-proto'] ||
    req.protocol ||
    'https'
  ).toString();
  const protocol = protoHeader.includes('https') ? 'wss' : 'ws';
  return `${protocol}://${host}/twilio/stream`;
}

/**
 * The one place the <Connect><Stream> TwiML is built. BOTH entry points into a
 * media stream use it — the initial /voice answer and the /dial-status
 * reconnect after a failed live transfer — so the two can never drift on the
 * stream URL or the parameter set (a missing `token` would fail the WS auth
 * gate; a missing `host` would silently disable the next transfer's fallback).
 */
function buildStreamTwiml(
  req: express.Request,
  params: {
    from?: string;
    stir?: string;
    host?: string | undefined;
    callSid?: string;
    transferFailed?: boolean;
  }
): string {
  const twiml = new VoiceResponse();
  const connect = twiml.connect();
  const stream = connect.stream({ url: deriveStreamUrl(req) });
  // Pass the caller's number through so the stream handler can pre-fetch their
  // account/appointments before they even finish speaking (arrives in the
  // Twilio 'start' event as start.customParameters.from).
  if (params.from) stream.parameter({ name: 'from', value: params.from });
  // S2: also pass STIR/SHAKEN through so twilioStream.ts can record it
  // (log-only — see CallStore.startCall's stirVerstat field).
  if (params.stir) stream.parameter({ name: 'stir', value: params.stir });
  // The public host, so a later transfer_to_owner can build its own absolute
  // dial-status action URL (see derivePublicHost).
  if (params.host) stream.parameter({ name: 'host', value: params.host });

  // Bind the media-stream WebSocket to this call with a short-lived signed
  // token (verified when the stream connects). Skipped in dev/test where no
  // secret is configured and issueStreamToken() returns "".
  if (params.callSid) {
    const token = issueStreamToken(params.callSid);
    if (token) stream.parameter({ name: 'token', value: token });
  }

  // Marks this segment as the reconnect after a live transfer that never
  // connected — twilioStream.ts opens with an apology + message-taking
  // instead of the recorded-line greeting, and never re-dials.
  if (params.transferFailed) {
    stream.parameter({ name: 'transferFailed', value: '1' });
  }

  return twiml.toString();
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
  res.type('text/xml').send(
    buildStreamTwiml(req, {
      from,
      stir: stirVerstat,
      host: derivePublicHost(req),
      callSid,
    })
  );
});

/**
 * Action callback for the live transfer's <Dial> (handleTransferToOwner).
 * Twilio POSTs here once the dial ends, with DialCallStatus =
 * completed | no-answer | busy | failed | canceled.
 *
 * Before this existed, a <Dial> with no action meant a no-answer landed the
 * caller in Richa's PERSONAL voicemail (invisible to the salon), and a
 * busy/failed dial simply HUNG UP on them — nothing followed the <Dial>.
 * Now anything short of a completed human conversation reconnects the caller
 * to a fresh Erica session (transferFailed=1) that apologizes and takes a
 * message. No blocklist check here: this caller already passed it at /voice.
 */
twilioVoice.post('/dial-status', twilioSignature(), (req, res) => {
  const dialCallStatus = (req.body?.DialCallStatus || '').toString();
  const callSid = (req.body?.CallSid || '').toString();

  if (dialCallStatus === 'completed') {
    // The human conversation happened and ended — nothing left to do.
    const twiml = new VoiceResponse();
    twiml.hangup();
    res.type('text/xml').send(twiml.toString());
    return;
  }

  logger.info(
    { dialCallStatus: dialCallStatus || undefined, callSid },
    '☎️ live transfer did not connect — reconnecting the caller to Erica'
  );

  // Twilio re-sends the original From/StirVerstat on action callbacks; pass
  // them through so the failback segment keeps the caller-ID context.
  res.type('text/xml').send(
    buildStreamTwiml(req, {
      from: (req.body?.From || '').toString(),
      stir: (req.body?.StirVerstat || '').toString(),
      host: derivePublicHost(req),
      callSid,
      transferFailed: true,
    })
  );
});
