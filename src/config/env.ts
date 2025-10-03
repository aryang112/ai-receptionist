import 'dotenv/config';

export const env = {
  PORT: Number(process.env.PORT || 5050),
  NODE_ENV: process.env.NODE_ENV || 'development',
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
  TIMEZONE: process.env.TIMEZONE || 'America/New_York',
  USE_MOCK_PHOREST: process.env.USE_MOCK_PHOREST || 'true'

};
