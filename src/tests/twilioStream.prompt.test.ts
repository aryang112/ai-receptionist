import { describe, it, expect } from 'vitest';
import { buildInstructions } from '../realtime/twilioStream.js';
import businessHours from '../config/business.json';

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
