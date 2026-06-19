import 'dotenv/config';

// Read-only: list every service in the Phorest catalog (active + archived),
// showing the exact names the booking fuzzy-matcher keys off.
// Usage: npx tsx scripts/list-services.ts

const BASE = (process.env.PHOREST_BASE_URL || '').replace(/\/$/, '');
const BID = process.env.PHOREST_BUSINESS_ID || '';
const BRANCH = process.env.PHOREST_BRANCH_ID || '';
const AUTH =
  'Basic ' +
  Buffer.from(`${process.env.PHOREST_API_USERNAME}:${process.env.PHOREST_API_SECRET}`).toString('base64');

async function api(path: string): Promise<any> {
  const res = await fetch(`${BASE}/${path}`, {
    headers: { Authorization: AUTH, Accept: 'application/json' },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

async function main() {
  const all: any[] = [];
  let page = 0;
  while (true) {
    const r = await api(`api/business/${BID}/branch/${BRANCH}/service?size=100&page=${page}`);
    const services = r._embedded?.services ?? [];
    all.push(...services);
    const totalPages = r.page?.totalPages ?? 1;
    if (page >= totalPages - 1) break;
    page += 1;
  }

  const active = all.filter((s) => !s.archived);
  const archived = all.filter((s) => s.archived);

  const fmt = (s: any) => {
    const effective = s.internetName || s.name; // what the AI matches against
    const price = typeof s.price === 'number' ? `$${s.price}` : '—';
    const dur = typeof s.duration === 'number' ? `${s.duration}m` : '—';
    const alias = s.internetName && s.internetName !== s.name ? `  (internetName: "${s.internetName}")` : '';
    return `  • ${effective}  [${price}, ${dur}]${alias}${s.archived ? '  [ARCHIVED]' : ''}`;
  };

  console.log(`\n=== ACTIVE services (${active.length}) — these are bookable ===`);
  active
    .map((s) => ({ s, key: (s.internetName || s.name || '').toLowerCase() }))
    .sort((a, b) => a.key.localeCompare(b.key))
    .forEach(({ s }) => console.log(fmt(s)));

  console.log(`\n=== ARCHIVED services (${archived.length}) — NOT bookable ===`);
  archived
    .map((s) => ({ s, key: (s.internetName || s.name || '').toLowerCase() }))
    .sort((a, b) => a.key.localeCompare(b.key))
    .forEach(({ s }) => console.log(fmt(s)));

  const lash = all.filter((s) =>
    `${s.name} ${s.internetName || ''}`.toLowerCase().match(/lash|lift|laminat/)
  );
  console.log(`\n=== LASH / LIFT / LAMINATION matches (${lash.length}) ===`);
  if (!lash.length) console.log('  (none found)');
  lash.forEach((s) => console.log(fmt(s)));
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
