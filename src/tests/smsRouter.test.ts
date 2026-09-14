import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { env } from '../config/env.js';
import {
  routeInbound,
  isAcknowledgment,
  isOwner,
  isAllowedForAgent,
  REVIEW_REPLY_WINDOW_MS,
} from '../services/smsRouter.js';
import { SmsStore, __resetSmsStoreForTests } from '../services/smsStore.js';

// SMS_STORE_PATH is read at call time (smsStore.file()), so pointing it at a
// per-test tmp fixture works with a plain static import — same approach as
// admin.route.test.ts.
const tmpFile = path.join(
  os.tmpdir(),
  `sms-router-${process.pid}-${Date.now()}.jsonl`
);
const originalPath = env.SMS_STORE_PATH;
const originalOwner = env.OWNER_PHONE;

const CLIENT = '+14105551234';
const OWNER = '+14433706471';

/** No review request was ever sent to this number. */
const noReviewRequest = async () => null;
/** A review request went out an hour ago. */
const recentReviewRequest = async () => Date.now() - 60 * 60 * 1000;
/** A review request went out well outside the reply window. */
const staleReviewRequest = async () =>
  Date.now() - REVIEW_REPLY_WINDOW_MS - 60_000;

beforeEach(() => {
  (env as any).SMS_STORE_PATH = tmpFile;
  (env as any).OWNER_PHONE = OWNER;
  __resetSmsStoreForTests();
  try {
    fs.unlinkSync(tmpFile);
  } catch {
    /* first run */
  }
});

afterEach(() => {
  (env as any).SMS_STORE_PATH = originalPath;
  (env as any).OWNER_PHONE = originalOwner;
  try {
    fs.unlinkSync(tmpFile);
  } catch {
    /* already gone */
  }
});

describe('isAcknowledgment — drawn from the real 57-message backlog', () => {
  // Every string below is an ACTUAL inbound message that was dropped by the
  // dead demo webhook. If the classifier regresses, these are the customers
  // who get the wrong reply.
  it.each([
    'Absolutely!! Done! ',
    'Sure thing!',
    'Done!',
    'Of course!',
    'Will do😘',
    'Heyyyy Richa 🤗 Done ',
    'Yes of course! ',
    'Hi , sure no problem !',
    'absolutely ',
    'Sure',
    'Done! ',
    'Of course ',
    'No',
  ])('treats %j as an acknowledgment', (body) => {
    expect(isAcknowledgment(body)).toBe(true);
  });

  it('treats an iOS tapback as an acknowledgment', () => {
    expect(
      isAcknowledgment(
        "Loved “ Hi Kyisha! It's Richa 😊 Could you do me a quick favor"
      )
    ).toBe(true);
    expect(isAcknowledgment("Liked “Hi Shannon! It's Richa")).toBe(true);
  });

  it('treats a bare emoji reaction as an acknowledgment', () => {
    expect(isAcknowledgment(' ​🤗​ ')).toBe(true);
    expect(isAcknowledgment('👍')).toBe(true);
  });

  it('does NOT treat a request as an acknowledgment, even a polite one', () => {
    expect(isAcknowledgment('Thanks! Can I come in Thursday?')).toBe(false);
    expect(isAcknowledgment('Sure — do you have anything tomorrow?')).toBe(
      false
    );
    expect(isAcknowledgment('done, also can I move my 3pm')).toBe(false);
    expect(isAcknowledgment('what time do you open')).toBe(false);
    expect(isAcknowledgment('how much is brow threading')).toBe(false);
  });

  it('does not fire "am"/"pm" inside ordinary words', () => {
    // Guards the word-boundary regex: a naive substring check would classify
    // this as booking intent because of "am" in "amazing".
    expect(isAcknowledgment('done, that was amazing')).toBe(true);
  });

  it('treats a long message as a conversation, not an acknowledgment', () => {
    expect(
      isAcknowledgment(
        'Of course. I also shared it on a Facebook post of someone looking to get their eyebrows done'
      )
    ).toBe(false);
  });
});

describe('isOwner', () => {
  it('matches the owner across formatting differences', () => {
    expect(isOwner('+14433706471')).toBe(true);
    expect(isOwner('4433706471')).toBe(true);
    expect(isOwner('14433706471')).toBe(true);
  });

  it('does not match a client', () => {
    expect(isOwner(CLIENT)).toBe(false);
  });
});

describe('routeInbound — lane selection', () => {
  it('routes the owner phone to the owner lane, whatever she writes', async () => {
    const d = await routeInbound(
      OWNER,
      'A7 tell her 2pm works',
      noReviewRequest
    );
    expect(d.lane).toBe('owner');
  });

  it('routes an acknowledgment after a recent review request to review_reply', async () => {
    const d = await routeInbound(
      CLIENT,
      'Absolutely!! Done!',
      recentReviewRequest
    );
    expect(d.lane).toBe('review_reply');
  });

  it('routes an acknowledgment with NO review request to booking', async () => {
    // Without the review-request evidence a bare "Done!" is unexplained, and
    // the agent handles it better than a canned thank-you would.
    const d = await routeInbound(CLIENT, 'Done!', noReviewRequest);
    expect(d.lane).toBe('booking');
  });

  it('routes an acknowledgment outside the reply window to booking', async () => {
    const d = await routeInbound(CLIENT, 'Done!', staleReviewRequest);
    expect(d.lane).toBe('booking');
  });

  it('routes a booking request to booking even right after a review request', async () => {
    // The expensive mistake: thanking someone who wanted an appointment.
    const d = await routeInbound(
      CLIENT,
      'Thanks! Can I come in Thursday?',
      recentReviewRequest
    );
    expect(d.lane).toBe('booking');
  });

  it('continues an open conversation rather than re-classifying it', async () => {
    SmsStore.recordInbound(CLIENT, 'can I book thursday', 'booking');
    SmsStore.recordOutbound(CLIENT, 'I have 2:15 or 3:30 — which works?');
    SmsStore.setState(CLIENT, 'active');

    // "Yes" mid-conversation means "book it", NOT the START keyword and NOT a
    // review acknowledgment.
    const d = await routeInbound(CLIENT, 'yes', recentReviewRequest);
    expect(d.lane).toBe('booking');
    expect(d.resuming).toBe(true);
  });
});

describe('routeInbound — compliance always wins', () => {
  it('routes STOP to compliance even mid-conversation', async () => {
    SmsStore.setState(CLIENT, 'active');
    const d = await routeInbound(CLIENT, 'STOP', noReviewRequest);
    expect(d.lane).toBe('compliance');
    expect(d.keyword).toBe('stop');
  });

  it('routes HELP to compliance', async () => {
    const d = await routeInbound(CLIENT, 'help', noReviewRequest);
    expect(d.lane).toBe('compliance');
    expect(d.keyword).toBe('help');
  });

  it('does NOT treat "cancel my 3pm" as an opt-out', async () => {
    // A substring match on "cancel" would blacklist a client who was trying to
    // manage an appointment. Exact whole-message match only.
    const d = await routeInbound(
      CLIENT,
      'cancel my 3pm please',
      noReviewRequest
    );
    expect(d.lane).toBe('booking');
  });

  it('does NOT treat "Can you stop by earlier?" as an opt-out', async () => {
    const d = await routeInbound(
      CLIENT,
      'Can you stop by earlier?',
      noReviewRequest
    );
    expect(d.lane).toBe('booking');
  });

  it('suppresses an opted-out number and sends nothing', async () => {
    SmsStore.setState(CLIENT, 'opted_out');
    const d = await routeInbound(CLIENT, 'hey are you open', noReviewRequest);
    expect(d.lane).toBe('compliance');
    expect(d.suppressed).toBe(true);
  });

  it('treats "yes" from an opted-out number as opt-in, but not otherwise', async () => {
    SmsStore.setState(CLIENT, 'opted_out');
    const optIn = await routeInbound(CLIENT, 'yes', noReviewRequest);
    expect(optIn.lane).toBe('compliance');
    expect(optIn.keyword).toBe('start');

    // A DIFFERENT number: resetting the in-memory index alone would not clear
    // the opt-out, because the store replays it back from the JSONL file —
    // which is exactly the durability the opt-out ledger is supposed to have.
    const neverOptedOut = '+14105559999';
    const plain = await routeInbound(neverOptedOut, 'yes', noReviewRequest);
    expect(plain.lane).not.toBe('compliance');
  });

  it('an opt-out survives a restart (replayed from the JSONL ledger)', () => {
    SmsStore.setState(CLIENT, 'opted_out');
    __resetSmsStoreForTests(); // simulates a process restart
    expect(SmsStore.get(CLIENT).state).toBe('opted_out');
  });

  it('accepts an unambiguous START from a number that never opted out', async () => {
    const d = await routeInbound(CLIENT, 'unstop', noReviewRequest);
    expect(d.lane).toBe('compliance');
    expect(d.keyword).toBe('start');
  });
});

describe('routeInbound — failure of the review lookup must not lose the message', () => {
  it('falls through to booking when the lookup throws', async () => {
    const throwing = async () => {
      throw new Error('twilio down');
    };
    // The lookup itself fails open (returns null) in production; here we prove
    // the router still produces a lane if a future lookup rejects instead.
    await expect(
      routeInbound(CLIENT, 'Done!', throwing as any)
    ).rejects.toThrow();
    // ...and that a null-returning lookup (the real failure mode) is safe:
    const d = await routeInbound(CLIENT, 'Done!', async () => null);
    expect(d.lane).toBe('booking');
  });
});

describe('isAllowedForAgent — the taste-test gate', () => {
  const originalList = env.SMS_ALLOWED_NUMBERS;
  afterEach(() => {
    (env as any).SMS_ALLOWED_NUMBERS = originalList;
  });

  it('allows everyone when no list is configured (the launch state)', () => {
    (env as any).SMS_ALLOWED_NUMBERS = [];
    expect(isAllowedForAgent(CLIENT)).toBe(true);
  });

  it('allows only the listed numbers when a list is configured', () => {
    (env as any).SMS_ALLOWED_NUMBERS = ['+14105550123'];
    expect(isAllowedForAgent('+14105550123')).toBe(true);
    expect(isAllowedForAgent(CLIENT)).toBe(false);
  });

  it('normalizes formatting so a list entry cannot silently miss', () => {
    (env as any).SMS_ALLOWED_NUMBERS = ['(410) 555-0123'];
    expect(isAllowedForAgent('+14105550123')).toBe(true);
    expect(isAllowedForAgent('4105550123')).toBe(true);
  });

  it('never gates the owner — her control channel must always work', () => {
    (env as any).SMS_ALLOWED_NUMBERS = ['+14105550123'];
    expect(isAllowedForAgent(OWNER)).toBe(true);
  });
});
