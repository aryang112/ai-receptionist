import { describe, expect, it } from 'vitest';
import { deriveLiveTestTelemetry } from '../services/liveTestTelemetry.js';

describe('deriveLiveTestTelemetry', () => {
  it('uses the newest cumulative voice snapshot and deduplicates backend response ids', () => {
    const telemetry = deriveLiveTestTelemetry(
      [
        {
          type: 'voice',
          event: 'live_usage',
          ts: 30,
          detail: {
            voiceSeconds: 60,
            responseId: 'resp_1',
            backendUsage: {
              inputTokens: 1_000_000,
              cachedTokens: 500_000,
              outputTokens: 100_000,
            },
          },
        },
        // A replay must not double-charge the same completed response.
        {
          type: 'voice',
          event: 'live_usage',
          ts: 40,
          detail: {
            voiceSeconds: 90,
            responseId: 'resp_1',
            backendUsage: {
              inputTokens: 9_000_000,
              cachedTokens: 0,
              outputTokens: 9_000_000,
            },
          },
        },
        // Input order is deliberately not timestamp order.
        {
          type: 'voice',
          event: 'live_usage',
          ts: 20,
          detail: { voiceSeconds: 999 },
        },
        {
          type: 'voice',
          event: 'live_usage',
          ts: 50,
          detail: {
            voiceSeconds: 120,
            responseId: 'resp_2',
            backendUsage: {
              inputTokens: 1_000_000,
              cachedTokens: 0,
              outputTokens: 1_000_000,
            },
            final: true,
            finalConfirmed: true,
          },
        },
      ],
      'gpt-5.6-terra'
    );

    expect(telemetry).toMatchObject({
      voiceSeconds: 120,
      backendResponseCount: 2,
      finalConfirmed: true,
    });
    expect(telemetry!.audioCostUsd).toBeCloseTo(0.1, 10);
    // resp_1: 0.5M uncached*$2 + 0.5M cached*$0.2 + 0.1M output*$12 = 2.3
    // resp_2: 1M input*$2 + 1M output*$12 = 14
    expect(telemetry!.backendCostUsd).toBeCloseTo(16.3, 10);
    expect(telemetry!.totalCostUsd).toBeCloseTo(16.4, 10);
  });

  it('preserves unavailable billing fields instead of fabricating a zero cost', () => {
    const telemetry = deriveLiveTestTelemetry(
      [
        {
          type: 'voice',
          event: 'live_usage',
          ts: 10,
          detail: {
            responseId: 'resp_missing_usage',
            final: true,
            finalConfirmed: false,
          },
        },
      ],
      'unknown-model'
    );

    expect(telemetry).toEqual({
      backendResponseCount: 0,
      finalConfirmed: false,
    });
    expect(telemetry).not.toHaveProperty('voiceSeconds');
    expect(telemetry).not.toHaveProperty('audioCostUsd');
    expect(telemetry).not.toHaveProperty('backendCostUsd');
    expect(telemetry).not.toHaveProperty('totalCostUsd');
  });

  it('does not create telemetry when a call has no Live usage events', () => {
    expect(
      deriveLiveTestTelemetry(
        [{ type: 'voice', event: 'other_event', detail: {} }],
        'gpt-5.6-luna'
      )
    ).toBeUndefined();
  });
});
