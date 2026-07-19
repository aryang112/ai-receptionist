import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';
import { twilioVoice } from '../routes/twilio.js';

const app = express();
app.use('/twilio', twilioVoice);

describe('twilio voice route', () => {
  it('returns TwiML containing streaming connect', async () => {
    const res = await request(app)
      .post('/twilio/voice')
      .set('Host', 'example.ngrok.app')
      .set('X-Forwarded-Proto', 'https')
      .send();

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('xml');
    const body = res.text;
    expect(body).toMatch(/<Connect>/i);
    expect(body).toMatch(/<Stream[^>]*url="wss:\/\/example.ngrok.app\/twilio\/stream"/i);
  });
});
