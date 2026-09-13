// Real API + real read-only Phorest probe through the production call controller.
// A fake Twilio transport records paced audio and acknowledges marks; no phone is dialed.
import 'dotenv/config';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import WebSocket from 'ws';
const model = process.env.PROBE_BACKEND || 'gpt-5.6-terra';
const phrase =
  process.env.PROBE_PHRASE ||
  'I want eyebrow threading and upper lip threading next Friday afternoon.';
const seconds = Number(process.env.PROBE_SECONDS || 35);
const inputAt = Number(process.env.PROBE_INPUT_AT_MS || 10000);
const turnsFile = process.env.PROBE_TURNS_FILE;
const engine = process.env.PROBE_ENGINE || 'live';
const remoteUrl = process.env.PROBE_URL;
const callerPhone = process.env.PROBE_CALLER_PHONE || '+12025550198';
const streamSecret = process.env.WS_AUTH_SECRET;
const output =
  process.env.PROBE_OUTPUT ||
  `/tmp/erica-controller-${engine}-${model}-${Date.now()}`;
fs.mkdirSync(output, { recursive: true });
// A remote probe does not control the hosted adapter mode. Never assume that
// the local simulate settings below protect a hosted real-write deployment.
if (remoteUrl) {
  const statusUrl = new URL(remoteUrl);
  statusUrl.protocol = statusUrl.protocol === 'wss:' ? 'https:' : 'http:';
  statusUrl.pathname = '/admin/voice-test';
  statusUrl.search = '';
  const statusResponse = await fetch(statusUrl, {
    headers: { Authorization: `Bearer ${process.env.ADMIN_TOKEN || ''}` },
  });
  if (!statusResponse.ok)
    throw new Error('Cannot verify hosted appointment write mode.');
  const status = await statusResponse.json();
  if (
    status.writes !== 'simulate' &&
    process.env.PROBE_ALLOW_REAL_BACKEND !== 'true'
  ) {
    throw new Error(
      'Hosted appointment writes are real. Set PROBE_ALLOW_REAL_BACKEND=true only for an explicitly scoped probe.'
    );
  }
}
Object.assign(process.env, {
  NODE_ENV: 'development',
  VOICE_ENGINE: engine,
  OPENAI_LIVE_BACKEND_MODEL: model,
  PHOREST_WRITE_MODE: 'simulate',
  OWNER_SMS_MODE: 'simulate',
  USE_MOCK_PHOREST: 'false',
  RECORD_CALLS: 'false',
  TWILIO_ACCOUNT_SID: '',
  TWILIO_AUTH_TOKEN: '',
  WS_AUTH_SECRET: '',
  VOICE_TEST_ALLOWED_PHONES: callerPhone,
  CALL_STORE_PATH: path.join(output, 'calls.jsonl'),
  LOG_LEVEL: 'warn',
});
const key = process.env.OPENAI_REALTIME_API_KEY || process.env.OPENAI_API_KEY;
function encode(sample) {
  let sign = sample < 0 ? 128 : 0;
  let v = Math.min(32635, Math.abs(sample)) + 132;
  let exponent = 7;
  for (let mask = 16384; exponent > 0 && !(v & mask); exponent--, mask >>= 1) {}
  return ~(sign | (exponent << 4) | ((v >> (exponent + 3)) & 15)) & 255;
}
function configuredTurns() {
  if (!turnsFile) return [{ atMs: inputAt, text: phrase }];

  let value;
  try {
    value = JSON.parse(fs.readFileSync(turnsFile, 'utf8'));
  } catch (error) {
    throw new Error(
      `Unable to read PROBE_TURNS_FILE: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!Array.isArray(value) || value.length === 0)
    throw new Error('PROBE_TURNS_FILE must contain a non-empty JSON array');

  return value.map((turn, index) => {
    if (
      !turn ||
      typeof turn !== 'object' ||
      !Number.isFinite(turn.atMs) ||
      turn.atMs < 0 ||
      typeof turn.text !== 'string' ||
      !turn.text.trim()
    ) {
      throw new Error(
        `PROBE_TURNS_FILE turn ${index} must have a non-negative numeric atMs and non-empty text`
      );
    }
    return { atMs: turn.atMs, text: turn.text };
  });
}

async function callerAudio(text) {
  const cache = `/tmp/erica-probe-${crypto.createHash('sha256').update(text).digest('hex').slice(0, 12)}.ulaw`;
  if (fs.existsSync(cache)) return fs.readFileSync(cache);
  const response = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini-tts',
      voice: 'alloy',
      input: text,
      response_format: 'pcm',
    }),
  });
  if (!response.ok) throw new Error(`TTS failed: ${response.status}`);
  const pcm = Buffer.from(await response.arrayBuffer());
  const caller = Buffer.alloc(Math.floor(pcm.length / 6));
  for (let i = 0; i < caller.length; i++)
    caller[i] = encode(
      Math.round(
        (pcm.readInt16LE(i * 6) +
          pcm.readInt16LE(i * 6 + 2) +
          pcm.readInt16LE(i * 6 + 4)) /
          3
      )
    );
  fs.writeFileSync(cache, caller);
  return caller;
}

const turns = configuredTurns();
const callerTurns = [];
for (const turn of turns) {
  // Keep generation serial so a long soak never creates a burst of TTS calls.
  callerTurns.push({
    ...turn,
    audio:
      process.env.PROBE_GREETING_ONLY === 'true'
        ? Buffer.alloc(0)
        : await callerAudio(turn.text),
  });
}
const { TwilioRealtimeCall } = await import(
  '../../dist/realtime/twilioStream.js'
);
const { muLawRms } = await import('../../dist/voice/mulawAudio.js');
if (process.env.PROBE_STALL_MS) {
  const { phorest } = await import('../../dist/services/phorest.js');
  const get = phorest.getAvailability.bind(phorest);
  phorest.getAvailability = async (...args) => {
    await new Promise((r) => setTimeout(r, Number(process.env.PROBE_STALL_MS)));
    return get(...args);
  };
}
const frames = [];
const speech = [];
let call;
let mediaClock = 0;
let speak = false;
let silenceRun = 0;
let callerStartedAt;
let callerEndedAt;
const turnReplay = turns.map((turn) => ({
  scheduledAtMs: turn.atMs,
  actualStartMs: null,
  actualEndMs: null,
}));
const started = Date.now();
class Socket extends EventEmitter {
  readyState = 1;
  send(raw) {
    const event = JSON.parse(raw);
    if (event.event === 'media') {
      const b = Buffer.from(event.media.payload, 'base64');
      frames.push(b);
      if (muLawRms(b) > 200) {
        silenceRun = 0;
        if (!speak) {
          speak = true;
          speech.push({ startMs: Date.now() - started });
        }
      } else if (speak && ++silenceRun >= 30) {
        speak = false;
        speech[speech.length - 1].endMs = Date.now() - started;
      }
    }
    if (event.event === 'mark')
      setTimeout(
        () =>
          this.emit(
            'message',
            Buffer.from(JSON.stringify({ event: 'mark', mark: event.mark }))
          ),
        20
      );
  }
  close() {
    this.readyState = 3;
    this.emit('close', 1000, Buffer.alloc(0));
  }
}
const socket = new Socket();
const callSid = `CA_probe_${Date.now()}`;
let transport;
if (remoteUrl) {
  transport = new WebSocket(remoteUrl);
  transport.on('message', (data) => socket.send(data.toString()));
  transport.on('close', () => {
    socket.readyState = 3;
  });
  await new Promise((resolve, reject) => {
    transport.once('open', resolve);
    transport.once('error', reject);
  });
  socket.on('message', (data) => {
    if (transport.readyState === 1) transport.send(data.toString());
  });
} else call = new TwilioRealtimeCall(socket);
const expiry = Date.now() + 300000;
const token =
  remoteUrl && streamSecret
    ? `${callSid}.${expiry}.${crypto.createHmac('sha256', streamSecret).update(`${callSid}.${expiry}`).digest('hex')}`
    : '';
socket.emit(
  'message',
  Buffer.from(
    JSON.stringify({
      event: 'start',
      start: {
        streamSid: 'MZ_probe',
        callSid,
        customParameters: { from: callerPhone, token },
      },
    })
  )
);
let nextTurn = 0;
let activeTurn;
const timer = setInterval(() => {
  if (socket.readyState !== 1) return;
  let b = Buffer.alloc(160, 255);
  const elapsed = Date.now() - started;
  // Start each turn no earlier than its schedule. A later scheduled turn waits
  // for the prior audio to finish, so caller audio stays at 1x and never overlaps.
  while (!activeTurn && nextTurn < callerTurns.length) {
    const turn = callerTurns[nextTurn];
    if (!turn.audio.length) {
      nextTurn++;
      continue;
    }
    if (elapsed < turn.atMs) break;
    activeTurn = { ...turn, index: 0, replay: turnReplay[nextTurn] };
    activeTurn.replay.actualStartMs = elapsed;
    if (callerStartedAt === undefined) callerStartedAt = elapsed;
  }
  if (activeTurn) {
    activeTurn.audio.copy(b, 0, activeTurn.index, activeTurn.index + 160);
    activeTurn.index += 160;
    if (activeTurn.index >= activeTurn.audio.length) {
      const endedAt = Date.now() - started;
      activeTurn.replay.actualEndMs = endedAt;
      callerEndedAt = endedAt;
      nextTurn++;
      activeTurn = undefined;
    }
  }
  mediaClock += 20;
  socket.emit(
    'message',
    Buffer.from(
      JSON.stringify({
        event: 'media',
        media: { timestamp: String(mediaClock), payload: b.toString('base64') },
      })
    )
  );
}, 20);
await new Promise((r) => setTimeout(r, seconds * 1000));
clearInterval(timer);
socket.emit('message', Buffer.from(JSON.stringify({ event: 'stop' })));
await new Promise((r) => setTimeout(r, 2200));
transport?.close();
fs.writeFileSync(path.join(output, 'output.ulaw'), Buffer.concat(frames));
const result = {
  engine,
  model,
  remote: !!remoteUrl,
  ...(turnsFile ? {} : { phrase }),
  turns: turnReplay,
  callerStartedAt,
  callerEndedAt,
  speech,
  outputBytes: frames.reduce((n, b) => n + b.length, 0),
  output,
};
fs.writeFileSync(
  path.join(output, 'summary.json'),
  JSON.stringify(result, null, 2)
);
console.log(JSON.stringify(result));
