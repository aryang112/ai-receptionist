import { describe, it, expect, afterEach, vi } from 'vitest';
import { rateLimiter } from '../middleware/rateLimit.js';
import { twilioSignature } from '../middleware/twilioSignature.js';
import { env } from '../config/env.js';

// F10i — close the endpoint-security coverage gaps the earlier swarms left:
// the rate-limit window and the Twilio signature 403 reject path (the route
// test only passed via the NODE_ENV==='test' bypass).

function res() {
  const r: any = {
    statusCode: 0,
    body: null,
    ended: false,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      this.ended = true;
      return this;
    },
    send() {
      this.ended = true;
      return this;
    },
  };
  return r;
}

describe('rateLimiter (F10l/F10i)', () => {
  it('allows up to max, then 429s within the window', () => {
    const mw = rateLimiter({ windowMs: 60_000, max: 2 });
    const next = vi.fn();
    const req: any = { ip: '1.1.1.1' };
    mw(req, res(), next);
    mw(req, res(), next);
    const blocked = res();
    mw(req, blocked, next);
    expect(next).toHaveBeenCalledTimes(2);
    expect(blocked.statusCode).toBe(429);
  });

  it('keeps separate buckets per IP', () => {
    const mw = rateLimiter({ windowMs: 60_000, max: 1 });
    const next = vi.fn();
    mw({ ip: '1.1.1.1' } as any, res(), next);
    mw({ ip: '2.2.2.2' } as any, res(), next);
    expect(next).toHaveBeenCalledTimes(2);
  });
});

describe('twilioSignature (F10i)', () => {
  const origToken = env.TWILIO_AUTH_TOKEN;
  afterEach(() => {
    process.env.NODE_ENV = 'test';
    env.TWILIO_AUTH_TOKEN = origToken;
  });

  it('rejects an invalid signature with 403 when active', () => {
    process.env.NODE_ENV = 'development'; // not test -> middleware active
    env.TWILIO_AUTH_TOKEN = 'some-token';
    const mw = twilioSignature();
    const req: any = {
      header: (h: string) =>
        h === 'X-Twilio-Signature'
          ? 'bad-signature'
          : h === 'x-forwarded-proto'
            ? 'https'
            : h === 'x-forwarded-host'
              ? 'x.ngrok.app'
              : undefined,
      headers: { host: 'x.ngrok.app' },
      protocol: 'https',
      originalUrl: '/twilio/voice',
      body: {},
    };
    const r = res();
    const next = vi.fn();
    mw(req, r, next);
    expect(r.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('passes through in test mode (cannot validate without a real request)', () => {
    process.env.NODE_ENV = 'test';
    const mw = twilioSignature();
    const next = vi.fn();
    mw({ header: () => undefined, body: {} } as any, res(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
