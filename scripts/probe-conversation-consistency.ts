// Live Realtime regression probe. Business tools are canned: no Phorest writes,
// Twilio calls, or owner messages. Credentials must be loaded by the caller.
// node --env-file=../ai-receptionist/.env --import tsx scripts/probe-conversation-consistency.ts
// AUDIO_INPUT=1 exercises spoken input using macOS say + ffmpeg; output is saved.
import WebSocket from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DateTime } from 'luxon';
import {
  buildInstructions,
  TOOL_DEFINITIONS,
  REALTIME_CONTEXT_NOTES,
  buildUnrecognizedCallerContext,
} from '../src/realtime/twilioStream.js';

const root = process.env.PROBE_OUTPUT || 'outputs/conversation-consistency';
fs.mkdirSync(root, { recursive: true });
const source = fs.readFileSync(
  new URL('../src/realtime/twilioStream.ts', import.meta.url),
  'utf8'
);
// Read the actual returned coaching, not an independently maintained imitation.
const messageNote = source.match(
  /'([A]cknowledge once, briefly, that the message has been passed[^']+)'/
)?.[1];
const retryNote = source.match(
  /'(Say a brief natural line in your own words and retry this tool once[^']+)'/
)?.[1];
if (!messageNote || !retryNote)
  throw new Error(
    'Actual tool notes not found; update this probe deliberately.'
  );
const key = process.env.OPENAI_REALTIME_API_KEY || process.env.OPENAI_API_KEY;
if (!key) throw new Error('Missing OpenAI key');
const model = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2.1';
const audioInput = process.env.AUDIO_INPUT === '1';
type Scenario = {
  name: string;
  turns: string[];
  history?: [string, string][];
  retry?: boolean;
  uncertain?: boolean;
  context?: string;
};
const scenarios: Scenario[] = [
  {
    name: 'settled-ending',
    history: [
      ['user', 'What is brow threading?'],
      [
        'assistant',
        'It removes unwanted brow hair using thread. Is there anything else I can help with?',
      ],
    ],
    turns: ["No, that's all. Thank you, goodbye."],
  },
  {
    name: 'message-goodbye',
    history: [
      ['user', 'I am a delivery vendor and need to leave a message for Richa.'],
      ['assistant', 'What would you like Richa to know?'],
    ],
    turns: [
      'Please tell her the supplies will arrive Thursday. That is everything, thank you and goodbye.',
    ],
  },
  { name: 'job-inquiry', turns: ['Are you hiring? I am looking for a job.'] },
  {
    name: 'supplied-name',
    turns: [
      'My name is Taylor Reed. I want eyebrow threading September eleventh at one PM.',
      'One PM works.',
      'Yes, this is the best number.',
      'Yes, please book that.',
      "No, that's everything, goodbye.",
    ],
  },
  {
    name: 'new-contact-sequence',
    turns: [
      'I want brow threading September eleventh at one PM.',
      'One PM works.',
      'Yes, this is the best number.',
      'Taylor Reed.',
      'Yes, please book that.',
      "No, that's everything, goodbye.",
    ],
  },
  {
    name: 'retry-limit',
    retry: true,
    turns: [
      'Please check brow threading appointments September eleventh at one PM.',
      'No, I will call back later. Goodbye.',
    ],
  },
  {
    name: 'uncertain-message',
    uncertain: true,
    history: [
      ['user', 'I need to leave a personal message for Richa.'],
      ['assistant', 'What would you like her to know?'],
    ],
    turns: [
      'Please ask her to call me about my treatment.',
      'Okay, I will call later. Goodbye.',
    ],
  },
  {
    name: 'new-request-after-closer',
    history: [
      ['user', 'What is brow threading?'],
      [
        'assistant',
        'It removes unwanted brow hair using thread. Is there anything else I can help with?',
      ],
    ],
    turns: [
      'Actually, what are your Friday hours?',
      "No, that's all, goodbye.",
    ],
  },
];
const selected = scenarios.filter(
  (s) =>
    !process.env.PROBE_CASES ||
    process.env.PROBE_CASES.split(',').includes(s.name)
);
const reports: any[] = [];
for (const scenario of selected) {
  const events: any[] = [];
  let turn = 0,
    responseCount = 0,
    buffer: Buffer[] = [],
    allAudio: Buffer[] = [];
  let deadline: ReturnType<typeof setTimeout>;
  let started = 0;
  const ws = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`,
    { headers: { Authorization: `Bearer ${key}` } }
  );
  const send = (x: unknown) => ws.send(JSON.stringify(x));
  const userTurn = async () => {
    if (turn >= scenario.turns.length) {
      ws.close();
      return;
    }
    const text = scenario.turns[turn++]!;
    events.push({ role: 'caller', text });
    if (audioInput) {
      const prefix = path.resolve(root, `${scenario.name}-caller-${turn}`);
      execFileSync('say', [
        '-v',
        'Samantha',
        '-r',
        '165',
        '-o',
        `${prefix}.aiff`,
        text,
      ]);
      execFileSync('ffmpeg', [
        '-loglevel',
        'error',
        '-y',
        '-i',
        `${prefix}.aiff`,
        '-ar',
        '8000',
        '-ac',
        '1',
        '-f',
        'mulaw',
        `${prefix}.ulaw`,
      ]);
      const pcmu = fs.readFileSync(`${prefix}.ulaw`);
      allAudio.push(pcmu, Buffer.alloc(2400, 255));
      // Pace input like a telephone stream, including a complete trailing pause.
      const payload = Buffer.concat([pcmu, Buffer.alloc(8000, 255)]);
      for (let n = 0; n < payload.length; n += 160) {
        if (ws.readyState !== WebSocket.OPEN) return;
        send({
          type: 'input_audio_buffer.append',
          audio: payload.subarray(n, n + 160).toString('base64'),
        });
        await new Promise((r) => setTimeout(r, 20));
      }
      started = Date.now();
      send({ type: 'response.create' });
    } else {
      send({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text }],
        },
      });
      started = Date.now();
      send({ type: 'response.create' });
    }
  };
  await new Promise<void>((resolve, reject) => {
    deadline = setTimeout(() => {
      events.push({ error: 'scenario timeout' });
      ws.close();
    }, 120000);
    ws.on('open', () =>
      send({
        type: 'session.update',
        session: {
          type: 'realtime',
          model,
          instructions:
            buildInstructions(
              DateTime.fromISO('2026-09-08T19:00', { zone: 'America/New_York' })
            ) +
            '\n' +
            (scenario.name.includes('name') || scenario.name.includes('contact')
              ? buildUnrecognizedCallerContext()
              : '') +
            (scenario.context || ''),
          output_modalities: ['audio'],
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
        },
      })
    );
    ws.on('error', reject);
    ws.on('close', () => {
      clearTimeout(deadline);
      resolve();
    });
    ws.on('message', async (data) => {
      const event = JSON.parse(data.toString());
      if (event.type === 'error') {
        events.push({ error: event.error?.message });
        ws.close();
      }
      if (event.type === 'session.updated') {
        for (const [role, text] of scenario.history || [])
          send({
            type: 'conversation.item.create',
            item: {
              type: 'message',
              role,
              content: [
                { type: role === 'user' ? 'input_text' : 'output_text', text },
              ],
            },
          });
        await userTurn();
      }
      if (event.type === 'response.output_audio.delta')
        buffer.push(Buffer.from(event.delta, 'base64'));
      if (event.type !== 'response.done') return;
      if (++responseCount > 20) {
        events.push({ error: 'response loop' });
        ws.close();
        return;
      }
      if (event.response.status !== 'completed') {
        events.push({
          error: `Response ${event.response.status}`,
          details: event.response.status_details,
        });
        ws.close();
        return;
      }
      const output = event.response.output || [];
      const text = output
        .flatMap((i: any) => i.content || [])
        .map((c: any) => c.transcript || c.text || '')
        .join('');
      const audio = Buffer.concat(buffer);
      buffer = [];
      allAudio.push(audio, Buffer.alloc(4000, 255));
      const calls = output.filter((i: any) => i.type === 'function_call');
      events.push({
        role: 'erica',
        text,
        audioBytes: audio.length,
        elapsedMs: Date.now() - started,
        tools: calls.map((c: any) => ({
          name: c.name,
          args: JSON.parse(c.arguments || '{}'),
        })),
      });
      for (const c of calls) {
        const args = JSON.parse(c.arguments || '{}');
        let result: any;
        if (c.name === 'suggest_availability')
          result = scenario.retry
            ? { error: 'temporary lookup failure', note: retryNote }
            : {
                service: 'Brow Threading',
                date: args.date,
                slots: [
                  { time: '1:00 PM', value: '13:00' },
                  { time: '1:15 PM', value: '13:15' },
                ],
                note: 'Offer only returned times nearest the request.',
              };
        else if (c.name === 'book_appointment')
          result = {
            appointmentId: 'fixture_appointment',
            service: 'Brow Threading',
            date: args.date,
            time: args.time,
          };
        else if (c.name === 'lookup_customer')
          result = {
            found: false,
            note: 'No matching client. Continue as a new caller without mentioning the lookup miss.',
          };
        else if (c.name === 'leave_message_for_owner')
          result = scenario.uncertain
            ? {
                messageAccepted: false,
                outcomeUncertain: true,
                note: "Apologize briefly that you couldn't confirm the message went through. Do not retry, claim success, discuss internal details, or promise a response. Then stop and wait.",
              }
            : { messageAccepted: true, note: messageNote };
        else if (c.name === 'end_call')
          result = {
            ending: true,
            note: REALTIME_CONTEXT_NOTES.endCallGoodbye,
          };
        else {
          events.push({ error: `Unexpected tool ${c.name}` });
          ws.close();
          return;
        }
        send({
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id: c.call_id,
            output: JSON.stringify(result),
          },
        });
      }
      if (calls.length) {
        started = Date.now();
        send({ type: 'response.create' });
      } else await userTurn();
    });
  });
  fs.writeFileSync(
    path.join(root, `${scenario.name}.ulaw`),
    Buffer.concat(allAudio)
  );
  execFileSync('ffmpeg', [
    '-loglevel',
    'error',
    '-y',
    '-f',
    'mulaw',
    '-ar',
    '8000',
    '-ac',
    '1',
    '-i',
    path.join(root, `${scenario.name}.ulaw`),
    path.join(root, `${scenario.name}.wav`),
  ]);
  const report = { scenario: scenario.name, model, audioInput, events };
  reports.push(report);
  fs.writeFileSync(
    path.join(root, 'results.json'),
    JSON.stringify(reports, null, 2)
  );
  console.log(JSON.stringify(report));
  if (events.some((e) => e.error)) process.exitCode = 1;
  // Avoid bursting the account TPM limit across synthetic long conversations.
  if (scenario !== selected.at(-1))
    await new Promise((r) => setTimeout(r, 10000));
}
