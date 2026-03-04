import 'dotenv/config';

export const env = {
  PORT: Number(process.env.PORT || 5050),
  NODE_ENV: process.env.NODE_ENV || 'development',
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
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
  PHOREST_BRANCH_ID: process.env.PHOREST_BRANCH_ID || 'BhmcJWTC1BWLuHLwzzZR6w'
};
