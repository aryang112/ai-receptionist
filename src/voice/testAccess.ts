import { env, isVoiceTestMode } from '../config/env.js';
const normalize = (value: string) => value.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
/** Explicit owner test numbers only; an empty list rejects every test call. */
export function allowedTestCaller(phone: string | undefined): boolean {
  if (!phone) return false;
  const number = normalize(phone);
  return number.length === 10 && env.VOICE_TEST_ALLOWED_PHONES.split(',').some((p) => normalize(p) === number);
}
/** The Twilio signature validates the webhook before this mapping is used. */
export function testCallerIdentity(body: Record<string, unknown> | undefined): string {
  const from = String(body?.From ?? '');
  const to = String(body?.To ?? '');
  return isVoiceTestMode() && body?.Direction === 'outbound-api' && allowedTestCaller(to) ? to : from;
}
