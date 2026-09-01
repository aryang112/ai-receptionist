// Read-only live validation of candidate Realtime session fields (lessons.md:
// a rejected session.update kills every call). Run:
//   node --env-file=.env --import tsx scripts/validate-session-fields.ts
// Read-only live validation of candidate Realtime session fields (lessons.md:
// a rejected session.update kills every call). Opens one fresh WS per variant,
// sends the production-shaped session.update plus ONE candidate field, and
// reports whether OpenAI answered session.updated or error. No audio, no call.
import WebSocket from 'ws';
const MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2.1';
const KEY = process.env.OPENAI_REALTIME_API_KEY || process.env.OPENAI_API_KEY || '';
const base = () => ({
  type: 'realtime', model: MODEL, output_modalities: ['audio'],
  instructions: 'probe', tools: [],
  truncation: { type: 'retention_ratio', retention_ratio: 0.8 },
  audio: {
    input: { format: { type: 'audio/pcmu' }, noise_reduction: { type: 'near_field' },
      turn_detection: { type: 'server_vad', threshold: 0.6, prefix_padding_ms: 300, silence_duration_ms: 700, interrupt_response: false, create_response: false } },
    output: { format: { type: 'audio/pcmu' }, voice: 'marin' },
  },
});
const variants: Array<[string, (s: any) => void]> = [
  ['baseline (production shape)', () => {}],
  ['reasoning.effort=low', (s) => { s.reasoning = { effort: 'low' }; }],
  ['reasoning.effort=minimal', (s) => { s.reasoning = { effort: 'minimal' }; }],
  ['audio.output.speed=1.05', (s) => { s.audio.output.speed = 1.05; }],
  ['semantic_vad eagerness=auto (+create/interrupt off)', (s) => { s.audio.input.turn_detection = { type: 'semantic_vad', eagerness: 'auto', interrupt_response: false, create_response: false }; }],
  ['server_vad idle_timeout_ms=20000', (s) => { s.audio.input.turn_detection.idle_timeout_ms = 20000; }],
  ['parallel_tool_calls=true', (s) => { s.parallel_tool_calls = true; }],
  ['tool_choice=auto', (s) => { s.tool_choice = 'auto'; }],
  ['max_output_tokens=400', (s) => { s.max_output_tokens = 400; }],
];
function probe(label: string, mutate: (s: any) => void): Promise<string> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL)}`, { headers: { Authorization: `Bearer ${KEY}` } });
    const s = base(); mutate(s);
    let done = false; const finish = (r: string) => { if (!done) { done = true; try { ws.close(); } catch {} resolve(r); } };
    const t = setTimeout(() => finish('TIMEOUT (no session.updated/error in 8s)'), 8000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'session.update', session: s })));
    ws.on('message', (d) => { const e = JSON.parse(d.toString());
      if (e.type === 'session.updated') { clearTimeout(t); const sess = e.session || {}; finish(`ACCEPTED — echoed: reasoning=${JSON.stringify(sess.reasoning)} speed=${sess.audio?.output?.speed} td=${sess.audio?.input?.turn_detection?.type}/${sess.audio?.input?.turn_detection?.eagerness ?? ''} idle=${sess.audio?.input?.turn_detection?.idle_timeout_ms ?? ''} ptc=${sess.parallel_tool_calls} tc=${sess.tool_choice} mot=${sess.max_output_tokens}`); }
      if (e.type === 'error') { clearTimeout(t); finish(`REJECTED — ${e.error?.code ?? ''}: ${e.error?.message ?? JSON.stringify(e.error)}`); } });
    ws.on('error', (err) => { clearTimeout(t); finish(`WS ERROR ${String(err).slice(0, 120)}`); });
  });
}
(async () => { for (const [label, m] of variants) { console.log(`${label.padEnd(52)} → ${await probe(label, m)}`); } })();
