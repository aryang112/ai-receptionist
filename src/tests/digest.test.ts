import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
  vi,
} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DateTime } from 'luxon';

// M4: mock sendOwnerSms entirely (a plain fn spy) rather than mocking the
// 'twilio' package — digest.ts only cares that sendOwnerSms was called with
// the right (body, to) pairs, and this keeps the scheduler tests from ever
// touching a real/fake Twilio client at all.
const sendOwnerSmsMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../services/ownerSms.js', () => ({
  sendOwnerSms: sendOwnerSmsMock,
}));

// Point CALL_STORE_PATH / DIGEST_STATE_PATH at unique per-suite tmp files —
// same technique callStore.test.ts / blocklist.test.ts / admin.route.test.ts
// use. env.CALL_STORE_PATH and env.DIGEST_STATE_PATH are read at call-time
// (not module-load time — confirmed in callStore.ts/digest.ts), so a plain
// static reassignment after import works, matching admin.route.test.ts.
const tmpCallStore = path.join(
  os.tmpdir(),
  `digest-test-calls-${process.pid}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}.jsonl`
);
const tmpDigestState = path.join(
  os.tmpdir(),
  `digest-test-state-${process.pid}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}.json`
);

let CallStore: typeof import('../services/callStore.js').CallStore;
let buildDailyDigest: typeof import('../services/digest.js').buildDailyDigest;
let buildWeeklyDigest: typeof import('../services/digest.js').buildWeeklyDigest;
let maybeSendDigest: typeof import('../services/digest.js').maybeSendDigest;
let env: typeof import('../config/env.js').env;

beforeAll(async () => {
  ({ env } = await import('../config/env.js'));
  env.CALL_STORE_PATH = tmpCallStore;
  env.DIGEST_STATE_PATH = tmpDigestState;
  ({ CallStore } = await import('../services/callStore.js'));
  ({ buildDailyDigest, buildWeeklyDigest, maybeSendDigest } = await import(
    '../services/digest.js'
  ));
});

afterAll(() => {
  for (const f of [tmpCallStore, tmpDigestState]) {
    try {
      fs.rmSync(f, { force: true });
    } catch {
      // best effort
    }
  }
});

// business.json (V1) has NO vacation/closedDates on 2026-08-19/20 and salon
// hours cover the daytime slots used below (see hours.test.ts fixtures) —
// 2026-08-19 is a Wednesday, well within the standing weekday hours.
const DAY = '2026-08-19'; // Wednesday
const QUIET_DAY = '2026-08-18'; // Tuesday — nothing recorded for this date

let seq = 0;
function nextCallSid(): string {
  seq += 1;
  return `CA_digest_${seq}`;
}

function tsAt(dateISO: string, hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return DateTime.fromISO(dateISO, { zone: env.TIMEZONE })
    .set({ hour: h, minute: m, second: 0, millisecond: 0 })
    .toMillis();
}

describe('buildDailyDigest / buildWeeklyDigest (M4)', () => {
  beforeEach(() => {
    // Truncate the tmp call store between tests so each test's fixture is isolated.
    try {
      fs.writeFileSync(tmpCallStore, '');
    } catch {
      // ignore
    }
  });

  it('returns null when there were zero handled calls that day (file empty)', () => {
    expect(buildDailyDigest(QUIET_DAY)).toBeNull();
  });

  it('returns null on a webhook-blocked-only day (S2 reject, never opened a session)', () => {
    const sid = nextCallSid();
    CallStore.recordBlocked(sid, '4105551234');
    // recordBlocked stamps Date.now() — force it onto QUIET_DAY via a
    // constructed ts write instead, since recordBlocked doesn't take one.
    // Simplest: read back, fix the ts, rewrite the line directly.
    const raw = fs.readFileSync(tmpCallStore, 'utf8').trim().split('\n');
    const fixed = raw.map((line) => {
      const row = JSON.parse(line);
      if (row.callSid === sid) row.ts = tsAt(QUIET_DAY, '11:00');
      return JSON.stringify(row);
    });
    fs.writeFileSync(tmpCallStore, fixed.join('\n') + '\n');

    expect(buildDailyDigest(QUIET_DAY)).toBeNull();
  });

  it('a fixture day with booking + spam + after-hours + cost produces exact math', () => {
    // Call 1: booked, $45, in-hours (business.json Wed = 12:00-19:00; 3pm is
    // squarely inside), some cost.
    const sid1 = nextCallSid();
    CallStore.startCall({ callSid: sid1, startedAt: tsAt(DAY, '15:00') });
    CallStore.recordBooking(sid1, {
      service: 'Brow Threading',
      price: 45,
      date: DAY,
      time: '15:15',
    });
    CallStore.endCall(sid1, {
      endedAt: tsAt(DAY, '11:05'),
      durationMs: 60000,
      outcome: 'booked',
      estCostUsd: 0.12,
    });

    // Call 2: booked AFTER HOURS (9pm — salon closed), $30 — the "captured" case.
    const sid2 = nextCallSid();
    CallStore.startCall({ callSid: sid2, startedAt: tsAt(DAY, '21:00') });
    CallStore.recordBooking(sid2, {
      service: 'Lash Lift',
      price: 30,
      date: DAY,
      time: '21:15',
    });
    CallStore.endCall(sid2, {
      endedAt: tsAt(DAY, '21:04'),
      durationMs: 45000,
      outcome: 'booked',
      estCostUsd: 0.08,
    });

    // Call 3: spam decline, no booking.
    const sid3 = nextCallSid();
    CallStore.startCall({ callSid: sid3, startedAt: tsAt(DAY, '13:00') });
    CallStore.endCall(sid3, {
      endedAt: tsAt(DAY, '13:01'),
      durationMs: 15000,
      outcome: 'spam',
      estCostUsd: 0.02,
    });

    // Call 4: info call (price/hours question), no booking.
    const sid4 = nextCallSid();
    CallStore.startCall({ callSid: sid4, startedAt: tsAt(DAY, '14:00') });
    CallStore.endCall(sid4, {
      endedAt: tsAt(DAY, '14:02'),
      durationMs: 30000,
      outcome: 'info',
      estCostUsd: 0.05,
    });

    const digest = buildDailyDigest(DAY);
    expect(digest).not.toBeNull();
    expect(digest!.length).toBeLessThanOrEqual(300);

    // Exact math: revenue = 45 + 30 = 75; cost = 0.12+0.08+0.02+0.05 = 0.27.
    expect(digest).toContain('4 calls');
    expect(digest).toContain('2 booked ($75)');
    expect(digest).toContain('1 spam block');
    expect(digest).toContain('1 info call');
    expect(digest).toContain('1 after-hours booking');
    expect(digest).toContain('Est cost $0.27');
    expect(digest).not.toMatch(/undefined|NaN/);
  });

  it('weekly digest sums 7 days and picks the best day by revenue', () => {
    // Two days of bookings inside the 7-day window ending on DAY.
    const day1 = DateTime.fromISO(DAY, { zone: env.TIMEZONE })
      .minus({ days: 2 })
      .toISODate()!;
    const day2 = DAY;

    const sidA = nextCallSid();
    CallStore.startCall({ callSid: sidA, startedAt: tsAt(day1, '10:00') });
    CallStore.recordBooking(sidA, {
      service: 'Full Face',
      price: 20,
      date: day1,
      time: '10:15',
    });
    CallStore.endCall(sidA, {
      endedAt: tsAt(day1, '10:03'),
      durationMs: 20000,
      outcome: 'booked',
      estCostUsd: 0.05,
    });

    const sidB = nextCallSid();
    CallStore.startCall({ callSid: sidB, startedAt: tsAt(day2, '12:00') });
    CallStore.recordBooking(sidB, {
      service: 'Brow Lamination',
      price: 60,
      date: day2,
      time: '12:15',
    });
    CallStore.endCall(sidB, {
      endedAt: tsAt(day2, '12:04'),
      durationMs: 25000,
      outcome: 'booked',
      estCostUsd: 0.06,
    });

    const weekly = buildWeeklyDigest(DAY);
    expect(weekly).not.toBeNull();
    expect(weekly).toContain('2 calls');
    // ANALYTICS AUDIT FIX (2026-08-22, P2): whole-dollar amounts render with
    // no decimals — "$80", not "$80.00".
    expect(weekly).toContain('2 booked ($80)');
    // day2 ($60) beats day1 ($20) — best day should be day2's weekday label.
    const day2Label = DateTime.fromISO(day2, { zone: env.TIMEZONE }).toFormat(
      'ccc'
    );
    expect(weekly).toContain(`Best day: ${day2Label} ($60)`);
  });

  it('weekly digest returns null when the whole 7-day window is quiet', () => {
    expect(buildWeeklyDigest(QUIET_DAY)).toBeNull();
  });

  it('ANALYTICS AUDIT FIX: a call with TWO booking rows sums revenue across both, not just the last', () => {
    const sid = nextCallSid();
    CallStore.startCall({ callSid: sid, startedAt: tsAt(DAY, '15:00') });
    CallStore.recordBooking(sid, {
      service: 'Brow Threading',
      price: 25,
      date: DAY,
      time: '15:15',
    });
    CallStore.recordBooking(sid, {
      service: 'Lash Lift',
      price: 30.5,
      date: DAY,
      time: '15:45',
    });
    CallStore.endCall(sid, {
      endedAt: tsAt(DAY, '15:05'),
      durationMs: 60000,
      outcome: 'booked',
      estCostUsd: 0.05,
    });

    const digest = buildDailyDigest(DAY);
    expect(digest).not.toBeNull();
    // 2 booking ROWS on ONE call — "2 booked", not "1 booked".
    expect(digest).toContain('2 booked ($55.50)');
  });

  it('ANALYTICS AUDIT FIX: fractional revenue renders with exactly 2 decimals ("$75.50", never "$75.5")', () => {
    const sid = nextCallSid();
    CallStore.startCall({ callSid: sid, startedAt: tsAt(DAY, '16:00') });
    CallStore.recordBooking(sid, {
      service: 'Full Face',
      price: 75.5,
      date: DAY,
      time: '16:15',
    });
    CallStore.endCall(sid, {
      endedAt: tsAt(DAY, '16:05'),
      durationMs: 60000,
      outcome: 'booked',
      estCostUsd: 0.03,
    });

    const digest = buildDailyDigest(DAY);
    expect(digest).toContain('$75.50');
    expect(digest).not.toContain('$75.5)'); // never the bare-float form
  });

  // Transfer failback (2026-08-24): the live transfer rang out and the caller
  // was reconnected to a second Erica session on the SAME callSid, so the call
  // has TWO end rows. Same rule as admin.ts: last outcome wins, cost sums.
  it('a transfer-failback call (two end rows) counts once, takes the LAST outcome and SUMS cost', () => {
    const sid = nextCallSid();
    CallStore.startCall({ callSid: sid, startedAt: tsAt(DAY, '14:00') });
    // Segment 1 ended in the transfer…
    CallStore.endCall(sid, {
      endedAt: tsAt(DAY, '14:02'),
      durationMs: 120000,
      outcome: 'transferred',
      estCostUsd: 0.04,
    });
    // …segment 2 is how the call actually ended.
    CallStore.endCall(sid, {
      endedAt: tsAt(DAY, '14:05'),
      durationMs: 90000,
      outcome: 'info',
      estCostUsd: 0.02,
    });

    const digest = buildDailyDigest(DAY);
    // ONE call (one start row), reported by its FINAL outcome…
    expect(digest).toContain('Erica today: 1 call');
    expect(digest).toContain('1 info call');
    // …and both segments' tokens were really spent, so the cost is the sum.
    expect(digest).toContain('Est cost $0.06');
  });
});

// ANALYTICS AUDIT FIX (2026-08-22, P1): the scheduler now summarizes
// YESTERDAY, sent the FOLLOWING morning — TRIGGER_DAY is the day the check
// runs ("today" from the scheduler's point of view); DAY (2026-08-19,
// Wednesday) is the day being summarized ("yesterday"). Default DIGEST_TIME
// is now '08:30'.
const TRIGGER_DAY = DateTime.fromISO(DAY, { zone: 'America/New_York' })
  .plus({ days: 1 })
  .toISODate()!; // 2026-08-20, Thursday

describe('maybeSendDigest scheduler core (M4)', () => {
  let origEnabled: string;
  let origTime: string;
  let origTo: string;
  let origOwnerPhone: string;

  beforeAll(() => {
    origEnabled = env.DIGEST_ENABLED;
    origTime = env.DIGEST_TIME;
    origTo = env.DIGEST_TO;
    origOwnerPhone = env.OWNER_PHONE;
  });

  beforeEach(() => {
    env.DIGEST_ENABLED = 'true';
    env.DIGEST_TIME = '08:30';
    env.DIGEST_TO = '';
    env.OWNER_PHONE = '+14433706471';
    sendOwnerSmsMock.mockClear();
    try {
      fs.rmSync(tmpDigestState, { force: true });
    } catch {
      // ignore
    }
    try {
      fs.writeFileSync(tmpCallStore, '');
    } catch {
      // ignore
    }
  });

  afterEach(() => {
    env.DIGEST_ENABLED = origEnabled;
    env.DIGEST_TIME = origTime;
    env.DIGEST_TO = origTo;
    env.OWNER_PHONE = origOwnerPhone;
  });

  function seedOneBookedCall(dateISO: string) {
    const sid = nextCallSid();
    CallStore.startCall({ callSid: sid, startedAt: tsAt(dateISO, '11:00') });
    CallStore.recordBooking(sid, {
      service: 'Brow Threading',
      price: 45,
      date: dateISO,
      time: '11:15',
    });
    CallStore.endCall(sid, {
      endedAt: tsAt(dateISO, '11:05'),
      durationMs: 60000,
      outcome: 'booked',
      estCostUsd: 0.12,
    });
  }

  it('does NOT fire before DIGEST_TIME', async () => {
    seedOneBookedCall(DAY);
    const before = DateTime.fromISO(TRIGGER_DAY, { zone: env.TIMEZONE }).set({
      hour: 8,
      minute: 0,
    });

    await maybeSendDigest(before);

    expect(sendOwnerSmsMock).not.toHaveBeenCalled();
  });

  it('fires once past DIGEST_TIME and covers YESTERDAY, stamping TODAY (the trigger day)', async () => {
    seedOneBookedCall(DAY);
    const atDue = DateTime.fromISO(TRIGGER_DAY, { zone: env.TIMEZONE }).set({
      hour: 8,
      minute: 30,
    });

    await maybeSendDigest(atDue);

    expect(sendOwnerSmsMock).toHaveBeenCalledTimes(1);
    expect(sendOwnerSmsMock.mock.calls[0]?.[1]).toBe('+14433706471');
    expect(sendOwnerSmsMock.mock.calls[0]?.[0]).toContain('booked');
    // ANALYTICS AUDIT FIX: opens with "Erica yesterday" — the call happened
    // on DAY, the check ran on TRIGGER_DAY (DAY+1).
    expect(sendOwnerSmsMock.mock.calls[0]?.[0]).toContain('Erica yesterday');

    // Stamp key is unchanged: the day the CHECK ran (TRIGGER_DAY), not the
    // day summarized (DAY).
    const state = JSON.parse(fs.readFileSync(tmpDigestState, 'utf8'));
    expect(state.lastSentISO).toBe(TRIGGER_DAY);
  });

  it("a restart well after DIGEST_TIME (no prior stamp for today) still sends yesterday's digest", async () => {
    // Simulates a process restart: no digest-state file exists yet, and
    // `now` is hours past DIGEST_TIME on TRIGGER_DAY — the stamp check
    // (lastSentISO !== todayISO) is untouched by the yesterday-semantics
    // fix, so this must still fire exactly once.
    seedOneBookedCall(DAY);
    const wellAfterDue = DateTime.fromISO(TRIGGER_DAY, {
      zone: env.TIMEZONE,
    }).set({ hour: 14, minute: 0 });

    await maybeSendDigest(wellAfterDue);

    expect(sendOwnerSmsMock).toHaveBeenCalledTimes(1);
    expect(sendOwnerSmsMock.mock.calls[0]?.[0]).toContain('Erica yesterday');
  });

  it('never sends twice the same day, even on a later tick', async () => {
    seedOneBookedCall(DAY);
    const atDue = DateTime.fromISO(TRIGGER_DAY, { zone: env.TIMEZONE }).set({
      hour: 8,
      minute: 30,
    });
    const laterTick = atDue.plus({ minutes: 5 });

    await maybeSendDigest(atDue);
    expect(sendOwnerSmsMock).toHaveBeenCalledTimes(1);

    await maybeSendDigest(laterTick);
    expect(sendOwnerSmsMock).toHaveBeenCalledTimes(1); // still just once
  });

  it('a quiet yesterday (no handled calls) does not send, but still stamps so it does not re-check all day', async () => {
    // QUIET_DAY itself has nothing seeded; trigger the check the day AFTER
    // QUIET_DAY so "yesterday" (from the check's perspective) is the quiet one.
    const triggerAfterQuiet = DateTime.fromISO(QUIET_DAY, {
      zone: env.TIMEZONE,
    })
      .plus({ days: 1 })
      .toISODate()!;
    const atDue = DateTime.fromISO(triggerAfterQuiet, {
      zone: env.TIMEZONE,
    }).set({ hour: 8, minute: 30 });

    await maybeSendDigest(atDue);

    expect(sendOwnerSmsMock).not.toHaveBeenCalled();
    const state = JSON.parse(fs.readFileSync(tmpDigestState, 'utf8'));
    expect(state.lastSentISO).toBe(triggerAfterQuiet);
  });

  it('DIGEST_ENABLED=false short-circuits entirely (no send, no stamp)', async () => {
    env.DIGEST_ENABLED = 'false';
    seedOneBookedCall(DAY);
    const atDue = DateTime.fromISO(TRIGGER_DAY, { zone: env.TIMEZONE }).set({
      hour: 8,
      minute: 30,
    });

    await maybeSendDigest(atDue);

    expect(sendOwnerSmsMock).not.toHaveBeenCalled();
    expect(fs.existsSync(tmpDigestState)).toBe(false);
  });

  it('Monday morning (yesterday was Sunday) appends the weekly summary as a second message', async () => {
    // ANALYTICS AUDIT FIX (2026-08-22, P1): the weekly now fires when
    // YESTERDAY was Sunday (i.e. the check runs Monday morning), covering
    // the 7 salon-TZ days ending on that Sunday — not "today is Sunday"
    // (the old behavior, which excluded Sunday-evening calls from both the
    // daily AND the next weekly's window).
    const sunday = DateTime.fromISO(DAY, { zone: env.TIMEZONE })
      .set({ weekday: 7 })
      .toISODate()!;
    const monday = DateTime.fromISO(sunday, { zone: env.TIMEZONE })
      .plus({ days: 1 })
      .toISODate()!;
    seedOneBookedCall(sunday);
    const atDue = DateTime.fromISO(monday, { zone: env.TIMEZONE }).set({
      hour: 8,
      minute: 30,
    });

    await maybeSendDigest(atDue);

    expect(sendOwnerSmsMock).toHaveBeenCalledTimes(2);
    expect(sendOwnerSmsMock.mock.calls[0]?.[0]).toContain('Erica yesterday');
    expect(sendOwnerSmsMock.mock.calls[1]?.[0]).toContain('Erica this week');
  });

  it('DIGEST_TO with multiple recipients sends one SMS per recipient', async () => {
    env.DIGEST_TO = '+14105551111, +14105552222';
    seedOneBookedCall(DAY);
    const atDue = DateTime.fromISO(TRIGGER_DAY, { zone: env.TIMEZONE }).set({
      hour: 8,
      minute: 30,
    });

    await maybeSendDigest(atDue);

    expect(sendOwnerSmsMock).toHaveBeenCalledTimes(2);
    expect(sendOwnerSmsMock.mock.calls[0]?.[1]).toBe('+14105551111');
    expect(sendOwnerSmsMock.mock.calls[1]?.[1]).toBe('+14105552222');
  });
});
