import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// S2: isBlocked is a bare function export (not a method on a shared object
// like `phorest`/`CallStore`), so mock the whole module rather than spy on a
// namespace object — guaranteed to work regardless of ESM export mutability.
vi.mock('../services/blocklist.js', () => ({
  isBlocked: vi.fn(),
}));

import { twilioVoice } from '../routes/twilio.js';
import { isBlocked } from '../services/blocklist.js';
import { CallStore } from '../services/callStore.js';

const app = express();
// Twilio webhooks POST form-encoded bodies — mirrors src/index.ts's real setup
// so req.body.From / req.body.StirVerstat / req.body.CallSid actually populate.
app.use(express.urlencoded({ extended: false }));
app.use('/twilio', twilioVoice);

describe('twilio voice route', () => {
  beforeEach(() => {
    vi.mocked(isBlocked).mockReset().mockReturnValue(false);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  describe('S2 — repeat-spam blocklist', () => {
    it('a blocked number gets Reject TwiML — no <Connect>, no stream', async () => {
      vi.mocked(isBlocked).mockReturnValue(true);
      const recordBlockedSpy = vi
        .spyOn(CallStore, 'recordBlocked')
        .mockImplementation(() => {});

      const res = await request(app)
        .post('/twilio/voice')
        .set('Host', 'example.ngrok.app')
        .set('X-Forwarded-Proto', 'https')
        .type('form')
        .send({ From: '+14105551234', CallSid: 'CA_blocked_1' });

      expect(res.status).toBe(200);
      const body = res.text;
      expect(body).toMatch(/<Reject/i);
      expect(body).not.toMatch(/<Connect>/i);
      expect(body).not.toMatch(/<Stream/i);
      expect(isBlocked).toHaveBeenCalledWith('+14105551234');
      expect(recordBlockedSpy).toHaveBeenCalledWith(
        'CA_blocked_1',
        '+14105551234',
        undefined
      );
    });

    it('an unblocked number still gets a normal <Connect><Stream>, with the from + stir parameters passed through', async () => {
      vi.mocked(isBlocked).mockReturnValue(false);

      const res = await request(app)
        .post('/twilio/voice')
        .set('Host', 'example.ngrok.app')
        .set('X-Forwarded-Proto', 'https')
        .type('form')
        .send({
          From: '+14105551234',
          StirVerstat: 'TN-Validation-Passed-A',
          CallSid: 'CA_ok_1',
        });

      expect(res.status).toBe(200);
      const body = res.text;
      expect(body).toMatch(/<Connect>/i);
      expect(body).toMatch(/<Stream/i);
      expect(body).not.toMatch(/<Reject/i);
      expect(body).toMatch(/name="from" value="\+14105551234"/);
      expect(body).toMatch(/name="stir" value="TN-Validation-Passed-A"/);
    });

    it('a call with no STIR header connects normally with no stir parameter at all', async () => {
      vi.mocked(isBlocked).mockReturnValue(false);

      const res = await request(app)
        .post('/twilio/voice')
        .set('Host', 'example.ngrok.app')
        .set('X-Forwarded-Proto', 'https')
        .send();

      expect(res.status).toBe(200);
      const body = res.text;
      expect(body).toMatch(/<Connect>/i);
      expect(body).not.toMatch(/name="stir"/);
    });
  });
});
