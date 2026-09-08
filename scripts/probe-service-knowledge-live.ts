import WebSocket from 'ws';
import { DateTime } from 'luxon';
import {
  buildInstructions,
  TOOL_DEFINITIONS,
} from '../src/realtime/twilioStream.js';
import { getServiceInformation } from '../src/services/serviceKnowledge.js';

const key = process.env.OPENAI_REALTIME_API_KEY || process.env.OPENAI_API_KEY;
const model = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2.1';
if (!key)
  throw new Error('OPENAI_REALTIME_API_KEY or OPENAI_API_KEY is required');

const questions = [
  'How long does eyebrow tinting usually last?',
  'Would brow lamination work for sparse brows, and how long does it last?',
  'What aftercare should I follow after a lash lift?',
  'I take prescribed aspirin. What should I do before microblading?',
  'Is microblading safe if I am pregnant?',
  'What aftercare should I follow after an oxygen facial?',
];

type ProbeResult = {
  question: string;
  tool?: string;
  args?: unknown;
  preToolSpeech: string;
  answer: string;
  toolDecisionMs?: number;
  lookupMs?: number;
  postToolFirstAudioMs?: number;
  error?: string;
};

async function probe(question: string): Promise<ProbeResult> {
  const ws = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`,
    { headers: { Authorization: `Bearer ${key}` } }
  );
  const result: ProbeResult = {
    question,
    preToolSpeech: '',
    answer: '',
  };
  let phase: 'greeting' | 'question' | 'answer' = 'greeting';
  let transcript = '';
  let questionStartedAt = 0;
  let toolResultAt = 0;
  let settled = false;
  const send = (value: unknown) => ws.send(JSON.stringify(value));

  return await new Promise<ProbeResult>((resolve) => {
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      resolve(result);
    };
    const timer = setTimeout(() => {
      result.error = 'timeout';
      finish();
    }, 45_000);

    ws.on('open', () => {
      send({
        type: 'session.update',
        session: {
          type: 'realtime',
          model,
          output_modalities: ['audio'],
          instructions: buildInstructions(
            DateTime.fromISO('2026-09-04T18:45', {
              zone: 'America/New_York',
            })
          ),
          tools: TOOL_DEFINITIONS,
          audio: {
            input: {
              format: { type: 'audio/pcmu' },
              turn_detection: null,
            },
            output: { format: { type: 'audio/pcmu' }, voice: 'cedar' },
          },
        },
      });
    });

    ws.on('message', (raw) => {
      const event = JSON.parse(raw.toString());
      if (event.type === 'error') {
        result.error = event.error?.message || 'Realtime API error';
        finish();
        return;
      }
      if (event.type === 'session.updated') {
        send({ type: 'response.create' });
        return;
      }
      if (event.type === 'response.output_audio_transcript.delta') {
        transcript += event.delta || '';
      }
      if (
        phase === 'answer' &&
        !result.postToolFirstAudioMs &&
        event.type === 'response.output_audio.delta'
      ) {
        result.postToolFirstAudioMs = Date.now() - toolResultAt;
      }
      if (event.type !== 'response.done') return;

      const output = event.response?.output ?? [];
      const calls = output.filter((item: any) => item.type === 'function_call');
      const spoken = transcript.trim();
      transcript = '';

      if (phase === 'greeting') {
        phase = 'question';
        questionStartedAt = Date.now();
        send({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: question }],
          },
        });
        send({ type: 'response.create' });
        return;
      }

      if (phase === 'question') {
        result.preToolSpeech = spoken;
        const call = calls[0];
        if (!call) {
          result.answer = spoken;
          result.error = 'no tool call';
          finish();
          return;
        }
        result.toolDecisionMs = Date.now() - questionStartedAt;
        result.tool = call.name;
        let args: unknown = {};
        try {
          args = JSON.parse(call.arguments || '{}');
        } catch {}
        result.args = args;
        const lookupStartedAt = performance.now();
        const toolResult =
          call.name === 'get_service_information'
            ? getServiceInformation(args)
            : { error: `Unexpected tool ${call.name}` };
        result.lookupMs = performance.now() - lookupStartedAt;
        phase = 'answer';
        toolResultAt = Date.now();
        send({
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id: call.call_id,
            output: JSON.stringify(toolResult),
          },
        });
        send({ type: 'response.create' });
        return;
      }

      result.answer = spoken;
      finish();
    });
    ws.on('error', (error) => {
      result.error = error.message;
      finish();
    });
  });
}

const results: ProbeResult[] = [];
for (const question of questions) results.push(await probe(question));
console.log(JSON.stringify({ model, results }, null, 2));
if (
  results.some(
    (result) =>
      result.error ||
      result.tool !== 'get_service_information' ||
      result.preToolSpeech.length > 0
  )
) {
  process.exitCode = 1;
}
