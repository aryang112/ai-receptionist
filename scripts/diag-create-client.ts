/**
 * Validate the application's exact new-client body against the tenant.
 * Default: print a redacted preview only. --try placeholder creates ONE labelled
 * test client, verifies its stored email consents, then archives that same client.
 * Never retries a create. No appointment, SMS, or phone call is requested.
 */
import 'dotenv/config';
import { env } from '../src/config/env.js';
import { buildClientCreatePayload } from '../src/services/phorest.client.js';

const args = process.argv.slice(2);
if (args.length && args.join(' ') !== '--try placeholder') {
  throw new Error('Usage: diag-create-client.ts [--try placeholder]');
}
const label = `DeleteMe-${Date.now()}`;
// Entire 202-555-01xx range is reserved for fictional numbers.
const phone = `20255501${String(Date.now() % 100).padStart(2, '0')}`;
const payload = buildClientCreatePayload({ name: `EricaDiag ${label}`, phone });
console.log(
  JSON.stringify(
    {
      mode: args.length ? 'create-verify-archive' : 'preview-only',
      payload: {
        ...payload,
        mobile: '[reserved test number]',
        email: '[placeholder email]',
        creatingBranchId: '[configured branch]',
      },
    },
    null,
    2
  )
);

if (args.length) {
  for (const key of [
    'PHOREST_BASE_URL',
    'PHOREST_API_USERNAME',
    'PHOREST_API_SECRET',
    'PHOREST_BUSINESS_ID',
    'PHOREST_BRANCH_ID',
  ] as const) {
    if (!env[key]) throw new Error(`Missing ${key}`);
  }
  const root = new URL(
    `api/business/${env.PHOREST_BUSINESS_ID}/client`,
    `${env.PHOREST_BASE_URL.replace(/\/$/, '')}/`
  );
  root.protocol = 'https:';
  const headers = {
    Authorization: `Basic ${Buffer.from(`${env.PHOREST_API_USERNAME}:${env.PHOREST_API_SECRET}`).toString('base64')}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  const request = async (url: URL, method: string, body?: unknown) => {
    const res = await fetch(url, {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok)
      throw new Error(
        `${method} client diagnostic HTTP ${res.status}; do not retry a create without reconciliation`
      );
    return res.json() as Promise<Record<string, unknown>>;
  };
  const created = await request(root, 'POST', payload);
  if (typeof created.clientId !== 'string')
    throw new Error(
      `Create response missing clientId. Find EricaDiag ${label} in Phorest; do not retry.`
    );
  const clientUrl = new URL(
    `${root.href}/${encodeURIComponent(created.clientId)}`
  );
  let verified = false;
  try {
    const stored = await request(clientUrl, 'GET');
    verified =
      stored.firstName === payload.firstName &&
      stored.lastName === payload.lastName &&
      stored.email === payload.email &&
      stored.emailMarketingConsent === false &&
      stored.emailReminderConsent === false;
    console.log(
      JSON.stringify({
        created: true,
        exactIdentityAndEmail:
          stored.email === payload.email &&
          stored.lastName === payload.lastName,
        emailMarketingConsent: stored.emailMarketingConsent,
        emailReminderConsent: stored.emailReminderConsent,
        verified,
      })
    );
  } finally {
    // Only mutate the client ID returned by THIS diagnostic's create response.
    const archived = await request(clientUrl, 'PUT', {
      ...payload,
      archived: true,
      smsMarketingConsent: false,
      smsReminderConsent: false,
    });
    const stored = await request(clientUrl, 'GET');
    console.log(JSON.stringify({ archived: stored.archived === true, label }));
    if (stored.archived !== true)
      throw new Error(`Test client archive not confirmed: EricaDiag ${label}`);
  }
  if (!verified)
    throw new Error(
      'Created client did not retain the expected consent settings'
    );
}
