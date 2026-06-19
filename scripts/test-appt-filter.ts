import 'dotenv/config';

// Does /appointment filter by client? Test clientId (camel) vs client_id (snake),
// and dump one raw appointment to see if it even carries a clientId field.
const BASE = (process.env.PHOREST_BASE_URL || '').replace(/\/$/, '');
const BID = process.env.PHOREST_BUSINESS_ID || '';
const BRANCH = process.env.PHOREST_BRANCH_ID || '';
const AUTH =
  'Basic ' +
  Buffer.from(`${process.env.PHOREST_API_USERNAME}:${process.env.PHOREST_API_SECRET}`).toString('base64');

const CLIENT = process.argv[2] || 'Y3JkIE3Ft893xv3Su3tZMw'; // Shalu
const FROM = '2026-06-19';
const TO = '2026-07-15';

async function api(path: string): Promise<any> {
  const res = await fetch(`${BASE}/${path}`, { headers: { Authorization: AUTH, Accept: 'application/json' } });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

async function count(param: string) {
  const r = await api(
    `api/business/${BID}/branch/${BRANCH}/appointment?${param}=${encodeURIComponent(CLIENT)}&from_date=${FROM}&to_date=${TO}&size=50`
  );
  const appts = r._embedded?.appointments ?? [];
  return appts;
}

async function main() {
  const camel = await count('clientId');
  const snake = await count('client_id');
  console.log(`clientId= (camel) -> ${camel.length} appointments`);
  console.log(`client_id= (snake) -> ${snake.length} appointments`);
  console.log('');
  console.log('Distinct clientIds present in the camel result (if the field exists):');
  const ids = new Set(camel.map((a: any) => a.clientId));
  console.log('  ', [...ids]);
  console.log('');
  console.log('Raw keys on first appointment:', camel[0] ? Object.keys(camel[0]) : '(none)');
  console.log('First appointment (raw):', JSON.stringify(camel[0], null, 2)?.slice(0, 600));
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
