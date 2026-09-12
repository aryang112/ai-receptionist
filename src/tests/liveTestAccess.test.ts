import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from '../config/env.js';
import { allowedTestCaller, testCallerIdentity } from '../voice/testAccess.js';
afterEach(() => vi.restoreAllMocks());
describe('owner taste-test caller boundary', () => {
  it('rejects absent, malformed and unlisted numbers, including empty configuration', () => {
    const before = env.VOICE_TEST_ALLOWED_PHONES;
    try {
      env.VOICE_TEST_ALLOWED_PHONES = '';
      expect(allowedTestCaller('2025550198')).toBe(false);
      env.VOICE_TEST_ALLOWED_PHONES = '+1 (202) 555-0198';
      expect(allowedTestCaller('2025550198')).toBe(true);
      expect(allowedTestCaller('2025550199')).toBe(false);
      expect(allowedTestCaller(undefined)).toBe(false);
      expect(allowedTestCaller('5550198')).toBe(false);
    } finally {
      env.VOICE_TEST_ALLOWED_PHONES = before;
    }
  });
  it('uses outbound recipient only for a simulated, allowed outbound-api call', () => {
    const previous = {
      mode: env.PHOREST_WRITE_MODE,
      allowed: env.VOICE_TEST_ALLOWED_PHONES,
    };
    try {
      env.PHOREST_WRITE_MODE = 'simulate';
      env.VOICE_TEST_ALLOWED_PHONES = '2025550198';
      const body = {
        From: '+12025550199',
        To: '+12025550198',
        Direction: 'outbound-api',
      };
      expect(testCallerIdentity(body)).toBe(body.To);
      expect(testCallerIdentity({ ...body, Direction: 'inbound' })).toBe(
        body.From
      );
      expect(testCallerIdentity({ ...body, To: '+12025550197' })).toBe(
        body.From
      );
      env.PHOREST_WRITE_MODE = 'real';
      expect(testCallerIdentity(body)).toBe(body.From);
    } finally {
      env.PHOREST_WRITE_MODE = previous.mode;
      env.VOICE_TEST_ALLOWED_PHONES = previous.allowed;
    }
  });
});
