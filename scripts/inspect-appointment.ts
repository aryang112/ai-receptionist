import 'dotenv/config';
import { DateTime } from 'luxon';

// Read-only Phorest diagnostic: where did an appointment land (state + time)?
// Usage: npx tsx scripts/inspect-appointment.ts [appointmentId] [firstName] [lastName]

const BASE = (process.env.PHOREST_BASE_URL || '').replace(/\/$/, '');
const BID = process.env.PHOREST_BUSINESS_ID || '';
const BRANCH = process.env.PHOREST_BRANCH_ID || '';
const TZ = process.env.TIMEZONE || 'America/New_York';
const AUTH =
  'Basic ' +
  Buffer.from(`${process.env.PHOREST_API_USERNAME}:${process.env.PHOREST_API_SECRET}`).toString('base64');

const apptId = process.argv[2] || 'c20q0se_UkEMbvXkOYu4OA';
const firstName = process.argv[3] || 'Aryan';
const lastName = process.argv[4] || 'Gupta';

async function api(path: string): Promise<any> {
  const res = await fetch(`${BASE}/${path}`, {
    headers: { Authorization: AUTH, Accept: 'application/json' },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

function showAppt(a: any, label: string) {
  const asUtc = DateTime.fromISO(`${a.appointmentDate}T${a.startTime}`, { zone: 'utc' }).setZone(TZ);
  const asLocal = DateTime.fromISO(`${a.appointmentDate}T${a.startTime}`, { zone: TZ });
  console.log(`  [${label}] id=${a.appointmentId}`);
  console.log(`     state=${a.state}  activationState=${a.activationState}  confirmed=${a.confirmed}  service=${a.serviceName}`);
  console.log(`     stored: date=${a.appointmentDate} start=${a.startTime} end=${a.endTime}`);
  console.log(`     if stored value is UTC  -> ${asUtc.toFormat('ccc MMM d, h:mm a')} ${TZ}`);
  console.log(`     if stored value is LOCAL-> ${asLocal.toFormat('ccc MMM d, h:mm a')} ${TZ}`);
}

async function main() {
  console.log(`Base=${BASE}\n`);

  // 1) Direct GET by appointment id
  try {
    const a = await api(`api/business/${BID}/branch/${BRANCH}/appointment/${apptId}`);
    console.log('Direct GET /appointment/{id}:');
    if (a && a.appointmentId) showAppt(a, 'direct');
    else console.log('  (no appointmentId in response)', JSON.stringify(a).slice(0, 300));
  } catch (e) {
    console.log('Direct GET /appointment/{id} FAILED:', String(e));
  }
  console.log('');

  // 2) By client name -> appointments in a wide window, NO state filter
  try {
    const c = await api(
      `api/business/${BID}/client?firstName=${encodeURIComponent(firstName)}&lastName=${encodeURIComponent(lastName)}&size=10`
    );
    const clients = c._embedded?.clients ?? [];
    console.log(`Clients matching ${firstName} ${lastName}: ${clients.length}`);
    const today = DateTime.now().setZone(TZ).toISODate();
    const to = DateTime.now().setZone(TZ).plus({ days: 14 }).toISODate();
    for (const cl of clients) {
      console.log(`  clientId=${cl.clientId} mobile=${cl.mobile}`);
      const r = await api(
        `api/business/${BID}/branch/${BRANCH}/appointment?clientId=${encodeURIComponent(cl.clientId)}&from_date=${today}&to_date=${to}&size=50`
      );
      const appts = r._embedded?.appointments ?? [];
      console.log(`    appointments in next 14 days (raw, no state filter): ${appts.length}`);
      for (const a of appts) showAppt(a, 'by-client');
    }
  } catch (e) {
    console.log('Client/appointment query FAILED:', String(e));
  }
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
