// Read-only LIVE probe of the current local prompt on the production model +
// session shape: text in, audio-transcript out, business tools intercepted
// with canned results (no Phorest, no Twilio, no SMS). Run before any prompt
// deploy:  node --env-file=.env --import tsx scripts/probe-prompt-live.ts
// Scenarios are edited in place; each opens one fresh WebSocket.
import WebSocket from 'ws';
import {
  buildInstructions,
  TOOL_DEFINITIONS,
} from '../src/realtime/twilioStream.js';
const MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2.1';
const KEY =
  process.env.OPENAI_REALTIME_API_KEY || process.env.OPENAI_API_KEY || '';
const CLOSURE_NOTE =
  'Follow TEMPORARY CLOSURE POLICY for this request to speak with Richa. Give the full reopen date, ask what the caller needs, then wait. Handle supported salon tasks directly. Offer a message only after the need is known and it is personal/Richa-only, outside your capabilities, or the caller still asks to leave one.';
const TOOL_RESULTS: Record<string, (a: any) => unknown> = {
  suggest_availability: (a) => ({
    service: 'Brow Threading',
    date: a.date,
    slots: [
      { time: '12:45 PM', value: '12:45' },
      { time: '1:00 PM', value: '13:00' },
      { time: '1:15 PM', value: '13:15' },
      { time: '3:30 PM', value: '15:30' },
    ],
    note: 'Offer the times nearest what the caller asked. Only ever offer times from slots.',
  }),
  book_appointment: (a) => ({
    ok: true,
    booked: true,
    appointmentId: 'apt_9',
    service: a.serviceName,
    date: a.date,
    time: a.time,
  }),
  lookup_customer: () => ({
    found: false,
    note: 'No matching client. Treat this as a normal new caller and do not mention the lookup miss.',
  }),
  leave_message_for_owner: () => ({
    ok: true,
    delivered: true,
    note: 'Message accepted. Acknowledge once naturally, ask once if they need anything else, then wait.',
  }),
  transfer_to_owner: () => ({
    transferred: false,
    needDiscoveryRequired: true,
    messageAvailable: true,
    note: CLOSURE_NOTE,
  }),
  get_prices: (a) => ({
    prices: [{ service: 'Brow Threading', price: 15, durationMin: 15 }],
  }),
  wait_for_user: () => ({ ok: true }),
  end_call: () => ({
    ending: true,
    note: 'The server will close after your next spoken line. Say exactly one short, warm, natural farewell addressed to the caller now.',
  }),
};
function session(instructions: string) {
  return {
    type: 'realtime',
    model: MODEL,
    output_modalities: ['audio'],
    instructions,
    tools: TOOL_DEFINITIONS,
    truncation: { type: 'retention_ratio', retention_ratio: 0.8 },
    audio: {
      input: {
        format: { type: 'audio/pcmu' },
        noise_reduction: { type: 'near_field' },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.6,
          prefix_padding_ms: 300,
          silence_duration_ms: 700,
          interrupt_response: false,
          create_response: false,
        },
      },
      output: { format: { type: 'audio/pcmu' }, voice: 'marin' },
    },
  };
}
async function run(name: string, turns: string[]) {
  const instructions = buildInstructions();
  const ws = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL)}`,
    { headers: { Authorization: `Bearer ${KEY}` } }
  );
  const out: string[] = [];
  let turnIdx = 0;
  let transcript = '';
  let pendingCalls: any[] = [];
  const send = (o: unknown) => ws.send(JSON.stringify(o));
  const nextTurn = () => {
    if (turnIdx >= turns.length) {
      ws.close();
      return;
    }
    const text = turns[turnIdx++]!;
    out.push(`  CALLER: ${text}`);
    send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text }],
      },
    });
    send({ type: 'response.create' });
  };
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      out.push('  <timeout>');
      try {
        ws.close();
      } catch {}
      resolve();
    }, 90000);
    ws.on('open', () =>
      send({ type: 'session.update', session: session(instructions) })
    );
    ws.on('close', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.on('message', (d) => {
      const e = JSON.parse(d.toString());
      if (e.type === 'session.updated') {
        out.push('  [greeting]');
        send({ type: 'response.create' });
      }
      if (e.type === 'error') {
        out.push(`  ERROR ${JSON.stringify(e.error)}`);
        ws.close();
      }
      if (e.type === 'response.output_audio_transcript.delta')
        transcript += e.delta;
      if (e.type === 'response.done') {
        const items = e.response?.output ?? [];
        const calls = items.filter((i: any) => i.type === 'function_call');
        const spoke = transcript.trim();
        if (spoke) out.push(`  ERICA : ${spoke}`);
        transcript = '';
        for (const c of calls) {
          let args: any = {};
          try {
            args = JSON.parse(c.arguments || '{}');
          } catch {}
          out.push(`  [tool ${c.name}(${JSON.stringify(args)})]`);
          const result = (TOOL_RESULTS[c.name] ?? (() => ({ ok: true })))(args);
          send({
            type: 'conversation.item.create',
            item: {
              type: 'function_call_output',
              call_id: c.call_id,
              output: JSON.stringify(result),
            },
          });
        }
        // A silent tool never gets a response.create (mirrors openaiSession).
        const allSilent =
          calls.length > 0 &&
          calls.every((c: any) => c.name === 'wait_for_user');
        if (calls.length && !allSilent) {
          send({ type: 'response.create' });
          return;
        }
        nextTurn();
      }
    });
  });
  console.log(`\n### ${name}\n` + out.join('\n'));
}
(async () => {
  await run('A. new-caller booking during closure (confirmation beat?)', [
    'Hi, I want to book a brow threading on September eleventh around one.',
    'One fifteen works.',
    'Yes, this number is fine.',
    'Tony Stark.',
    'Yes.',
    "No that's all, thanks.",
  ]);
  await run('B. bare Richa request during closure', [
    'Hi, is Richa there?',
    'I wanted to ask her about a lash lift.',
  ]);
  await run('C. speak to someone', [
    'Can I talk to someone?',
    "It's personal, I'd rather leave her a message.",
    'Tell her Priya called about the invoice, she can call me back.',
  ]);
  await run('D. hours this week', [
    'What are your hours this week?',
    'Say that again?',
  ]);
  await run('E. bare hello / noise', [
    'Hello?',
    'Um.',
    '(background TV chatter, not addressed to you)',
    'Sorry — can I book a brow threading?',
  ]);
  await run('F. Richa availability with date', [
    "Can you check Richa's availability for tomorrow?",
  ]);
  process.exit(0);
})();
