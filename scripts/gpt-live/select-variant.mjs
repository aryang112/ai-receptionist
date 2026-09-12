import 'dotenv/config';
const variant = process.argv[2];
if (variant && !['terra', 'luna', 'realtime'].includes(variant))
  throw new Error(
    'Usage: node scripts/gpt-live/select-variant.mjs [terra|luna|realtime]'
  );
const base =
  process.env.VOICE_TEST_URL || 'https://erica-production-f2e2.up.railway.app';
if (!process.env.ADMIN_TOKEN) throw new Error('ADMIN_TOKEN is required');
const response = await fetch(
  `${base}/admin/voice-test${variant ? '/variant' : ''}`,
  {
    method: variant ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${process.env.ADMIN_TOKEN}`,
      'Content-Type': 'application/json',
    },
    ...(variant ? { body: JSON.stringify({ variant }) } : {}),
  }
);
const result = await response.json();
console.log(JSON.stringify(result, null, 2));
if (!response.ok) process.exitCode = 1;
