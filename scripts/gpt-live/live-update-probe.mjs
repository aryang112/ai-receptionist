// Mid-session session.update variants (what can change during a call?)
import WebSocket from 'ws';
const key = process.env.OPENAI_REALTIME_API_KEY || process.env.OPENAI_API_KEY;
const tool = { type: 'function', name: 'get_business_hours', description: 'Salon hours.', parameter: undefined, parameters: { type: 'object', properties: { day: { type: 'string' } } } };
const tool2 = { type: 'function', name: 'book_appointment', description: 'Book.', parameters: { type: 'object', properties: { when: { type: 'string' } } } };
const base = () => ({ model: 'gpt-live-1', instructions: 'You are Erica.', audio: { format: { type: 'audio/pcmu', rate: 8000 }, output: { voice: 'marin' } }, delegation: { type: 'responses', responses: { model: 'gpt-5.6-luna', instructions: 'Backend.', tools: [tool], tool_choice: 'auto' } } });
const variants = [
  ['update backend instructions (with delegation.type)', { delegation: { type: 'responses', responses: { instructions: 'Backend v2: caller is recognized client Priya.' } } }],
  ['update backend tools (add book_appointment)', { delegation: { type: 'responses', responses: { tools: [tool, tool2] } } }],
  ['update backend model luna→terra', { delegation: { type: 'responses', responses: { model: 'gpt-5.6-terra' } } }],
  ['update backend reasoning.effort', { delegation: { type: 'responses', responses: { reasoning: { effort: 'low' } } } }],
  ['update live instructions', { instructions: 'You are Erica v2.' }],
  ['update voice', { audio: { output: { voice: 'cedar' } } }],
  ['instructions.append with 900-token content (limit 500?)', null, 'append-big'],
];
function run(label, upd, special) {
  return new Promise((resolve) => {
    const ws = new WebSocket('wss://api.openai.com/v1/live/sessions', { headers: { Authorization: `Bearer ${key}`, 'User-Agent': 'erica-live-probe/0.1' } });
    let out = []; let done = false; const finish = (r) => { if (done) return; done = true; out.push(r); try { ws.close(); } catch {} resolve(out.join(' | ')); };
    const t = setTimeout(() => finish('TIMEOUT'), 9000);
    const silence = Buffer.alloc(160, 0xff).toString('base64'); let iv;
    ws.on('open', () => ws.send(JSON.stringify({ type: 'session.start', event_id: 'start', session: base() })));
    ws.on('message', (raw) => {
      const ev = JSON.parse(raw.toString());
      if (ev.type === 'session.output_audio.delta') return;
      if (ev.type === 'session.started') {
        iv = setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'session.input_audio.append', audio: silence })); }, 20);
        if (special === 'append-big') ws.send(JSON.stringify({ type: 'session.instructions.append', event_id: 'big', delegation_id: null, content: ('The salon offers brow threading, lip threading, full face threading, microblading, and lash lifts. ').repeat(60) }));
        else ws.send(JSON.stringify({ type: 'session.update', event_id: 'upd', session: upd }));
        setTimeout(() => { clearInterval(iv); ws.send(JSON.stringify({ type: 'session.close', event_id: 'close' })); }, 1500); return;
      }
      if (ev.type === 'session.updated') { const s = ev.session || {}; out.push(`session.updated ✓ instr=${JSON.stringify(s.instructions)?.slice(0,30)} voice=${s.audio?.output?.voice} backend=${s.delegation?.responses?.model} bInstr=${JSON.stringify(s.delegation?.responses?.instructions)?.slice(0,40)} tools=${(s.delegation?.responses?.tools||[]).map(t=>t.name).join(',')} reasoning=${JSON.stringify(s.delegation?.responses?.reasoning)}`); return; }
      if (ev.type === 'session.instructions.appended') { out.push('appended ✓ ' + JSON.stringify({ start_ms: ev.start_ms, end_ms: ev.end_ms })); return; }
      if (ev.type === 'error') { clearTimeout(t); clearInterval(iv); finish(`REJECTED ${ev.error?.code}: ${ev.error?.message}`.slice(0, 220)); return; }
      if (ev.type === 'session.closed') { clearTimeout(t); clearInterval(iv); finish('closed'); return; }
    });
    ws.on('error', (e) => finish('WS ERROR ' + e.message));
    ws.on('close', () => { clearTimeout(t); clearInterval(iv); finish('ws closed'); });
  });
}
for (const [label, upd, sp] of variants) console.log(`${label.padEnd(52)} → ${await run(label, upd, sp)}`);
