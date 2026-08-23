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

// AUDIT FIX (2026-08-22, P0 bundle): numbers that must NEVER be spam-recorded
// or webhook-blocked, no matter what. Under Vonage call-forwarding a
// misconfigured trunk can substitute ONE common number as every caller's ID —
// one spam verdict against that number would dead the entire forwarded line
// at the webhook. Covers our own Twilio number, the owner's phone, and the
// env allowlist SPAM_NEVER_BLOCK (comma-separated; put the Vonage/salon
// number(s) there before Stage 1). Recomputed per call — cheap, and it keeps
// env-mutating tests honest.
function allowlisted(normalized: string): boolean {
  const raw = [env.TWILIO_NUMBER, env.OWNER_PHONE, ...env.SPAM_NEVER_BLOCK];
  return raw.some((n) => n && normalizePhone(n) === normalized);
}

// Loaded lazily and kept warm; a write updates this AND the file
// (write-through), so isBlocked() never has to hit disk on the hot path.
// AUDIT FIX (2026-08-22): the cache is mtime-aware — a manual edit of
// data/blocklist.json (the documented unblock path) now takes effect on a
// RUNNING process at the next read instead of being invisible until restart
// and then silently clobbered by the next write-through.
let cache: BlocklistData | null = null;
let cacheMtimeMs: number | null = null;

function loadCache(): BlocklistData {
  let mtimeMs: number | null = null;
  try {
    mtimeMs = fs.statSync(env.BLOCKLIST_PATH).mtimeMs;
  } catch {
    // File missing — first run, or someone deleted it (a legitimate "unblock
    // everyone" move). Treat as empty; drop any stale cache.
    cache = {};
    cacheMtimeMs = null;
    return cache;
  }
  if (cache && cacheMtimeMs === mtimeMs) return cache;
  try {
    const raw = fs.readFileSync(env.BLOCKLIST_PATH, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    cache =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as BlocklistData)
        : {};
    cacheMtimeMs = mtimeMs;
  } catch {
    // Unreadable or malformed JSON — start empty. Never throw: a corrupt
    // blocklist must not take down call handling.
    cache = {};
    cacheMtimeMs = null;
  }
  return cache;
}

function persist(data: BlocklistData): void {
  try {
    const file = env.BLOCKLIST_PATH;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  } catch (err) {
    logger.warn(
      { err },
      'blocklist: failed to persist — spam count kept in memory only'
    );
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
    if (allowlisted(normalized)) {
      logger.warn(
        { last4: normalized.slice(-4) },
        'blocklist: allowlisted number got a spam outcome — NOT recording'
      );
      return;
    }
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
    if (allowlisted(normalized)) return false;
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
  cacheMtimeMs = null;
}
