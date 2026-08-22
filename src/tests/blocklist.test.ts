import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Point the blocklist at a unique temp file BEFORE importing it, since env
// snapshots BLOCKLIST_PATH at module-load time in some flows — mirrors
// callStore.test.ts's pattern exactly. Import dynamically after set.
const tmpFile = path.join(
  os.tmpdir(),
  `blocklist-test-${process.pid}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}.json`
);

let recordSpamOutcome: typeof import('../services/blocklist.js').recordSpamOutcome;
let isBlocked: typeof import('../services/blocklist.js').isBlocked;
let __resetBlocklistCacheForTests: typeof import('../services/blocklist.js').__resetBlocklistCacheForTests;
let env: typeof import('../config/env.js').env;

beforeAll(async () => {
  process.env.BLOCKLIST_PATH = tmpFile;
  ({ env } = await import('../config/env.js'));
  const mod = await import('../services/blocklist.js');
  recordSpamOutcome = mod.recordSpamOutcome;
  isBlocked = mod.isBlocked;
  __resetBlocklistCacheForTests = mod.__resetBlocklistCacheForTests;
});

afterAll(() => {
  try {
    fs.rmSync(tmpFile, { force: true });
  } catch {
    // best effort
  }
});

describe('blocklist (S2 — repeat-spam threshold)', () => {
  it('an unknown number is never blocked', () => {
    expect(isBlocked('4105551111')).toBe(false);
  });

  it('one spam outcome is a warning, not a block (threshold default 2)', () => {
    recordSpamOutcome('4105552222');
    expect(isBlocked('4105552222')).toBe(false);
  });

  it('a second spam outcome blocks the number', () => {
    // Normalizes the same way the rest of the codebase does: strip a leading
    // 1 on an 11-digit number.
    recordSpamOutcome('14105552222');
    expect(isBlocked('4105552222')).toBe(true);
  });

  it('a different number is unaffected by another number crossing the threshold', () => {
    expect(isBlocked('4105553333')).toBe(false);
  });

  it('persists across a reload — proves the write-through actually hit disk', () => {
    // Drop the in-memory cache and force a fresh read from env.BLOCKLIST_PATH.
    __resetBlocklistCacheForTests();
    expect(isBlocked('4105552222')).toBe(true);

    const raw = JSON.parse(fs.readFileSync(tmpFile, 'utf8'));
    expect(raw['4105552222']).toMatchObject({ count: 2 });
    expect(typeof raw['4105552222'].lastTs).toBe('number');
    // Human-editable shape: a plain object keyed by the 10-digit number.
    expect(raw['4105553333']).toBeUndefined();
  });

  it('never throws even if the target path is unwritable — record and check both fail soft', () => {
    // Same trick as callStore.test.ts: tmpFile is a real FILE at this point
    // (written above), so nesting a path under it makes mkdirSync ENOTDIR.
    __resetBlocklistCacheForTests();
    const prev = env.BLOCKLIST_PATH;
    env.BLOCKLIST_PATH = path.join(tmpFile, 'nested', 'blocklist.json');
    try {
      expect(() => recordSpamOutcome('4105554444')).not.toThrow();
      expect(() => isBlocked('4105554444')).not.toThrow();
      // The write couldn't land on disk, but nothing threw and isBlocked degrades
      // gracefully (still under threshold either way — one call, one record).
      expect(isBlocked('4105554444')).toBe(false);
    } finally {
      env.BLOCKLIST_PATH = prev;
      __resetBlocklistCacheForTests();
    }
  });

  it('ignores a too-short/garbage number without throwing', () => {
    expect(() => recordSpamOutcome('123')).not.toThrow();
    expect(isBlocked('123')).toBe(false);
  });
});
