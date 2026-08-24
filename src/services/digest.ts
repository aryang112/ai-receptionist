// src/services/digest.ts
//
// M4: the daily owner digest SMS + Monday weekly summary. Richa/Aryan
// shouldn't have to open the /admin dashboard (M3) to know the pilot is
// working — this is the proactive "here's what Erica did for you yesterday"
// text, sent the following morning (ANALYTICS AUDIT FIX, 2026-08-22, P1 —
// a same-evening send would permanently miss every call after send time).
//
// Reads ONLY via readCalls() from callStore.ts (never a hand-rolled JSONL
// parser — same rule M3's admin.ts followed). A day's window is a
// salon-timezone CALENDAR day (luxon, env.TIMEZONE — sourced from
// business.json at boot, same as core/hours.ts), not a rolling 24h window,
// so the digest text reads naturally ("Erica yesterday: 6 calls...").
import fs from 'node:fs';
import path from 'node:path';
import { DateTime } from 'luxon';
import { env } from '../config/env.js';
import { logger } from '../core/logger.js';
import { readCalls } from '../services/callStore.js';
import { getOpenClose } from '../core/hours.js';
import { sendOwnerSms } from '../services/ownerSms.js';

// ─────────────────────────────────────────────────────────────────────────
// Record shapes read back from callStore.readCalls() — same loosely-typed
// approach as admin.ts (the store itself is the contract; this is just what
// this module reads off it).
// ─────────────────────────────────────────────────────────────────────────
type AnyRow = {
  type: string;
  callSid?: string;
  ts?: number;
  [k: string]: unknown;
};

/** One call's digest-relevant facts for a single calendar day (salon TZ). */
type DigestCall = {
  blocked: boolean;
  outcome: string;
  // ANALYTICS AUDIT FIX (2026-08-22, P1): a call can book MULTIPLE services
  // (multiple 'booking' rows) — bookingRevenue is the SUM of every row's
  // price, bookingCount is the number of booking ROWS (not calls), matching
  // admin.ts's /api/stats fix. A call with zero bookings has bookingCount 0
  // and bookingRevenue 0.
  bookingRevenue: number;
  bookingCount: number;
  estCostUsd: number | undefined;
  afterHours: boolean;
};

/**
 * Group readCalls() rows by callSid and keep only the ones whose start (or,
 * for a webhook-blocked S2 call with no start row, its 'blocked' row) falls
 * on `dateISO` in salon TZ. Mirrors admin.ts's buildCallSummaries grouping
 * (start+blocked → own 'blocked' entry; start present → the real call), kept
 * intentionally smaller since the digest only needs a handful of fields.
 */
function callsForDate(rows: AnyRow[], dateISO: string): DigestCall[] {
  const byCall = new Map<string, AnyRow[]>();
  for (const row of rows) {
    const callSid = row.callSid;
    if (!callSid) continue;
    const list = byCall.get(callSid);
    if (list) list.push(row);
    else byCall.set(callSid, [row]);
  }

  const out: DigestCall[] = [];
  for (const group of byCall.values()) {
    const start = group.find((r) => r.type === 'start');
    const blockedRow = group.find((r) => r.type === 'blocked');

    if (!start && blockedRow) {
      const ts = blockedRow.ts as number | undefined;
      if (typeof ts !== 'number') continue;
      const iso = DateTime.fromMillis(ts, { zone: env.TIMEZONE }).toISODate();
      if (iso !== dateISO) continue;
      out.push({
        blocked: true,
        outcome: 'blocked',
        bookingRevenue: 0,
        bookingCount: 0,
        estCostUsd: undefined,
        afterHours: false,
      });
      continue;
    }
    if (!start) continue; // malformed/partial group — nothing to count

    const ts = start.ts as number | undefined;
    if (typeof ts !== 'number') continue;
    const dt = DateTime.fromMillis(ts, { zone: env.TIMEZONE });
    const iso = dt.toISODate();
    if (iso !== dateISO) continue;

    // A transfer-failback call (the live transfer rang out and the caller was
    // reconnected to a fresh Erica session on the SAME callSid) writes one
    // 'end' row per segment. Same rule admin.ts's buildCallSummaries uses: the
    // LAST end row is the final word on the outcome, and cost SUMS across
    // segments (each segment's tokens were really spent). The digest reads no
    // other end-row field, so nothing else here needs the multi-row treatment.
    const endRows = group.filter((r) => r.type === 'end') as Array<{
      outcome?: string;
      estCostUsd?: number;
    }>;
    const end = endRows[endRows.length - 1];
    const estCostUsd = endRows.some((e) => e.estCostUsd !== undefined)
      ? endRows.reduce((sum, e) => sum + (e.estCostUsd ?? 0), 0)
      : undefined;
    // ANALYTICS AUDIT FIX (2026-08-22, P1): collect EVERY booking row for
    // this call, not just the last one — a call can book multiple services
    // in one visit, and the old `[...group].reverse().find(...)` silently
    // dropped every row but the last, under-counting both revenue and the
    // booked count.
    const bookingRows = group.filter((r) => r.type === 'booking') as Array<{
      price?: number;
    }>;
    const bookingRevenue = bookingRows.reduce(
      (sum, b) => sum + (b.price ?? 0),
      0
    );

    const openClose = getOpenClose(dateISO);
    const afterHours =
      !openClose || dt < openClose.open || dt >= openClose.close;

    out.push({
      blocked: false,
      outcome: end?.outcome ?? 'none',
      bookingRevenue,
      bookingCount: bookingRows.length,
      estCostUsd,
      afterHours,
    });
  }
  return out;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}
/**
 * ANALYTICS AUDIT FIX (2026-08-22, P2): whole-dollar amounts render with no
 * decimals ("$75"), fractional ones with exactly 2 ("$75.50") — never the
 * bare-float "$75.5" a plain template-literal interpolation produced.
 */
function fmtMoney(n: number): string {
  const r = round2(n);
  return Number.isInteger(r) ? `$${r}` : `$${r.toFixed(2)}`;
}

/**
 * Plain-text daily digest for `forDateISO` (salon-TZ calendar day). Returns
 * null when zero HANDLED calls happened that day — a webhook-blocked-only
 * day (S2 spam rejects, never opened a session) still counts as quiet, so
 * Richa doesn't get texted for a day nothing actually talked to Erica.
 * ≤ ~300 chars, no markdown. `label` controls the opening phrase ("Erica
 * `${label}`: ...") — the scheduler (maybeSendDigest) always passes
 * 'yesterday' since it summarizes the PREVIOUS salon-TZ day (ANALYTICS
 * AUDIT FIX, 2026-08-22, P1); defaults to 'today' for direct/adhoc callers.
 */
export function buildDailyDigest(
  forDateISO: string,
  label: string = 'today'
): string | null {
  const rows = readCalls() as AnyRow[];
  const calls = callsForDate(rows, forDateISO);
  const handled = calls.filter((c) => !c.blocked);
  if (handled.length === 0) return null;

  // ANALYTICS AUDIT FIX (2026-08-22, P1): "booked" now counts booking ROWS
  // (a call can book multiple services), not calls-with-a-booking — matches
  // admin.ts's /api/stats fix so the two surfaces agree.
  const bookedRows = handled.reduce((sum, c) => sum + c.bookingCount, 0);
  const revenue = round2(handled.reduce((sum, c) => sum + c.bookingRevenue, 0));
  const rescheduled = handled.filter((c) => c.outcome === 'rescheduled').length;
  const cancelled = handled.filter((c) => c.outcome === 'cancelled').length;
  const info = handled.filter((c) => c.outcome === 'info').length;
  const spamDeclined = handled.filter((c) => c.outcome === 'spam').length;
  const webhookBlocked = calls.filter((c) => c.blocked).length;
  const spamTotal = spamDeclined + webhookBlocked;
  const afterHoursBooked = handled.filter(
    (c) => c.afterHours && c.bookingCount > 0
  ).length;
  const estCost = round4(
    handled.reduce((sum, c) => sum + (c.estCostUsd ?? 0), 0)
  );

  const parts: string[] = [];
  // "booked" is an adjective here, not a countable noun — never pluralize it.
  if (bookedRows > 0) parts.push(`${bookedRows} booked (${fmtMoney(revenue)})`);
  if (rescheduled > 0) parts.push(plural(rescheduled, 'reschedule'));
  if (cancelled > 0) parts.push(plural(cancelled, 'cancellation'));
  if (info > 0) parts.push(`${plural(info, 'info call')}`);
  if (spamTotal > 0) parts.push(`${plural(spamTotal, 'spam block')}`);

  let msg = `Erica ${label}: ${plural(handled.length, 'call')}`;
  if (parts.length > 0) msg += ` — ${parts.join(', ')}`;
  msg += '.';
  if (afterHoursBooked > 0) {
    msg += ` ${plural(afterHoursBooked, 'after-hours booking')} captured.`;
  }
  if (estCost > 0) msg += ` Est cost $${estCost.toFixed(2)}.`;

  return msg;
}

/**
 * Plain-text weekly digest: 7-day totals ending on `weekEndISO` (inclusive,
 * salon-TZ calendar days) + the single best day by revenue. Same
 * quiet-week → null rule as the daily digest.
 */
export function buildWeeklyDigest(weekEndISO: string): string | null {
  const rows = readCalls() as AnyRow[];
  const end = DateTime.fromISO(weekEndISO, { zone: env.TIMEZONE });
  if (!end.isValid) return null;

  let totalHandled = 0;
  let totalBooked = 0;
  let totalRevenue = 0;
  let totalSpam = 0;
  let totalCost = 0;
  let bestDay: { dateISO: string; revenue: number } | null = null;

  for (let i = 6; i >= 0; i--) {
    const dateISO = end.minus({ days: i }).toISODate();
    if (!dateISO) continue;
    const calls = callsForDate(rows, dateISO);
    const handled = calls.filter((c) => !c.blocked);
    totalHandled += handled.length;

    // ANALYTICS AUDIT FIX (2026-08-22, P1): sum ALL booking rows for the
    // day (not just one per call) — same fix as buildDailyDigest/admin.ts.
    let dayRevenue = 0;
    for (const c of handled) {
      totalBooked += c.bookingCount;
      dayRevenue += c.bookingRevenue;
      if (c.outcome === 'spam') totalSpam += 1;
      totalCost += c.estCostUsd ?? 0;
    }
    totalSpam += calls.filter((c) => c.blocked).length;
    totalRevenue += dayRevenue;

    if (dayRevenue > 0 && (!bestDay || dayRevenue > bestDay.revenue)) {
      bestDay = { dateISO, revenue: dayRevenue };
    }
  }

  if (totalHandled === 0) return null;

  let msg = `Erica this week: ${plural(totalHandled, 'call')} — ${totalBooked} booked (${fmtMoney(totalRevenue)})`;
  if (totalSpam > 0) msg += `, ${plural(totalSpam, 'spam block')}`;
  msg += '.';
  if (bestDay) {
    const label = DateTime.fromISO(bestDay.dateISO, {
      zone: env.TIMEZONE,
    }).toFormat('ccc');
    msg += ` Best day: ${label} (${fmtMoney(bestDay.revenue)}).`;
  }
  if (totalCost > 0) msg += ` Est cost $${round4(totalCost).toFixed(2)}.`;

  return msg;
}

// ─────────────────────────────────────────────────────────────────────────
// Scheduler core — index.ts just wires a 60s setInterval around this. Kept
// here (not in index.ts) so tests can drive it directly with a fixed luxon
// DateTime and a tmp digest-state path, without touching real timers.
// ─────────────────────────────────────────────────────────────────────────
type DigestState = { lastSentISO?: string };

/** Never throws — a corrupt/missing state file just means "not sent yet". */
function loadDigestState(): DigestState {
  try {
    const raw = fs.readFileSync(env.DIGEST_STATE_PATH, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as DigestState) : {};
  } catch {
    return {};
  }
}

/** Never throws — same callStore/blocklist write-through pattern. */
function persistDigestState(state: DigestState): void {
  try {
    const file = env.DIGEST_STATE_PATH;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n');
  } catch (err) {
    logger.warn(
      { err },
      'digest: failed to persist digest-state — may re-check tomorrow'
    );
  }
}

/** "HH:mm" → [hour, minute], falling back to the 08:30 default on garbage input. */
function parseDigestTime(value: string): [number, number] {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (m) {
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    if (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) return [hh, mm];
  }
  return [8, 30];
}

function digestRecipients(): string[] {
  const raw = env.DIGEST_TO.trim();
  if (!raw) return env.OWNER_PHONE ? [env.OWNER_PHONE] : [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The testable scheduler core. Fires (sends SMS) at most once per
 * salon-TZ calendar day, only once `now` is at/past DIGEST_TIME — and, per
 * the ANALYTICS AUDIT FIX (2026-08-22, P1), the digest it sends covers
 * YESTERDAY (a full salon-TZ calendar day), not the still-in-progress
 * "today". A same-day-evening send (the old default) permanently excluded
 * every call after the send time — including the entire after-hours pilot
 * window — from any digest at all. When yesterday was a Sunday (i.e. this
 * fires on a Monday morning), the weekly summary is appended as a second
 * message, covering the 7 salon-TZ days ending on that Sunday (Mon..Sun
 * inclusive) — so a Sunday-evening call is no longer excluded from both the
 * daily AND the next weekly's window. Guarded internally by DIGEST_ENABLED
 * — index.ts's setInterval calls this unconditionally.
 *
 * Note: the "already ran today" stamp key is unchanged — it is stamped
 * against the day the check RUNS (today), not the day being summarized
 * (yesterday), so a restart after DIGEST_TIME still sends yesterday's
 * digest later the same day (state.lastSentISO !== today's date yet).
 * The stamp is written even on a quiet day (both digests null) —
 * otherwise a zero-call day would re-read the whole call store on every
 * 60s tick for the rest of the day for no reason. A late call arriving
 * AFTER a quiet day's digest check goes unreported until the weekly
 * rollup — an accepted trade-off, not a bug.
 */
export async function maybeSendDigest(
  now: DateTime = DateTime.now()
): Promise<void> {
  if (env.DIGEST_ENABLED !== 'true') return;

  const zoned = now.setZone(env.TIMEZONE);
  const todayISO = zoned.toISODate();
  if (!todayISO) return;

  const [dueHour, dueMinute] = parseDigestTime(env.DIGEST_TIME);
  const pastDigestTime =
    zoned.hour > dueHour ||
    (zoned.hour === dueHour && zoned.minute >= dueMinute);
  if (!pastDigestTime) return;

  const state = loadDigestState();
  if (state.lastSentISO === todayISO) return; // already handled today

  const recipients = digestRecipients();
  if (recipients.length === 0) {
    persistDigestState({ lastSentISO: todayISO });
    return;
  }

  const yesterday = zoned.minus({ days: 1 });
  const yesterdayISO = yesterday.toISODate();
  if (!yesterdayISO) {
    persistDigestState({ lastSentISO: todayISO });
    return;
  }

  const daily = buildDailyDigest(yesterdayISO, 'yesterday');
  if (daily) {
    for (const to of recipients) {
      await sendOwnerSms(daily, to);
    }
  }

  if (yesterday.weekday === 7) {
    // luxon: 7 = Sunday — yesterday was Sunday, so this is Monday morning
    // and the just-completed week (Mon..Sun) is ready to roll up.
    const weekly = buildWeeklyDigest(yesterdayISO);
    if (weekly) {
      for (const to of recipients) {
        await sendOwnerSms(weekly, to);
      }
    }
  }

  persistDigestState({ lastSentISO: todayISO });
}
