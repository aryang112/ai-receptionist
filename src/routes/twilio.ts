// src/routes/twilio.ts
import express from 'express';
import twilio from 'twilio';

const { VoiceResponse } = twilio.twiml;
export const twilioVoice = express.Router();

function deriveStreamUrl(req: express.Request) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const protoHeader = (req.headers['x-forwarded-proto'] || req.protocol || 'https').toString();
  const protocol = protoHeader.includes('https') ? 'wss' : 'ws';
  return `${protocol}://${host}/twilio/stream`;
}

/**
 * Primary webhook: greet caller and open a Twilio media stream that routes
 * real-time audio through OpenAI Realtime.
 */
twilioVoice.post('/voice', (req, res) => {
  const streamUrl = deriveStreamUrl(req);
  console.log('📞 Twilio /voice called');
  console.log('   Protocol from req.protocol:', req.protocol);
  console.log('   X-Forwarded-Proto header:', req.headers['x-forwarded-proto']);
  console.log('   Generated Stream URL:', streamUrl);

  const twiml = new VoiceResponse();
  twiml.say({ voice: 'Polly.Joanna-Neural' }, "Hi, this is Erica from Richa's Threading Salon. How can I help you today?");
  const connect = twiml.connect();
  connect.stream({ url: streamUrl });

  res.type('text/xml').send(twiml.toString());
});

/**
 * Legacy endpoint retained to avoid 404s if Twilio replays the gather URL.
 */
twilioVoice.post('/gather', (_req, res) => {
  const twiml = new VoiceResponse();
  twiml.say({ voice: 'Polly.Joanna' }, 'One moment while I connect you.');
  res.type('text/xml').send(twiml.toString());
});
