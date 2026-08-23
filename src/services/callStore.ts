// src/services/callStore.ts
//
// Append-only JSONL per-call persistence — the foundation for the owner ROI
// digest/dashboard. One JSON line per event ({ type, callSid, ts, ...fields }).
//
// Design rules:
//  - Node builtins only (fs, path). No external deps.
//  - Every method is wrapped so it can NEVER throw into the caller: a persistence
//    failure must not break a live phone call. fs errors are caught + swallowed
//    (logged at warn, without the caller's full phone number).
//  - The FULL from-number IS written to the file (this is the private data store),
//    but is NOT logged to pino here.
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../config/env.js';
import { logger } from '../core/logger.js';

type StartMeta = {
  callSid: string;
  // These may be genuinely absent on a given call (no caller ID, unrecognized
  // caller). With exactOptionalPropertyTypes we must allow explicit `undefined`,
  // not just an absent key, since the call site passes them through directly.
  streamSid?: string | undefined;
  from?: string | undefined;
  recognizedClientId?: string | undefined;
  startedAt: number;
  // S2: STIR/SHAKEN attestation as reported by Twilio (log-only this round —
  // collected for a future tuning pass, no blocking decisions made on it).
  stirVerstat?: string | undefined;
};

type ToolCallEntry = {
  name: string;
  ok: boolean;
  error?: string;
  detail?: Record<string, unknown>;
};

type BookingEntry = {
  service: string;
  price?: number;
  date: string;
  time: string;
};

// M1: per-call token usage, accumulated across every turn that reported one
// (openaiSession's onUsage, fired inside the existing 📊 turn tokens block).
type UsageAccumulator = {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  turns: number;
};

// M1: one interleaved-transcript turn. ts lets the dashboard render a chat
// view in true chronological order even though caller/erica text arrives via
// two independent event streams.
export type TranscriptEntry = {
  role: 'caller' | 'erica';
  text: string;
  ts: number;
};

type EndEntry = {
  endedAt: number;
  durationMs: number;
  // e.g. "booked" | "rescheduled" | "cancelled" | "transferred" | "info" | "none"
  outcome: string;
  // Optional: Erica's accumulated spoken text for the call (F10e / 4.1 digest).
  assistantTranscript?: string | undefined;
  // M1: token usage for the whole call, and a dollar ESTIMATE derived from it
  // (see twilioStream.ts estimateCostUsd — gpt-realtime audio rates). Absent
  // when the call never reported usage (e.g. it never opened a session).
  usage?: UsageAccumulator | undefined;
  estCostUsd?: number | undefined;
  // M1: why the call ended — 'silence — no response after check-in',
  // 'duration cap', 'spam decline', 'caller confirmed done', 'caller hung up'
  // (Twilio 'stop' with no prior reason), 'transferred to owner', etc. The
  // dashboard's flag source (M3). Absent for a call that never started.
  endReason?: string | undefined;
};

let dirEnsured = false;

/** Lazily create the parent dir once, then append one JSONL line. Never throws. */
function append(record: Record<string, unknown>): void {
  try {
    const file = env.CALL_STORE_PATH;
    if (!dirEnsured) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      dirEnsured = true;
    }
    fs.appendFileSync(file, JSON.stringify(record) + '\n');
  } catch (err) {
    // Swallow — persistence must never break a live call. Don't log the caller's
    // phone number (it may be in `record.from`); log only the failure + type.
    logger.warn(
      { err, type: record.type },
      'callStore: failed to persist event'
    );
  }
}

export const CallStore = {
  startCall(meta: StartMeta): void {
    append({
      type: 'start',
      callSid: meta.callSid,
      ts: meta.startedAt,
      streamSid: meta.streamSid,
      from: meta.from,
      recognizedClientId: meta.recognizedClientId,
      stirVerstat: meta.stirVerstat,
    });
  },

  // S2: a caller rejected at the webhook for being a repeat spam number — the
  // call never opens an OpenAI session, so this is the only record of it.
  // Full number is written to the file (private data store) same as
  // startCall's `from`; never logged to pino elsewhere.
  recordBlocked(callSid: string, from: string, stirVerstat?: string): void {
    append({
      type: 'blocked',
      callSid,
      ts: Date.now(),
      from,
      stirVerstat,
    });
  },

  recordToolCall(callSid: string, entry: ToolCallEntry): void {
    append({
      type: 'tool',
      callSid,
      ts: Date.now(),
      name: entry.name,
      ok: entry.ok,
      error: entry.error,
      detail: entry.detail,
    });
  },

  recordBooking(callSid: string, booking: BookingEntry): void {
    append({
      type: 'booking',
      callSid,
      ts: Date.now(),
      service: booking.service,
      price: booking.price,
      date: booking.date,
      time: booking.time,
    });
  },

  endCall(callSid: string, end: EndEntry): void {
    append({
      type: 'end',
      callSid,
      ts: end.endedAt,
      durationMs: end.durationMs,
      outcome: end.outcome,
      ...(end.assistantTranscript
        ? { assistantTranscript: end.assistantTranscript }
        : {}),
      ...(end.usage ? { usage: end.usage } : {}),
      ...(end.estCostUsd !== undefined ? { estCostUsd: end.estCostUsd } : {}),
      ...(end.endReason ? { endReason: end.endReason } : {}),
    });
  },

  // M1: the full interleaved both-side transcript for a call, written once
  // (skip-if-empty is the caller's job — twilioStream.ts's cleanup()). A
  // separate record from 'end' so a large transcript never bloats every read
  // of the (much smaller, much more frequently scanned) end/booking rows.
  recordTranscript(callSid: string, entries: TranscriptEntry[]): void {
    append({
      type: 'transcript',
      callSid,
      ts: Date.now(),
      entries,
    });
  },
};

/**
 * Read + parse the JSONL store, skipping malformed lines. Returns [] if the file
 * doesn't exist yet or can't be read. Never throws. For future digest use.
 */
export function readCalls(): any[] {
  let raw: string;
  try {
    raw = fs.readFileSync(env.CALL_STORE_PATH, 'utf8');
  } catch {
    return [];
  }
  const out: any[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // Skip malformed line — a partial/corrupt write shouldn't poison the read.
    }
  }
  return out;
}
