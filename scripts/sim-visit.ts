import 'dotenv/config';
import WebSocket from 'ws';
import { phorest } from '../src/services/phorest.js';
import { TwilioRealtimeCall } from '../src/realtime/twilioStream.js';

function buildCall() {
  const socket: any = { readyState: WebSocket.OPEN, send: () => {}, close: () => {}, on: () => {} };
  const call: any = new TwilioRealtimeCall(socket);
  call.session = { appendTwilioAudio: () => {}, truncateActiveResponse: () => {}, close: () => {} };
  call.streamSid = 'S_sim';
  call.callSid = 'CA_sim_visit';
  return call;
}

(async () => {
  const DATE = process.argv[2] ?? '2026-09-16';
  const CLIENT = 'cZnmhQAdjNMKRauaLNjh0w'; // the owner's own record
  const call = buildCall();

  const listed = await call.handleListAppointments({ clientId: CLIENT });
  console.log('\n--- WHAT ERICA IS TOLD ABOUT THE ACCOUNT ---');
  for (const a of listed.appointments) console.log(`   ${a.date}  ${a.time}  ${a.service}`);
  console.log('\n   coaching:', listed.note);

  const sameDay = listed.appointments.filter((a: any) => a.date === listed.appointments[0]?.date);
  if (sameDay.length < 2) {
    console.log('\n(only one appointment in the soonest sitting — nothing to plan)');
    return;
  }
  const ids = sameDay.map((a: any) => a.appointmentId);

  const plan = await call.handleRescheduleVisit({
    appointmentIds: ids,
    date: sameDay[0].date,
    preferredTime: process.argv[3] ?? '17:30',
  });
  console.log('\n--- THE PLAN (nothing written) ---');
  if (!plan.planned) { console.log('   ', plan.note ?? plan.error); return; }
  for (const [i, opt] of plan.options.entries()) {
    console.log(`   option ${i + 1}: ` + opt.items.map((it: any) => `${it.service} ${it.time}`).join('  →  '));
  }
  console.log('\n   coaching:', plan.note);

  const raw = await phorest.getAvailability('WvM2CmPz9vrPXELZkCKxww', sameDay[0].date);
  const rawHHmm = raw.map((s: string) => s.slice(11, 16));
  const used = plan.options.flatMap((o: any) => o.items.map((it: any) =>
    new Date(`2000-01-01 ${it.time}`).toTimeString().slice(0, 5)));
  const invented = used.filter((t: string) => !rawHHmm.includes(t));
  console.log('\n   invented times:', invented.length ? invented.join(', ') : 'none ✅');
})().catch((e) => { console.error('ERR', e?.message ?? e); process.exit(1); });
