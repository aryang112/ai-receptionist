// Run only when the tester is ready to answer. Never changes the incoming webhook.
import 'dotenv/config';
import twilio from 'twilio';
const to = process.argv[2];
if (!to || !/^\+1\d{10}$/.test(to))
  throw new Error(
    'Supply your approved test phone: node scripts/gpt-live/owner-call.mjs +1XXXXXXXXXX'
  );
const base =
  process.env.VOICE_TEST_URL || 'https://erica-production-f2e2.up.railway.app';
const response = await fetch(`${base}/admin/voice-test`, {
  headers: { Authorization: `Bearer ${process.env.ADMIN_TOKEN}` },
});
if (!response.ok)
  throw new Error(`Cannot verify hosted test mode: ${response.status}`);
const status = await response.json();
if (
  !status.enabled ||
  status.writes !== 'simulate' ||
  status.ownerNotifications !== 'simulate' ||
  status.activeCalls !== 0
)
  throw new Error('Server is not idle in safe test mode. No call placed.');
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);
const call = await client.calls.create({
  to,
  from: process.env.TWILIO_NUMBER,
  url: `${base}/twilio/voice`,
  method: 'POST',
  timeLimit: 600,
});
console.log(
  JSON.stringify({
    callSid: call.sid,
    testerLast4: to.slice(-4),
    engine: status.engine,
    backendModel: status.backendModel,
    status: call.status,
  })
);
