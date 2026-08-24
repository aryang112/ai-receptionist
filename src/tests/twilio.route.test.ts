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
import { env } from '../config/env.js';

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
    expect(body).toMatch(
      /<Stream[^>]*url="wss:\/\/example.ngrok.app\/twilio\/stream"/i
    );
  });

  // Transfer failback (2026-08-24): handleTransferToOwner has no Express
  // `req`, so /voice hands the public host down to the media stream — that's
  // the only way the <Dial> can carry an absolute action URL.
  it('passes the public host through as a `host` stream parameter', async () => {
    const res = await request(app)
      .post('/twilio/voice')
      .set('Host', 'example.ngrok.app')
      .set('X-Forwarded-Proto', 'https')
      .type('form')
      .send({ From: '+14105551234', CallSid: 'CA_host_1' });

    expect(res.status).toBe(200);
    expect(res.text).toMatch(/name="host" value="example.ngrok.app"/);
  });

  it('prefers X-Forwarded-Host for the `host` parameter (behind the proxy)', async () => {
    const res = await request(app)
      .post('/twilio/voice')
      .set('Host', 'internal.local')
      .set('X-Forwarded-Host', 'erica.up.railway.app')
      .set('X-Forwarded-Proto', 'https')
      .send();

    expect(res.text).toMatch(/name="host" value="erica.up.railway.app"/);
    // …and the stream URL still agrees with it (one shared derivation).
    expect(res.text).toMatch(
      /url="wss:\/\/erica.up.railway.app\/twilio\/stream"/
    );
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

// ─────────────────────────────────────────────────────────────────────────
// POST /twilio/dial-status — the live-transfer no-answer fallback
// (2026-08-24). Before this route existed a <Dial> with no action meant a
// no-answer dumped the caller in Richa's PERSONAL voicemail and a
// busy/failed dial HUNG UP on them outright.
// ─────────────────────────────────────────────────────────────────────────
describe('twilio /dial-status route — transfer failback', () => {
  const origSecret = env.WS_AUTH_SECRET;
  beforeEach(() => {
    vi.mocked(isBlocked).mockReset().mockReturnValue(false);
    // Deterministic token minting regardless of the developer's .env.
    env.WS_AUTH_SECRET = 'dial-status-test-secret';
  });
  afterEach(() => {
    env.WS_AUTH_SECRET = origSecret;
    vi.restoreAllMocks();
  });

  function post(body: Record<string, string>) {
    return request(app)
      .post('/twilio/dial-status')
      .set('Host', 'example.ngrok.app')
      .set('X-Forwarded-Proto', 'https')
      .type('form')
      .send(body);
  }

  it('completed: the human conversation happened — Hangup, never a new stream', async () => {
    const res = await post({
      DialCallStatus: 'completed',
      CallSid: 'CA_dial_done',
      From: '+14105551234',
    });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('xml');
    expect(res.text).toMatch(/<Hangup\s*\/?>/i);
    expect(res.text).not.toMatch(/<Connect>/i);
    expect(res.text).not.toMatch(/<Stream/i);
  });

  it('no-answer: reconnects the caller to a fresh Erica session with transferFailed + a fresh token', async () => {
    const res = await post({
      DialCallStatus: 'no-answer',
      CallSid: 'CA_dial_noanswer',
      From: '+14105551234',
      StirVerstat: 'TN-Validation-Passed-A',
    });

    expect(res.status).toBe(200);
    const body = res.text;
    expect(body).toMatch(/<Connect>/i);
    expect(body).toMatch(
      /<Stream[^>]*url="wss:\/\/example.ngrok.app\/twilio\/stream"/i
    );
    expect(body).toMatch(/name="transferFailed" value="1"/);
    // The caller's context rides along, so the failback session still knows
    // who it's talking to…
    expect(body).toMatch(/name="from" value="\+14105551234"/);
    expect(body).toMatch(/name="stir" value="TN-Validation-Passed-A"/);
    expect(body).toMatch(/name="host" value="example.ngrok.app"/);
    // …and the WS auth gate is satisfied by a token bound to the same callSid.
    expect(body).toMatch(
      /name="token" value="CA_dial_noanswer\.\d+\.[0-9a-f]+"/
    );
    expect(body).not.toMatch(/<Hangup/i);
  });

  it('busy / failed / canceled all reconnect too — the caller is never hung up on', async () => {
    for (const status of ['busy', 'failed', 'canceled']) {
      const res = await post({
        DialCallStatus: status,
        CallSid: `CA_dial_${status}`,
        From: '+14105551234',
      });
      expect(res.status).toBe(200);
      expect(res.text).toMatch(/<Connect>/i);
      expect(res.text).toMatch(/name="transferFailed" value="1"/);
      expect(res.text).not.toMatch(/<Hangup/i);
    }
  });

  it('sits behind twilioSignature — an invalid signature is rejected with 403', async () => {
    // Mirrors middleware.test.ts: the middleware short-circuits under
    // NODE_ENV==='test', so activate it the same way that test does.
    const origNodeEnv = process.env.NODE_ENV;
    const origToken = env.TWILIO_AUTH_TOKEN;
    process.env.NODE_ENV = 'development';
    env.TWILIO_AUTH_TOKEN = 'some-token';
    try {
      const res = await post({
        DialCallStatus: 'no-answer',
        CallSid: 'CA_dial_unsigned',
      });
      expect(res.status).toBe(403);
      expect(res.text).not.toMatch(/<Connect>/i);
    } finally {
      process.env.NODE_ENV = origNodeEnv;
      env.TWILIO_AUTH_TOKEN = origToken;
    }
  });
});
