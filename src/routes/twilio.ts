// src/routes/twilio.ts
import express from 'express';
import twilio from 'twilio';
import { createRequire } from 'module';
import { aiReply } from '../services/ai.js';
import { phorest } from '../services/phorest.js';
import { getSession, appendToSession, clearSession } from '../services/session.js';

const require = createRequire(import.meta.url);
const businessConfig = require('../config/business.json') as {
  name: string;
  timezone: string;
  hours: Record<string, string[]>;
  closedDates: string[];
};

const { VoiceResponse } = twilio.twiml;
export const twilioVoice = express.Router();

/** Build full business context sent to GPT-4o-mini on every turn */
async function buildBusinessContext() {
  const services = await phorest.listServices();
  const servicesSummary = services
    .map((s) => `${s.name}: $${s.price} (${s.durationMin} min)`)
    .join(', ');

  return {
    salonName: businessConfig.name,
    hours: businessConfig.hours,
    timezone: businessConfig.timezone,
    closedDates: businessConfig.closedDates,
    services: servicesSummary,
  };
}

/** First webhook: greet + gather speech */
twilioVoice.post('/voice', async (_req, res) => {
  const twiml = new VoiceResponse();
  const gather = twiml.gather({
    input: ['speech'],
    action: '/twilio/gather',
    method: 'POST',
    speechTimeout: 'auto',
  });
  gather.say(
    { voice: 'Polly.Joanna-Neural' },
    "Hi, this is Erica from Richa's Threading Salon. How can I help you today?",
  );
  // reprompt if silence
  twiml.redirect('/twilio/voice');
  res.type('text/xml').send(twiml.toString());
});

/** Second webhook: Twilio posts SpeechResult here */
twilioVoice.post('/gather', async (req, res) => {
  const userText: string = req.body?.SpeechResult || '';
  const callSid: string = req.body?.CallSid || '';

  // Retrieve conversation history for this call
  const session = getSession(callSid);

  // Always pass full business context — no keyword gating
  const context = await buildBusinessContext();

  const reply = await aiReply(userText, context, session.messages);

  // Store both sides of the conversation
  appendToSession(callSid, 'user', userText);
  appendToSession(callSid, 'assistant', reply);

  const twiml = new VoiceResponse();
  const gather = twiml.gather({
    input: ['speech'],
    action: '/twilio/gather',
    method: 'POST',
    speechTimeout: 'auto',
  });
  gather.say({ voice: 'Polly.Joanna-Neural' }, reply);
  twiml.redirect('/twilio/voice');

  res.type('text/xml').send(twiml.toString());
});

/** Status callback: clean up session when call ends */
twilioVoice.post('/status', async (req, res) => {
  const callSid: string = req.body?.CallSid || '';
  const status: string = req.body?.CallStatus || '';

  if (['completed', 'no-answer', 'failed'].includes(status)) {
    clearSession(callSid);
  }

  res.sendStatus(204);
});
