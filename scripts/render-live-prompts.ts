// Render both prompt layers using the current public business facts and the
// warmed Phorest catalog. Run with: node --env-file=.env --import tsx scripts/render-live-prompts.ts
import { DateTime } from 'luxon';
import { env } from '../src/config/env.js';
import { phorest } from '../src/services/phorest.js';
import { buildInstructions } from '../src/realtime/twilioStream.js';
import {
  buildBackendPrompt,
  buildLivePrompt,
} from '../src/voice/livePrompts.js';

async function main() {
  const now = DateTime.now().setZone(env.TIMEZONE);
  const services = await phorest.listServices();
  const productionInstructions = buildInstructions(now, services);
  const live = buildLivePrompt(productionInstructions, services);
  const backend = buildBackendPrompt(productionInstructions, services);

  console.log(`=== LIVE PROMPT (~${Math.ceil(live.length / 4)} tokens) ===`);
  console.log(live);
  console.log(
    `=== BACKEND PROMPT (~${Math.ceil(backend.length / 4)} tokens) ===`
  );
  console.log(backend);
  console.log('=== BACKEND PROTOCOL CHECK ===');
  const protocolTerms =
    /server_vad|SILENT\/PROACTIVE|function_call|response\.create|session\.update|playback|\bVAD\b/i;
  console.log(
    `Realtime-only protocol terms: ${protocolTerms.test(backend) ? 'FOUND' : 'none'}`
  );
  console.log(`Catalog services rendered: ${services.length}`);
}

void main().catch(() => {
  console.error(
    'Unable to render prompts. Check local environment configuration and Phorest read access.'
  );
  process.exitCode = 1;
});
