import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { env } from '../config/env.js';
import { logger } from '../core/logger.js';
import {
  logRingStream,
  recentWarnings,
  clearLogRing,
} from '../core/logRing.js';
import { adminRouter } from '../routes/admin.js';

const app = express();
app.use('/admin', adminRouter);

const orig = {
  ADMIN_TOKEN: env.ADMIN_TOKEN,
  NODE_ENV: env.NODE_ENV,
};

beforeEach(() => {
  clearLogRing();
  env.ADMIN_TOKEN = '';
  env.NODE_ENV = 'test';
});

afterEach(() => {
  clearLogRing();
  env.ADMIN_TOKEN = orig.ADMIN_TOKEN;
  env.NODE_ENV = orig.NODE_ENV;
});

describe('logRing capture', () => {
  it('captures warn and error lines from the real logger, not info', () => {
    logger.info({ probe: 'ring-info' }, 'info line stays out of the ring');
    logger.warn({ probe: 'ring-warn' }, 'warn line lands in the ring');
    logger.error({ probe: 'ring-error' }, 'error line lands in the ring');

    const lines = recentWarnings().map((e) => e.line);
    expect(lines.some((l) => l.includes('ring-warn'))).toBe(true);
    expect(lines.some((l) => l.includes('ring-error'))).toBe(true);
    expect(lines.some((l) => l.includes('ring-info'))).toBe(false);
    // pino's own numeric levels survive the round-trip
    const levels = recentWarnings().map((e) => e.level);
    expect(levels).toContain(40);
    expect(levels).toContain(50);
  });

  it('caps at 300 entries, keeping the newest', () => {
    for (let i = 0; i < 350; i++) {
      logRingStream.write(
        JSON.stringify({ level: 40, time: 1000 + i, msg: `w${i}` }) + '\n'
      );
    }
    const entries = recentWarnings();
    expect(entries.length).toBe(300);
    expect(entries[0]?.line).toContain('w50'); // oldest 50 evicted
    expect(entries[entries.length - 1]?.line).toContain('w349');
  });

  it('keeps a non-JSON line rather than dropping it', () => {
    logRingStream.write('not json at all\n');
    const entries = recentWarnings();
    expect(entries.length).toBe(1);
    expect(entries[0]?.line).toBe('not json at all');
    expect(entries[0]?.level).toBe(40);
  });
});

describe('GET /admin/api/logs', () => {
  it('requires auth when a token is configured', async () => {
    env.ADMIN_TOKEN = 'sekrit-token-for-test';
    const res = await request(app).get('/admin/api/logs');
    expect(res.status).toBe(401);
  });

  it('returns ring entries with Bearer auth', async () => {
    env.ADMIN_TOKEN = 'sekrit-token-for-test';
    logger.warn({ probe: 'ring-http' }, 'visible through the endpoint');
    const res = await request(app)
      .get('/admin/api/logs')
      .set('Authorization', 'Bearer sekrit-token-for-test');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.entries)).toBe(true);
    const lines = (res.body.entries as Array<{ line: string }>).map(
      (e) => e.line
    );
    expect(lines.some((l) => l.includes('ring-http'))).toBe(true);
  });

  it('honors ?limit=', async () => {
    // Authenticated request — an empty-token dev request makes adminAuth
    // itself emit a warn, which lands in the ring mid-test (that's the
    // feature working, but it makes the newest-entry assertion ambiguous).
    env.ADMIN_TOKEN = 'sekrit-token-for-test';
    for (let i = 0; i < 10; i++) {
      logRingStream.write(
        JSON.stringify({ level: 40, time: 2000 + i, msg: `lim${i}` }) + '\n'
      );
    }
    const res = await request(app)
      .get('/admin/api/logs?limit=3')
      .set('Authorization', 'Bearer sekrit-token-for-test');
    expect(res.status).toBe(200);
    expect(res.body.entries.length).toBe(3);
    expect(res.body.entries[2].line).toContain('lim9'); // newest kept
  });
});

describe('admin cache headers', () => {
  it('every /admin response carries Cache-Control: no-store', async () => {
    env.ADMIN_TOKEN = 'sekrit-token-for-test';
    const page = await request(app)
      .get('/admin')
      .set('Authorization', 'Bearer sekrit-token-for-test');
    expect(page.headers['cache-control']).toBe('no-store');
    const api = await request(app)
      .get('/admin/api/logs')
      .set('Authorization', 'Bearer sekrit-token-for-test');
    expect(api.headers['cache-control']).toBe('no-store');
  });
});

describe('dashboard CSP override', () => {
  it('the page allows inline script (helmet app-wide CSP would kill the dashboard JS)', async () => {
    env.ADMIN_TOKEN = 'sekrit-token-for-test';
    const page = await request(app)
      .get('/admin')
      .set('Authorization', 'Bearer sekrit-token-for-test');
    expect(page.headers['content-security-policy']).toContain(
      "script-src 'self' 'unsafe-inline'"
    );
    // API responses do NOT get the relaxed override
    const api = await request(app)
      .get('/admin/api/logs')
      .set('Authorization', 'Bearer sekrit-token-for-test');
    expect(api.headers['content-security-policy'] || '').not.toContain(
      "'unsafe-inline'"
    );
  });
});
