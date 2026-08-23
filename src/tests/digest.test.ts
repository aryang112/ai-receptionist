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
    expect(weekly).toContain('2 booked ($80.00)');
    // day2 ($60) beats day1 ($20) — best day should be day2's weekday label.
    const day2Label = DateTime.fromISO(day2, { zone: env.TIMEZONE }).toFormat(
      'ccc'
    );
    expect(weekly).toContain(`Best day: ${day2Label} ($60.00)`);
  });

  it('weekly digest returns null when the whole 7-day window is quiet', () => {
    expect(buildWeeklyDigest(QUIET_DAY)).toBeNull();
  });
});

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
    env.DIGEST_TIME = '19:30';
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
    const before = DateTime.fromISO(DAY, { zone: env.TIMEZONE }).set({
      hour: 19,
      minute: 0,
    });

    await maybeSendDigest(before);

    expect(sendOwnerSmsMock).not.toHaveBeenCalled();
  });

  it('fires once past DIGEST_TIME and stamps digest-state', async () => {
    seedOneBookedCall(DAY);
    const atDue = DateTime.fromISO(DAY, { zone: env.TIMEZONE }).set({
      hour: 19,
      minute: 30,
    });

    await maybeSendDigest(atDue);

    expect(sendOwnerSmsMock).toHaveBeenCalledTimes(1);
    expect(sendOwnerSmsMock.mock.calls[0]?.[1]).toBe('+14433706471');
    expect(sendOwnerSmsMock.mock.calls[0]?.[0]).toContain('booked');

    const state = JSON.parse(fs.readFileSync(tmpDigestState, 'utf8'));
    expect(state.lastSentISO).toBe(DAY);
  });

  it('never sends twice the same day, even on a later tick', async () => {
    seedOneBookedCall(DAY);
    const atDue = DateTime.fromISO(DAY, { zone: env.TIMEZONE }).set({
      hour: 19,
      minute: 30,
    });
    const laterTick = atDue.plus({ minutes: 5 });

    await maybeSendDigest(atDue);
    expect(sendOwnerSmsMock).toHaveBeenCalledTimes(1);

    await maybeSendDigest(laterTick);
    expect(sendOwnerSmsMock).toHaveBeenCalledTimes(1); // still just once
  });

  it('a quiet day (no handled calls) does not send, but still stamps so it does not re-check all evening', async () => {
    const atDue = DateTime.fromISO(QUIET_DAY, { zone: env.TIMEZONE }).set({
      hour: 19,
      minute: 30,
    });

    await maybeSendDigest(atDue);

    expect(sendOwnerSmsMock).not.toHaveBeenCalled();
    const state = JSON.parse(fs.readFileSync(tmpDigestState, 'utf8'));
    expect(state.lastSentISO).toBe(QUIET_DAY);
  });

  it('DIGEST_ENABLED=false short-circuits entirely (no send, no stamp)', async () => {
    env.DIGEST_ENABLED = 'false';
    seedOneBookedCall(DAY);
    const atDue = DateTime.fromISO(DAY, { zone: env.TIMEZONE }).set({
      hour: 19,
      minute: 30,
    });

    await maybeSendDigest(atDue);

    expect(sendOwnerSmsMock).not.toHaveBeenCalled();
    expect(fs.existsSync(tmpDigestState)).toBe(false);
  });

  it('Sunday appends the weekly summary as a second message', async () => {
    // Find the Sunday in the same week as DAY (2026-08-19 is a Wednesday →
    // 2026-08-23 is the Sunday). Seed a booking that lands inside that
    // 7-day window so the weekly digest is non-null too.
    const sunday = DateTime.fromISO(DAY, { zone: env.TIMEZONE })
      .set({ weekday: 7 })
      .toISODate()!;
    seedOneBookedCall(sunday);
    const atDue = DateTime.fromISO(sunday, { zone: env.TIMEZONE }).set({
      hour: 19,
      minute: 30,
    });

    await maybeSendDigest(atDue);

    expect(sendOwnerSmsMock).toHaveBeenCalledTimes(2);
    expect(sendOwnerSmsMock.mock.calls[0]?.[0]).toContain('Erica today');
    expect(sendOwnerSmsMock.mock.calls[1]?.[0]).toContain('Erica this week');
  });

  it('DIGEST_TO with multiple recipients sends one SMS per recipient', async () => {
    env.DIGEST_TO = '+14105551111, +14105552222';
    seedOneBookedCall(DAY);
    const atDue = DateTime.fromISO(DAY, { zone: env.TIMEZONE }).set({
      hour: 19,
      minute: 30,
    });

    await maybeSendDigest(atDue);

    expect(sendOwnerSmsMock).toHaveBeenCalledTimes(2);
    expect(sendOwnerSmsMock.mock.calls[0]?.[1]).toBe('+14105551111');
    expect(sendOwnerSmsMock.mock.calls[1]?.[1]).toBe('+14105552222');
  });
});
