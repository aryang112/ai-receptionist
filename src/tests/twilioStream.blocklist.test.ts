import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import WebSocket from 'ws';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The OpenAI session constructor throws without a key; some import paths reach it.
process.env.OPENAI_REALTIME_API_KEY ||= 'test-key';

let TwilioRealtimeCall: typeof import('../realtime/twilioStream.js').TwilioRealtimeCall;
let phorest: typeof import('../services/phorest.js').phorest;
let blocklist: typeof import('../services/blocklist.js');
let CallStore: typeof import('../services/callStore.js').CallStore;
let env: typeof import('../config/env.js').env;

const tmpFile = path.join(
  os.tmpdir(),
  `blocklist-twiliostream-test-${process.pid}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}.json`
);

beforeAll(async () => {
  ({ TwilioRealtimeCall } = await import('../realtime/twilioStream.js'));
  ({ phorest } = await import('../services/phorest.js'));
  blocklist = await import('../services/blocklist.js');
  ({ CallStore } = await import('../services/callStore.js'));
  ({ env } = await import('../config/env.js'));
});

beforeEach(() => {
  env.BLOCKLIST_PATH = tmpFile;
  blocklist.__resetBlocklistCacheForTests();
  try {
    fs.rmSync(tmpFile, { force: true });
  } catch {
    // best effort
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  try {
    fs.rmSync(tmpFile, { force: true });
  } catch {
    // best effort
  }
});

/**
 * Same mock-socket scaffolding as twilioStream.vacation.test.ts /
 * twilioStream.silenceWatchdog.test.ts — the OpenAI session is stubbed out so
 * no real WS connection is attempted.
 */
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
    requestResponse: vi.fn(),
    close: vi.fn(),
  };
  call.streamSid = 'STREAMSID';
  call.sessionReady = true;
  call.started = true;
  if (call.preAuthTimer) {
    clearTimeout(call.preAuthTimer);
    call.preAuthTimer = undefined;
  }
  return call;
}

describe('S2 — recordSpamOutcomeIfNotClient (client guard)', () => {
  it('records a spam outcome for a number that does NOT resolve to a Phorest client', async () => {
    vi.spyOn(phorest, 'lookupCustomerByPhone').mockResolvedValue(null);
    const call = buildCall();

    await call.recordSpamOutcomeIfNotClient('4105551234');
    expect(blocklist.isBlocked('4105551234')).toBe(false); // 1st offense only

    await call.recordSpamOutcomeIfNotClient('4105551234');
    expect(blocklist.isBlocked('4105551234')).toBe(true); // 2nd offense — blocked
  });

  it('NEVER records/blocklists a number that resolves to a known Phorest client', async () => {
    vi.spyOn(phorest, 'lookupCustomerByPhone').mockResolvedValue({
      clientId: 'client_real',
      firstName: 'Jane',
      lastName: 'Smith',
    });
    const call = buildCall();

    // Even calling it repeatedly must never cross the threshold — a real
    // client can NEVER be blocklisted, even if a call was mis-tagged 'spam'.
    await call.recordSpamOutcomeIfNotClient('4105551234');
    await call.recordSpamOutcomeIfNotClient('4105551234');
    await call.recordSpamOutcomeIfNotClient('4105551234');

    expect(blocklist.isBlocked('4105551234')).toBe(false);
    const raw = fs.existsSync(tmpFile)
      ? JSON.parse(fs.readFileSync(tmpFile, 'utf8'))
      : {};
    expect(raw['4105551234']).toBeUndefined();
  });

  it('a Phorest lookup failure fails open to recording, and never throws', async () => {
    vi.spyOn(phorest, 'lookupCustomerByPhone').mockRejectedValue(
      new Error('network blip')
    );
    const call = buildCall();

    await expect(
      call.recordSpamOutcomeIfNotClient('4105551234')
    ).resolves.toBeUndefined();
    // The lookup itself failed (no positive client match), so the guard
    // treats it like "not a known client" and still records the outcome —
    // consistent with prepareCallerContext's own catch-and-fall-back pattern.
    expect(blocklist.isBlocked('4105551234')).toBe(false); // still just 1
  });
});

describe('S2 — cleanup() wiring', () => {
  beforeEach(() => {
    // cleanup() also calls CallStore.endCall — stub it so tests never touch
    // the real ./data/calls.jsonl file.
    vi.spyOn(CallStore, 'endCall').mockImplementation(() => {});
  });

  it('a spam-outcome call with a known caller number fires the guarded recorder', () => {
    const call = buildCall();
    call.callSid = 'CA_spam_1';
    call.callerFrom = '4105551234';
    call.outcome = 'spam';
    call.startedAtMs = Date.now() - 1000;
    const spy = vi.fn().mockResolvedValue(undefined);
    call.recordSpamOutcomeIfNotClient = spy;

    call.cleanup();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('4105551234');
  });

  it('a normal (non-spam) call never fires the guarded recorder', () => {
    const call = buildCall();
    call.callSid = 'CA_normal_1';
    call.callerFrom = '4105551234';
    call.outcome = 'completed';
    call.startedAtMs = Date.now() - 1000;
    const spy = vi.fn().mockResolvedValue(undefined);
    call.recordSpamOutcomeIfNotClient = spy;

    call.cleanup();

    expect(spy).not.toHaveBeenCalled();
  });

  it('a spam outcome with no known caller number never fires the guarded recorder', () => {
    const call = buildCall();
    call.callSid = 'CA_spam_2';
    call.callerFrom = undefined;
    call.outcome = 'spam';
    call.startedAtMs = Date.now() - 1000;
    const spy = vi.fn().mockResolvedValue(undefined);
    call.recordSpamOutcomeIfNotClient = spy;

    call.cleanup();

    expect(spy).not.toHaveBeenCalled();
  });
});
