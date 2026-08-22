// src/services/blocklist.ts
//
// S2: repeat-spam blocklist. Once a caller has been tagged 'spam' (S1) enough
// times, the /voice webhook rejects them before an OpenAI Realtime session is
// ever opened — a repeat robocaller costs ~$0 instead of a full call.
//
// Design rules (mirrors callStore.ts):
//  - Node builtins only (fs, path). No external deps.
//  - Every public function is wrapped so it can NEVER throw into the caller: a
//    persistence hiccup must not break call handling. fs errors are caught +
//    swallowed (logged at warn — no full phone number in the log).
//  - In-memory cache + write-through JSON file at env `BLOCKLIST_PATH`
//    (default './data/blocklist.json'), parent dir created lazily.
//  - JSON shape is an object keyed by the normalized 10-digit number so a
//    human can open the file and edit it directly — e.g. delete a number, or
//    drop its `count` below the threshold, to unblock it. That manual edit IS
//    the unblock path; there is no code-level "unblock" function.
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../config/env.js';
import { logger } from '../core/logger.js';

type BlocklistEntry = { count: number; lastTs: number };
type BlocklistData = Record<string, BlocklistEntry>;

// Same convention as the rest of the codebase: 10 digits, strip a leading 1.
function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.length === 11 && digits.startsWith('1')
    ? digits.slice(1)
    : digits;
}

// Loaded lazily on first use and kept warm; a write updates this AND the file
// (write-through), so isBlocked() never has to hit disk on the hot path.
let cache: BlocklistData | null = null;

function loadCache(): BlocklistData {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(env.BLOCKLIST_PATH, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    cache =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as BlocklistData)
        : {};
  } catch {
    // Missing file (first run), unreadable, or malformed JSON — start empty.
    // Never throw: a corrupt blocklist must not take down call handling.
    cache = {};
  }
  return cache;
}

function persist(data: BlocklistData): void {
  try {
    const file = env.BLOCKLIST_PATH;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  } catch (err) {
    logger.warn({ err }, 'blocklist: failed to persist — spam count kept in memory only');
  }
}

/**
 * Increment a caller's spam-outcome count. Called only for numbers that are
 * NOT a known Phorest client (see the client guard at the twilioStream.ts
 * call site) — this module has no way to enforce that itself, by design (it
 * has no knowledge of Phorest).
 */
export function recordSpamOutcome(phone: string): void {
  try {
    const normalized = normalizePhone(phone);
    if (!normalized || normalized.length !== 10) return;
    const data = loadCache();
    const existing = data[normalized];
    data[normalized] = {
      count: (existing?.count ?? 0) + 1,
      lastTs: Date.now(),
    };
    persist(data);
  } catch (err) {
    logger.warn({ err }, 'blocklist: recordSpamOutcome failed');
  }
}

/** count >= SPAM_BLOCK_THRESHOLD (default 2) — one spam verdict is a warning, two blocks. */
export function isBlocked(phone: string): boolean {
  try {
    const normalized = normalizePhone(phone);
    if (!normalized) return false;
    const data = loadCache();
    const entry = data[normalized];
    return !!entry && entry.count >= env.SPAM_BLOCK_THRESHOLD;
  } catch {
    return false;
  }
}

/**
 * Test-only: drop the in-memory cache so the next read/write re-loads from
 * `env.BLOCKLIST_PATH` — lets tests point at a fresh tmp file per case and
 * prove persistence actually round-trips through disk, not just memory.
 */
export function __resetBlocklistCacheForTests(): void {
  cache = null;
}
