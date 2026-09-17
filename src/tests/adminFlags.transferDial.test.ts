// src/tests/adminFlags.transferDial.test.ts
//
// M4: proves the transfer-failed flag now fires for a rung-out/busy live
// transfer even when the transfer_to_owner TOOL call itself succeeded
// (ok:true) — the real-world failure mode from production call
// CAb66df4eb8f3d3c4eced28f85c457a6c2 (2026-09-17): Erica correctly placed
// the <Dial>, Richa's phone rang out, and nothing about that was ever
// visible to the twice-daily QA sweep. See src/routes/twilio.ts's
// /dial-status handler and src/services/callStore.ts's recordDialStatus.
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  afterAll,
  vi,
} from 'vitest';
import request from 'supertest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { env } from '../config/env.js';
import { adminRouter } from '../routes/admin.js';

// Same fixture-file pattern as admin.route.test.ts: CALL_STORE_PATH is read
// at call-time (not module-load time), so pointing it at a per-test tmp file
// works with a plain static import of adminRouter.
const tmpFile = path.join(
  os.tmpdir(),
  `admin-flags-transfer-dial-${process.pid}-${Date.now()}-${Math.random()
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
  vi.unstubAllGlobals();
});

afterAll(() => {
  try {
    fs.rmSync(tmpFile, { force: true });
  } catch {
    // best effort
  }
});

const nowMs = Date.now();
const recentTs = nowMs - 2 * 60 * 60 * 1000; // 2h ago

/** A call where the transfer_to_owner TOOL call succeeded (ok:true) — the
 * dial was correctly placed — but Twilio's /dial-status callback reports a
 * non-'completed' DialCallStatus, i.e. the real production failure mode. */
function ranOutTransferRows(callSid: string, dialCallStatus: string) {
  return [
    { type: 'start', callSid, ts: recentTs, from: '+14105552222' },
    {
      type: 'tool',
      callSid,
      ts: recentTs + 1000,
      name: 'transfer_to_owner',
      ok: true,
    },
    {
      type: 'dial_status',
      callSid,
      ts: recentTs + 15000,
      dialCallStatus,
    },
    {
      type: 'end',
      callSid,
      ts: recentTs + 16000,
      durationMs: 16000,
      outcome: 'none',
      endReason: 'caller hung up',
    },
  ];
}

async function getCall(callSid: string) {
  const res = await request(app).get('/admin/api/calls?days=1');
  expect(res.status).toBe(200);
  return res.body.calls.find((c: { callSid: string }) => c.callSid === callSid);
}

describe('admin — transfer-failed flag for a rung-out/busy dial (M4)', () => {
  it('DialCallStatus no-answer: flags transfer-failed and surfaces transferDialStatus', async () => {
    writeFixture(ranOutTransferRows('CA_noanswer', 'no-answer'));
    const call = await getCall('CA_noanswer');
    expect(call).toBeDefined();
    // The tool call itself succeeded — this must NOT be tool-error.
    expect(call.tools).toEqual(
      expect.arrayContaining([{ name: 'transfer_to_owner', ok: true }])
    );
    expect(call.flags).not.toContain('tool-error');
    expect(call.flags).toContain('transfer-failed');
    expect(call.transferDialStatus).toBe('no-answer');
  });

  it('DialCallStatus busy: flags transfer-failed and surfaces transferDialStatus', async () => {
    writeFixture(ranOutTransferRows('CA_busy', 'busy'));
    const call = await getCall('CA_busy');
    expect(call).toBeDefined();
    expect(call.flags).toContain('transfer-failed');
    expect(call.transferDialStatus).toBe('busy');
  });

  it('DialCallStatus completed: NOT flagged, no transferDialStatus (a successful human conversation)', async () => {
    // /twilio/dial-status never calls recordDialStatus for 'completed' — no
    // dial_status row is written at all, mirroring production behaviour.
    writeFixture([
      { type: 'start', callSid: 'CA_completed', ts: recentTs, from: '+14105553333' },
      {
        type: 'tool',
        callSid: 'CA_completed',
        ts: recentTs + 1000,
        name: 'transfer_to_owner',
        ok: true,
      },
      {
        type: 'end',
        callSid: 'CA_completed',
        ts: recentTs + 20000,
        durationMs: 20000,
        outcome: 'transferred',
        endReason: 'transferred to owner',
      },
    ]);
    const call = await getCall('CA_completed');
    expect(call).toBeDefined();
    expect(call.flags).not.toContain('transfer-failed');
    expect(call.transferDialStatus).toBeUndefined();
  });

  it('no dial at all: NOT flagged (no regression on an ordinary call)', async () => {
    writeFixture([
      { type: 'start', callSid: 'CA_ordinary', ts: recentTs, from: '+14105554444' },
      {
        type: 'end',
        callSid: 'CA_ordinary',
        ts: recentTs + 10000,
        durationMs: 10000,
        outcome: 'info',
        endReason: 'caller confirmed done',
      },
    ]);
    const call = await getCall('CA_ordinary');
    expect(call).toBeDefined();
    expect(call.flags).not.toContain('transfer-failed');
    expect(call.transferDialStatus).toBeUndefined();
  });

  it('multi-segment failback: one dial_status row + TWO end rows on the same callSid still flags transfer-failed exactly once, with the reconnected segment as the final outcome', async () => {
    writeFixture([
      { type: 'start', callSid: 'CA_failback_dial', ts: recentTs, from: '+14105555555' },
      {
        type: 'tool',
        callSid: 'CA_failback_dial',
        ts: recentTs + 1000,
        name: 'transfer_to_owner',
        ok: true,
      },
      {
        type: 'dial_status',
        callSid: 'CA_failback_dial',
        ts: recentTs + 20000,
        dialCallStatus: 'no-answer',
      },
      // Segment 1 ended in the (failed) transfer attempt…
      {
        type: 'end',
        callSid: 'CA_failback_dial',
        ts: recentTs + 20000,
        durationMs: 20000,
        outcome: 'transferred',
        endReason: 'transferred to owner',
      },
      // …and segment 2 (the reconnected failback session) is how the call
      // actually ended.
      {
        type: 'end',
        callSid: 'CA_failback_dial',
        ts: recentTs + 45000,
        durationMs: 25000,
        outcome: 'info',
        endReason: 'caller confirmed done',
      },
    ]);
    const res = await request(app).get('/admin/api/calls?days=1');
    const matches = res.body.calls.filter(
      (c: { callSid: string }) => c.callSid === 'CA_failback_dial'
    );
    // One joined call, not two.
    expect(matches).toHaveLength(1);
    const call = matches[0];
    expect(call.outcome).toBe('info'); // last end row wins, per sumUsage's doc comment
    expect(call.durationMs).toBe(45000); // segments sum
    expect(call.flags).toContain('transfer-failed');
    expect(
      call.flags.filter((f: string) => f === 'transfer-failed')
    ).toHaveLength(1); // present, not duplicated
    expect(call.transferDialStatus).toBe('no-answer');
  });
});
