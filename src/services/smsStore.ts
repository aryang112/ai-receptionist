// src/services/smsStore.ts
//
// Append-only JSONL persistence for SMS threads, plus the in-memory index the
// router and agent read on every inbound message.
//
// Mirrors callStore.ts's design rules deliberately — do not invent a second
// persistence pattern here:
//  - Node builtins only (fs, path). No external deps.
//  - Every write is wrapped so it can NEVER throw into the caller. Losing a
//    line of history must not cost us a customer's reply.
//  - The FULL phone number IS written to the file (this is the private store)
//    but is NEVER logged to pino — only its last four digits.
//
// The file is the source of truth; the in-memory index is a replay of it, so a
// restart loses nothing. Threads are keyed by E.164 phone, one per customer.
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../config/env.js';
import { logger } from '../core/logger.js';

export type SmsLane =
  | 'owner'
  | 'compliance'
  | 'review_reply'
  | 'booking';

export type SmsDirection = 'inbound' | 'outbound';

export type SmsMessage = {
  direction: SmsDirection;
  body: string;
  ts: number;
  /** Twilio message SID for outbound; MessageSid for inbound. */
  sid?: string | undefined;
  /** Which lane handled this message (inbound only). */
  lane?: SmsLane | undefined;
};

export type ThreadState =
  /** No conversation in progress. */
  | 'idle'
  /** Erica is mid-conversation with the customer. */
  | 'active'
  /** Erica asked Richa and is waiting on her instruction. */
  | 'awaiting_owner'
  /** Customer sent STOP. No outbound may be sent, ever, until START. */
  | 'opted_out';

export type SmsThread = {
  phone: string;
  state: ThreadState;
  /** Short human reference Richa sees in her escalation text, e.g. "A7". */
  ref: string;
  /** Phorest client id once resolved by caller ID. */
  clientId?: string | undefined;
  /** Customer's display name once known. */
  name?: string | undefined;
  messages: SmsMessage[];
  lastInboundAt?: number | undefined;
  lastOutboundAt?: number | undefined;
  /** Set when escalated; cleared when Richa's instruction is applied. */
  escalatedAt?: number | undefined;
  /** What Erica told Richa it was stuck on. */
  escalationReason?: string | undefined;
  createdAt: number;
  updatedAt: number;
};

/** How much history the agent gets. Keeps prompt size and cost bounded. */
export const MAX_THREAD_MESSAGES = 40;

const threads = new Map<string, SmsThread>();
/** ref -> phone, so Richa can reply "A7 tell her yes" and hit the right thread. */
const refIndex = new Map<string, string>();
let loaded = false;

function file(): string {
  return env.SMS_STORE_PATH;
}

function tail(phone: string): string {
  return phone.slice(-4);
}

function append(record: Record<string, unknown>): void {
  try {
    const f = file();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, JSON.stringify({ ...record, ts: Date.now() }) + '\n');
  } catch (err) {
    // Never propagate. A dropped history line must not drop the reply itself.
    logger.warn({ err: (err as Error)?.message }, 'smsStore append failed');
  }
}

/**
 * Short, unambiguous thread reference for Richa's escalation texts.
 *
 * Deliberately excludes I, O, 0 and 1 — Richa is typing these back on a phone
 * keyboard and "1" vs "I" would silently route her instruction to the wrong
 * customer. Collisions are resolved by extending, never by reusing.
 */
const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function mintRef(): string {
  for (let len = 2; len <= 4; len++) {
    for (let attempt = 0; attempt < 200; attempt++) {
      let ref = '';
      for (let i = 0; i < len; i++) {
        ref += REF_ALPHABET[Math.floor(Math.random() * REF_ALPHABET.length)];
      }
      if (!refIndex.has(ref)) return ref;
    }
  }
  // Astronomically unlikely; still must not return a duplicate.
  return `Z${Date.now().toString(36).toUpperCase().slice(-4)}`;
}

function blankThread(phone: string): SmsThread {
  const now = Date.now();
  const ref = mintRef();
  const thread: SmsThread = {
    phone,
    state: 'idle',
    ref,
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
  refIndex.set(ref, phone);
  return thread;
}

/**
 * Replay the JSONL into memory. Called lazily on first access and safe to call
 * repeatedly. A corrupt line is skipped, not fatal — one bad write must not
 * make the whole history unreadable.
 */
export function loadSmsStore(): void {
  if (loaded) return;
  loaded = true;
  let raw: string;
  try {
    raw = fs.readFileSync(file(), 'utf8');
  } catch {
    return; // No file yet — a fresh install, not an error.
  }
  let skipped = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      applyEvent(JSON.parse(line));
    } catch {
      skipped++;
    }
  }
  if (skipped) {
    logger.warn({ skipped }, 'smsStore: skipped unreadable history lines');
  }
  logger.info({ threads: threads.size }, '💬 SMS thread store loaded');
}

/** The single reducer. Both live writes and replay go through it, so memory
 *  and file can never diverge. */
function applyEvent(e: Record<string, any>): void {
  const phone = String(e.phone || '');
  if (!phone) return;

  let thread = threads.get(phone);
  if (!thread) {
    thread = blankThread(phone);
    threads.set(phone, thread);
  }
  // Replay must restore the ORIGINAL ref, not the freshly minted one, or
  // Richa's older escalation texts would point at nothing after a restart.
  if (e.ref && e.ref !== thread.ref) {
    refIndex.delete(thread.ref);
    thread.ref = String(e.ref);
    refIndex.set(thread.ref, phone);
  }

  switch (e.type) {
    case 'message': {
      thread.messages.push({
        direction: e.direction,
        body: String(e.body ?? ''),
        ts: Number(e.ts) || Date.now(),
        sid: e.sid,
        lane: e.lane,
      });
      if (thread.messages.length > MAX_THREAD_MESSAGES) {
        thread.messages.splice(0, thread.messages.length - MAX_THREAD_MESSAGES);
      }
      if (e.direction === 'inbound') thread.lastInboundAt = Number(e.ts);
      else thread.lastOutboundAt = Number(e.ts);
      break;
    }
    case 'state':
      thread.state = e.state;
      break;
    case 'identity':
      if (e.clientId) thread.clientId = String(e.clientId);
      if (e.name) thread.name = String(e.name);
      break;
    case 'escalated':
      thread.state = 'awaiting_owner';
      thread.escalatedAt = Number(e.ts) || Date.now();
      thread.escalationReason = e.reason ? String(e.reason) : undefined;
      break;
    case 'owner_resolved':
      thread.escalatedAt = undefined;
      thread.escalationReason = undefined;
      thread.state = 'active';
      break;
    default:
      break;
  }
  thread.updatedAt = Number(e.ts) || Date.now();
}

function write(phone: string, event: Record<string, unknown>): void {
  loadSmsStore();
  const existing = threads.get(phone);
  const ref = existing?.ref ?? undefined;
  const record = { ...event, phone, ...(ref ? { ref } : {}) };
  applyEvent({ ...record, ts: Date.now() });
  // Re-read: a brand-new thread minted its ref inside applyEvent, and the file
  // must carry that same ref or a restart would mint a different one.
  const after = threads.get(phone);
  append({ ...record, ref: after?.ref });
}

export const SmsStore = {
  /** Get a thread, creating it if this phone has never texted before. */
  get(phone: string): SmsThread {
    loadSmsStore();
    let t = threads.get(phone);
    if (!t) {
      t = blankThread(phone);
      threads.set(phone, t);
    }
    return t;
  },

  find(phone: string): SmsThread | undefined {
    loadSmsStore();
    return threads.get(phone);
  },

  byRef(ref: string): SmsThread | undefined {
    loadSmsStore();
    const phone = refIndex.get(ref.toUpperCase());
    return phone ? threads.get(phone) : undefined;
  },

  recordInbound(
    phone: string,
    body: string,
    lane: SmsLane,
    sid?: string
  ): void {
    write(phone, { type: 'message', direction: 'inbound', body, lane, sid });
    logger.info(
      { tail: tail(phone), lane, chars: body.length },
      '📥 SMS inbound'
    );
  },

  recordOutbound(phone: string, body: string, sid?: string): void {
    write(phone, { type: 'message', direction: 'outbound', body, sid });
    logger.info({ tail: tail(phone), chars: body.length }, '📤 SMS outbound');
  },

  setState(phone: string, state: ThreadState): void {
    write(phone, { type: 'state', state });
  },

  setIdentity(phone: string, clientId?: string, name?: string): void {
    if (!clientId && !name) return;
    write(phone, { type: 'identity', clientId, name });
  },

  escalate(phone: string, reason: string): void {
    write(phone, { type: 'escalated', reason });
    logger.info({ tail: tail(phone), reason }, '🚩 SMS escalated to owner');
  },

  resolveEscalation(phone: string): void {
    write(phone, { type: 'owner_resolved' });
  },

  /**
   * Threads Richa still owes an answer on, oldest first — so an instruction
   * with no ref applies to the one that has been waiting longest, and the
   * digest can list them.
   */
  awaitingOwner(): SmsThread[] {
    loadSmsStore();
    return [...threads.values()]
      .filter((t) => t.state === 'awaiting_owner')
      .sort((a, b) => (a.escalatedAt ?? 0) - (b.escalatedAt ?? 0));
  },

  /** Most recently escalated thread — the default target for a bare
   *  instruction from Richa ("yes that's fine"). */
  mostRecentlyEscalated(): SmsThread | undefined {
    const open = this.awaitingOwner();
    return open.length ? open[open.length - 1] : undefined;
  },

  all(): SmsThread[] {
    loadSmsStore();
    return [...threads.values()];
  },
};

/** Test seam only — drops the in-memory index so a suite can start clean. */
export function __resetSmsStoreForTests(): void {
  threads.clear();
  refIndex.clear();
  loaded = false;
}
