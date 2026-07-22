import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';

const level = process.env.LOG_LEVEL || 'info';

/**
 * In dev we ALSO tee every log line to a file so a call can be inspected after
 * it happens — the full firehose (🗣️ ERICA SAID / USER SAID transcripts, tool
 * calls, negotiated voice, per-turn latency, TPM, errors), not just the
 * structured events in data/calls.jsonl. The file is TRUNCATED on every boot
 * ({ flags: 'w' }), so it only ever holds the CURRENT run — no unbounded growth
 * across restarts. Live stdout is unchanged (you still watch the pane).
 *
 * LOG_FILE=off disables it; LOG_FILE=/some/path relocates it. Skipped by default
 * in production (stdout → the platform's log aggregator) and under test.
 */
function resolveLogFile(): string | null {
  const explicit = process.env.LOG_FILE;
  if (explicit === 'off') return null;
  if (explicit && explicit.length) return explicit;
  if (process.env.VITEST) return null; // don't spew a file during unit tests
  const nodeEnv = process.env.NODE_ENV || 'development';
  if (nodeEnv === 'production' || nodeEnv === 'test') return null;
  return './data/dev.log';
}

function buildLogger(): pino.Logger {
  const file = resolveLogFile();
  if (!file) return pino({ level });
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 'w' truncates on open → one file per server run.
    const fileStream = fs.createWriteStream(file, { flags: 'w' });
    return pino(
      { level },
      pino.multistream([
        { stream: process.stdout, level },
        { stream: fileStream, level },
      ])
    );
  } catch {
    // Never let logging setup break boot — fall back to stdout only.
    return pino({ level });
  }
}

export const logger = buildLogger();
