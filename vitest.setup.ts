// Global test isolation (2026-08-22 audit follow-up): EVERY `npm test` run was
// appending ~33 fake records (CA_test bookings, tool rows, spam outcomes) to
// the REAL data/calls.jsonl — handler-level suites drive code whose CallStore/
// blocklist writes hit the production paths unless each suite remembers to
// override them. That polluted the pilot's dashboard/digest evidence base.
//
// This setup file runs BEFORE any test module imports src/config/env.ts, so
// the env snapshot every module sees points at a throwaway per-run tmp dir.
// Suites that need their own fixture paths still override env.* locally —
// this is the safety net, not a replacement for those overrides.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'erica-test-data-'));

process.env.CALL_STORE_PATH = path.join(testDataDir, 'calls.jsonl');
process.env.BLOCKLIST_PATH = path.join(testDataDir, 'blocklist.json');
process.env.DIGEST_STATE_PATH = path.join(testDataDir, 'digest-state.json');
