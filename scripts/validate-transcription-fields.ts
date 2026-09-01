// Read-only live validation of audio.input.transcription sub-fields.
// Run: node --env-file=.env --import tsx scripts/validate-transcription-fields.ts
import WebSocket from 'ws';
const MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2.1';
const KEY = process.env.OPENAI_REALTIME_API_KEY || process.env.OPENAI_API_KEY || '';
const TM = process.env.OPENAI_INPUT_TRANSCRIPTION || 'gpt-4o-mini-transcribe';
const base = () => ({ type: 'realtime', model: MODEL, output_modalities: ['audio'], instructions: 'probe', tools: [],
  truncation: { type: 'retention_ratio', retention_ratio: 0.8 },
  audio: { input: { format: { type: 'audio/pcmu' }, noise_reduction: { type: 'near_field' }, transcription: { model: TM },
    turn_detection: { type: 'server_vad', threshold: 0.6, prefix_padding_ms: 300, silence_duration_ms: 700, interrupt_response: false, create_response: false } },
    output: { format: { type: 'audio/pcmu' }, voice: 'marin' } } });
const variants: Array<[string, (s: any) => void]> = [
  [`transcription model=${TM} (current prod)`, () => {}],
  ['+ transcription.language=en', (s) => { s.audio.input.transcription.language = 'en'; }],
  ['+ transcription.prompt (salon vocabulary)', (s) => { s.audio.input.transcription.language = 'en'; s.audio.input.transcription.prompt = "Richa's Threading Salon. Richa, Erica, brow threading, eyebrow threading, lash lift, lash tint, brow lamination, facial, waxing."; }],
  ['+ transcription.keywords (array)', (s) => { s.audio.input.transcription.language = 'en'; s.audio.input.transcription.keywords = ['Richa', 'Erica', 'threading', 'lash lift', 'lash tint']; }],
  ['reasoning.effort=low + language=en (combined candidate)', (s) => { s.reasoning = { effort: 'low' }; s.audio.input.transcription.language = 'en'; }],
];
function probe(mutate: (s: any) => void): Promise<string> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL)}`, { headers: { Authorization: `Bearer ${KEY}` } });
    const s = base(); mutate(s); let done = false;
    const finish = (r: string) => { if (!done) { done = true; try { ws.close(); } catch {} resolve(r); } };
    const t = setTimeout(() => finish('TIMEOUT'), 8000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'session.update', session: s })));
    ws.on('message', (d) => { const e = JSON.parse(d.toString());
      if (e.type === 'session.updated') { clearTimeout(t); finish(`ACCEPTED — transcription echoed: ${JSON.stringify(e.session?.audio?.input?.transcription)} reasoning=${JSON.stringify(e.session?.reasoning)}`); }
      if (e.type === 'error') { clearTimeout(t); finish(`REJECTED — ${e.error?.code}: ${e.error?.message}`); } });
    ws.on('error', (err) => { clearTimeout(t); finish(`WS ERROR ${String(err).slice(0, 100)}`); });
  });
}
(async () => { for (const [label, m] of variants) console.log(`${label.padEnd(58)} → ${await probe(m)}`); })();
