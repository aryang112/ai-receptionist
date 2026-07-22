#!/usr/bin/env node
// Human-readable live view of the dev log (data/dev.log — see src/core/logger.ts).
// Usage: npm run logs   (Ctrl-C to stop). No dependencies.
//
// Reads pino JSON lines and prints:  HH:MM:SS LEVEL  message   {extra fields}
// Highlights the markers you care about on a call: 🗣️ transcripts, the
// negotiated voice, tool calls, latency (⏱), TPM (⚖️), and errors.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const FILE = process.argv[2] || './data/dev.log';
if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, '');

const LEVELS = { 10: 'TRACE', 20: 'DEBUG', 30: 'INFO', 40: 'WARN', 50: 'ERROR', 60: 'FATAL' };
const COLOR = { INFO: '\x1b[32m', WARN: '\x1b[33m', ERROR: '\x1b[31m', FATAL: '\x1b[41m', DEBUG: '\x1b[90m', TRACE: '\x1b[90m' };
const DIM = '\x1b[2m', RESET = '\x1b[0m';
// Fields already shown or too noisy to inline.
const SKIP = new Set(['level', 'time', 'pid', 'hostname', 'msg']);

function fmt(line) {
  let d;
  try { d = JSON.parse(line); } catch { return line; }
  const lvl = LEVELS[d.level] || String(d.level ?? '');
  const c = COLOR[lvl] || '';
  const t = d.time ? new Date(d.time).toLocaleTimeString('en-US', { hour12: false }) : '';
  const extra = Object.keys(d)
    .filter((k) => !SKIP.has(k))
    .map((k) => `${k}=${typeof d[k] === 'object' ? JSON.stringify(d[k]) : d[k]}`)
    .join(' ');
  return `${DIM}${t}${RESET} ${c}${lvl.padEnd(5)}${RESET} ${d.msg ?? ''}${extra ? `  ${DIM}${extra}${RESET}` : ''}`;
}

// -F follows across truncation (the log truncates on every server restart).
const tail = spawn('tail', ['-n', '500', '-F', FILE]);
let buf = '';
tail.stdout.on('data', (chunk) => {
  buf += chunk.toString();
  const lines = buf.split('\n');
  buf = lines.pop() ?? '';
  for (const l of lines) if (l.trim()) console.log(fmt(l));
});
tail.stderr.on('data', () => {}); // ignore "file truncated" notices
process.on('SIGINT', () => { tail.kill(); process.exit(0); });
