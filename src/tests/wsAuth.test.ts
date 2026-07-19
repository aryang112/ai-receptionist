import { describe, it, expect, afterEach, vi } from 'vitest';
import { env } from '../config/env.js';
import {
  issueStreamToken,
  verifyStreamToken,
  assertWsAuthConfigured,
} from '../security/wsAuth.js';

// wsAuth signs/verifies with env.WS_AUTH_SECRET read at call time, so we set it
// per-test rather than depending on .env. Covers the F3 reject + fail-closed paths.
const origSecret = env.WS_AUTH_SECRET;
const origNodeEnv = env.NODE_ENV;
afterEach(() => {
  env.WS_AUTH_SECRET = origSecret;
  env.NODE_ENV = origNodeEnv;
  vi.useRealTimers();
});

describe('wsAuth — token round-trip + reject paths (F3)', () => {
  it('round-trips a valid token bound to its callSid', () => {
    env.WS_AUTH_SECRET = 'unit-test-secret';
    const token = issueStreamToken('CA1');
    expect(token).not.toBe('');
    expect(verifyStreamToken(token, 'CA1')).toBe(true);
  });

  it('rejects a malformed or tampered token', () => {
    env.WS_AUTH_SECRET = 'unit-test-secret';
    expect(verifyStreamToken('not.a.token', 'CA1')).toBe(false);
    const token = issueStreamToken('CA1');
    expect(verifyStreamToken(token + 'x', 'CA1')).toBe(false);
  });

  it('rejects a token minted for a different callSid', () => {
    env.WS_AUTH_SECRET = 'unit-test-secret';
    const token = issueStreamToken('CA1');
    expect(verifyStreamToken(token, 'CA2')).toBe(false);
  });

  it('rejects an expired token', () => {
    env.WS_AUTH_SECRET = 'unit-test-secret';
    vi.useFakeTimers();
    const token = issueStreamToken('CA1');
    vi.advanceTimersByTime((env.WS_TOKEN_TTL_SECONDS + 1) * 1000);
    expect(verifyStreamToken(token, 'CA1')).toBe(false);
  });

  it('fails CLOSED in production when the secret is empty', () => {
    env.WS_AUTH_SECRET = '';
    env.NODE_ENV = 'production';
    expect(verifyStreamToken('x.y.z', 'CA1')).toBe(false);
    expect(() => assertWsAuthConfigured()).toThrow(/WS_AUTH_SECRET/);
  });

  it('is dev-permissive (and boots) only when NOT production', () => {
    env.WS_AUTH_SECRET = '';
    env.NODE_ENV = 'test';
    expect(verifyStreamToken('anything', 'CA1')).toBe(true);
    expect(() => assertWsAuthConfigured()).not.toThrow();
  });
});
