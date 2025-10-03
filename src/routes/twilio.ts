// src/routes/twilio.ts
import express from 'express';
import twilio from 'twilio';
import { aiReply } from '../services/ai.js';
import { phorest } from '../services/phorest.js';

const { VoiceResponse } = twilio.twiml;
export const twilioVoice = express.Router();

/** First webhook: greet + gather speech */
twilioVoice.post('/voice', async (_req, res) => {
  const twiml = new VoiceResponse();
  const gather = twiml.gather({
    input: ['speech'],
    action: '/twilio/gather',
    method: 'POST',
    speechTimeout: 'auto'
  });
  gather.say({ voice: 'Polly.Joanna' }, "Hi, this is Erica from Richa's Threading Salon. How can I help you today?");
  // reprompt if silence
  twiml.redirect('/twilio/voice');
  res.type('text/xml').send(twiml.toString());
});

/** Second webhook: Twilio posts SpeechResult here */
twilioVoice.post('/gather', async (req, res) => {
  const userText: string = req.body?.SpeechResult || '';

  // quick, optional context to ground the model
  let extraInfo: string | undefined;
  const t = userText.toLowerCase();

  if (t.includes('hour') || t.includes('open') || t.includes('close')) {
    extraInfo = "We’re open Mon–Fri 10am–7pm, Sat 10am–6pm, and closed Sunday.";
  } else if (t.includes('price') || t.includes('cost') || t.includes('service')) {
    const services = await phorest.listServices();
    const summary = services.slice(0, 4).map(s => `${s.name} ${s.price}`).join(', ');
    extraInfo = `Popular services and prices: ${summary}. I can book one for you.`;
  }

  const reply = await aiReply(userText, extraInfo ? { extraInfo } : undefined);

  const twiml = new VoiceResponse();
  const gather = twiml.gather({
    input: ['speech'],
    action: '/twilio/gather',
    method: 'POST',
    speechTimeout: 'auto'
  });
  gather.say({ voice: 'Polly.Joanna' }, reply);
  twiml.redirect('/twilio/voice');

  res.type('text/xml').send(twiml.toString());
});
