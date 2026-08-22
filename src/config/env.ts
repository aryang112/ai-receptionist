import 'dotenv/config';

export const env = {
  PORT: Number(process.env.PORT || 5050),
  NODE_ENV: process.env.NODE_ENV || 'development',
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
  OPENAI_REALTIME_API_KEY:
    process.env.OPENAI_REALTIME_API_KEY || process.env.OPENAI_API_KEY || '',
  // GA Realtime model. The old 'gpt-4o-realtime-preview' (and the realtime beta
  // endpoint) were shut off by OpenAI in May 2026 — gpt-realtime is the GA model.
  OPENAI_REALTIME_MODEL: process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime',
  // 'cedar' / 'marin' are OpenAI's newest, most natural Realtime voices (recommended).
  // Other options: alloy, ash, ballad, coral, echo, sage, shimmer, verse.
  OPENAI_REALTIME_VOICE: process.env.OPENAI_REALTIME_VOICE || 'cedar',
  // Turn-detection / noise tuning (so background noise doesn't falsely interrupt
  // Erica). Higher threshold = needs clearer speech to trigger. Raise toward
  // 0.7–0.8 on a noisy line. noise_reduction: 'near_field' (phone) | 'far_field' | 'off'.
  OPENAI_VAD_THRESHOLD: Number(process.env.OPENAI_VAD_THRESHOLD || 0.6),
  OPENAI_VAD_SILENCE_MS: Number(process.env.OPENAI_VAD_SILENCE_MS || 700),
  OPENAI_VAD_PREFIX_MS: Number(process.env.OPENAI_VAD_PREFIX_MS || 300),
  OPENAI_NOISE_REDUCTION: process.env.OPENAI_NOISE_REDUCTION || 'near_field',
  TIMEZONE: process.env.TIMEZONE || 'America/New_York',
  USE_MOCK_PHOREST: process.env.USE_MOCK_PHOREST || 'true',

  // Phorest availability re-anchors its grid to each appointment's END, so free
  // starts come back at odd minutes (2:43, 2:58…). We snap offered times UP to
  // this clean clock grid (minutes). 15 = quarter-hours; set 30 for half-hours.
  SLOT_GRID_MIN: Number(process.env.SLOT_GRID_MIN || 15),

  // G2: silence watchdog. After this much mutual silence (neither the caller
  // nor Erica has said anything), Erica checks in once ("Are you still
  // there?"). If silence continues for SILENCE_HANGUP_MS after that check-in,
  // the call ends gracefully instead of sitting in open-ended dead air.
  SILENCE_CHECKIN_MS: Number(process.env.SILENCE_CHECKIN_MS || 20000),
  SILENCE_HANGUP_MS: Number(process.env.SILENCE_HANGUP_MS || 15000),

  // G3: hard cap on call length. At MAX_CALL_MINUTES - 60s Erica gets a
  // background-only nudge to wrap up; at MAX_CALL_MINUTES she says one
  // goodbye and the call ends via the shared hangup path — bounds Realtime
  // token spend against a chatty/malicious caller (worse under the TPM freeze).
  MAX_CALL_MINUTES: Number(process.env.MAX_CALL_MINUTES || 10),

  // Twilio
  TWILIO_NUMBER: process.env.TWILIO_NUMBER || '',
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID || '',
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN || '',

  // Phorest (real API)
  PHOREST_BASE_URL: process.env.PHOREST_BASE_URL || '',
  PHOREST_API_USERNAME: process.env.PHOREST_API_USERNAME || '',
  PHOREST_API_SECRET: process.env.PHOREST_API_SECRET || '',
  PHOREST_BUSINESS_ID: process.env.PHOREST_BUSINESS_ID || '',
  PHOREST_BRANCH_ID: process.env.PHOREST_BRANCH_ID || '',
  PHOREST_PRIMARY_STAFF_ID: process.env.PHOREST_PRIMARY_STAFF_ID || '',
  PHOREST_PREFERRED_SERVICE_IDS: (
    process.env.PHOREST_PREFERRED_SERVICE_IDS || ''
  )
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean),
  OWNER_PHONE: process.env.OWNER_PHONE || '+14433706471',

  // WebSocket auth — signed token for the Twilio media stream <-> server WS.
  // Empty secret = dev-permissive: consumers must treat "" as "skip verification
  // but warn" (never silently accept in production). TTL bounds token lifetime.
  WS_AUTH_SECRET: process.env.WS_AUTH_SECRET || '',
  WS_TOKEN_TTL_SECONDS: Number(process.env.WS_TOKEN_TTL_SECONDS || 300),

  // Rate limiting (per-IP, sliding window). /twilio/* is voice traffic (looser);
  // /api/* is the admin/data surface (stricter).
  RATE_LIMIT_WINDOW_MS: Number(process.env.RATE_LIMIT_WINDOW_MS || 60000),
  RATE_LIMIT_MAX: Number(process.env.RATE_LIMIT_MAX || 120),
  API_RATE_LIMIT_MAX: Number(process.env.API_RATE_LIMIT_MAX || 30),

  // Caller lookup cache: how long the phone->client index stays warm.
  CLIENT_INDEX_TTL_HOURS: Number(process.env.CLIENT_INDEX_TTL_HOURS || 1),

  // Phorest GET /appointment/{id} 404s on this tenant (always), so the direct
  // fetch is pure latency + a guaranteed error before we fall back to the scan.
  // Off by default; flip to 'true' only on a tenant where the direct GET works.
  PHOREST_DIRECT_GET_APPT: process.env.PHOREST_DIRECT_GET_APPT === 'true',

  // Append-only call log (JSONL) for the admin surface / auditing.
  CALL_STORE_PATH: process.env.CALL_STORE_PATH || './data/calls.jsonl',
};
