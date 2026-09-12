// Live-API access + session-shape probe. Opens ONE gpt-live-1 session with the
// exact shape Erica would use (pcmu/8000, marin, responses delegation with one
// real tool), logs every event, closes after ~4s. Cost: a few cents at most.
import WebSocket from 'ws';

const key = process.env.OPENAI_REALTIME_API_KEY || process.env.OPENAI_API_KEY;
if (!key) { console.error('no key'); process.exit(1); }
const variant = process.argv[2] || 'responses';

const tool = {
  type: 'function',
  name: 'get_business_hours',
  description: 'Return the salon hours for a given day.',
  parameters: { type: 'object', properties: { day: { type: 'string' } }, required: [] },
};

const session = {
  model: 'gpt-live-1',
  instructions: 'You are Erica, a salon receptionist. Speak briefly. Delegate any hours question to the backend.',
  audio: { format: { type: 'audio/pcmu', rate: 8000 }, output: { voice: process.env.PROBE_VOICE || 'marin' } },
  delegation: variant === 'client'
    ? { type: 'client' }
    : { type: 'responses', responses: { model: process.env.PROBE_BACKEND || 'gpt-5.6-luna', instructions: 'Backend for a salon receptionist.', tools: [tool], tool_choice: 'auto' } },
};

const ws = new WebSocket('wss://api.openai.com/v1/live/sessions', {
  headers: { Authorization: `Bearer ${key}`, 'User-Agent': 'erica-live-probe/0.1' },
});
const t0 = Date.now();
const log = (...a) => console.log(`[+${String(Date.now() - t0).padStart(5)}ms]`, ...a);

ws.on('open', () => {
  log('open → session.start', JSON.stringify(session.audio), 'delegation=' + session.delegation.type);
  ws.send(JSON.stringify({ type: 'session.start', event_id: 'start_1', session }));
});
ws.on('message', (raw) => {
  const ev = JSON.parse(raw.toString());
  if (ev.type === 'session.output_audio.delta') { process.stdout.write('.'); return; }
  if (ev.type === 'session.started') {
    log('session.started id=' + ev.session?.id, 'voice=' + ev.session?.audio?.output?.voice, 'format=' + JSON.stringify(ev.session?.audio?.format), 'delegation=' + JSON.stringify(ev.session?.delegation?.type), 'model=' + ev.session?.model);
    // greeting-first pattern from the docs
    ws.send(JSON.stringify({ type: 'session.instructions.append', event_id: 'greet_1', delegation_id: null, content: 'Greet the caller immediately with exactly: "Thanks for calling, this is Erica." Then stop and listen.' }));
    // keep input audio flowing (silence, 20ms of mu-law 0xFF)
    const silence = Buffer.alloc(160, 0xff).toString('base64');
    const iv = setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'session.input_audio.append', audio: silence })); }, 20);
    setTimeout(() => { clearInterval(iv); log('→ session.close'); ws.send(JSON.stringify({ type: 'session.close', event_id: 'close_1' })); }, 4500);
    setTimeout(() => { log('timeout, exiting'); process.exit(0); }, 9000);
    return;
  }
  const brief = JSON.stringify(ev);
  log(ev.type, brief.length > 600 ? brief.slice(0, 600) + '…' : brief);
  if (ev.type === 'session.closed') { setTimeout(() => process.exit(0), 200); }
  if (ev.type === 'error' && !ev.client_event_id?.startsWith('greet')) { /* keep going to see all */ }
});
ws.on('unexpected-response', (_req, res) => {
  let body = ''; res.on('data', (c) => body += c); res.on('end', () => { log('HTTP', res.statusCode, body.slice(0, 800)); process.exit(2); });
});
ws.on('error', (e) => { log('ws error', e.message); });
ws.on('close', (c, r) => { log('ws close', c, r.toString()); setTimeout(() => process.exit(0), 100); });
