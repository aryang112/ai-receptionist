import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../config/env.js';
import { CallStore } from '../services/callStore.js';
import {
  buildFallbackCallSummary,
  formatGeneratedCallSummary,
  maybeSendPostCallSummary,
  POST_CALL_SUMMARY_MAX_CHARS,
  type PostCallSummaryInput,
} from '../services/postCallSummary.js';

const input: PostCallSummaryInput = {
  callSid: 'CA_summary',
  callerPhone: '+1 (443) 555-5404',
  callerName: 'Sneha A',
  transcript: [
    {
      role: 'caller',
      text: 'I want to walk in and ask if there is availability.',
      ts: 1,
    },
    {
      role: 'erica',
      text: 'We are closed through September 9. I can check September 10 onward. Which service would you like?',
      ts: 2,
    },
  ],
  outcome: 'none',
  endReason: 'caller hung up',
};

const generated = {
  callerName: 'Wrong Generated Name',
  purpose: 'Asked about walk-in availability.',
  handling:
    'I explained the closure and offered to check availability from September 10 onward.',
  ending: 'No appointment was booked.',
};

describe('post-call owner summaries', () => {
  const originalEnabled = env.OWNER_CALL_SUMMARY_ENABLED;
  const originalExcluded = [...env.OWNER_CALL_SUMMARY_EXCLUDE_PHONES];

  beforeEach(() => {
    env.OWNER_CALL_SUMMARY_ENABLED = 'true';
    env.OWNER_CALL_SUMMARY_EXCLUDE_PHONES = [];
    vi.spyOn(CallStore, 'recordOwnerNotification').mockImplementation(() => {});
  });

  afterEach(() => {
    env.OWNER_CALL_SUMMARY_ENABLED = originalEnabled;
    env.OWNER_CALL_SUMMARY_EXCLUDE_PHONES = [...originalExcluded];
    vi.restoreAllMocks();
  });

  it('formats the requested natural owner-facing structure and trusts the Phorest name', () => {
    expect(formatGeneratedCallSummary(input, generated)).toBe(
      'Hi Richa — Sneha A called and asked about walk-in availability. I explained the closure and offered to check availability from September 10 onward. No appointment was booked.'
    );
  });

  it('uses a caller-stated name only when no trusted caller name exists', () => {
    expect(
      formatGeneratedCallSummary(
        {
          ...input,
          callerName: 'a caller',
          transcript: [
            {
              role: 'caller',
              text: 'Hi, my name is Ashley Colby and I am calling from Bank of America.',
              ts: 1,
            },
          ],
        },
        { ...generated, callerName: 'Ashley Colby' }
      )
    ).toMatch(/^Hi Richa — Ashley Colby called and/);
  });

  it('rejects a generated name that the caller never stated', () => {
    expect(
      formatGeneratedCallSummary(
        { ...input, callerName: 'a caller' },
        { ...generated, callerName: 'Invented Person' }
      )
    ).toMatch(/^Hi Richa — A caller asked about/);
  });

  it('does nothing when disabled', async () => {
    env.OWNER_CALL_SUMMARY_ENABLED = 'false';
    const send = vi.fn();
    const generate = vi.fn();

    await expect(
      maybeSendPostCallSummary(input, { send, generate })
    ).resolves.toEqual({ sent: false, reason: 'disabled' });
    expect(generate).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('normalizes and excludes internal test callers before generation', async () => {
    env.OWNER_CALL_SUMMARY_EXCLUDE_PHONES = ['443-555-5404'];
    const send = vi.fn();
    const generate = vi.fn();

    await expect(
      maybeSendPostCallSummary(input, { send, generate })
    ).resolves.toEqual({ sent: false, reason: 'excluded' });
    expect(generate).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('skips a generic recap when a call-specific owner text already succeeded', async () => {
    const send = vi.fn();
    const generate = vi.fn();

    await expect(
      maybeSendPostCallSummary(input, {
        send,
        generate,
        alreadyNotified: () => true,
      })
    ).resolves.toEqual({ sent: false, reason: 'already_notified' });
    expect(generate).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('sends one generated recap and records only delivery metadata', async () => {
    const send = vi.fn().mockResolvedValue({
      queued: true,
      sid: 'SM_summary',
      status: 'queued',
    });

    const result = await maybeSendPostCallSummary(input, {
      generate: async () => generated,
      send,
      alreadyNotified: () => false,
    });

    expect(result).toMatchObject({ sent: true });
    expect(send).toHaveBeenCalledWith(
      'Hi Richa — Sneha A called and asked about walk-in availability. I explained the closure and offered to check availability from September 10 onward. No appointment was booked.'
    );
    expect(CallStore.recordOwnerNotification).toHaveBeenCalledWith(
      input.callSid,
      { kind: 'post_call_summary', ok: true }
    );
  });

  it('falls back to bounded transcript excerpts when generation fails', async () => {
    const send = vi.fn().mockResolvedValue({
      queued: true,
      sid: 'SM_fallback',
      status: 'queued',
    });

    const result = await maybeSendPostCallSummary(input, {
      generate: async () => {
        throw new Error('summary unavailable');
      },
      send,
      alreadyNotified: () => false,
    });

    expect(result).toMatchObject({ sent: true });
    expect(send.mock.calls[0]?.[0]).toContain('Sneha A called.');
    expect(send.mock.calls[0]?.[0]).toContain('They said:');
    expect(send.mock.calls[0]?.[0].length).toBeLessThanOrEqual(
      POST_CALL_SUMMARY_MAX_CHARS
    );
  });

  it('returns delivery_failed and audits a rejected SMS without throwing', async () => {
    await expect(
      maybeSendPostCallSummary(input, {
        generate: async () => generated,
        send: async () => ({ queued: false, reason: 'failed' }),
        alreadyNotified: () => false,
      })
    ).resolves.toEqual({ sent: false, reason: 'delivery_failed' });
    expect(CallStore.recordOwnerNotification).toHaveBeenCalledWith(
      input.callSid,
      { kind: 'post_call_summary', ok: false, error: 'failed' }
    );
  });

  it('builds a useful fallback even when no transcript exists', () => {
    expect(buildFallbackCallSummary({ ...input, transcript: [] })).toContain(
      'There was not enough conversation to summarize.'
    );
  });
});
