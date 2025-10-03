import express from 'express';
import { aiReply } from '../services/ai.js';
import { suggestSlots, bookAppointment } from '../services/booking.js';
import { phorest } from '../services/phorest.js';

const twilio = require('twilio');
const VoiceResponse = twilio.twiml.VoiceResponse;

export const twilioVoice = express.Router();

/**
 * Twilio hits this when the call first connects.
 * We greet and ask an open question; then <Gather input="speech"> sends transcript to /twilio/gather
 */
twilioVoice.post('/voice', async (_req, res) => {
  const twiml = new VoiceResponse();
  const gather = twiml.gather({
    input: 'speech',
    action: '/twilio/gather',
    method: 'POST',
    speechTimeout: 'auto'
  });
  gather.say({ voice: 'Polly.Joanna' }, "Hi, this is Erica from Richa's Threading Salon. How can I help you today?");
  // If no speech, fall through and reprompt:
  twiml.redirect('/twilio/voice');
  res.type('text/xml').send(twiml.toString());
});

/**
 * Twilio posts speechResult here (caller’s words).
 * We call OpenAI to generate a reply; optionally call your booking API when intent is obvious.
 */
twilioVoice.post('/gather', async (req, res) => {
  const userText: string = req.body.SpeechResult || '';

  // Very simple intent guess (you can improve later)
  const text = userText.toLowerCase();

  // Optionally, route to your backend flows (mock/real)
  let extraInfo: string | undefined;

  // Example: hours
  if (text.includes('hour') || text.includes('open') || text.includes('close')) {
    // pull from /api/hours equivalent (direct import not needed if you have a helper)
    extraInfo = "We’re open Mon–Fri 10am–7pm, Sat 10am–6pm, and closed Sunday.";
  }

  // Example: prices/services
  if (text.includes('price') || text.includes('cost') || text.includes('service')) {
    const services = await phorest.listServices();
    const top = services.map(s => `${s.name} ${s.price}`).slice(0, 4).join(', ');
    extraInfo = `Popular services and prices: ${top}. I can book one for you.`;
  }

  // (Optional) You can parse “book eyebrow on Oct 3 at 2pm” and call bookAppointment()
  // For MVP, we let OpenAI do the dialog first; when the user confirms details,
  // we’ll call your /api/book route.

  const reply = await aiReply(userText, extraInfo ? { extraInfo } : undefined);

  const twiml = new VoiceResponse();
  const gather = twiml.gather({
    input: 'speech',
    action: '/twilio/gather',
    method: 'POST',
    speechTimeout: 'auto'
  });
  gather.say({ voice: 'Polly.Joanna' }, reply);
  twiml.redirect('/twilio/voice');

  res.type('text/xml').send(twiml.toString());
});
