/**
 * diag-create-client.ts — reproduce the Phorest `EMAIL_REQUIRED` client-create
 * failure (prod 2026-09-07 1:03 PM ET, and the same double book_appointment
 * failure on 2026-08-27 6:13 PM ET).
 *
 * Production sends POST /client with a PLACEHOLDER email
 * (`<digits>@placeholder.richasthreading.com`, see createClient in
 * src/services/phorest.client.ts) and Phorest answers
 * 400 {"errorCode":"EMAIL_REQUIRED","detail":"Email is Required"}.
 * This script isolates WHICH part Phorest rejects.
 *
 * Read-only by default: with no args it only prints the payload variants.
 * Each `--try` WRITES one clearly-labelled test client to the live tenant
 * (firstName "EricaDiag", lastName "DeleteMe-<ts>") — delete them in Phorest
 * afterwards.
 *
 *   npx tsx scripts/diag-create-client.ts                 # print only
 *   npx tsx scripts/diag-create-client.ts --try placeholder   # exactly what prod sends
 *   npx tsx scripts/diag-create-client.ts --try none          # no email field at all
 *   npx tsx scripts/diag-create-client.ts --try real          # real-looking mailbox on a real domain
 *   npx tsx scripts/diag-create-client.ts --try nomobile      # placeholder email, no mobile
 */
import 'dotenv/config';

const variant = process.argv.includes('--try')
  ? process.argv[process.argv.indexOf('--try') + 1]
  : undefined;

const base = (process.env.PHOREST_BASE_URL || '').trim().replace(/\/?$/, '/');
const businessId = process.env.PHOREST_BUSINESS_ID || '';
const branchId = process.env.PHOREST_BRANCH_ID || '';
const user = process.env.PHOREST_API_USERNAME || '';
const secret = process.env.PHOREST_API_SECRET || '';

if (!base || !businessId || !branchId || !user || !secret) {
  console.error(
    'Missing PHOREST_BASE_URL / PHOREST_BUSINESS_ID / PHOREST_BRANCH_ID / PHOREST_API_USERNAME / PHOREST_API_SECRET in .env'
  );
  process.exit(1);
}

const ts = Date.now();
// A fake-but-well-formed test number (555-01xx block is reserved, never dialable).
const mobile = `4105550${String(ts).slice(-3)}`;
const common = {
  firstName: 'EricaDiag',
  lastName: `DeleteMe-${ts}`,
  creatingBranchId: branchId,
};

const variants: Record<string, Record<string, unknown>> = {
  placeholder: {
    ...common,
    email: `${mobile}@placeholder.richasthreading.com`,
    mobile,
  },
  none: { ...common, mobile },
  real: { ...common, email: `erica.diag.${ts}@gmail.com`, mobile },
  nomobile: { ...common, email: `${ts}@placeholder.richasthreading.com` },
};

if (!variant) {
  console.log(
    'Payload variants (nothing sent — pass --try <name> to POST one):'
  );
  for (const [name, body] of Object.entries(variants)) {
    console.log(`\n[${name}]`, JSON.stringify(body, null, 2));
  }
  process.exit(0);
}

const body = variants[variant];
if (!body) {
  console.error(
    `Unknown variant "${variant}". One of: ${Object.keys(variants).join(', ')}`
  );
  process.exit(1);
}

(async () => {
  const url = new URL(`api/business/${businessId}/client`, base);
  console.log(`POST ${url}\n${JSON.stringify(body, null, 2)}\n`);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Basic ${Buffer.from(`${user}:${secret}`).toString('base64')}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  console.log(`HTTP ${res.status}`);
  console.log(text.slice(0, 1000));
  if (res.ok) {
    console.log(
      `\n✅ Phorest ACCEPTED variant "${variant}". Delete client "EricaDiag DeleteMe-${ts}" in Phorest.`
    );
  } else {
    console.log(`\n❌ Phorest REJECTED variant "${variant}".`);
  }
})().catch((err) => {
  console.error('Request failed:', err);
  process.exit(1);
});
