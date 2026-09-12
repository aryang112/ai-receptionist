// Field-acceptance probe for gpt-live-1 (one fresh session per variant).
import WebSocket from 'ws';
const key = process.env.OPENAI_REALTIME_API_KEY || process.env.OPENAI_API_KEY;
const tool = { type: 'function', name: 'get_business_hours', description: 'Salon hours for a day.', parameters: { type: 'object', properties: { day: { type: 'string' } } } };
const base = () => ({
  model: 'gpt-live-1',
  instructions: 'You are Erica, a salon receptionist. Speak briefly.',
  audio: { format: { type: 'audio/pcmu', rate: 8000 }, output: { voice: 'marin' } },
  delegation: { type: 'responses', responses: { model: 'gpt-5.6-luna', instructions: 'Backend.', tools: [tool], tool_choice: 'auto' } },
});
const variants = [
  ['baseline', (s) => {}, { dumpClosed: true }],
  ['delegation.type=client', (s) => { s.delegation = { type: 'client' }; }],
  ['voice=cedar', (s) => { s.audio.output.voice = 'cedar'; }],
  ['voice=quartz', (s) => { s.audio.output.voice = 'quartz'; }],
  ['audio.input.noise_reduction=near_field', (s) => { s.audio.input = { noise_reduction: { type: 'near_field' } }; }],
  ['audio.input.turn_detection=server_vad', (s) => { s.audio.input = { turn_detection: { type: 'server_vad' } }; }],
  ['turn_detection (top-level) server_vad', (s) => { s.turn_detection = { type: 'server_vad' }; }],
  ['audio.input.keywords=[...]', (s) => { s.audio.input = { keywords: ['Richa', 'microblading', 'Erica'] }; }],
  ['keywords (top-level)', (s) => { s.keywords = ['Richa', 'microblading']; }],
  ['store=false', (s) => { s.store = false; }],
  ['input history (developer msg)', (s) => { s.input = [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'The caller is a recognized client named Priya.' }] }]; }],
  ['responses.reasoning.effort=low', (s) => { s.delegation.responses.reasoning = { effort: 'low' }; }],
  ['responses.reasoning.effort=minimal', (s) => { s.delegation.responses.reasoning = { effort: 'minimal' }; }],
  ['responses.service_tier=priority', (s) => { s.delegation.responses.service_tier = 'priority'; }],
  ['responses.parallel_tool_calls=false', (s) => { s.delegation.responses.parallel_tool_calls = false; }],
  ['responses.model=gpt-5.6-terra', (s) => { s.delegation.responses.model = 'gpt-5.6-terra'; }],
  ['responses.model=gpt-5.4-mini (older)', (s) => { s.delegation.responses.model = 'gpt-5.4-mini'; }],
  ['mid-session session.update backend instructions', (s) => {}, { update: { delegation: { responses: { instructions: 'Backend v2: caller is recognized client Priya.' } } } }],
  ['mid-session thinking.append (delegation_id null)', (s) => {}, { thinking: 'Caller ID matched a recognized client named Priya; do not greet by name.' }],
];
function run(label, mutate, opts = {}) {
  return new Promise((resolve) => {
    const s = base(); mutate(s);
    const ws = new WebSocket('wss://api.openai.com/v1/live/sessions', { headers: { Authorization: `Bearer ${key}`, 'User-Agent': 'erica-live-probe/0.1' } });
    let out = []; let done = false; let started = false; let startedAt = 0;
    const finish = (r) => { if (done) return; done = true; out.push(r); try { ws.close(); } catch {} resolve(out.join(' | ')); };
    const t = setTimeout(() => finish('TIMEOUT'), 9000);
    const silence = Buffer.alloc(160, 0xff).toString('base64');
    let iv;
    ws.on('open', () => ws.send(JSON.stringify({ type: 'session.start', event_id: 'start', session: s })));
    ws.on('unexpected-response', (_q, res) => { let b=''; res.on('data', c=>b+=c); res.on('end', ()=>{ clearTimeout(t); finish(`HTTP ${res.statusCode} ${b.slice(0,300)}`); }); });
    ws.on('message', (raw) => {
      const ev = JSON.parse(raw.toString());
      if (ev.type === 'session.output_audio.delta') return;
      if (ev.type === 'session.started') {
        started = true; startedAt = Date.now();
        const se = ev.session || {};
        out.push(`ACCEPTED voice=${se.audio?.output?.voice} fmt=${se.audio?.format?.type}/${se.audio?.format?.rate} deleg=${se.delegation?.type}${se.delegation?.responses ? ' backend=' + se.delegation.responses.model + (se.delegation.responses.reasoning ? ' reasoning=' + JSON.stringify(se.delegation.responses.reasoning) : '') + (se.delegation.responses.service_tier ? ' tier=' + se.delegation.responses.service_tier : '') + (se.delegation.responses.parallel_tool_calls !== undefined ? ' ptc=' + se.delegation.responses.parallel_tool_calls : '') : ''}${se.store !== undefined ? ' store=' + se.store : ''}${se.audio?.input ? ' audio.input=' + JSON.stringify(se.audio.input) : ''}${se.turn_detection ? ' td=' + JSON.stringify(se.turn_detection) : ''}${se.keywords ? ' kw=' + JSON.stringify(se.keywords) : ''}${se.input ? ' input=' + JSON.stringify(se.input).slice(0,80) : ''}${se.expires_at ? ' expires_in=' + Math.round((se.expires_at*1000 - Date.now())/60000) + 'min' : ''}`);
        iv = setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'session.input_audio.append', audio: silence })); }, 20);
        if (opts.update) ws.send(JSON.stringify({ type: 'session.update', event_id: 'upd', session: opts.update }));
        if (opts.thinking) ws.send(JSON.stringify({ type: 'session.thinking.append', event_id: 'think', delegation_id: null, content: opts.thinking }));
        setTimeout(() => { clearInterval(iv); ws.send(JSON.stringify({ type: 'session.close', event_id: 'close' })); }, opts.update || opts.thinking ? 1500 : 700);
        return;
      }
      if (ev.type === 'session.updated') { out.push('session.updated ok backend.instructions=' + JSON.stringify(ev.session?.delegation?.responses?.instructions).slice(0, 60)); return; }
      if (ev.type === 'session.thinking.appended') { out.push('thinking.appended ok'); return; }
      if (ev.type === 'session.usage.updated') { out.push('usage.updated ' + JSON.stringify(ev.usage ?? ev).slice(0, 120)); return; }
      if (ev.type === 'session.closed') { clearTimeout(t); clearInterval(iv); if (opts.dumpClosed) console.log('  session.closed FULL:', JSON.stringify(ev).slice(0, 1500)); finish(`closed reason=${ev.reason} usage=${JSON.stringify(ev.usage ?? ev.session?.usage ?? null)}`); return; }
      if (ev.type === 'error') { clearTimeout(t); clearInterval(iv); finish(`REJECTED ${ev.error?.type ?? ''}/${ev.error?.code ?? ''}: ${ev.error?.message ?? JSON.stringify(ev)}`.slice(0, 260)); return; }
      out.push(ev.type);
    });
    ws.on('error', (e) => { clearTimeout(t); finish('WS ERROR ' + e.message); });
    ws.on('close', () => { clearTimeout(t); clearInterval(iv); finish(started ? 'ws closed' : 'ws closed before started'); });
  });
}
for (const [label, m, o] of variants) { console.log(`${label.padEnd(48)} → ${await run(label, m, o)}`); }
