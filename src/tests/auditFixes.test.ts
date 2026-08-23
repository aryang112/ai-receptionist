import {
  describe,
  it,
  expect,
  beforeAll,
  afterEach,
  beforeEach,
  vi,
} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import WebSocket from 'ws';
import { phorest } from '../services/phorest.js';
import { env } from '../config/env.js';
import {
  recordSpamOutcome,
  isBlocked,
  __resetBlocklistCacheForTests,
} from '../services/blocklist.js';

// Regression tests for the 2026-08-22 pre-production audit fixes (Fable).
// Each describe names the finding it locks in.

process.env.OPENAI_REALTIME_API_KEY ||= 'test-key';

let TwilioRealtimeCall: typeof import('../realtime/twilioStream.js').TwilioRealtimeCall;
beforeAll(async () => {
  ({ TwilioRealtimeCall } = await import('../realtime/twilioStream.js'));
});

afterEach(() => vi.restoreAllMocks());

function buildCall() {
  const socket: any = {
    readyState: WebSocket.OPEN,
    send: () => {},
    close: () => {},
    on: () => {},
  };
  const call: any = new TwilioRealtimeCall(socket);
  call.session = {
    appendTwilioAudio: () => {},
    truncateActiveResponse: vi.fn(),
    injectContext: vi.fn(),
    requestResponse: vi.fn(() => true),
    close: vi.fn(),
  };
  call.streamSid = 'S';
  return call;
}

// business.json: vacations 2026-09-01..2026-09-09; sundays closed.
const VACATION_DATE = '2026-09-03'; // a Thursday inside the vacation range
const SUNDAY_DATE = '2025-10-05';

describe('P0 — closed/vacation days must yield ZERO open slots (fetchOpenSlots null-openClose)', () => {
  it('suggest_availability on a vacation date offers nothing even though Phorest returns a full slate', async () => {
    vi.spyOn(phorest, 'getAvailability').mockResolvedValue([
      `${VACATION_DATE}T13:00:00`,
      `${VACATION_DATE}T14:00:00`,
      `${VACATION_DATE}T15:00:00`,
    ]);
    const call = buildCall();
    const res = await call.handleSuggestAvailability({
      serviceName: 'Lash Lift',
      date: VACATION_DATE,
    });
    expect(res.salonOpenThatDay).toBe(false);
    expect(res.slots ?? []).toHaveLength(0);
  });

  it('book_appointment on a vacation date is REJECTED at the pre-write re-check (the no-prior-suggest warn-allow path)', async () => {
    vi.spyOn(phorest, 'getAvailability').mockResolvedValue([
      `${VACATION_DATE}T13:00:00`,
      `${VACATION_DATE}T14:00:00`,
    ]);
    const createSpy = vi.spyOn(phorest, 'createAppointment');
    const call = buildCall();
    // No offeredSlots entry -> the old warn-allow path went straight to the
    // write; the fresh re-check must now stop it (fresh open list is empty).
    const res = await call.handleBookAppointment({
      serviceName: 'Lash Lift',
      date: VACATION_DATE,
      time: '13:00',
      customer: { name: 'Jane Smith' },
    });
    expect(res.error).toBeDefined();
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('a closed weekday (Sunday) behaves the same', async () => {
    vi.spyOn(phorest, 'getAvailability').mockResolvedValue([
      `${SUNDAY_DATE}T13:00:00`,
    ]);
    const createSpy = vi.spyOn(phorest, 'createAppointment');
    const call = buildCall();
    const res = await call.handleBookAppointment({
      serviceName: 'Lash Lift',
      date: SUNDAY_DATE,
      time: '13:00',
      customer: { name: 'Jane Smith' },
    });
    expect(res.error).toBeDefined();
    expect(createSpy).not.toHaveBeenCalled();
  });
});

describe('P1 — aborted spam hangup rolls the outcome back', () => {
  it("outcome returns to its pre-spam value when the caller barges in on the decline", async () => {
    const call = buildCall();
    call.callSid = 'CA_spamabort';
    call.outcome = 'none';
    call.endCallNow = vi.fn().mockResolvedValue({ status: 'aborted' });
    const res = await call.handleEndCall({ reason: 'spam' });
    expect(res.aborted).toBe(true);
    expect(call.outcome).toBe('none');
  });

  it('outcome also rolls back on a hangup ERROR (call still live)', async () => {
    const call = buildCall();
    call.callSid = 'CA_spamerr';
    call.outcome = 'info';
    call.endCallNow = vi
      .fn()
      .mockResolvedValue({ status: 'error', message: 'boom' });
    const res = await call.handleEndCall({ reason: 'spam' });
    expect(res.error).toBe('boom');
    expect(call.outcome).toBe('info');
  });

  it('a SUCCESSFUL spam hangup keeps the spam tag', async () => {
    const call = buildCall();
    call.callSid = 'CA_spamok';
    call.outcome = 'none';
    call.endCallNow = vi.fn().mockImplementation(async () => {
      return { status: 'ended' };
    });
    await call.handleEndCall({ reason: 'spam' });
    expect(call.outcome).toBe('spam');
  });
});

describe('P0 bundle — blocklist allowlist + mtime-aware cache', () => {
  let tmpDir: string;
  let savedPath: string;
  let savedTwilio: string;
  let savedNeverBlock: string[];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blk-'));
    savedPath = env.BLOCKLIST_PATH;
    savedTwilio = env.TWILIO_NUMBER;
    savedNeverBlock = env.SPAM_NEVER_BLOCK;
    (env as any).BLOCKLIST_PATH = path.join(tmpDir, 'blocklist.json');
    __resetBlocklistCacheForTests();
  });

  afterEach(() => {
    (env as any).BLOCKLIST_PATH = savedPath;
    (env as any).TWILIO_NUMBER = savedTwilio;
    (env as any).SPAM_NEVER_BLOCK = savedNeverBlock;
    __resetBlocklistCacheForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('TWILIO_NUMBER can never be spam-recorded nor blocked', () => {
    (env as any).TWILIO_NUMBER = '+14103046449';
    recordSpamOutcome('4103046449');
    recordSpamOutcome('4103046449');
    expect(isBlocked('4103046449')).toBe(false);
    expect(fs.existsSync(env.BLOCKLIST_PATH)).toBe(false); // nothing recorded
  });

  it('SPAM_NEVER_BLOCK entries are immune even if the FILE already lists them over threshold', () => {
    (env as any).SPAM_NEVER_BLOCK = ['+1 (555) 200-3000'];
    fs.writeFileSync(
      env.BLOCKLIST_PATH,
      JSON.stringify({ '5552003000': { count: 99, lastTs: 1 } })
    );
    __resetBlocklistCacheForTests();
    expect(isBlocked('5552003000')).toBe(false);
    // A non-allowlisted number in the same file still blocks normally.
    fs.writeFileSync(
      env.BLOCKLIST_PATH,
      JSON.stringify({
        '5552003000': { count: 99, lastTs: 1 },
        '5559998888': { count: 2, lastTs: 1 },
      })
    );
    __resetBlocklistCacheForTests();
    expect(isBlocked('5559998888')).toBe(true);
  });

  it('a manual file edit takes effect on a RUNNING process (mtime-aware reload)', async () => {
    recordSpamOutcome('5551234567');
    recordSpamOutcome('5551234567');
    expect(isBlocked('5551234567')).toBe(true);
    // Human unblocks by editing the file — no restart, no test-only reset.
    await new Promise((r) => setTimeout(r, 10)); // ensure a distinct mtime
    fs.writeFileSync(env.BLOCKLIST_PATH, JSON.stringify({}));
    expect(isBlocked('5551234567')).toBe(false);
  });
});

describe('P1 — spam client-guard fails CLOSED on a lookup error', () => {
  it('a Phorest outage during cleanup records nothing', async () => {
    const lookupSpy = vi
      .spyOn(phorest, 'lookupCustomerByPhone')
      .mockRejectedValue(new Error('phorest down'));
    const call = buildCall();
    await call.recordSpamOutcomeIfNotClient('5551231234');
    expect(lookupSpy).toHaveBeenCalled();
    expect(isBlocked('5551231234')).toBe(false);
  });
});
