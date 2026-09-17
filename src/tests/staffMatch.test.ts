import { describe, it, expect, beforeAll } from 'vitest';

// Register item 05, reproduced live 2026-09-15: "eyebrow threading and upper
// lip" resolved to the stylist MANU — the word "and" is two edits from "manu".
// The caller was then asked which service they wanted, having just said it.

let matchStaffName: typeof import('../realtime/twilioStream.js').matchStaffName;
beforeAll(async () => {
  ({ matchStaffName } = await import('../realtime/twilioStream.js'));
});
const STAFF = ['Bonnie', 'Manu', 'Phorest', 'Richa'];

describe('matchStaffName', () => {
  it('does not turn a service phrase into a stylist', () => {
    expect(matchStaffName('eyebrow threading and upper lip', STAFF)).toBeNull();
    expect(matchStaffName('and', STAFF)).toBeNull();
    expect(matchStaffName('brow thread and lip thread', STAFF)).toBeNull();
    expect(matchStaffName('full face threading', STAFF)).toBeNull();
  });

  it('still matches a real staff name', () => {
    expect(matchStaffName('Manu', STAFF)).toBe('Manu');
    expect(matchStaffName('Richa', STAFF)).toBe('Richa');
    expect(matchStaffName('Bonnie', STAFF)).toBe('Bonnie');
  });

  it('still tolerates how the phone mishears Richa', () => {
    // The reason the distance-2 boundary cannot simply be tightened.
    expect(matchStaffName('Risha', STAFF)).toBe('Richa');
    expect(matchStaffName('Rishka', STAFF)).toBe('Richa');
    expect(matchStaffName('Richard', STAFF)).toBe('Richa');
  });

  it('still finds a name inside a phrase', () => {
    expect(matchStaffName('with Risha', STAFF)).toBe('Richa');
    expect(matchStaffName('an appointment with Manu', STAFF)).toBe('Manu');
    expect(matchStaffName('Richa availability', STAFF)).toBe('Richa');
  });

  // The length-scaled bound (maxEditsFor) is now the actual mechanism, not
  // the stopword list — "and", "want", "then" and "than" are each distance 2
  // from "manu" (a 4-letter name only tolerates 1 edit), so they never match
  // even against a name list with no filler words removed from the query at
  // all. This is deliberately checked against a bare ['Manu'] roster so a
  // future edit to STAFF_MATCH_STOPWORDS can't accidentally make this test
  // pass for the wrong reason.
  it('the length-scaled bound alone rejects ordinary words distance-2 from a 4-letter name', () => {
    expect(matchStaffName('and', ['Manu'])).toBeNull();
    expect(matchStaffName('want', ['Manu'])).toBeNull();
    expect(matchStaffName('then', ['Manu'])).toBeNull();
    expect(matchStaffName('than', ['Manu'])).toBeNull();
  });

  it('still matches Richa (5 letters) through the phone-mishearing variants', () => {
    expect(matchStaffName('Richard', STAFF)).toBe('Richa');
    expect(matchStaffName('Rishka', STAFF)).toBe('Richa');
    expect(matchStaffName('Risha', STAFF)).toBe('Richa');
    expect(matchStaffName('with Risha', STAFF)).toBe('Richa');
  });

  it('a 4-letter name still tolerates exactly one edit', () => {
    // "Mano" is one substitution away from "Manu" — allowed at length 4.
    expect(matchStaffName('Mano', ['Manu'])).toBe('Manu');
  });

  it('a 3-letter (or shorter) name requires an exact match, no fuzz at all', () => {
    // "Rob" vs "Bob" is one substitution away but 3 letters get zero fuzz.
    expect(matchStaffName('Rob', ['Bob'])).toBeNull();
    expect(matchStaffName('Bob', ['Bob'])).toBe('Bob');
  });
});
