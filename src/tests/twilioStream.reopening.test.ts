import { afterEach, describe, expect, it, vi } from 'vitest';
import { DateTime } from 'luxon';
import {
  buildInstructions,
  TwilioRealtimeCall,
} from '../realtime/twilioStream.js';

afterEach(() => vi.useRealTimers());

// Exercise the real hours handler without a socket or session. The global test
// setup isolates its telemetry writes in a temporary directory.
async function hoursAt(iso: string) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(iso));
  const call = Object.create(TwilioRealtimeCall.prototype) as any;
  call.callSid = '';
  call.outcome = 'none';
  return call.handleGetBusinessHours({});
}

describe('September 10 reopening', () => {
  it('keeps the active closure through the last Eastern second, despite UTC being September 10', async () => {
    const hours = await hoursAt('2026-09-10T03:59:59Z');
    expect(hours.temporaryClosures).toEqual([
      {
        from: '2026-09-01',
        through: '2026-09-09',
        reopens: '2026-09-10',
        publicExplanation: 'Richa is away',
      },
    ]);
    expect(hours.note).toContain('TEMPORARY CLOSURE POLICY');
  });

  it('removes the expired notice and closure coaching at Eastern midnight', async () => {
    const hours = await hoursAt('2026-09-10T04:00:00Z');
    expect(hours.temporaryClosures).toEqual([]);
    expect(hours.note).toContain('CURRENT STATUS');
    expect(hours.note).not.toContain('TEMPORARY CLOSURE POLICY');
    expect(JSON.stringify(hours)).not.toMatch(/Richa is away|2026-09-0[19]/);
    expect(hours.thursday).toBe('12:00-19:00');
    expect(hours.sunday).toBe('Closed');
  });

  it('still returns upcoming closures before they start', async () => {
    const hours = await hoursAt('2026-08-31T12:00:00-04:00');
    expect(hours.temporaryClosures).toHaveLength(1);
    expect(hours.temporaryClosures[0].from).toBe('2026-09-01');
  });

  it('renders normal hours and transfer status on reopening day', () => {
    const now = DateTime.fromISO('2026-09-10T12:00:00-04:00');
    const prompt = buildInstructions(now);
    const status = prompt.slice(prompt.indexOf('═══ CURRENT STATUS'));
    expect(status).not.toMatch(/away|TEMPORARY CLOSURE|September 1 through/);
    expect(status).toContain('open 12 PM to 7 PM');
    expect(status).toContain('At this moment we are OPEN');
    expect(status).toContain('Richa is AVAILABLE to take a call right now');
  });
});
