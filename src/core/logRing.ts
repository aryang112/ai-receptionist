// In-memory ring of recent WARN+ log lines, exposed read-only at
// /admin/api/logs. Lets the cloud QA routine (and the dashboard) see server
// warnings/errors through the same authenticated admin API instead of needing
// a Railway token (which would be deploy-capable — far too much power to hand
// to a monitoring agent). Process-local and ephemeral by design: a restart
// clears it, matching the lifetime of the container logs it mirrors. Contains
// only what the logger already emits, which never includes secrets or full
// phone numbers per the project's core logging rules.

export interface LogRingEntry {
  ts: number;
  level: number; // pino numeric level: 40 warn, 50 error, 60 fatal
  line: string; // the raw serialized log line
}

const CAPACITY = 300;

const ring: LogRingEntry[] = [];

// Shaped as a pino destination: multistream hands each serialized line to
// write(). Level filtering (warn+) happens in the multistream config, not here.
export const logRingStream = {
  write(chunk: string): void {
    const line = String(chunk).trim();
    if (!line) return;
    let ts = Date.now();
    let level = 40;
    try {
      const parsed = JSON.parse(line) as { time?: number; level?: number };
      if (typeof parsed.time === 'number') ts = parsed.time;
      if (typeof parsed.level === 'number') level = parsed.level;
    } catch {
      // Non-JSON line (shouldn't happen with pino) — keep it anyway.
    }
    ring.push({ ts, level, line });
    if (ring.length > CAPACITY) ring.splice(0, ring.length - CAPACITY);
  },
};

export function recentWarnings(limit: number = CAPACITY): LogRingEntry[] {
  const n = Math.max(1, Math.min(CAPACITY, Math.floor(limit) || CAPACITY));
  return ring.slice(-n);
}

// Test-only escape hatch so suites can assert from a clean slate.
export function clearLogRing(): void {
  ring.length = 0;
}
