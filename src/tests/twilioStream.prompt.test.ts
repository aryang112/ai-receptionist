import { describe, it, expect } from 'vitest';
import { DateTime } from 'luxon';
import { buildInstructions } from '../realtime/twilioStream.js';
import businessHours from '../config/business.json';

const at = (iso: string) => DateTime.fromISO(iso, { zone: 'America/New_York' });

// L1: Erica must be able to answer "where are you located?" — the address is
// sourced from business.json (single source of truth), never hardcoded in
// the prompt string itself. This locks in that the LOCATION line is present
// and reflects the config value.
describe('buildInstructions — LOCATION', () => {
  it('includes the salon address, sourced from business.json', () => {
    const instructions = buildInstructions();

    expect(instructions).toContain(businessHours.location.address);
    expect(instructions).toContain(businessHours.location.city);
    expect(instructions).toContain(businessHours.location.state);
    expect(instructions).toContain(businessHours.location.zip);
    expect(instructions).toContain('LOCATION:');
  });
});

// V1: buildInstructions takes an injectable `now` (defaults to real now, same
// pattern as getHoursStatus) so the vacation block is testable without
// waiting for the real calendar date. business.json vacation: 2026-09-01 to
// 2026-09-09.
describe('buildInstructions — VACATION', () => {
  it('injects an ACTIVE vacation block when "now" falls inside the range', () => {
    const instructions = buildInstructions(at('2026-09-05T12:00'));
    expect(instructions).toContain('VACATION');
    expect(instructions).toMatch(/Richa is away right now/);
    expect(instructions).toMatch(/transfer_to_owner/);
  });

  it('injects an UPCOMING vacation block when "now" is within 14 days of the start', () => {
    const instructions = buildInstructions(at('2026-08-22T09:00'));
    expect(instructions).toContain('VACATION');
    expect(instructions).toMatch(/Richa will be away/);
    // Must not claim she's already away before she actually is.
    expect(instructions).not.toMatch(/Richa is away right now/);
  });

  it('omits the vacation block entirely when no vacation is active or upcoming', () => {
    const instructions = buildInstructions(at('2026-10-01T09:00'));
    expect(instructions).not.toContain('VACATION');
  });
});

// S1: a new SPAM & TELEMARKETING section between CONVERSATION POLICY and
// GENERAL RULES — the decline-then-end_call('spam') guidance for scam/
// telemarketing calls.
describe('buildInstructions — SPAM & TELEMARKETING (S1)', () => {
  it('includes the section with the decline line and the end_call(reason: spam) instruction', () => {
    const instructions = buildInstructions();
    expect(instructions).toContain('SPAM & TELEMARKETING');
    expect(instructions).toMatch(/not interested/i);
    expect(instructions).toMatch(/reason 'spam'/);
    expect(instructions).toMatch(/never (transfer|engage)/i);
  });

  it('sits between CONVERSATION POLICY and GENERAL RULES', () => {
    const instructions = buildInstructions();
    const policyIdx = instructions.indexOf('CONVERSATION POLICY');
    const spamIdx = instructions.indexOf('SPAM & TELEMARKETING');
    const generalIdx = instructions.indexOf('GENERAL RULES');
    expect(policyIdx).toBeGreaterThan(-1);
    expect(spamIdx).toBeGreaterThan(policyIdx);
    expect(generalIdx).toBeGreaterThan(spamIdx);
  });
});
