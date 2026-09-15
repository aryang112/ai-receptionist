import 'dotenv/config';
import WebSocket from 'ws';
import { phorest } from '../src/services/phorest.js';
import { TwilioRealtimeCall } from '../src/realtime/twilioStream.js';

function buildCall() {
  const socket: any = { readyState: WebSocket.OPEN, send: () => {}, close: () => {}, on: () => {} };
  const call: any = new TwilioRealtimeCall(socket);
  call.session = { appendTwilioAudio: () => {}, truncateActiveResponse: () => {}, close: () => {} };
  call.streamSid = 'S_sim';
  call.callSid = 'CA_sim';
  return call;
}

(async () => {
  const DATE = process.argv[2] ?? '2026-09-15';
  const raw = await phorest.getAvailability('WvM2CmPz9vrPXELZkCKxww', DATE);
  const rawHHmm = raw.map((s) => s.slice(11, 16));
  console.log(`\nPHOREST SAYS IS FREE (${rawHHmm.length}):\n  ${rawHHmm.join(' ')}`);

  const plain = await buildCall().handleSuggestAvailability({ serviceName: 'Brow Threading', date: DATE });
  console.log(`\n1. NORMAL ASK ("do you have anything tomorrow?")`);
  console.log('   Erica offers:', plain.slots.map((s: any) => s.time).join('  |  '));
  console.log('   squeeze-in framing present:', /fit the caller in/.test(plain.note ?? ''));

  const exact = await buildCall().handleSuggestAvailability({ serviceName: 'Brow Threading', date: DATE, preferredTime: '18:10' });
  console.log(`\n2. CALLER ASKS FOR 6:10 PM (an off-grid time)`);
  console.log('   Erica offers:', exact.slots.map((s: any) => s.time).join('  |  '));

  const busy = await buildCall().handleSuggestAvailability({ serviceName: 'Brow Threading', date: DATE, preferredTime: '17:30' });
  console.log(`\n3. CALLER ASKS FOR 5:30 PM (the Loretta slot — genuinely taken)`);
  console.log('   Erica offers:', busy.slots.map((s: any) => s.time).join('  |  '));
  console.log('   offers 5:30 itself?', busy.slots.some((s: any) => s.value === '17:30'));

  const all = [...plain.slots, ...exact.slots, ...busy.slots].map((s: any) => s.value);
  const invented = all.filter((v) => !rawHHmm.includes(v));
  console.log(`\nINVENTED TIMES ACROSS ALL THREE: ${invented.length ? invented.join(', ') : 'none ✅'}`);
})().catch((e) => { console.error('ERR', e?.message ?? e); process.exit(1); });
