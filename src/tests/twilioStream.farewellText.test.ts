import { beforeAll, describe, expect, it } from 'vitest';

// W1 (2026-09-17): isFarewellText is the wording half of the Live close gate
// (TwilioRealtimeCall#liveHasCurrentFarewell filters Erica's rolling output
// text by lastCallerSpeechStoppedAt, then asks this function whether what is
// left is a goodbye). Unit-tested module-level, the same way
// isMoreHelpOfferText is, so the wording judgement is provable without
// standing up a call.
//
// The regression that created this file: production call
// CA2e23da275cdde534bc4f3d6b93f65426 (2026-09-17 19:05 ET). Erica said
// "Yeah. I'll take care of that. You're welcome", the old pattern matched
// `take care`, end_call concluded the farewell had been spoken, and the
// caller was hung up on without ever hearing a goodbye.

process.env.OPENAI_REALTIME_API_KEY ||= 'test-key';

let isFarewellText: typeof import('../realtime/twilioStream.js').isFarewellText;
beforeAll(async () => {
  ({ isFarewellText } = await import('../realtime/twilioStream.js'));
});

describe('isFarewellText — genuine sign-offs still count', () => {
  it('matches the farewells Erica actually uses to close', () => {
    expect(isFarewellText('Goodbye!')).toBe(true);
    expect(isFarewellText('Alright, bye!')).toBe(true);
    expect(isFarewellText('Take care.')).toBe(true);
    expect(isFarewellText('Okay, take care!')).toBe(true);
    expect(isFarewellText('You take care now, bye.')).toBe(true);
    expect(isFarewellText('Have a great day!')).toBe(true);
    expect(isFarewellText('Have a lovely evening.')).toBe(true);
    expect(isFarewellText('Have a good weekend.')).toBe(true);
  });

  it('keeps "take care of yourself", which is a sign-off, not an action', () => {
    expect(isFarewellText('Take care of yourself!')).toBe(true);
    expect(isFarewellText('Okay, take care of yourself. Bye.')).toBe(true);
  });
});

describe('isFarewellText — "take care OF something" is an action, not a goodbye', () => {
  // The exact production transcript, typographic apostrophes (U+2019) included,
  // as the Live output-transcript stream delivered it.
  it('rejects the real CA2e23da… line that caused the farewell-less hangup', () => {
    expect(isFarewellText('Yeah. I’ll take care of that. You’re welcome')).toBe(
      false
    );
  });

  it('rejects the whole "take care of <x>" family', () => {
    expect(isFarewellText('I’ll take care of that.')).toBe(false);
    expect(isFarewellText("I'll take care of it.")).toBe(false);
    expect(isFarewellText('Let me take care of this for you.')).toBe(false);
    expect(isFarewellText('We’ll take care of you when you get here.')).toBe(
      false
    );
    expect(isFarewellText('I’ve taken care of that.')).toBe(false);
    expect(isFarewellText('I can take care of the booking now.')).toBe(false);
  });

  it('still matches a real farewell that follows the action in the same buffer', () => {
    // liveClosingText is a JOINED rolling buffer, so the turn Erica speaks
    // after being asked for a goodbye arrives appended to the action line.
    expect(
      isFarewellText('Yeah. I’ll take care of that. You’re welcome. Take care!')
    ).toBe(true);
  });
});

describe('isFarewellText — backchannels and word boundaries', () => {
  it('rejects non-closing speech', () => {
    expect(isFarewellText('Okay.')).toBe(false);
    expect(isFarewellText('Your brow threading is booked for 4 PM.')).toBe(
      false
    );
    expect(isFarewellText('')).toBe(false);
  });

  it('does not match a farewell word embedded in another word', () => {
    expect(isFarewellText('Goodbyes are the hardest part.')).toBe(false);
    expect(isFarewellText('We sell combs and hair byproducts.')).toBe(false);
  });
});
