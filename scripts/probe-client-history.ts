// Read-only Phorest diagnostic: what service-history signals exist for a client?
// Run: node --env-file=.env --import tsx scripts/probe-client-history.ts
// Prints the raw client fields (phone/email redacted) and 120 days of past
// appointments in 30-day windows (Phorest caps a range at 31 days).

import { DateTime } from 'luxon';
const BASE = (process.env.PHOREST_BASE_URL || '').replace(/\/$/, '');
const BID = process.env.PHOREST_BUSINESS_ID || '';
const BRANCH = process.env.PHOREST_BRANCH_ID || '';
const TZ = process.env.TIMEZONE || 'America/New_York';
const AUTH = 'Basic ' + Buffer.from(`${process.env.PHOREST_API_USERNAME}:${process.env.PHOREST_API_SECRET}`).toString('base64');
async function api(path: string): Promise<any> {
  const res = await fetch(`${BASE}/${path}`, { headers: { Authorization: AUTH, Accept: 'application/json' } });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}
async function main() {
  const c = await api(`api/business/${BID}/client?firstName=Aryan&lastName=Gupta&size=5`);
  const clients = c._embedded?.clients ?? [];
  console.log('clients:', clients.length);
  for (const cl of clients) {
    const redacted = { ...cl, mobile: cl.mobile ? '***' + String(cl.mobile).slice(-4) : undefined, email: cl.email ? '***' : undefined, landLine: undefined };
    console.log('RAW CLIENT FIELDS:', Object.keys(cl).join(', '));
    console.log(JSON.stringify(redacted, null, 1).slice(0, 1500));
    // try direct client GET for richer fields
    try { const one = await api(`api/business/${BID}/client/${cl.clientId}`); console.log('DIRECT CLIENT GET keys:', Object.keys(one).join(', ')); } catch (e) { console.log('direct client GET failed', String(e).slice(0,120)); }
    const now = DateTime.now().setZone(TZ);
    const all: any[] = [];
    for (let i = 0; i < 4; i++) {
      const to = now.minus({ days: 30 * i }).toISODate();
      const from = now.minus({ days: 30 * (i + 1) }).toISODate();
      const r = await api(`api/business/${BID}/branch/${BRANCH}/appointment?client_id=${encodeURIComponent(cl.clientId)}&from_date=${from}&to_date=${to}&size=50`);
      all.push(...(r._embedded?.appointments ?? []));
    }
    console.log(`past-120d appointments (raw): ${all.length}`);
    if (all[0]) console.log('APPT FIELDS:', Object.keys(all[0]).join(', '));
    const counts: Record<string, number> = {};
    for (const a of all) { const k = `${a.state}/${a.activationState}`; counts[k] = (counts[k] || 0) + 1; }
    console.log('state counts:', counts);
    for (const a of all.slice(0, 12)) console.log(`  ${a.appointmentDate} ${a.startTime} ${a.serviceName} state=${a.state} act=${a.activationState} staff=${a.staffId?.slice(0,6)}`);
    break;
  }
  // also: does the appointment endpoint accept client_id with a big past range? (31-day cap check)
  try { await api(`api/business/${BID}/branch/${BRANCH}/appointment?client_id=x&from_date=2026-05-01&to_date=2026-08-01&size=1`); console.log('90-day range accepted'); } catch (e) { console.log('90-day range:', String(e).slice(0, 160)); }
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
