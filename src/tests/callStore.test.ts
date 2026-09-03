import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Point the store at a unique temp file BEFORE importing callStore, since env
// snapshots CALL_STORE_PATH at module-load time. Import dynamically after set.
const tmpFile = path.join(
  os.tmpdir(),
  `callstore-test-${process.pid}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}.jsonl`
);

let CallStore: typeof import('../services/callStore.js').CallStore;
let readCalls: typeof import('../services/callStore.js').readCalls;
let env: typeof import('../config/env.js').env;

beforeAll(async () => {
  process.env.CALL_STORE_PATH = tmpFile;
  ({ env } = await import('../config/env.js'));
  const mod = await import('../services/callStore.js');
  CallStore = mod.CallStore;
  readCalls = mod.readCalls;
});

afterAll(() => {
  try {
    fs.rmSync(tmpFile, { force: true });
  } catch {
    // best effort
  }
});

describe('CallStore (append-only JSONL)', () => {
  const callSid = 'CA_test_123';

  it('reads empty when nothing written yet', () => {
    expect(readCalls()).toEqual([]);
  });

  it('appends start/tool/booking/end and reads back in order', () => {
    CallStore.startCall({
      callSid,
      streamSid: 'MZ_stream_1',
      from: '+14155551212',
      recognizedClientId: 'client_abc',
      startedAt: 1000,
    });
    CallStore.recordToolCall(callSid, {
      name: 'checkAvailability',
      ok: true,
      detail: { slots: 3 },
    });
    CallStore.recordToolCall(callSid, {
      name: 'bookAppointment',
      ok: false,
      error: 'slot taken',
    });
    CallStore.recordBooking(callSid, {
      service: 'Lash Lift',
      price: 85,
      date: '2026-07-20',
      time: '14:00',
    });
    CallStore.endCall(callSid, {
      endedAt: 5000,
      durationMs: 4000,
      outcome: 'booked',
    });

    const rows = readCalls();
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.type)).toEqual([
      'start',
      'tool',
      'tool',
      'booking',
      'end',
    ]);

    // Every row carries the common envelope.
    for (const r of rows) {
      expect(r.callSid).toBe(callSid);
      expect(typeof r.ts).toBe('number');
    }

    const [start, tool1, tool2, booking, end] = rows;

    expect(start).toMatchObject({
      type: 'start',
      ts: 1000,
      streamSid: 'MZ_stream_1',
      from: '+14155551212', // full number IS persisted (private store)
      recognizedClientId: 'client_abc',
    });

    expect(tool1).toMatchObject({
      type: 'tool',
      name: 'checkAvailability',
      ok: true,
      detail: { slots: 3 },
    });

    expect(tool2).toMatchObject({
      type: 'tool',
      name: 'bookAppointment',
      ok: false,
      error: 'slot taken',
    });

    expect(booking).toMatchObject({
      type: 'booking',
      service: 'Lash Lift',
      price: 85,
      date: '2026-07-20',
      time: '14:00',
    });

    expect(end).toMatchObject({
      type: 'end',
      ts: 5000,
      durationMs: 4000,
      outcome: 'booked',
    });
  });

  it('skips malformed lines on read', () => {
    fs.appendFileSync(tmpFile, 'not-json{{{\n');
    fs.appendFileSync(
      tmpFile,
      JSON.stringify({ type: 'end', callSid, ts: 9000, outcome: 'none' }) + '\n'
    );
    const rows = readCalls();
    // 5 valid from before + 1 new valid; the malformed line is skipped.
    expect(rows).toHaveLength(6);
    expect(rows[rows.length - 1]).toMatchObject({ ts: 9000, outcome: 'none' });
  });

  it('never throws even if the target path is unwritable', () => {
    // append() reads the env snapshot object, so override that property (not
    // process.env). A path whose parent is a file, not a dir -> fs will throw.
    const prev = env.CALL_STORE_PATH;
    env.CALL_STORE_PATH = path.join(tmpFile, 'nested', 'x.jsonl');
    try {
      expect(() =>
        CallStore.endCall('CA_x', {
          endedAt: 1,
          durationMs: 0,
          outcome: 'none',
        })
      ).not.toThrow();
    } finally {
      env.CALL_STORE_PATH = prev;
    }
  });

  it('records owner-notification outcome metadata without an SMS body', () => {
    CallStore.recordOwnerNotification(callSid, {
      kind: 'post_call_summary',
      ok: true,
    });

    const rows = readCalls();
    const row = rows[rows.length - 1];
    expect(row).toMatchObject({
      type: 'owner_notification',
      callSid,
      kind: 'post_call_summary',
      ok: true,
    });
    expect(row).not.toHaveProperty('body');
  });
});
