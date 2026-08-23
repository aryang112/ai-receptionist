import { describe, it, expect } from 'vitest';
import { DateTime } from 'luxon';
import { buildInstructions } from '../realtime/twilioStream.js';
import businessHours from '../config/business.json';
import type { Service } from '../services/phorest.types.js';

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

// H1: the tool-only hours/prices design was a workaround for the old 40k TPM
// ceiling (lifted 2026-08-22) — both are now hot-loaded straight into the
// prompt so Erica answers instantly instead of "let me check that for you…"
// on every hours/price question.
describe('buildInstructions — HOURS (H1)', () => {
  it('renders a weekly HOURS line generated from business.json, plus a closed date', () => {
    const instructions = buildInstructions();
    expect(instructions).toContain('HOURS:');
    // business.json: mon: ["12:00-17:00"] → "Mon 12 PM–5 PM"
    expect(instructions).toContain('Mon 12 PM–5 PM');
    // business.json: sun: [] → "Sun closed"
    expect(instructions).toContain('Sun closed');
    // business.json closedDates[0] must appear verbatim (sourced, not hand-typed)
    expect(instructions).toContain(businessHours.closedDates[0]!);
  });

  it('softens the BUSINESS HOURS line — keeps "never guess", drops the always-use-the-tool mandate', () => {
    const instructions = buildInstructions();
    expect(instructions).toMatch(/BUSINESS HOURS:.*never guess/i);
    expect(instructions).not.toContain(
      'Always use the get_business_hours tool'
    );
  });
});

describe('buildInstructions — SERVICES & PRICES catalog (H1)', () => {
  const FIXTURE_SERVICES: Service[] = [
    { id: 's1', name: 'Eyebrow Threading', price: 15, durationMin: 15 },
    { id: 's2', name: 'Lash Lift', price: 65, durationMin: 45 },
    { id: 's3', name: '3) Bikini Wax', price: 30, durationMin: 20 },
  ];

  it('with a services array: alphabetized "Name — $price (Nmin)" lines, leading codes stripped, quote-only-from-list rule', () => {
    const instructions = buildInstructions(undefined, FIXTURE_SERVICES);

    const bikiniIdx = instructions.indexOf('Bikini Wax — $30 (20min)');
    const browIdx = instructions.indexOf('Eyebrow Threading — $15 (15min)');
    const lashIdx = instructions.indexOf('Lash Lift — $65 (45min)');
    expect(bikiniIdx).toBeGreaterThan(-1);
    expect(browIdx).toBeGreaterThan(bikiniIdx); // alphabetical: Bikini < Eyebrow < Lash
    expect(lashIdx).toBeGreaterThan(browIdx);

    expect(instructions).not.toMatch(/3\)\s*Bikini/); // leading "3) " code stripped
    expect(instructions).toMatch(/never guess a price/i);
    // the tool-first fallback wording must NOT still be present
    expect(instructions).not.toContain('call get_prices WITH the serviceName');
  });

  it('with services=null (default), the SERVICES & PRICES section is byte-identical to the pre-H1 tool-first text', () => {
    const instructions = buildInstructions();
    expect(instructions).toContain(
      `Callers often ask for prices. When they ask the price of a service, say a quick filler ("Let me check that for you…") and call get_prices WITH the serviceName they asked about — it returns that service's exact price and duration. Only omit serviceName if they ask broadly "what services do you offer." Quote ONLY what get_prices returns; NEVER guess or make up a price. Read service names naturally (ignore any leading numbers/codes like "3)").`
    );
  });
});
