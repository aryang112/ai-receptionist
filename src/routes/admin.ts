// src/routes/admin.ts
//
// M3: the owner/Richa audit surface. GET-only — this route never mutates
// anything. Serves a self-contained dashboard.html plus a small read-only
// JSON API built entirely from callStore's readCalls() (never a hand-rolled
// JSONL parser — see callStore.ts's own design-rules comment).
//
// Auth: env.ADMIN_TOKEN, mirrors src/security/wsAuth.ts's fail-closed
// pattern — empty token is dev-permissive (one-time warn), but REFUSES every
// route in production. Never a raw string compare (constant-time hash
// compare — see safeTokenEquals).
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { DateTime } from 'luxon';
import { env } from '../config/env.js';
import { logger } from '../core/logger.js';
import { readCalls } from '../services/callStore.js';
import { getOpenClose } from '../core/hours.js';
import { recentWarnings } from '../core/logRing.js';

export const adminRouter = express.Router();

// ─────────────────────────────────────────────────────────────────────────
// Dashboard HTML — read once at boot, served from memory on every request.
// This is ESM (no __dirname); resolve via import.meta.url. The compiled
// `tsc` build copies referenced *.json* module imports into dist/ (verified:
// dist/config/business.json), but dashboard.html is plain static content, not
// a TS module import, so it is NOT auto-copied by the build. Try the path
// next to the running file first (works for `tsx` dev, where that file IS
// src/routes/admin.ts), then fall back to the source tree relative to the
// process cwd (works for a compiled `node dist/index.js` run from the repo
// root, since no asset-copy step exists in `npm run build` today).
// ─────────────────────────────────────────────────────────────────────────
const here = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_HTML_CANDIDATES = [
  path.join(here, '..', 'public', 'dashboard.html'),
  path.join(process.cwd(), 'src', 'public', 'dashboard.html'),
];
const DASHBOARD_HTML_PATH =
  DASHBOARD_HTML_CANDIDATES.find((p) => fs.existsSync(p)) ??
  DASHBOARD_HTML_CANDIDATES[0]!;

let dashboardHtml: string;
try {
  dashboardHtml = fs.readFileSync(DASHBOARD_HTML_PATH, 'utf8');
} catch (err) {
  logger.error(
    { err, path: DASHBOARD_HTML_PATH },
    'admin: failed to read dashboard.html at boot'
  );
  dashboardHtml = '<!doctype html><p>Dashboard unavailable.</p>';
}

// ─────────────────────────────────────────────────────────────────────────
// Auth
// ─────────────────────────────────────────────────────────────────────────
const COOKIE_NAME = 'admin_token';
let warnedNoAdminToken = false;

/**
 * Constant-time token compare. `timingSafeEqual` THROWS on a length
 * mismatch, and a naive pad would leak length via timing anyway — hashing
 * both sides first always yields two fixed 32-byte buffers, so the compare
 * never throws and never leaks the candidate's length.
 */
function safeTokenEquals(candidate: string, expected: string): boolean {
  const a = createHash('sha256').update(candidate).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function getCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (key !== name) continue;
    try {
      return decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      return part.slice(idx + 1).trim();
    }
  }
  return undefined;
}

function extractBearer(authHeader: string | undefined): string | undefined {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return undefined;
  return authHeader.slice('Bearer '.length).trim();
}

/**
 * Fails closed in production when ADMIN_TOKEN is unset (never fall open on
 * a missing secret where it matters — same rule as wsAuth.verifyStreamToken).
 * Dev/test with no token configured is permissive (warns once). When a
 * token IS configured, accepts it via `?token=`, `Authorization: Bearer`, or
 * the `admin_token` cookie already set by a prior `?token=` exchange. A
 * `?token=` hit on the page itself is stashed in an httpOnly cookie and the
 * request is redirected to the clean URL so the token never lingers in
 * browser history or access logs.
 */
export function adminAuth(req: Request, res: Response, next: NextFunction) {
  if (!env.ADMIN_TOKEN) {
    if (env.NODE_ENV === 'production') {
      res.status(401).json({ error: 'Admin dashboard is not configured' });
      return;
    }
    if (!warnedNoAdminToken) {
      warnedNoAdminToken = true;
      logger.warn(
        'ADMIN_TOKEN is empty — /admin is unauthenticated (dev only)'
      );
    }
    next();
    return;
  }

  const queryToken =
    typeof req.query.token === 'string' ? req.query.token : undefined;
  const candidate =
    queryToken ??
    extractBearer(req.headers.authorization) ??
    getCookie(req, COOKIE_NAME);

  if (!candidate || !safeTokenEquals(candidate, env.ADMIN_TOKEN)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  if (queryToken && req.path === '/') {
    res.cookie(COOKIE_NAME, queryToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure: env.NODE_ENV === 'production',
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });
    res.redirect('/admin');
    return;
  }

  next();
}

adminRouter.use(adminAuth);

// ─────────────────────────────────────────────────────────────────────────
// Record shapes read back from callStore.readCalls() (loosely typed — the
// store itself is the contract; this is just what this route reads off it).
// ─────────────────────────────────────────────────────────────────────────
type StartRow = {
  type: 'start';
  callSid: string;
  ts: number;
  from?: string;
  recognizedClientId?: string;
  stirVerstat?: string;
};
type ToolRow = {
  type: 'tool';
  callSid: string;
  ts: number;
  name: string;
  ok: boolean;
  error?: string;
  detail?: Record<string, unknown>;
};
type BookingRow = {
  type: 'booking';
  callSid: string;
  ts: number;
  service: string;
  price?: number;
  date: string;
  time: string;
};
type EndRow = {
  type: 'end';
  callSid: string;
  ts: number;
  durationMs: number;
  outcome: string;
  assistantTranscript?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    turns: number;
  };
  estCostUsd?: number;
  endReason?: string;
};
type TranscriptRow = {
  type: 'transcript';
  callSid: string;
  ts: number;
  entries: Array<{ role: 'caller' | 'erica'; text: string; ts: number }>;
};
type RecordingRow = {
  type: 'recording';
  callSid: string;
  ts: number;
  recordingSid: string;
};
type BlockedRow = {
  type: 'blocked';
  callSid: string;
  ts: number;
  from?: string;
  stirVerstat?: string;
};
// ANALYTICS AUDIT FIX (2026-08-22, P2): appended when a caller-ID match
// resolves AFTER the call's 'start' row has already been persisted (the
// c4b9c7d late-prefetch upgrade) — see twilioStream.ts's
// adoptRecognizedCaller. Its mere presence in a call's group means the
// call is recognized even though the start row's recognizedClientId is
// (permanently) empty.
type RecognizedRow = {
  type: 'recognized';
  callSid: string;
  ts: number;
  clientId: string;
};
type AnyRow =
  | StartRow
  | ToolRow
  | BookingRow
  | EndRow
  | TranscriptRow
  | RecordingRow
  | BlockedRow
  | RecognizedRow
  | { type: string; callSid?: string; ts?: number; [k: string]: unknown };

/** Never expose a full phone number over HTTP — last 4 digits only. */
function last4(phone: string | undefined): string | undefined {
  if (!phone) return undefined;
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : digits || undefined;
}

export type CallSummary = {
  callSid: string;
  startTs: number;
  fromLast4?: string | undefined;
  recognized: boolean;
  durationMs: number;
  outcome: string;
  endReason?: string | undefined;
  tools: Array<{ name: string; ok: boolean }>;
  // ANALYTICS AUDIT FIX (2026-08-22, P1): a call can book MULTIPLE services
  // (multiple 'booking' rows) — `bookings` is the full ordered list (always
  // present, empty when none). `booking` is kept as an ALIAS to the last
  // row for dashboard.html's existing single-booking detail card (its
  // render was left untouched — see admin.ts's /api/stats revenue fix for
  // the matching sum-not-last-row correction).
  bookings: Array<{
    service: string;
    price?: number | undefined;
    date: string;
    time: string;
  }>;
  booking?:
    | {
        service: string;
        price?: number | undefined;
        date: string;
        time: string;
      }
    | undefined;
  usage?: EndRow['usage'] | undefined;
  estCostUsd?: number | undefined;
  hasRecording: boolean;
  hasTranscript: boolean;
  blocked: boolean;
  flags: string[];
};

/** Grep-target: the exact endReason strings the code actually writes (see
 * twilioStream.ts setEndReasonOnce call sites) — matched loosely (includes)
 * so small wording tweaks upstream don't silently break the flag. */
function computeFlags(args: {
  outcome: string;
  endReason?: string | undefined;
  tools: Array<{ name: string; ok: boolean }>;
}): string[] {
  const flags: string[] = [];
  const reason = (args.endReason ?? '').toLowerCase();
  if (args.outcome === 'none') flags.push('no-outcome');
  if (args.tools.some((t) => !t.ok)) flags.push('tool-error');
  if (reason.includes('silence')) flags.push('silence-hangup');
  if (reason.includes('duration cap')) flags.push('duration-cap');
  if (args.outcome === 'spam' || reason.includes('spam')) flags.push('spam');
  if (args.tools.some((t) => t.name === 'transfer_to_owner' && !t.ok))
    flags.push('transfer-failed');
  return flags;
}

function buildCallSummaries(rows: AnyRow[]): CallSummary[] {
  const byCall = new Map<string, AnyRow[]>();
  for (const row of rows) {
    const callSid = (row as { callSid?: string }).callSid;
    if (!callSid) continue;
    const list = byCall.get(callSid);
    if (list) list.push(row);
    else byCall.set(callSid, [row]);
  }

  const out: CallSummary[] = [];
  for (const [callSid, group] of byCall) {
    const start = group.find((r) => r.type === 'start') as StartRow | undefined;
    const blocked = group.find((r) => r.type === 'blocked') as
      | BlockedRow
      | undefined;

    if (!start && blocked) {
      // S2: webhook-rejected before any OpenAI session — its own entry.
      out.push({
        callSid,
        startTs: blocked.ts,
        fromLast4: last4(blocked.from),
        recognized: false,
        durationMs: 0,
        outcome: 'blocked',
        tools: [],
        bookings: [],
        hasRecording: false,
        hasTranscript: false,
        blocked: true,
        flags: [],
      });
      continue;
    }
    if (!start) continue; // malformed/partial group — nothing to show

    const end = group.find((r) => r.type === 'end') as EndRow | undefined;
    const tools = group
      .filter((r): r is ToolRow => r.type === 'tool')
      .map((t) => ({ name: t.name, ok: t.ok }));
    // ANALYTICS AUDIT FIX (2026-08-22, P1): collect EVERY booking row for
    // this call — a call can book multiple services in one visit, and the
    // old `[...group].reverse().find(...)` silently dropped every row but
    // the last, under-counting revenue in /api/stats. `bookings` carries
    // the full list; `booking` stays as an alias to the LAST row for
    // dashboard.html's existing single-booking detail card.
    const bookingRows = group.filter(
      (r): r is BookingRow => r.type === 'booking'
    );
    const bookings = bookingRows.map((b) => ({
      service: b.service,
      ...(b.price !== undefined ? { price: b.price } : {}),
      date: b.date,
      time: b.time,
    }));
    const lastBooking = bookings[bookings.length - 1];
    const hasRecording = group.some((r) => r.type === 'recording');
    const hasTranscript = group.some((r) => r.type === 'transcript');
    // ANALYTICS AUDIT FIX (2026-08-22, P2): a caller-ID match that resolved
    // AFTER this call's start row was persisted (late-prefetch upgrade)
    // never lands in start.recognizedClientId — check for a 'recognized'
    // row too (see twilioStream.ts's adoptRecognizedCaller).
    const recognizedRow = group.some((r) => r.type === 'recognized');

    const outcome = end?.outcome ?? 'none';
    const endReason = end?.endReason;

    out.push({
      callSid,
      startTs: start.ts,
      fromLast4: last4(start.from),
      recognized: !!start.recognizedClientId || recognizedRow,
      durationMs: end?.durationMs ?? 0,
      outcome,
      ...(endReason ? { endReason } : {}),
      tools,
      bookings,
      ...(lastBooking ? { booking: lastBooking } : {}),
      ...(end?.usage ? { usage: end.usage } : {}),
      ...(end?.estCostUsd !== undefined ? { estCostUsd: end.estCostUsd } : {}),
      hasRecording,
      hasTranscript,
      blocked: false,
      flags: computeFlags({ outcome, endReason, tools }),
    });
  }

  out.sort((a, b) => b.startTs - a.startTs);
  return out;
}

function daysParam(req: Request, fallback: number): number {
  const raw = req.query.days;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ─────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────
adminRouter.get('/', (_req, res) => {
  res.type('html').send(dashboardHtml);
});

adminRouter.get('/api/calls', (req, res) => {
  const days = daysParam(req, 7);
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const rows = readCalls() as AnyRow[];
  const calls = buildCallSummaries(rows).filter((c) => c.startTs >= since);
  res.json({ days, calls });
});

adminRouter.get('/api/stats', (req, res) => {
  const days = daysParam(req, 30);
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const rows = readCalls() as AnyRow[];
  const calls = buildCallSummaries(rows).filter((c) => c.startTs >= since);

  type DayBucket = {
    date: string;
    calls: number;
    bookings: number;
    revenue: number;
    estCostUsd: number;
  };
  const dayMap = new Map<string, DayBucket>();
  const outcomes: Record<string, number> = {};
  let bookings = 0;
  let revenue = 0;
  let spamDeclined = 0;
  let afterHours = 0;
  let totalDurationMs = 0;
  let durationSamples = 0;
  let totalEstCostUsd = 0;

  for (const c of calls) {
    outcomes[c.outcome] = (outcomes[c.outcome] ?? 0) + 1;
    if (c.outcome === 'spam') spamDeclined += 1;

    // ANALYTICS AUDIT FIX (2026-08-22, P1): a webhook-blocked row never
    // opened an OpenAI session — it's reported separately as
    // `webhookBlocked` below, and must NOT inflate the `calls` totals or
    // the daily buckets (it still appears in /api/calls). Everything below
    // this guard (day bucket, revenue, after-hours, duration, cost) is
    // per-call data a blocked row never has.
    if (c.blocked) continue;

    const dt = DateTime.fromMillis(c.startTs, { zone: env.TIMEZONE });
    const dateISO = dt.toISODate() ?? 'unknown';
    let bucket = dayMap.get(dateISO);
    if (!bucket) {
      bucket = {
        date: dateISO,
        calls: 0,
        bookings: 0,
        revenue: 0,
        estCostUsd: 0,
      };
      dayMap.set(dateISO, bucket);
    }
    bucket.calls += 1;

    // ANALYTICS AUDIT FIX (2026-08-22, P1): sum EVERY booking row for this
    // call (a call can book multiple services) — "bookings"/"booked" is a
    // count of ROWS, not calls, and revenue is the sum of every row's
    // price. The old code read only the last booking row per call.
    for (const b of c.bookings) {
      bookings += 1;
      bucket.bookings += 1;
      const price = b.price ?? 0;
      revenue += price;
      bucket.revenue += price;
    }

    const openClose = getOpenClose(dateISO);
    const isAfterHours =
      !openClose || dt < openClose.open || dt >= openClose.close;
    if (isAfterHours) afterHours += 1;

    if (c.durationMs > 0) {
      totalDurationMs += c.durationMs;
      durationSamples += 1;
    }

    if (c.estCostUsd !== undefined) {
      totalEstCostUsd += c.estCostUsd;
      bucket.estCostUsd += c.estCostUsd;
    }
  }

  const webhookBlocked = calls.filter((c) => c.blocked).length;
  const nonBlockedCalls = calls.length - webhookBlocked;
  const avgDurationMs =
    durationSamples > 0 ? Math.round(totalDurationMs / durationSamples) : 0;
  const revenuePerDollar =
    totalEstCostUsd > 0 ? revenue / totalEstCostUsd : null;

  const daysList = [...dayMap.values()].sort((a, b) =>
    a.date < b.date ? 1 : a.date > b.date ? -1 : 0
  );

  res.json({
    days,
    daily: daysList,
    totals: {
      // ANALYTICS AUDIT FIX (2026-08-22, P1): excludes webhook-blocked rows
      // (reported separately below as webhookBlocked) — matches digest.ts's
      // definition of "calls" (handled calls only).
      calls: nonBlockedCalls,
      outcomes,
      bookings,
      revenue: Math.round(revenue * 100) / 100,
      spamDeclined,
      webhookBlocked,
      afterHours,
      avgDurationMs,
      totalEstCostUsd: Math.round(totalEstCostUsd * 10000) / 10000,
      revenuePerDollar:
        revenuePerDollar === null
          ? null
          : Math.round(revenuePerDollar * 100) / 100,
    },
  });
});

// Recent WARN+ server log lines from the in-memory ring (core/logRing.ts) —
// how the cloud QA routine sweeps for server errors without a Railway token.
// Ephemeral: covers the current container only, same as platform logs.
adminRouter.get('/api/logs', (req, res) => {
  const limit = Number(req.query.limit) || undefined;
  res.json({ entries: recentWarnings(limit) });
});

adminRouter.get('/api/transcript/:callSid', (req, res) => {
  const { callSid } = req.params;
  const rows = readCalls() as AnyRow[];
  const transcript = [...rows]
    .reverse()
    .find((r) => r.type === 'transcript' && r.callSid === callSid) as
    | TranscriptRow
    | undefined;
  if (!transcript) {
    res.status(404).json({ error: 'No transcript for this call' });
    return;
  }
  res.json({ callSid, entries: transcript.entries });
});

adminRouter.get('/api/recording/:callSid', async (req, res) => {
  const { callSid } = req.params;
  const rows = readCalls() as AnyRow[];
  const recording = [...rows]
    .reverse()
    .find((r) => r.type === 'recording' && r.callSid === callSid) as
    | RecordingRow
    | undefined;
  if (!recording) {
    res.status(404).json({ error: 'No recording for this call' });
    return;
  }
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) {
    res.status(503).json({ error: 'Recording playback not configured' });
    return;
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Recordings/${recording.recordingSid}.mp3`;
  try {
    const twilioRes = await fetch(url, {
      headers: {
        // Credentials go out over HTTPS to Twilio only — never echoed back
        // to the browser and never logged (not even on failure below).
        Authorization: `Basic ${Buffer.from(
          `${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`
        ).toString('base64')}`,
      },
    });
    if (!twilioRes.ok || !twilioRes.body) {
      logger.warn(
        { callSid, status: twilioRes.status },
        'admin: recording proxy fetch failed'
      );
      res.status(502).json({ error: 'Recording fetch failed' });
      return;
    }
    res.setHeader('Content-Type', 'audio/mpeg');
    Readable.fromWeb(
      twilioRes.body as import('stream/web').ReadableStream
    ).pipe(res);
  } catch (err) {
    logger.warn({ callSid, err: String(err) }, 'admin: recording proxy error');
    if (!res.headersSent)
      res.status(502).json({ error: 'Recording fetch failed' });
  }
});
