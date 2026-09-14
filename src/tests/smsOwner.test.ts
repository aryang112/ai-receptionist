import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { env } from '../config/env.js';
import { SmsStore, __resetSmsStoreForTests } from '../services/smsStore.js';
import { parseOwnerCommand } from '../services/smsOwner.js';
import { sendClientSms } from '../services/smsSender.js';

const tmpFile = path.join(
  os.tmpdir(),
  `sms-owner-${process.pid}-${Date.now()}.jsonl`
);
const originalPath = env.SMS_STORE_PATH;
const originalSendMode = env.SMS_SEND_MODE;

const ALICE = '+14105550001';
const BRIDGET = '+14105550002';

beforeEach(() => {
  (env as any).SMS_STORE_PATH = tmpFile;
  (env as any).SMS_SEND_MODE = 'simulate';
  __resetSmsStoreForTests();
  try {
    fs.unlinkSync(tmpFile);
  } catch {
    /* first run */
  }
});

afterEach(() => {
  (env as any).SMS_STORE_PATH = originalPath;
  (env as any).SMS_SEND_MODE = originalSendMode;
  try {
    fs.unlinkSync(tmpFile);
  } catch {
    /* already gone */
  }
});

describe('parseOwnerCommand — which client is Richa answering?', () => {
  it('tells her plainly when nothing is waiting', () => {
    expect(parseOwnerCommand('yes that is fine').kind).toBe('no_open_threads');
  });

  it('routes an explicit ref to that exact thread', () => {
    SmsStore.get(ALICE);
    SmsStore.get(BRIDGET);
    SmsStore.escalate(ALICE, 'asked about a refund');
    SmsStore.escalate(BRIDGET, 'wants a discount');
    const aliceRef = SmsStore.get(ALICE).ref;

    const cmd = parseOwnerCommand(`${aliceRef} tell her we can refund it`);
    expect(cmd.kind).toBe('instruction');
    if (cmd.kind !== 'instruction') return;
    expect(cmd.thread.phone).toBe(ALICE);
    expect(cmd.instruction).toBe('tell her we can refund it');
  });

  it('is case-insensitive and tolerates # and punctuation', () => {
    SmsStore.get(ALICE);
    SmsStore.escalate(ALICE, 'asked about a refund');
    const ref = SmsStore.get(ALICE).ref;

    for (const form of [
      `#${ref} yes`,
      `${ref.toLowerCase()}: yes`,
      `${ref}, yes`,
      `${ref} - yes`,
    ]) {
      const cmd = parseOwnerCommand(form);
      expect(cmd.kind).toBe('instruction');
      if (cmd.kind !== 'instruction') continue;
      expect(cmd.thread.phone).toBe(ALICE);
      expect(cmd.instruction).toBe('yes');
    }
  });

  it('defaults a bare instruction to the most recent escalation', () => {
    SmsStore.get(ALICE);
    SmsStore.escalate(ALICE, 'first');
    SmsStore.get(BRIDGET);
    SmsStore.escalate(BRIDGET, 'second, and most recent');

    const cmd = parseOwnerCommand('tell her yes that is fine');
    expect(cmd.kind).toBe('instruction');
    if (cmd.kind !== 'instruction') return;
    // She is replying to the text that just arrived, which is the newest one.
    expect(cmd.thread.phone).toBe(BRIDGET);
  });

  it('does not mistake an ordinary opening word for a bad ref', () => {
    // "OK book her friday" starts with a 2-char token that is not a ref.
    // Scolding her here would be worse than just doing the obvious thing.
    SmsStore.get(ALICE);
    SmsStore.escalate(ALICE, 'wants an earlier slot');

    const cmd = parseOwnerCommand('OK book her friday at 2');
    expect(cmd.kind).toBe('instruction');
    if (cmd.kind !== 'instruction') return;
    expect(cmd.thread.phone).toBe(ALICE);
    // The whole message is the instruction — "OK" is Richa talking, not a ref
    // to be stripped. Removing it would quietly edit what she said.
    expect(cmd.instruction).toBe('OK book her friday at 2');
  });

  it('refuses to guess when she deliberately names a ref we do not have', () => {
    SmsStore.get(ALICE);
    SmsStore.escalate(ALICE, 'wants an earlier slot');
    // Sending the WRONG client the wrong answer is far worse than one extra
    // round trip, so an explicit #ref that misses must not fall back.
    const cmd = parseOwnerCommand('#ZZ99 tell her yes');
    expect(cmd.kind).toBe('unknown_ref');
  });

  it('treats a ref with no instruction as empty', () => {
    SmsStore.get(ALICE);
    SmsStore.escalate(ALICE, 'wants an earlier slot');
    const ref = SmsStore.get(ALICE).ref;
    expect(parseOwnerCommand(ref).kind).toBe('empty');
  });
});

describe('thread refs', () => {
  it('never contains a character that is ambiguous on a phone keyboard', () => {
    // Richa types these back. 1/I and 0/O would silently route her instruction
    // to the wrong client.
    for (let i = 0; i < 200; i++) {
      __resetSmsStoreForTests();
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        /* fine */
      }
      const ref = SmsStore.get(`+1410555${String(1000 + i)}`).ref;
      expect(ref).not.toMatch(/[IO01]/);
    }
  });

  it('survives a restart so an older escalation text still resolves', () => {
    SmsStore.get(ALICE);
    SmsStore.escalate(ALICE, 'asked about parking');
    const ref = SmsStore.get(ALICE).ref;

    __resetSmsStoreForTests(); // process restart
    expect(SmsStore.byRef(ref)?.phone).toBe(ALICE);
  });
});

describe('sendClientSms — the opt-out guard cannot be bypassed', () => {
  it('refuses to text an opted-out number', async () => {
    SmsStore.setState(ALICE, 'opted_out');
    const result = await sendClientSms(ALICE, 'we have 2pm free');
    expect(result).toEqual({ sent: false, reason: 'opted_out' });
  });

  it('allows exactly one forced message — the STOP confirmation', async () => {
    SmsStore.setState(ALICE, 'opted_out');
    const result = await sendClientSms(ALICE, "You're unsubscribed", {
      force: true,
    });
    expect(result.sent).toBe(true);
  });

  it('refuses an empty message rather than sending whitespace', async () => {
    const result = await sendClientSms(ALICE, '   ');
    expect(result).toEqual({ sent: false, reason: 'empty' });
  });

  it('records the outbound message on the thread in simulate mode', async () => {
    await sendClientSms(ALICE, 'I have 2:15 or 3:30 Thursday — which works?');
    const thread = SmsStore.get(ALICE);
    const last = thread.messages[thread.messages.length - 1];
    expect(last?.direction).toBe('outbound');
    expect(last?.body).toContain('2:15');
  });

  it('truncates rather than sending a multi-segment wall of text', async () => {
    await sendClientSms(ALICE, 'x'.repeat(1000));
    const msgs = SmsStore.get(ALICE).messages;
    expect(msgs[msgs.length - 1]?.body.length).toBe(320);
  });
});
