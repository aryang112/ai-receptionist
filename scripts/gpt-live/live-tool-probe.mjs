// Tool round-trip probe v2: response.create right after function_call_output;
// energy-based speech detection on output audio for true latencies.
import WebSocket from 'ws';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const key = process.env.OPENAI_REALTIME_API_KEY || process.env.OPENAI_API_KEY;
const BACKEND = process.env.PROBE_BACKEND || 'gpt-5.6-luna';
const EFFORT = process.env.PROBE_EFFORT || '';
const CACHE = '/tmp/erica-live-caller-hours.ulaw';
async function tts(text) { const r = await fetch('https://api.openai.com/v1/audio/speech', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: 'alloy', input: text, response_format: 'pcm' }) }); if (!r.ok) throw new Error('tts ' + r.status); return Buffer.from(await r.arrayBuffer()); }
const expLut = new Uint8Array(256); for (let i = 1; i < 256; i++) expLut[i] = Math.floor(Math.log2(i));
function toMulaw(s) { const BIAS = 0x84, CLIP = 32635; let sign = (s >> 8) & 0x80; if (sign) s = -s; if (s > CLIP) s = CLIP; s += BIAS; const exp = expLut[(s >> 7) & 0xff]; const man = (s >> (exp + 3)) & 0x0f; return ~(sign | (exp << 4) | man) & 0xff; }
function fromMulaw(u) { u = ~u & 0xff; const sign = u & 0x80, exp = (u >> 4) & 7, man = u & 0x0f; let s = ((man << 3) + 0x84) << exp; s -= 0x84; return sign ? -s : s; }
function pcm24kToMulaw8k(buf) { const n = Math.floor(buf.length / 2 / 3); const out = Buffer.alloc(n); for (let i = 0; i < n; i++) { const a = buf.readInt16LE(i * 6), b = buf.readInt16LE(i * 6 + 2), c = buf.readInt16LE(i * 6 + 4); out[i] = toMulaw(Math.round((a + b + c) / 3)); } return out; }
function rms(buf) { let acc = 0; for (let i = 0; i < buf.length; i++) { const v = fromMulaw(buf[i]); acc += v * v; } return Math.sqrt(acc / buf.length); }
let callerMulaw; if (existsSync(CACHE)) callerMulaw = readFileSync(CACHE); else { callerMulaw = pcm24kToMulaw8k(await tts('Hi there. What are your hours on Saturday?')); writeFileSync(CACHE, callerMulaw); }

const tool = { type: 'function', name: 'get_business_hours', description: 'Return the salon opening hours for a given day of the week.', parameters: { type: 'object', properties: { day: { type: 'string' } }, required: ['day'] } };
const responses = { model: BACKEND, instructions: 'You are the backend for a salon receptionist. For any hours question call get_business_hours with the day, then reply with the hours in one short sentence.', tools: [tool], tool_choice: 'auto' };
if (EFFORT) responses.reasoning = { effort: EFFORT };
const session = { model: 'gpt-live-1', instructions: 'You are Erica, the receptionist at Richa\'s Threading Salon. Keep every turn to one or two short sentences. Delegate any question about hours, prices, or appointments to the backend before answering; never guess hours.', audio: { format: { type: 'audio/pcmu', rate: 8000 }, output: { voice: 'marin' } }, delegation: { type: 'responses', responses } };
const ws = new WebSocket('wss://api.openai.com/v1/live/sessions', { headers: { Authorization: `Bearer ${key}`, 'User-Agent': 'erica-live-probe/0.1' } });
const t0 = Date.now(); const T = () => `+${String(Date.now() - t0).padStart(5)}ms`; const log = (...a) => console.log(T(), ...a);
const silence = Buffer.alloc(160, 0xff).toString('base64');
let greetingEndedAt = 0, speaking = false, quietRun = 0, speechSegments = [], appendAt = 0, callerEndAt = 0, delegationAt = 0, fnCallAt = 0, outputSentAt = 0, backendText = '', outTranscript = '', phase = 'greeting', firstSpeechAfter = {};
function markSpeech(now) { for (const k of ['append', 'callerEnd', 'output']) { const ref = { append: appendAt, callerEnd: callerEndAt, output: outputSentAt }[k]; if (ref && !firstSpeechAfter[k]) firstSpeechAfter[k] = now - ref; } }
ws.on('open', () => ws.send(JSON.stringify({ type: 'session.start', event_id: 'start', session })));
ws.on('message', (raw) => {
  const ev = JSON.parse(raw.toString()); const now = Date.now();
  if (ev.type === 'session.output_audio.delta') {
    const buf = Buffer.from(ev.delta, 'base64'); const e = rms(buf);
    if (e > 200) { quietRun = 0; if (!speaking) { speaking = true; speechSegments.push({ start: now }); log('🔊 speech START (rms ' + Math.round(e) + ')'); markSpeech(now); } }
    else if (speaking && ++quietRun >= 3) { speaking = false; speechSegments[speechSegments.length - 1].end = now; if (!greetingEndedAt) greetingEndedAt = now; log('🔇 speech END'); }
    return;
  }
  if (ev.type === 'session.started') {
    log('session.started');
    ws.send(JSON.stringify({ type: 'session.instructions.append', event_id: 'greet', delegation_id: null, content: 'Greet the caller immediately with exactly: "Thanks for calling Richa\'s Threading Salon, this is Erica." Then stop and listen.' }));
    ws.send(JSON.stringify({ type: 'session.commentary.append', event_id: 'go', delegation_id: null, content: 'Begin the conversation now by speaking the greeting.' }));
    appendAt = now;
    let idx = 0, frames = 0;
    const iv = setInterval(() => { if (ws.readyState !== 1) return; frames++;
      if (phase === 'greeting' && greetingEndedAt && Date.now() - greetingEndedAt > 800) { phase = 'caller'; log('→ streaming caller audio'); }
      if (phase === 'caller') { const chunk = callerMulaw.subarray(idx, idx + 160); idx += 160; if (!chunk.length) { phase = 'after'; callerEndAt = Date.now(); log('caller audio finished'); return; } const b = Buffer.alloc(160, 0xff); chunk.copy(b); ws.send(JSON.stringify({ type: 'session.input_audio.append', audio: b.toString('base64') })); }
      else ws.send(JSON.stringify({ type: 'session.input_audio.append', audio: silence })); }, 20);
    setTimeout(() => { clearInterval(iv); ws.send(JSON.stringify({ type: 'session.close', event_id: 'close' })); }, 24000);
    setTimeout(() => { summary(); process.exit(0); }, 30000); return;
  }
  if (ev.type === 'session.output_transcript.delta') { outTranscript += ev.delta; log(`assistant» "${ev.delta}" [${ev.start_ms}-${ev.end_ms}]`); return; }
  if (ev.type === 'session.input_transcript.delta') { log(`caller» "${ev.delta}" [${ev.start_ms}-${ev.end_ms}]`); return; }
  if (ev.type === 'session.delegation.created') { delegationAt = now; log('delegation.created'); return; }
  if (ev.type === 'response.event') { const inner = ev.event || {};
    if (inner.type === 'response.output_item.done' && inner.item?.type === 'function_call') { fnCallAt = now; log('FUNCTION CALL', inner.item.name, inner.item.arguments);
      ws.send(JSON.stringify({ type: 'response.item.create', event_id: 'fnout', item: { type: 'function_call_output', call_id: inner.item.call_id, output: JSON.stringify({ day: 'Saturday', hours: '10:00 AM to 6:00 PM' }) } }));
      ws.send(JSON.stringify({ type: 'response.create', event_id: 'cont' })); outputSentAt = Date.now(); log('→ function_call_output + response.create sent'); return; }
    if (inner.type === 'response.output_text.delta') { backendText += inner.delta; return; }
    if (inner.type === 'response.output_text.done') { log('backend text:', JSON.stringify(inner.text)); return; }
    if (['response.created', 'response.completed', 'response.output_item.added', 'response.output_item.done'].includes(inner.type)) { log('response.event ▸', inner.type, inner.item ? inner.item.type : ''); }
    return; }
  if (ev.type === 'session.closed') { summary(); setTimeout(() => process.exit(0), 100); return; }
  if (ev.type === 'error') log('ERROR', JSON.stringify(ev).slice(0, 300));
});
function summary() { console.log('\n=== SUMMARY backend=' + BACKEND + (EFFORT ? ' effort=' + EFFORT : ' effort=default') + ' ===');
  console.log('assistant transcript:', JSON.stringify(outTranscript));
  console.log('speech segments (wall):', speechSegments.map(s => ((s.start - t0) / 1000).toFixed(2) + '→' + (s.end ? ((s.end - t0) / 1000).toFixed(2) : '…')).join('  '));
  console.log('greeting: append → first speech:', firstSpeechAfter.append ?? 'n/a', 'ms');
  console.log('caller end → first speech (preamble):', firstSpeechAfter.callerEnd ?? 'n/a', 'ms');
  console.log('caller end → delegation.created:', delegationAt && callerEndAt ? delegationAt - callerEndAt : 'n/a', 'ms');
  console.log('delegation → function_call:', fnCallAt && delegationAt ? fnCallAt - delegationAt : 'n/a', 'ms');
  console.log('function_call_output → first speech of answer:', firstSpeechAfter.output ?? 'n/a', 'ms'); }
