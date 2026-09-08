import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';

// M4: extraction target. Mirrors twilioStream.recording.test.ts's
// `vi.mock('twilio', ...)` pattern so getTwilioClient() (module-scope,
// memoized in ownerSms.ts's own `_twilioClient`) returns a fully-
// controllable fake instead of hitting a real Twilio client built from this
// repo's live .env credentials.
const messagesCreateMock = vi.fn();
const twilioClientMock = { messages: { create: messagesCreateMock } };
const twilioFactoryMock = vi.fn(() => twilioClientMock);
vi.mock('twilio', () => ({ default: twilioFactoryMock }));

let sendOwnerSms: typeof import('../services/ownerSms.js').sendOwnerSms;
let OWNER_SMS_TIMEOUT_MS: typeof import('../services/ownerSms.js').OWNER_SMS_TIMEOUT_MS;
let env: typeof import('../config/env.js').env;
let logger: typeof import('../core/logger.js').logger;

beforeAll(async () => {
  ({ sendOwnerSms, OWNER_SMS_TIMEOUT_MS } = await import(
    '../services/ownerSms.js'
  ));
  ({ env } = await import('../config/env.js'));
  ({ logger } = await import('../core/logger.js'));
});

describe('sendOwnerSms (M4 extraction from twilioStream.notifyOwnerSms)', () => {
  let origSid: string;
  let origToken: string;
  let origNumber: string;
  let origOwnerPhone: string;

  beforeAll(() => {
    origSid = env.TWILIO_ACCOUNT_SID;
    origToken = env.TWILIO_AUTH_TOKEN;
    origNumber = env.TWILIO_NUMBER;
    origOwnerPhone = env.OWNER_PHONE;
  });

  beforeEach(() => {
    env.TWILIO_ACCOUNT_SID = 'AC_test_sid';
    env.TWILIO_AUTH_TOKEN = 'test_auth_token';
    env.TWILIO_NUMBER = '+14105551111';
    env.OWNER_PHONE = '+14433706471';
    messagesCreateMock.mockReset();
    twilioFactoryMock.mockClear();
  });

  afterEach(() => {
    env.TWILIO_ACCOUNT_SID = origSid;
    env.TWILIO_AUTH_TOKEN = origToken;
    env.TWILIO_NUMBER = origNumber;
    env.OWNER_PHONE = origOwnerPhone;
  });

  it('sends from TWILIO_NUMBER to OWNER_PHONE by default', async () => {
    messagesCreateMock.mockResolvedValueOnce({
      sid: 'SMxxx',
      status: 'queued',
    });

    const result = await sendOwnerSms('hello Richa');

    expect(messagesCreateMock).toHaveBeenCalledTimes(1);
    expect(messagesCreateMock).toHaveBeenCalledWith({
      body: 'hello Richa',
      from: '+14105551111',
      to: '+14433706471',
    });
    expect(result).toEqual({
      queued: true,
      sid: 'SMxxx',
      status: 'queued',
    });
    expect(twilioFactoryMock).toHaveBeenCalledWith(
      'AC_test_sid',
      'test_auth_token',
      { timeout: OWNER_SMS_TIMEOUT_MS }
    );
  });

  it.each([
    'accepted',
    'queued',
    'sending',
    'sent',
    'scheduled',
    'delivered',
    'partially_delivered',
  ])('accepts Twilio status %s for delivery', async (status) => {
    messagesCreateMock.mockResolvedValueOnce({ sid: 'SMok', status });

    await expect(sendOwnerSms('hi')).resolves.toEqual({
      queued: true,
      sid: 'SMok',
      status,
    });
  });

  it.each(['failed', 'undelivered', 'canceled'])(
    'rejects terminal Twilio status %s',
    async (status) => {
      messagesCreateMock.mockResolvedValueOnce({ sid: 'SMbad', status });
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

      await expect(sendOwnerSms('hi')).resolves.toEqual({
        queued: false,
        reason: 'terminal_failure',
        status,
      });
      warnSpy.mockRestore();
    }
  );

  it('treats a missing SID as uncertain', async () => {
    messagesCreateMock.mockResolvedValueOnce({ status: 'queued' });
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    await expect(sendOwnerSms('hi')).resolves.toEqual({
      queued: false,
      reason: 'uncertain',
      status: 'queued',
    });
    warnSpy.mockRestore();
  });

  it('returns uncertain within the short cap when Twilio never settles', async () => {
    vi.useFakeTimers();
    messagesCreateMock.mockImplementationOnce(() => new Promise(() => {}));
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const pending = sendOwnerSms('hi');
      await vi.advanceTimersByTimeAsync(OWNER_SMS_TIMEOUT_MS);
      await expect(pending).resolves.toEqual({
        queued: false,
        reason: 'uncertain',
      });
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('an explicit `to` overrides OWNER_PHONE (DIGEST_TO multi-recipient case)', async () => {
    messagesCreateMock.mockResolvedValueOnce({
      sid: 'SMyyy',
      status: 'queued',
    });

    await sendOwnerSms('digest text', '+14105559999');

    expect(messagesCreateMock).toHaveBeenCalledWith({
      body: 'digest text',
      from: '+14105551111',
      to: '+14105559999',
    });
  });

  it('never throws when Twilio is not configured (missing creds) — skips with a warn', async () => {
    // getTwilioClient()'s `_twilioClient` is memoized at module scope (same
    // as twilioStream.ts's own client), so a prior test in this file having
    // already built a real client means just clearing env here wouldn't
    // un-memoize it. Force a fresh module instance with empty creds instead
    // — same technique twilioStream.recording.test.ts uses for its "no
    // client" case.
    const savedSid = process.env.TWILIO_ACCOUNT_SID;
    const savedToken = process.env.TWILIO_AUTH_TOKEN;
    process.env.TWILIO_ACCOUNT_SID = '';
    process.env.TWILIO_AUTH_TOKEN = '';
    vi.resetModules();
    try {
      const { sendOwnerSms: freshSend } = await import(
        '../services/ownerSms.js'
      );
      const { env: freshEnv } = await import('../config/env.js');
      const { logger: freshLogger } = await import('../core/logger.js');
      expect(freshEnv.TWILIO_ACCOUNT_SID).toBe('');
      const warnSpy = vi
        .spyOn(freshLogger, 'warn')
        .mockImplementation(() => {});

      await expect(freshSend('hi')).resolves.toEqual({
        queued: false,
        reason: 'not_configured',
      });
      expect(twilioFactoryMock).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ tool: 'owner_sms' }),
        'Owner SMS skipped — Twilio not configured'
      );
      warnSpy.mockRestore();
    } finally {
      process.env.TWILIO_ACCOUNT_SID = savedSid;
      process.env.TWILIO_AUTH_TOKEN = savedToken;
      vi.resetModules();
    }
  });

  it('never throws when the Twilio API call rejects — warns instead', async () => {
    messagesCreateMock.mockRejectedValueOnce(new Error('Twilio 500'));
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    await expect(sendOwnerSms('hi')).resolves.toEqual({
      queued: false,
      reason: 'failed',
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'owner_sms' }),
      'Owner SMS failed — continuing'
    );
    warnSpy.mockRestore();
  });

  it('skips (never throws) when no recipient resolves (empty OWNER_PHONE, no `to`)', async () => {
    env.OWNER_PHONE = '';
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    await expect(sendOwnerSms('hi')).resolves.toEqual({
      queued: false,
      reason: 'not_configured',
    });
    expect(messagesCreateMock).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
