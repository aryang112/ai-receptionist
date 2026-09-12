// Greeting-first reliability A/B: how long from session.started to first
// spoken audio, and how often it fails to greet within 4s of silence.
import WebSocket from 'ws';
const key = process.env.OPENAI_REALTIME_API_KEY || process.env.OPENAI_API_KEY;
function fromMulaw(u) { u = ~u & 0xff; const sign = u & 0x80, exp = (u >> 4) & 7, man = u & 0x0f; let s = ((man << 3) + 0x84) << exp; s -= 0x84; return sign ? -s : s; }
function rms(buf) { let acc = 0; for (let i = 0; i < buf.length; i++) { const v = fromMulaw(buf[i]); acc += v * v; } return Math.sqrt(acc / buf.length); }
const GREETING = 'Thanks for calling Richa\'s Threading Salon, this is Erica.';
const modes = {
  A_append_only: { pre: (ws) => ws.send(JSON.stringify({ type: 'session.instructions.append', event_id: 'g', delegation_id: null, content: `Greet the caller immediately with exactly: "${GREETING}" Then stop and listen.` })) },
  B_append_plus_commentary: { pre: (ws) => { ws.send(JSON.stringify({ type: 'session.instructions.append', event_id: 'g', delegation_id: null, content: `Greet the caller immediately with exactly: "${GREETING}" Then stop and listen.` })); ws.send(JSON.stringify({ type: 'session.commentary.append', event_id: 'c', delegation_id: null, content: 'Begin the conversation now by speaking the greeting.' })); } },
  C_instructions_only: { sessionExtra: { instructions: `You are Erica, a salon receptionist. As soon as the call connects, immediately say exactly: "${GREETING}" Then stop and listen.` }, pre: () => {} },
  D_input_history_developer: { sessionExtra: { input: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: `The phone call just connected. Speak first, right now, with exactly: "${GREETING}" Then stop and listen.` }] }] }, pre: () => {} },
};
function run(mode) { return new Promise((resolve) => {
  const m = modes[mode]; const session = Object.assign({ model: 'gpt-live-1', instructions: 'You are Erica, a salon receptionist. Keep turns short.', audio: { format: { type: 'audio/pcmu', rate: 8000 }, output: { voice: 'marin' } }, delegation: { type: 'client' } }, m.sessionExtra || {});
  const ws = new WebSocket('wss://api.openai.com/v1/live/sessions', { headers: { Authorization: `Bearer ${key}`, 'User-Agent': 'erica-live-probe/0.1' } });
  let startedAt = 0, firstSpeech = 0, transcript = '', iv, done = false; const silence = Buffer.alloc(160, 0xff).toString('base64');
  const finish = (r) => { if (done) return; done = true; clearInterval(iv); try { ws.close(); } catch {} resolve(r); };
  ws.on('open', () => ws.send(JSON.stringify({ type: 'session.start', event_id: 's', session })));
  ws.on('message', (raw) => { const ev = JSON.parse(raw.toString()); const now = Date.now();
    if (ev.type === 'session.started') { startedAt = now; m.pre(ws); iv = setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'session.input_audio.append', audio: silence })); }, 20); setTimeout(() => { ws.send(JSON.stringify({ type: 'session.close', event_id: 'x' })); }, 5000); setTimeout(() => finish({ firstSpeech, transcript }), 6500); return; }
    if (ev.type === 'session.output_audio.delta') { if (!firstSpeech && rms(Buffer.from(ev.delta, 'base64')) > 200) firstSpeech = now - startedAt; return; }
    if (ev.type === 'session.output_transcript.delta') { transcript += ev.delta; return; }
    if (ev.type === 'error') { finish({ error: ev.error?.message }); }
  });
  ws.on('error', (e) => finish({ error: e.message }));
}); }
for (const mode of Object.keys(modes)) { const res = []; for (let i = 0; i < 4; i++) res.push(await run(mode)); const ok = res.filter(r => r.firstSpeech); console.log(`${mode.padEnd(28)} greeted ${ok.length}/4 within 5s; first speech ms: [${res.map(r => r.error ? 'ERR:' + r.error : (r.firstSpeech || 'none')).join(', ')}]  sample: ${JSON.stringify((res.find(r => r.transcript)?.transcript || '').trim()).slice(0, 90)}`); }
