// Read-only scenario sweep. Drives the REAL handlers against REAL Phorest
// reads. No writes, no calls. Scenarios are drawn from the production issue
// register (docs/PRODUCTION_ISSUES_AND_GPT_LIVE_2026-09-12.md) plus the call
// patterns seen Sept 7-15.
import 'dotenv/config';
import WebSocket from 'ws';
import { TwilioRealtimeCall } from '../src/realtime/twilioStream.js';

function call() {
  const socket: any = {
    readyState: WebSocket.OPEN,
    send: () => {},
    close: () => {},
    on: () => {},
  };
  const c: any = new TwilioRealtimeCall(socket);
  c.session = {
    appendTwilioAudio: () => {},
    truncateActiveResponse: () => {},
    close: () => {},
  };
  c.streamSid = 'S_scn';
  c.callSid = 'CA_scn';
  return c;
}
const short = (v: any) => (v == null ? '—' : String(v).slice(0, 150));

async function avail(
  label: string,
  serviceName: string,
  date: string,
  preferredTime?: string
) {
  const r = await call().handleSuggestAvailability({
    serviceName,
    date,
    ...(preferredTime ? { preferredTime } : {}),
    searchNearby: true,
  });
  const verdict = r.notOffered
    ? `notOffered → closest: ${(r.closest ?? []).join(', ')}`
    : r.ambiguous
      ? `ambiguous → ${JSON.stringify(r.ambiguous).slice(0, 140)}`
      : `service="${r.service}"  times=${
          (r.slots ?? [])
            .map((s: any) => s.time)
            .slice(0, 4)
            .join(', ') || 'none'
        }${r.alternativeDates ? `  nearby=${r.alternativeDates.length}d` : ''}`;
  console.log(
    `\n▸ ${label}\n  asked: "${serviceName}"${preferredTime ? ` @ ${preferredTime}` : ''} on ${date}\n  → ${verdict}`
  );
  if (r.note) console.log(`  coaching: ${short(r.note)}`);
  return r;
}

async function price(label: string, serviceName: string) {
  const r = await call().handleGetPrices({ serviceName });
  console.log(
    `\n▸ ${label}\n  asked: "${serviceName}"\n  → ${short(JSON.stringify(r.match ?? r.matches ?? r.candidates ?? r))}`
  );
  if (r.note) console.log(`  coaching: ${short(r.note)}`);
}

(async () => {
  const TOMORROW = process.argv[2] ?? '2026-09-16';
  const SUNDAY = '2026-09-20';

  console.log('════ SERVICE UNDERSTANDING ════');
  await avail(
    '05 — threading+lip phrase read as a STAFF NAME (Sept 10, still open in register)',
    'eyebrow threading and upper lip',
    TOMORROW
  );
  await avail(
    'O06b — "brow and lip" must NOT silently become wax (2026-09-16 resolver fix)',
    'brow and lip',
    TOMORROW
  );
  await avail(
    '2026-09-16 — "brow threading and upper lip" resolves to the 2-service bundle',
    'brow threading and upper lip',
    TOMORROW
  );
  await avail(
    '2026-09-16 — "upper lip threading" resolves to Lip Threading, not notOffered',
    'upper lip threading',
    TOMORROW
  );
  await avail('01 — a person is not a service', 'Richa', TOMORROW);
  await avail(
    '03 — caller wording vs catalog name',
    'eyebrow threading',
    TOMORROW
  );
  await avail(
    'O06 — "henna brows" must NOT silently become Brow Threading',
    'henna brows',
    TOMORROW
  );
  await avail(
    '07 — full treatment vs touch-up',
    'microblading touch-up',
    TOMORROW
  );
  await avail(
    '06 — eyebrow tattoo → full micro blading/shading',
    'eyebrow tattoo',
    TOMORROW
  );
  await avail(
    'unknown service — must never say "not in our system"',
    'microneedling',
    TOMORROW
  );
  await avail('ambiguous family', 'wax', TOMORROW);

  console.log('\n════ TIME & DATE HANDLING ════');
  await avail(
    '11 — a broad preference must survive',
    'brow threading',
    TOMORROW,
    '16:00'
  );
  await avail('R13 — right at closing time', 'lash lift', TOMORROW, '18:45');
  await avail(
    'closed day (Sunday) — must say CLOSED, never "fully booked"',
    'brow threading',
    SUNDAY
  );

  console.log('\n════ PRICING ════');
  await price('price for a bundle phrase', 'brow threading and upper lip');
  await price('price for an unknown service', 'microneedling');
})().catch((e) => {
  console.error('ERR', e?.message ?? e);
  process.exit(1);
});
