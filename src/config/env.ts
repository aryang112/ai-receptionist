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
  OPENAI_REALTIME_VOICE: process.env.OPENAI_REALTIME_VOICE || 'shimmer',
  // Turn-detection / noise tuning (so background noise doesn't falsely interrupt
  // Erica). Higher threshold = needs clearer speech to trigger. Raise toward
  // 0.7–0.8 on a noisy line. noise_reduction: 'near_field' (phone) | 'far_field' | 'off'.
  OPENAI_VAD_THRESHOLD: Number(process.env.OPENAI_VAD_THRESHOLD || 0.6),
  OPENAI_VAD_SILENCE_MS: Number(process.env.OPENAI_VAD_SILENCE_MS || 500),
  OPENAI_VAD_PREFIX_MS: Number(process.env.OPENAI_VAD_PREFIX_MS || 300),
  OPENAI_NOISE_REDUCTION: process.env.OPENAI_NOISE_REDUCTION || 'near_field',
  TIMEZONE: process.env.TIMEZONE || 'America/New_York',
  USE_MOCK_PHOREST: process.env.USE_MOCK_PHOREST || 'true',

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
};
