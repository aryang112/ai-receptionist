import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DateTime } from 'luxon';
import { env } from '../config/env.js';
import { getOpenClose } from '../core/hours.js';
import { adminRouter } from '../routes/admin.js';

// M3 — callStore.CALL_STORE_PATH is read at call-time (not module-load time,
// confirmed by reading callStore.ts before writing this file), so pointing
// env.CALL_STORE_PATH at a per-test tmp fixture works with a plain static
// import of adminRouter — no dynamic re-import dance needed (unlike
// blocklist.test.ts, which resets a different module-level cache).
const tmpFile = path.join(
  os.tmpdir(),
  `admin-test-${process.pid}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}.jsonl`
);

function writeFixture(records: unknown[]): void {
  fs.writeFileSync(
    tmpFile,
    records.map((r) => JSON.stringify(r)).join('\n') + '\n'
  );
}

const app = express();
app.use('/admin', adminRouter);

const orig = {
  CALL_STORE_PATH: env.CALL_STORE_PATH,
  ADMIN_TOKEN: env.ADMIN_TOKEN,
  NODE_ENV: env.NODE_ENV,
  TWILIO_ACCOUNT_SID: env.TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN: env.TWILIO_AUTH_TOKEN,
};

beforeEach(() => {
  env.CALL_STORE_PATH = tmpFile;
  env.ADMIN_TOKEN = '';
  env.NODE_ENV = 'test';
  writeFixture([]);
});

afterEach(() => {
  env.CALL_STORE_PATH = orig.CALL_STORE_PATH;
  env.ADMIN_TOKEN = orig.ADMIN_TOKEN;
  env.NODE_ENV = orig.NODE_ENV;
  env.TWILIO_ACCOUNT_SID = orig.TWILIO_ACCOUNT_SID;
  env.TWILIO_AUTH_TOKEN = orig.TWILIO_AUTH_TOKEN;
  vi.unstubAllGlobals();
});

afterAll(() => {
  try {
    fs.rmSync(tmpFile, { force: true });
  } catch {
    // best effort
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Fixture data
// ─────────────────────────────────────────────────────────────────────────
const nowMs = Date.now();
const recentTs = nowMs - 2 * 60 * 60 * 1000; // 2h ago
const oldTs = nowMs - 200 * 24 * 60 * 60 * 1000; // 200 days ago

const fullCallRows = [
  {
    type: 'start',
    callSid: 'CA_full',
    ts: recentTs,
    streamSid: 'MZ1',
    from: '+14105551234',
    recognizedClientId: 'client_9',
    stirVerstat: 'TN-Validation-Passed-A',
  },
  {
    type: 'tool',
    callSid: 'CA_full',
    ts: recentTs + 1000,
    name: 'transfer_to_owner',
    ok: false,
    error: 'Transfer unavailable',
  },
  {
    type: 'tool',
    callSid: 'CA_full',
    ts: recentTs + 2000,
    name: 'book_appointment',
    ok: true,
  },
  {
    type: 'booking',
    callSid: 'CA_full',
    ts: recentTs + 2500,
    service: 'Brow Threading',
    price: 25,
    date: '2026-06-20',
    time: '2:00 PM',
  },
  {
    type: 'recording',
    callSid: 'CA_full',
    ts: recentTs + 500,
    recordingSid: 'RE_full_1',
  },
  {
    type: 'transcript',
    callSid: 'CA_full',
    ts: recentTs + 5000,
    entries: [
      { role: 'caller', text: 'Hi, I need a brow appointment', ts: recentTs + 100 },
      { role: 'erica', text: 'Sure! What day works?', ts: recentTs + 200 },
    ],
  },
  {
    type: 'end',
    callSid: 'CA_full',
    ts: recentTs + 6000,
    durationMs: 45000,
    outcome: 'booked',
    usage: { inputTokens: 1000, outputTokens: 400, cachedTokens: 200, turns: 3 },
    estCostUsd: 0.05,
    endReason: 'caller confirmed done',
  },
];

const blockedRow = {
  type: 'blocked',
  callSid: 'CA_blocked',
  ts: recentTs,
  from: '+14105559999',
};

const silenceCallRows = [
  { type: 'start', callSid: 'CA_silence', ts: recentTs, from: '+14105550000' },
  {
    type: 'end',
    callSid: 'CA_silence',
    ts: recentTs + 30000,
    durationMs: 30000,
    outcome: 'none',
    endReason: 'silence — no response after check-in',
  },
];

const oldCallRows = [
  { type: 'start', callSid: 'CA_old', ts: oldTs, from: '+14105551111' },
  {
    type: 'booking',
    callSid: 'CA_old',
    ts: oldTs + 1000,
    service: 'Old Service',
    price: 999,
    date: '2025-01-01',
    time: '9:00 AM',
  },
  {
    type: 'end',
    callSid: 'CA_old',
    ts: oldTs + 2000,
    durationMs: 10000,
    outcome: 'booked',
    estCostUsd: 1,
  },
];

/** The most recent PAST calendar day (salon zone) that hours.ts says is
 * open — reuses the real getOpenClose contract instead of hardcoding a
 * weekday, so this test is robust to whatever date the suite runs on and
 * never collides with business.json's closedDates/vacations by construction. */
function mostRecentOpenDay(zone: string): DateTime {
  let d = DateTime.now().setZone(zone).minus({ days: 1 }).startOf('day');
  for (let i = 0; i < 21; i++) {
    const iso = d.toISODate();
    if (iso && getOpenClose(iso)) return d;
    d = d.minus({ days: 1 });
  }
  throw new Error('mostRecentOpenDay: no open day found in the last 21 days');
}

// ─────────────────────────────────────────────────────────────────────────
// Auth
// ─────────────────────────────────────────────────────────────────────────
describe('admin — auth (mirrors wsAuth fail-closed pattern)', () => {
  it('production + empty ADMIN_TOKEN refuses every route', async () => {
    env.ADMIN_TOKEN = '';
    env.NODE_ENV = 'production';
    const res1 = await request(app).get('/admin');
    expect(res1.status).toBe(401);
    const res2 = await request(app).get('/admin/api/calls');
    expect(res2.status).toBe(401);
  });

  it('dev/test + empty ADMIN_TOKEN is permissive', async () => {
    const res = await request(app).get('/admin/api/calls');
    expect(res.status).toBe(200);
  });

  it('configured token: no credentials at all → 401', async () => {
    env.ADMIN_TOKEN = 'secret123';
    const res = await request(app).get('/admin/api/calls');
    expect(res.status).toBe(401);
  });

  it('configured token: wrong Bearer token → 401', async () => {
    env.ADMIN_TOKEN = 'secret123';
    const res = await request(app)
      .get('/admin/api/calls')
      .set('Authorization', 'Bearer wrong');
    expect(res.status).toBe(401);
  });

  it('configured token: correct Bearer token → 200', async () => {
    env.ADMIN_TOKEN = 'secret123';
    const res = await request(app)
      .get('/admin/api/calls')
      .set('Authorization', 'Bearer secret123');
    expect(res.status).toBe(200);
  });

  it('configured token: ?token= on the page sets an httpOnly cookie and redirects clean', async () => {
    env.ADMIN_TOKEN = 'secret123';
    const res = await request(app).get('/admin?token=secret123');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/admin');
    const setCookie = res.headers['set-cookie'];
    expect(setCookie).toBeDefined();
    const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(cookieStr).toContain('admin_token=secret123');
    expect((cookieStr as string).toLowerCase()).toContain('httponly');
  });

  it('configured token: an incorrect ?token= is rejected, no cookie set', async () => {
    env.ADMIN_TOKEN = 'secret123';
    const res = await request(app).get('/admin?token=nope');
    expect(res.status).toBe(401);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('configured token: cookie-only auth (as set by a prior ?token= exchange) works for the JSON API too', async () => {
    env.ADMIN_TOKEN = 'secret123';
    const res = await request(app)
      .get('/admin/api/calls')
      .set('Cookie', 'admin_token=secret123');
    expect(res.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// /api/calls — the join
// ─────────────────────────────────────────────────────────────────────────
describe('admin — GET /admin/api/calls joins per callSid', () => {
  it('joins booking + usage + tools + flags for a full call, and never leaks the full phone number', async () => {
    writeFixture(fullCallRows);
    const res = await request(app).get('/admin/api/calls?days=1');
    expect(res.status).toBe(200);
    const call = res.body.calls.find((c: { callSid: string }) => c.callSid === 'CA_full');
    expect(call).toBeDefined();
    expect(call.fromLast4).toBe('1234');
    expect(call.recognized).toBe(true);
    expect(call.outcome).toBe('booked');
    expect(call.booking).toEqual({
      service: 'Brow Threading',
      price: 25,
      date: '2026-06-20',
      time: '2:00 PM',
    });
    expect(call.usage).toEqual({
      inputTokens: 1000,
      outputTokens: 400,
      cachedTokens: 200,
      turns: 3,
    });
    expect(call.estCostUsd).toBe(0.05);
    expect(call.hasRecording).toBe(true);
    expect(call.hasTranscript).toBe(true);
    expect(call.blocked).toBe(false);
    expect(call.tools).toEqual(
      expect.arrayContaining([
        { name: 'transfer_to_owner', ok: false },
        { name: 'book_appointment', ok: true },
      ])
    );
    expect(call.flags).toEqual(
      expect.arrayContaining(['tool-error', 'transfer-failed'])
    );
    expect(call.flags).not.toContain('no-outcome');

    // The store's full number must never reach the HTTP response.
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('4105551234');
  });

  it('a webhook-blocked call (no start record) becomes its own entry, last-4 only', async () => {
    writeFixture([blockedRow]);
    const res = await request(app).get('/admin/api/calls?days=1');
    const call = res.body.calls.find((c: { callSid: string }) => c.callSid === 'CA_blocked');
    expect(call).toBeDefined();
    expect(call.blocked).toBe(true);
    expect(call.outcome).toBe('blocked');
    expect(call.fromLast4).toBe('9999');
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('4105559999');
  });

  it('no-outcome + silence-hangup flags derive from outcome/endReason', async () => {
    writeFixture(silenceCallRows);
    const res = await request(app).get('/admin/api/calls?days=1');
    const call = res.body.calls.find((c: { callSid: string }) => c.callSid === 'CA_silence');
    expect(call.flags).toEqual(
      expect.arrayContaining(['no-outcome', 'silence-hangup'])
    );
  });

  it('the days window excludes calls older than the requested range', async () => {
    writeFixture(oldCallRows);
    const res = await request(app).get('/admin/api/calls?days=1');
    expect(
      res.body.calls.find((c: { callSid: string }) => c.callSid === 'CA_old')
    ).toBeUndefined();

    const res2 = await request(app).get('/admin/api/calls?days=365');
    expect(
      res2.body.calls.find((c: { callSid: string }) => c.callSid === 'CA_old')
    ).toBeDefined();
  });

  it('newest first', async () => {
    writeFixture([...fullCallRows, ...silenceCallRows]);
    const res = await request(app).get('/admin/api/calls?days=1');
    const ts = res.body.calls.map((c: { startTs: number }) => c.startTs);
    expect(ts).toEqual([...ts].sort((a, b) => b - a));
  });
});

// ─────────────────────────────────────────────────────────────────────────
// /api/stats — revenue/cost math + after-hours classification
// ─────────────────────────────────────────────────────────────────────────
describe('admin — GET /admin/api/stats math', () => {
  it('computes revenue, cost, spam, webhook-blocked, and after-hours counts', async () => {
    const day = mostRecentOpenDay('America/New_York');
    const dateISO = day.toISODate()!;
    const oc = getOpenClose(dateISO)!;
    const inHoursTs = oc.open.plus({ hours: 1 }).toMillis();
    const afterHoursTs = oc.close.plus({ hours: 2 }).toMillis();

    const rows = [
      // in-hours booked call: $40 revenue, $0.10 cost
      { type: 'start', callSid: 'CA_in', ts: inHoursTs, from: '+14105551111' },
      {
        type: 'booking',
        callSid: 'CA_in',
        ts: inHoursTs + 1000,
        service: 'X',
        price: 40,
        date: dateISO,
        time: '1:00 PM',
      },
      {
        type: 'end',
        callSid: 'CA_in',
        ts: inHoursTs + 2000,
        durationMs: 60000,
        outcome: 'booked',
        estCostUsd: 0.1,
      },
      // after-hours booked call: $60 revenue, $0.05 cost — captured after-hours booking
      { type: 'start', callSid: 'CA_after', ts: afterHoursTs, from: '+14105552222' },
      {
        type: 'booking',
        callSid: 'CA_after',
        ts: afterHoursTs + 1000,
        service: 'Y',
        price: 60,
        date: dateISO,
        time: '9:00 PM',
      },
      {
        type: 'end',
        callSid: 'CA_after',
        ts: afterHoursTs + 2000,
        durationMs: 60000,
        outcome: 'booked',
        estCostUsd: 0.05,
      },
      // spam decline, no revenue
      { type: 'start', callSid: 'CA_spam', ts: inHoursTs + 10000, from: '+14105553333' },
      {
        type: 'end',
        callSid: 'CA_spam',
        ts: inHoursTs + 11000,
        durationMs: 8000,
        outcome: 'spam',
        endReason: 'spam decline',
        estCostUsd: 0.01,
      },
      // webhook-blocked, never opened a session
      { type: 'blocked', callSid: 'CA_blocked2', ts: inHoursTs + 15000, from: '+14105554444' },
    ];
    writeFixture(rows);

    const res = await request(app).get('/admin/api/stats?days=30');
    expect(res.status).toBe(200);
    const t = res.body.totals;
    expect(t.calls).toBe(4);
    expect(t.bookings).toBe(2);
    expect(t.revenue).toBeCloseTo(100, 5);
    expect(t.afterHours).toBe(1);
    expect(t.spamDeclined).toBe(1);
    expect(t.webhookBlocked).toBe(1);
    expect(t.totalEstCostUsd).toBeCloseTo(0.16, 5);
    expect(t.revenuePerDollar).toBeCloseTo(100 / 0.16, 1);
    expect(t.outcomes.booked).toBe(2);
    expect(t.outcomes.spam).toBe(1);
    expect(t.outcomes.blocked).toBe(1);
  });

  it('revenuePerDollar is null when there is no cost data (null-safe divide)', async () => {
    writeFixture([
      { type: 'start', callSid: 'CA_nocost', ts: recentTs, from: '+14105550001' },
      {
        type: 'booking',
        callSid: 'CA_nocost',
        ts: recentTs + 1000,
        service: 'Z',
        price: 30,
        date: '2026-06-20',
        time: '3:00 PM',
      },
      {
        type: 'end',
        callSid: 'CA_nocost',
        ts: recentTs + 2000,
        durationMs: 20000,
        outcome: 'booked',
      },
    ]);
    const res = await request(app).get('/admin/api/stats?days=1');
    expect(res.body.totals.revenuePerDollar).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// /api/transcript/:callSid
// ─────────────────────────────────────────────────────────────────────────
describe('admin — GET /admin/api/transcript/:callSid', () => {
  it('returns the transcript entries for a call', async () => {
    writeFixture(fullCallRows);
    const res = await request(app).get('/admin/api/transcript/CA_full');
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(2);
    expect(res.body.entries[0]).toMatchObject({
      role: 'caller',
      text: 'Hi, I need a brow appointment',
    });
  });

  it('404s when there is no transcript for the call', async () => {
    const res = await request(app).get('/admin/api/transcript/CA_missing');
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// /api/recording/:callSid — the proxy
// ─────────────────────────────────────────────────────────────────────────
describe('admin — GET /admin/api/recording/:callSid proxy', () => {
  beforeEach(() => {
    env.TWILIO_ACCOUNT_SID = 'AC_test_sid';
    env.TWILIO_AUTH_TOKEN = 'test_auth_token_123';
  });

  it('requires auth like every other admin route', async () => {
    env.ADMIN_TOKEN = 'secret123';
    writeFixture(fullCallRows);
    const res = await request(app).get('/admin/api/recording/CA_full');
    expect(res.status).toBe(401);
  });

  it('404s when there is no recording for the call', async () => {
    const res = await request(app).get('/admin/api/recording/CA_missing');
    expect(res.status).toBe(404);
  });

  it('streams the recording audio and never leaks Twilio credentials in the response', async () => {
    writeFixture(fullCallRows);
    const fakeBytes = 'FAKE_MP3_BYTES';
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(fakeBytes));
        controller.close();
      },
    });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, body: stream });
    vi.stubGlobal('fetch', fetchMock);

    const res = await request(app)
      .get('/admin/api/recording/CA_full')
      .buffer(true)
      .parse((res2: NodeJS.EventEmitter, cb: (err: Error | null, body: Buffer) => void) => {
        const chunks: Buffer[] = [];
        res2.on('data', (c: Buffer) => chunks.push(c));
        res2.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('audio/mpeg');
    expect((res.body as Buffer).toString('utf8')).toBe(fakeBytes);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledOpts] = fetchMock.mock.calls[0] as [
      string,
      { headers: Record<string, string> },
    ];
    expect(calledUrl).toBe(
      'https://api.twilio.com/2010-04-01/Accounts/AC_test_sid/Recordings/RE_full_1.mp3'
    );
    const expectedAuth =
      'Basic ' + Buffer.from('AC_test_sid:test_auth_token_123').toString('base64');
    expect(calledOpts.headers.Authorization).toBe(expectedAuth);

    // The response the BROWSER sees never contains the raw creds anywhere.
    const rawHeaders = JSON.stringify(res.headers);
    expect(rawHeaders).not.toContain('test_auth_token_123');
    expect(rawHeaders.toLowerCase()).not.toContain('basic ');
    expect((res.body as Buffer).toString('utf8')).not.toContain('test_auth_token_123');
  });

  it('a Twilio fetch failure surfaces a 502 without throwing', async () => {
    writeFixture(fullCallRows);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 404, body: null })
    );
    const res = await request(app).get('/admin/api/recording/CA_full');
    expect(res.status).toBe(502);
  });
});
