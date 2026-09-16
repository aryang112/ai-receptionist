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
});
