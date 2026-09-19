import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { buildInstructions } from '../realtime/twilioStream.js';
import type { Service } from '../services/phorest.types.js';
import {
  ambiguousPriceKeys,
  buildBackendPrompt,
  buildLivePrompt,
} from '../voice/livePrompts.js';

const salonTime = (iso: string) =>
  DateTime.fromISO(iso, { zone: 'America/New_York' });

const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), '__golden__');

function readGolden(name: string): string {
  return readFileSync(join(GOLDEN_DIR, name), 'utf8');
}

/**
 * Assert byte-identical output against a committed golden file. On mismatch,
 * print the first differing line (unified-diff style: expected `-`, actual
 * `+`) instead of dumping the whole multi-KB prompt into the test output.
 *
 * UPDATE_GOLDEN=1 mode (Workstream E, 2026-09-16): run
 * `UPDATE_GOLDEN=1 npx vitest run src/tests/livePrompts.test.ts` to WRITE the
 * actual output over the committed golden file instead of asserting against
 * it — use this only after a deliberate, reviewed wording change, then run
 * again WITHOUT the env var (a normal `npx vitest run`) to confirm the
 * regenerated goldens actually pass, and diff `src/tests/__golden__` to
 * confirm the only differences are the ones you intended.
 */
function expectMatchesGolden(actual: string, goldenFile: string): void {
  if (process.env.UPDATE_GOLDEN === '1') {
    writeFileSync(join(GOLDEN_DIR, goldenFile), actual, 'utf8');
    expect(actual).toBe(actual);
    return;
  }
  const expected = readGolden(goldenFile);
  if (actual === expected) {
    expect(actual).toBe(expected);
    return;
  }
  const expectedLines = expected.split('\n');
  const actualLines = actual.split('\n');
  const max = Math.max(expectedLines.length, actualLines.length);
  let i = 0;
  for (; i < max; i++) {
    if (expectedLines[i] !== actualLines[i]) break;
  }
  const context = 2;
  const from = Math.max(0, i - context);
  const diff = [
    `First difference at line ${i + 1} of golden/${goldenFile}:`,
    ...expectedLines
      .slice(from, i + context + 1)
      .map((line, idx) => `- ${idx + from === i ? line : line}`),
    '  ---',
    ...actualLines
      .slice(from, i + context + 1)
      .map((line, idx) => `+ ${idx + from === i ? line : line}`),
  ].join('\n');
  expect(actual, diff).toBe(expected);
}

const CATALOG: Service[] = [
  { id: 'svc_brow', name: 'Brow Threading', price: 15, durationMin: 15 },
  {
    id: 'svc_bundle',
    name: 'Brow Thread + Lip Thread',
    price: 25,
    durationMin: 25,
  },
  { id: 'svc_lash', name: 'Lash Lift', price: 65, durationMin: 45 },
];

describe('Live speech prompt', () => {
  it('is concise, uses the current public facts, and distinguishes direct hours from backend tasks', () => {
    const instructions = buildInstructions(
      salonTime('2026-10-01T12:00'),
      CATALOG
    );
    const prompt = buildLivePrompt(instructions, CATALOG);

    // Fix 2 (2026-09-17) raised this deliberately: the prompt now carries the
    // name+price list so a single-service price question costs no backend
    // round trip. The conversation rules themselves must still stay small —
    // the price list is the ONLY part allowed to grow with the catalog, and
    // `stays small even on the full production catalog` below bounds the whole
    // thing at realistic (63-service) scale.
    // Raised 1300 -> 1450 deliberately (2026-09-19). The rules block grew
    // because three rules MOVED here from the backend prompt, which is the
    // point of that work: the talking model decides every caller turn, so a
    // rule it must apply has to live in ITS prompt (scope, "a request to reach
    // Richa is complete as stated", and the price policy). A cap that blocks a
    // correct rule is the wrong constraint. It costs nothing at runtime — the
    // live prompt is sent once at session config, not per turn. The guard
    // itself stays, so the block cannot drift unbounded, and `stays small even
    // on the full production catalog` below still bounds the whole prompt at
    // realistic 63-service scale.
    const [conversationRules] = prompt.split('\nSERVICE PRICES\n');
    expect(
      Math.ceil((conversationRules ?? prompt).length / 4)
    ).toBeLessThanOrEqual(1450);
    expect(prompt).toContain('8902 Harford Road, Parkville, MD 21234');
    expect(prompt).toContain('Weekly hours:');
    expect(prompt).toContain('Today and right now:');
    expect(prompt).toContain('Answer straightforward hours');
    expect(prompt).toContain('do not delegate those questions');
    expect(prompt).toContain('availability, booking changes');
    expect(prompt).toContain('Ask one question at a time');
    expect(prompt).toContain('Backchannel policy:');
    expect(prompt).toContain('Interruption policy:');
    expect(prompt).toContain('Delegation policy:');
    expect(prompt).toContain('recorded');
    expect(prompt).not.toContain('svc_brow');
    expect(prompt).not.toContain('CURRENT STATUS (precomputed server-side');
  });

  // ---- Fix 2 (2026-09-17): prices answered instantly, accurately -------
  //
  // Production call CA2e23da275cdde534bc4f3d6b93f65426 spent THREE consecutive
  // backend round trips on three one-service price questions ("what's brow
  // threading" -> "Checking." -> "It's 15 dollars"), because the talking
  // model's prompt told it to delegate every price while hours and the address
  // were answered instantly from its own PUBLIC SALON FACTS.
  //
  // The accuracy guarantee is the part that must not regress, so these tests
  // pin BOTH halves: the instant quote, and every case that must still
  // delegate. Register item 05 (bundle resolution differs between the price
  // and availability paths) is open and out of scope — hence the hard line
  // that a two-service total is a delegation, never an instant quote.
  it('puts a name+price list in the talking prompt and authorises an instant single-service quote', () => {
    const instructions = buildInstructions(
      salonTime('2026-10-01T12:00'),
      CATALOG
    );
    const prompt = buildLivePrompt(instructions, CATALOG);

    expect(prompt).toContain('SERVICE PRICES');
    expect(prompt).toContain('- Brow Threading $15');
    expect(prompt).toContain('- Lash Lift $65');
    expect(prompt).toContain('Price policy:');
    expect(prompt).toContain('give that price straight away');
    expect(prompt).toContain('with no preamble and no delegation');
    // The delegation policy must no longer claim the backend owns prices
    // outright — a flat contradiction is what produced the narration.
    expect(prompt).toContain('bundled and multi-service pricing');
    expect(prompt).not.toContain('service selection and prices');
  });

  it('never exposes service IDs or durations to the talking model', () => {
    const prompt = buildLivePrompt('', CATALOG);

    for (const service of CATALOG) expect(prompt).not.toContain(service.id);
    expect(prompt).not.toContain('durationMin');
    expect(prompt).not.toContain('min)');
    expect(prompt).not.toContain('15 min');
    expect(prompt).not.toMatch(/\d+\s?min\b/);
    // Duration is backend-only, and the list must say so rather than let the
    // model infer bookability from a price row.
    expect(prompt).toContain('how long anything takes');
  });

  it('keeps every not-certain price on the delegation path', () => {
    const prompt = buildLivePrompt('', CATALOG);

    expect(prompt).toContain('exactly one line in SERVICE PRICES');
    expect(prompt).toContain('is not on the list');
    expect(prompt).toContain('more than one line could be what they mean');
    expect(prompt).toContain('a total or for two or more services');
    expect(prompt).toContain('a bundle, package or deal');
    expect(prompt).toContain('you are not certain which line matches');
    expect(prompt).toContain('Never add prices together yourself');
    expect(prompt).toContain('never answer with the nearest-sounding line');
    expect(prompt).toContain('never invent, round, or adjust a price');
  });

  it('strips Phorest ordinals, formats fractional prices, and drops $0 admin rows', () => {
    const prompt = buildLivePrompt('', [
      { id: 'a', name: '3) Chin Threading ', price: 15, durationMin: 10 },
      // A single (non-combo) service, priced fractionally, to pin the $X.XX
      // formatting — kept separate from the bundle-dropping case below.
      { id: 'b', name: 'Deep Pore Cleansing', price: 61.5, durationMin: 15 },
      // Real production rows. "Account Deposit is free" is a WRONG answer, not
      // a cheap one, so a $0 row must never be quotable; it falls through to
      // get_prices like any unlisted service.
      { id: 'c', name: 'Account Deposit', price: 0, durationMin: 5 },
      { id: 'd', name: 'Complimentary', price: 0, durationMin: 30 },
    ]);

    expect(prompt).toContain('- Chin Threading $15');
    expect(prompt).not.toContain('3) Chin');
    expect(prompt).toContain('- Deep Pore Cleansing $61.50');
    expect(prompt).not.toContain('Account Deposit');
    expect(prompt).not.toContain('Complimentary');
    expect(prompt).not.toContain('$0');
  });

  // ---- Task 3 (W9, 2026-09-17): bundle rows are bait for a wrong price ---
  //
  // Production call CA8f7e192eabbf740e90de733ebe1fab58: "eyebrow thread plus
  // chin thread" ($30, two services) was quoted as "Brow Thread, Lip Thread,
  // and Chin Thread together are 34 dollars" — the THREE-service bundle row,
  // silently adding a lip service the caller never asked for. The model sees
  // a bundle's price but never its composition, so a narrower request
  // pattern-matches onto a bigger bundle. Dropping bundle/combo rows from
  // this list is the fix: any bundle or multi-service question then falls
  // through to get_prices, exactly as it did before Fix 2 existed.
  it('drops bundle/combo rows so a bundle or multi-service question falls through to get_prices', () => {
    const prompt = buildLivePrompt('', [
      { id: 'a', name: 'Brow Threading', price: 15, durationMin: 10 },
      { id: 'b', name: 'Chin Threading', price: 15, durationMin: 10 },
      // "+" / "&" / "and" connectors — already excluded from ambiguity keys,
      // now also excluded from the visible price list itself.
      { id: 'c', name: 'Brow Thread + Lip Thread', price: 23, durationMin: 20 },
      {
        id: 'd',
        name: 'Brow Thread + Lip Thread + Chin Thread',
        price: 34,
        durationMin: 30,
      },
      { id: 'e', name: 'Brow Wax and Lip Wax', price: 23, durationMin: 20 },
      {
        id: 'f',
        name: 'Eye Brow Threading & Lamination Bundle',
        price: 75,
        durationMin: 60,
      },
      // No connector at all — only the bare word "bundle" marks this one.
      { id: 'g', name: 'Summer Beauty Bundle', price: 61.5, durationMin: 30 },
    ]);

    expect(prompt).toContain('- Brow Threading $15');
    expect(prompt).toContain('- Chin Threading $15');
    expect(prompt).not.toContain('Brow Thread + Lip Thread');
    expect(prompt).not.toContain('Brow Wax and Lip Wax');
    expect(prompt).not.toContain('Lamination Bundle');
    expect(prompt).not.toContain('Summer Beauty Bundle');
  });

  it('degrades to today exact tool-first behaviour when no catalog arrived', () => {
    const instructions = buildInstructions(
      salonTime('2026-10-01T12:00'),
      CATALOG
    );
    // The 250ms catalog race in twilioStream.ts resolves to null on a cold
    // cache or a failed fetch, and the call site then passes [].
    const cold = buildLivePrompt(instructions, []);
    // Same outcome when the catalog arrives but holds nothing quotable.
    const zeroPriced = buildLivePrompt(instructions, [
      { id: 'c', name: 'Account Deposit', price: 0, durationMin: 5 },
    ]);

    for (const prompt of [cold, zeroPriced]) {
      expect(prompt).not.toContain('SERVICE PRICES');
      expect(prompt).not.toContain('Price policy:');
      expect(prompt).toContain('service selection and prices');
      expect(prompt).not.toContain('straight away');
    }
  });

  it('stays small even on the full production catalog', () => {
    // 63 services is the real count `scripts/render-live-prompts.ts` reports
    // against live Phorest (the brief's "35" was stale). Names here are sized
    // like the real ones so the bound means something.
    const big: Service[] = Array.from({ length: 63 }, (_, i) => ({
      id: `svc_${i}`,
      // ~22 chars after the ordinal strip, the real catalog's average.
      name: `${i}) Bikini Butt Wax ${i}`,
      price: 10 + i,
      durationMin: 15,
    }));
    const instructions = buildInstructions(salonTime('2026-10-01T12:00'), big);
    const prompt = buildLivePrompt(instructions, big);

    expect(prompt).not.toContain('svc_0');
    // ~1640 tokens against the 908-token pre-Fix-2 baseline. The headroom is
    // for catalog growth, not for prose: if this trips, the catalog grew and
    // that is worth a look, not a bump.
    expect(Math.ceil(prompt.length / 4)).toBeLessThanOrEqual(1900);
  });

  // ---- W6 / review finding F1 (2026-09-17) -------------------------------
  //
  // 3b537c7 put the ringback preparation in the TALKING model's prompt,
  // unconditionally. That model holds no reachability fact at all —
  // `transferPossibleNow` -> the `RICHA'S LINE` fact exists only in the
  // backend prompt — so at 8:30 PM the caller asking for Richa heard "it may
  // take a moment and you might hear her phone ring", then heard the backend
  // retract it with "outside owner calling hours". That is precisely the
  // "Never promise and retract" rule (backendRules.ts ASKED FOR RICHA) being
  // scripted into the one model that cannot honour it.
  it('says nothing to the talking model about what happens on the line', () => {
    const prompt = buildLivePrompt('', CATALOG);

    expect(prompt).not.toContain('Reaching Richa');
    expect(prompt).not.toMatch(/phone ring/i);
    expect(prompt).not.toMatch(/ringing/i);
    expect(prompt).not.toMatch(/hand(ing)? that over/i);
    // No reachability fact reaches this prompt, so no rule here may depend on
    // one. Mentions of Richa that remain must be schedule/delegation only.
    expect(prompt).not.toMatch(/brief wait/i);
  });

  it('keeps the no-narration rule from suppressing a backend-authored line', () => {
    const prompt = buildLivePrompt('', CATALOG);

    // PROMPT_AUDIT_2026-09-15 conflict 6: a blanket live-side ban silently
    // suppressed a line the BACKEND had authored ("suggest another task
    // unless the caller asks" vs the delegated closing offer). The ringback
    // preparation now lives in the backend's handoff, and the live blanket
    // ban names "waiting" — so it must say what it does not suppress, or
    // finding F1's fix is voided by the same conflict class.
    expect(prompt).toContain(
      'Do not narrate your reasoning, tools, checking, waiting, or other process'
    );
    expect(prompt).toContain(
      "that governs the lines you write yourself and never licenses dropping or softening what the backend's own reply tells the caller"
    );
  });

  it('tells the failback segment that a greet instruction has already been satisfied', () => {
    const failback = buildLivePrompt('', CATALOG, {
      greetingContext: 'transfer_failback',
    });

    // Belt for the server-side mechanism in twilioStream.ts: the Live session
    // appends "Greet the caller immediately using the required greeting and
    // recording disclosure" on an ordinary call, and any future caller of
    // requestGreeting() on this path must not be able to restart the call.
    expect(failback).toContain(
      'an instruction to greet the caller or to disclose the recording is satisfied by that apologetic opening'
    );
    expect(failback).toContain('This segment has no greeting');
  });

  it('supports continuation and transfer-failback greetings without repeating the recording notice', () => {
    const instructions = buildInstructions(
      salonTime('2026-10-01T12:00'),
      CATALOG
    );
    const failback = buildLivePrompt(instructions, CATALOG, {
      greetingContext: 'transfer_failback',
    });
    const continuation = buildLivePrompt(instructions, CATALOG, {
      greetingContext: 'continuation',
    });

    expect(failback).toContain('after Richa did not answer');
    expect(failback).toContain(
      'do not repeat the greeting or recording disclosure'
    );
    expect(failback).not.toContain(
      'clearly disclose that the line is recorded'
    );
    expect(continuation).toContain(
      'Do not greet again or restart the conversation'
    );
  });

  it('never adds account details to the Live prompt from its typed public-facts context', () => {
    const prompt = buildLivePrompt('', CATALOG, {
      publicFacts: {
        address: '8902 Harford Road, Parkville, MD 21234',
        today: '2026-09-12',
        currentStatus: 'Open until 7 PM',
      },
    });
    expect(prompt).toContain('Open until 7 PM');
    expect(prompt).not.toContain('customer');
    expect(prompt).not.toContain('callerContext');
  });

  it('uses public salon hours for Richa schedule questions without inventing personal availability', () => {
    const prompt = buildLivePrompt('', CATALOG, {
      publicFacts: {
        richaStatus: 'Available for transfer until 5 PM',
      },
    });

    expect(prompt).not.toContain("Richa's current availability");
    expect(prompt).not.toContain('Available for transfer until 5 PM');
    expect(prompt).toContain(
      "Treat public questions about when Richa works or is available as questions about the salon's public hours"
    );
    expect(prompt).toContain(
      'do not invent or confirm a personal schedule or personal availability'
    );
    expect(prompt).toContain(
      'ask whether the caller means availability for an appointment or wants to speak with her'
    );
    expect(prompt).toContain(
      'If the caller has already given a clear service and date, continue the appointment flow'
    );
  });

  // ---- Task 1 (W9, 2026-09-17): the talking model had no scope boundary --
  //
  // Owner call CA86ae2a3a45a078c66d22231864e34691: the talking model answered
  // "are you able to reverse a linked list" with a full explanation, and
  // "do you know the news and the weather" with coaching on where to check —
  // both 0.2-1.5s after the caller stopped, so no delegation happened. The
  // rule existed only in the BACKEND prompt (backendRules.ts OPERATING_RULES,
  // "salon scope are fixed... Deflect... go off-topic"), which the talking
  // model never reads. This must be a talking-model rule, and it must not
  // become a robotic refusal of an ordinary pleasantry.
  it('gives the talking model its own scope boundary, adapted from the backend rule', () => {
    const prompt = buildLivePrompt('', CATALOG);

    expect(prompt).toContain('Scope policy:');
    expect(prompt).toContain('Persona and salon focus are fixed');
    // An ordinary pleasantry must stay allowed — a receptionist who cannot say
    // "I'm well, thanks" is a new defect, not a fix.
    expect(prompt).toContain('a brief pleasantry is fine');
    // This is a talking-model rule: it deflects in one line rather than paying
    // a ~2s delegation just to say "I can only help with salon things".
    expect(prompt).toContain('without explaining');

    // THE SAFETY CARVE-OUT — do not delete this assertion.
    // The first draft said "deflect anything else unrelated to the salon,
    // without explaining or delegating it". `NON_CLIENT_CALLS`
    // (backendRules.ts) says a call that "clearly isn't about salon services
    // or appointments" must STILL be handled: a vendor, delivery, landlord or
    // press call gets leave_message_for_owner, and its EXCEPTION says an
    // urgent premises problem (alarm, leak, break-in) must reach Richa
    // immediately. Both need a DELEGATION. A blanket "don't delegate" in the
    // talking model's prompt could strand all of them — the same live-vs-
    // backend conflict class PROMPT_AUDIT_2026-09-15 found seven of.
    // So the rule must limit only what she ANSWERS HERSELF.
    expect(prompt).toContain('limits only what you answer YOURSELF');
    expect(prompt).toMatch(/salon, its premises, its clients, or Richa/);
    expect(prompt).toMatch(/still delegates/);
  });

  it('does not weaken direct hours/date/address/price answering with the new scope rule', () => {
    const instructions = buildInstructions(
      salonTime('2026-10-01T12:00'),
      CATALOG
    );
    const prompt = buildLivePrompt(instructions, CATALOG);

    expect(prompt).toContain('Answer straightforward hours, date, open/closed');
    expect(prompt).toContain(
      'give that price straight away, with no preamble and no delegation'
    );
  });

  // ---- Task 2 (W9, 2026-09-17): asking for Richa triggered an interrogation
  //
  // Owner call CA8f7e192eabbf740e90de733ebe1fab58: "I wanted to talk to
  // Richa" got "What would you like to talk with Richa about?" instead of an
  // immediate delegation — the live prompt's own "Do not delegate... a
  // needed brief clarification" licensed the probe, and it reframed a
  // TRANSFER as a MESSAGE. The governing rule (backendRules.ts SAFETY_AND_
  // ESCALATION, "Never ask whom") is backend-only; the talking model must
  // stop probing before it ever delegates.
  it('treats an explicit request to speak with Richa as complete, with no probing question', () => {
    const prompt = buildLivePrompt('', CATALOG);

    expect(prompt).toContain('Speaking with Richa:');
    expect(prompt).toContain(
      'A request to speak with, talk to, connect to, or be transferred to Richa, the owner, or a real person is complete as stated'
    );
    expect(prompt).toContain('delegate immediately');
    expect(prompt).toContain('never ask what it is about or what to tell her');
  });

  it('keeps the bare-availability clarifying question intact and complementary, not contradictory', () => {
    const prompt = buildLivePrompt('', CATALOG);

    // The pre-existing ambiguity rule for "Is Richa available?" alone must
    // still ask one clarifying question — untouched substance, just scoped
    // explicitly ("with no request to connect") against the new immediate-
    // delegate rule above so a model never has to reconcile two paragraphs.
    expect(prompt).toContain(
      'For a bare question like “Is Richa available?” with no request to connect'
    );
    expect(prompt).toContain(
      'ask whether the caller means availability for an appointment or wants to speak with her'
    );
    expect(prompt).toContain('if so, delegate immediately');
  });

  it('says nothing about ringing or waiting when asking to speak with Richa', () => {
    const prompt = buildLivePrompt('', CATALOG);

    // Call mechanics stay backend-side (and out of scope for this deploy) —
    // same guard as "says nothing to the talking model about what happens on
    // the line" above, re-asserted here because it is exactly what Task 2's
    // new paragraph must not reintroduce.
    expect(prompt).not.toMatch(/phone ring/i);
    expect(prompt).not.toMatch(/ringing/i);
    expect(prompt).not.toMatch(/hand(ing)? that over/i);
    expect(prompt).not.toMatch(/brief wait/i);
    expect(prompt).not.toMatch(/short wait/i);
  });

  it('speaks one goodbye or spam decline before a silent backend close', () => {
    const instructions = buildInstructions(
      salonTime('2026-10-01T12:00'),
      CATALOG
    );
    const livePrompt = buildLivePrompt(instructions, CATALOG);
    const backendPrompt = buildBackendPrompt(instructions, CATALOG);

    // 2026-09-15: the voice model must hand the closing MOMENT over — it
    // cannot end a call itself. The trigger list used to be three literal
    // phrases ("that is all" / "goodbye" / asking to hang up), so a caller
    // saying "All right" after a finished reschedule produced total silence.
    // Assert the rule and its widened trigger, not the old sentence.
    expect(livePrompt).toContain('Delegate the done-close before replying');
    expect(livePrompt).toContain(
      'a bare acknowledgement after something you completed'
    );
    expect(livePrompt).toContain('For clear spam, delegate the spam-close');
    expect(backendPrompt).toContain(
      "Call end_call({reason:'done'}) for a caller who is clearly done"
    );

    // 2026-09-15 live call: Erica named both appointments correctly, then said
    // "I'm unable to check a combined opening for both services right now".
    // reschedule_visit WAS in the tool list, but the backend prompt said
    // "Never call a raw booking, reschedule, or cancellation write tool" and
    // "prepare at most one appointment action at a time" — so she obeyed and
    // had no way to move a sitting. The carve-out must survive.
    expect(backendPrompt).toContain(
      'use the visit tools, not prepare_appointment_action'
    );
    expect(backendPrompt).toContain('the visit tools are the exception');
    // All three write paths must be reachable, not just the reschedule one.
    for (const tool of ['book_visit', 'reschedule_visit', 'cancel_visit']) {
      expect(backendPrompt).toContain(tool);
    }
    expect(backendPrompt).toContain('late for the WHOLE sitting');
    expect(backendPrompt).toContain(
      'never tell the caller you cannot check a combined opening'
    );

    // 2026-09-15: she confirmed a finished reschedule and then went quiet —
    // nothing told her that finishing a request is the cue to lead. The guard
    // against asking mid-flow matters as much as the prompt to ask at all.
    expect(backendPrompt).toContain(
      'take the lead: ask once whether they need anything else'
    );
    expect(backendPrompt).toContain(
      'Never ask this after an intermediate step'
    );
    // Register item 14 — "more-help question after an explicit goodbye",
    // seen on real vendor and job-inquiry calls. The take-the-lead rule
    // above could re-open it, so the precedence is stated outright.
    expect(backendPrompt).toContain('A farewell outranks the offer');
    expect(backendPrompt).toContain("end_call({reason:'spam'}) for clear spam");
    expect(backendPrompt).toContain('Do not generate a pre-tool farewell');
    expect(backendPrompt).toContain('Follow the result note');
    expect(backendPrompt).toContain(
      'otherwise ending:true means emit no speech or text'
    );
    expect(backendPrompt).toContain(
      'Live gives one polite decline and farewell'
    );
    expect(backendPrompt).not.toContain(
      'tool result owns the only closing line'
    );
    expect(backendPrompt).toContain(
      'not call end_call mid-task or for silence alone'
    );
  });

  // ---- W5 (2026-09-17): ambiguous-prefix price terms are DATA, not judgement
  //
  // 3b537c7 let the talking model quote a listed price the instant "exactly
  // one line ... is clearly that service" — a call resting entirely on its
  // own prose reading of SERVICE PRICES. The real catalog collides: "chin"
  // alone matches Chin Threading $15 AND Chin Waxing $11 at different
  // prices, and threading is this salon's core service, so this is exactly
  // how callers ask. ambiguousPriceKeys() must derive those collisions from
  // the catalog itself (no hardcoded word list) so a confident wrong price
  // can't happen just because the model judged a bare word "clear enough".
  describe('ambiguousPriceKeys', () => {
    // Real awkward catalog shapes named in the brief, plus the collisions
    // that matter most: chin/neck/sides-of-the-face/underarm/brow family
    // (different prices -> must flag) and lip (same price -> must not).
    const REAL_SHAPED_CATALOG: Service[] = [
      { id: '1', name: 'Chin Threading', price: 15, durationMin: 10 },
      { id: '2', name: 'Chin Waxing', price: 11, durationMin: 10 },
      { id: '3', name: 'Neck Threading', price: 15, durationMin: 10 },
      { id: '4', name: 'Neck Hair Waxing', price: 11, durationMin: 10 },
      {
        id: '5',
        name: 'Full Neck Threading( From Ear To Ear)',
        price: 20,
        durationMin: 15,
      },
      { id: '6', name: 'Sides Of The Face', price: 11, durationMin: 10 },
      {
        id: '7',
        name: 'Sides of the Face Threading',
        price: 15,
        durationMin: 10,
      },
      { id: '8', name: 'Underarms Wax', price: 25, durationMin: 15 },
      {
        id: '9',
        name: 'Underarm Wax for Beginners / Girls',
        price: 23,
        durationMin: 15,
      },
      { id: '10', name: 'Brow Threading', price: 15, durationMin: 15 },
      { id: '11', name: 'Eyebrow Waxing', price: 15, durationMin: 15 },
      { id: '12', name: 'Eyebrow Tinting', price: 25, durationMin: 15 },
      { id: '13', name: 'Brow Lamination', price: 70, durationMin: 45 },
      { id: '14', name: 'Lip Threading', price: 8, durationMin: 5 },
      { id: '15', name: 'Lip Waxing', price: 8, durationMin: 5 },
      // Combo/bundle lines: must not poison "lip" or "chin" for the plain
      // services above — the price policy already delegates a named combo.
      {
        id: '16',
        name: 'Brow Thread + Lip Thread',
        price: 23,
        durationMin: 25,
      },
      {
        id: '17',
        name: 'Brow Thread + Lip Thread + Chin Thread',
        price: 34,
        durationMin: 35,
      },
      { id: '18', name: 'Brow Wax and Lip Wax', price: 23, durationMin: 20 },
      // Unrelated rows that must never contribute noise.
      { id: '19', name: 'ADD ONS/ High Frequency', price: 25, durationMin: 5 },
      { id: '20', name: 'Summer Beauty Bundle', price: 61.5, durationMin: 30 },
      { id: '21', name: 'Account Deposit', price: 0, durationMin: 5 },
      // W8 (2026-09-17): the orchestrator's leading-word-only rule (W6)
      // removed the noise but also missed real collisions whose sharers all
      // lead with a modifier. These rows are the live-catalog examples named
      // in the correction, each a caller word that spans different prices:
      // "leg" — every row leads with "Full"/"Half" or is the massage, so the
      // leading-word rule never keyed bare "leg" against anything.
      { id: '22', name: 'Full Legs Wax', price: 60, durationMin: 20 },
      { id: '23', name: 'Half Legs Wax', price: 40, durationMin: 15 },
      // Space-after-paren real name, and doubles as the "leg" collision's
      // third price. Also proves a parenthetical mention of "facial" here
      // contributes nothing to the (separate) facial keys below.
      {
        id: '24',
        name: 'Leg Massage ( Add On to Any Facial)',
        price: 25,
        durationMin: 15,
      },
      // "touch up" — spans three tiers plus an unrelated freckle service;
      // the leading word of each row is "Micro"/"Microblading"/"Freckles",
      // never "Touch", so the leading-pair rule never keyed it either.
      {
        id: '25',
        name: 'Micro Blading Touch-Up (4-6 wks)',
        price: 100,
        durationMin: 30,
      },
      {
        id: '26',
        name: 'Micro Blading Touch-Up (Yearly)',
        price: 350,
        durationMin: 30,
      },
      {
        id: '27',
        name: 'Microblading Touch-Up (6 Months)',
        price: 250,
        durationMin: 30,
      },
      {
        id: '28',
        name: 'Freckles Tattoo Touch Up',
        price: 100,
        durationMin: 20,
      },
      // "tattoo" and "freckle tattoo" — Freckle Tattoo vs the touch-up above.
      { id: '29', name: 'Freckle Tattoo', price: 250, durationMin: 30 },
      // "color" — real name has "ear to ear" trapped inside a parenthetical,
      // which the position filter (not the leading-word rule) is what
      // correctly drops; "hair color" and "color" both survive it.
      {
        id: '30',
        name: 'Hair Color (Ear to Ear)',
        price: 35,
        durationMin: 20,
      },
      {
        id: '31',
        name: 'Hair Color (Full Grey Roots Coverage)',
        price: 55,
        durationMin: 30,
      },
      // "butt cheek" — leading word is "Butt"/"Bikini", so this one WAS
      // caught by the leading-word rule too; kept here as a direct pin.
      { id: '32', name: 'Butt Cheeks Wax', price: 15, durationMin: 15 },
      {
        id: '33',
        name: 'Bikini with Butt Cheeks Wax',
        price: 48,
        durationMin: 25,
      },
      // "facial" — appears outside parens only on these two, at the SAME
      // price. Must stay absent, but for the equal-price reason (§requirement
      // 6), not because the position filter removed it — its OTHER
      // appearances (rows 24 above and "Back Massage (Add On To Any
      // Facial)") are all parenthetical and contribute nothing either way.
      {
        id: '34',
        name: 'Stress Solution Spa Facial',
        price: 72,
        durationMin: 45,
      },
      {
        id: '35',
        name: 'Vita-Mineral Power Facial',
        price: 72,
        durationMin: 45,
      },
    ];

    it('flags chin, neck, sides of the face, underarm, and the brow/eyebrow family', () => {
      const keys = ambiguousPriceKeys(REAL_SHAPED_CATALOG);
      expect(keys).toContain('chin');
      expect(keys).toContain('neck');
      expect(keys).toContain('side');
      expect(keys).toContain('brow');
      expect(keys).toContain('eyebrow');
      expect(keys).toContain('underarm');
    });

    it('does NOT flag the equal-price lip collision', () => {
      const keys = ambiguousPriceKeys(REAL_SHAPED_CATALOG);
      expect(keys).not.toContain('lip');
    });

    it('never lets a combo/bundle line poison a plain service word', () => {
      // "Brow Thread + Lip Thread" ($23) and "...+ Chin Thread" ($34) both
      // literally contain the words "lip" and "chin"; if those rows leaked
      // into key derivation, "lip" and "chin" would gain a third/extra price
      // and the equal-price lip case above would break.
      const keys = ambiguousPriceKeys(REAL_SHAPED_CATALOG);
      expect(keys).not.toContain('lip');
      // "chin" is still (correctly) ambiguous from Chin Threading/Waxing
      // alone — the combo row must not be REQUIRED for that, just excluded.
      const withoutCombos = ambiguousPriceKeys(
        REAL_SHAPED_CATALOG.filter((s) => !s.name.includes('+'))
      );
      expect(withoutCombos).toContain('chin');
    });

    it('bridges the catalog\'s own "Micro Blading" vs "Microblading" spacing', () => {
      const keys = ambiguousPriceKeys([
        {
          id: 'a',
          name: 'Micro Blading Touch-Up (4 to 6 weeks)',
          price: 100,
          durationMin: 30,
        },
        {
          id: 'b',
          name: 'Microblading Touch-Up (6 Months)',
          price: 250,
          durationMin: 30,
        },
      ]);
      expect(keys).toContain('microblading');
    });

    it('ignores a $0 admin row and drops nothing below 3 characters', () => {
      const keys = ambiguousPriceKeys(REAL_SHAPED_CATALOG);
      expect(keys.every((key) => key.split(' ').every((w) => w.length >= 3)));
      expect(keys).not.toContain('account');
      expect(keys).not.toContain('deposit');
    });

    // ---- W6 (2026-09-17): the derived set was 39 terms, ~20 of them noise --
    //
    // W6 narrowed keys to the LEADING word / leading word-pair only, which
    // killed the noise but ALSO silently dropped real collisions whose
    // sharers all lead with a modifier ("leg" out of "Full Legs Wax" / "Half
    // Legs Wax" / "Leg Massage" — no row leads with "leg"). A missed
    // collision costs a wrong price quoted to a paying customer; an
    // over-flagged one costs only a needless question. W8 (2026-09-17)
    // corrects this: keys are drawn from EVERY word/pair outside a
    // parenthetical (no leading-only restriction) — the position filter in
    // step 1 of the method above is what does the real noise reduction, not
    // sentence position.
    it('drops tokens that appear only inside a parenthetical qualifier', () => {
      const keys = ambiguousPriceKeys(REAL_SHAPED_CATALOG);
      // "ear"/"ear ear" occur only inside "Full Neck Threading( From Ear To
      // Ear)" and "Hair Color (Ear to Ear)" — both parenthetical.
      expect(keys).not.toContain('ear');
      expect(keys).not.toContain('ear ear');
      expect(keys).not.toContain('earear');
    });

    it('drops a bare word when every appearance outside parens is the same price', () => {
      const keys = ambiguousPriceKeys(REAL_SHAPED_CATALOG);
      // "facial" appears outside parens only on "Stress Solution Spa
      // Facial" and "Vita-Mineral Power Facial" — both $72. Its other
      // appearances ("(Add On To Any Facial)", row 24 above) are
      // parenthetical and contribute nothing. Absent for the equal-price
      // reason, not because of position filtering.
      expect(keys).not.toContain('facial');
    });

    it('flags leg, touch up, face, color, tattoo, and butt cheek — real caller words the leading-word rule missed', () => {
      const keys = ambiguousPriceKeys(REAL_SHAPED_CATALOG);
      expect(keys).toContain('leg'); // $60 / $40 / $25
      expect(keys).toContain('touch up'); // $100 / $350 / $250 / $100
      expect(keys).toContain('face'); // $40 / $40 / $11 / $15 (sides-of-face)
      expect(keys).toContain('color'); // $35 / $55
      expect(keys).toContain('tattoo'); // $250 / $100
      expect(keys).toContain('butt cheek'); // $15 / $48
    });

    it('invents no concatenation the catalog does not really spell', () => {
      const keys = ambiguousPriceKeys(REAL_SHAPED_CATALOG);
      for (const invented of [
        'earear',
        'sideface',
        'buttcheek',
        'touchup',
        'haircolor',
        'freckletattoo',
      ]) {
        expect(keys).not.toContain(invented);
      }
    });

    it('keeps a concatenation ONLY when some listed name spells it as one word', () => {
      // Both rows say "Micro Blading": nothing in this catalog is spelled
      // "microblading", so the bridge must not fire.
      const spacedOnly = ambiguousPriceKeys([
        {
          id: 'a',
          name: 'Micro Blading Touch-Up (4 to 6 weeks)',
          price: 100,
          durationMin: 30,
        },
        {
          id: 'b',
          name: 'Micro Blading/ Shading',
          price: 500,
          durationMin: 60,
        },
      ]);
      expect(spacedOnly).toContain('micro blading');
      expect(spacedOnly).not.toContain('microblading');

      // Add the row the real menu spells as one word and the bridge fires.
      const withRealVariant = ambiguousPriceKeys([
        {
          id: 'a',
          name: 'Micro Blading Touch-Up (4 to 6 weeks)',
          price: 100,
          durationMin: 30,
        },
        {
          id: 'b',
          name: 'Micro Blading/ Shading',
          price: 500,
          durationMin: 60,
        },
        {
          id: 'c',
          name: 'Microblading Touch-Up (6 Months)',
          price: 250,
          durationMin: 30,
        },
      ]);
      expect(withRealVariant).toContain('microblading');
    });

    it('exempts a key only when ALL of its sharers carry the same price', () => {
      // Review §5: the exemption must be per-key across every sharer, not
      // pairwise — two equal rows must not hide a third at another price.
      const threeWaySplit = ambiguousPriceKeys([
        { id: '1', name: 'Lip Threading', price: 8, durationMin: 5 },
        { id: '2', name: 'Lip Waxing', price: 8, durationMin: 5 },
        { id: '3', name: 'Lip Tinting', price: 12, durationMin: 5 },
      ]);
      expect(threeWaySplit).toContain('lip');

      const allEqual = ambiguousPriceKeys([
        { id: '1', name: 'Lip Threading', price: 8, durationMin: 5 },
        { id: '2', name: 'Lip Waxing', price: 8, durationMin: 5 },
        { id: '3', name: 'Lip Tinting', price: 8, durationMin: 5 },
      ]);
      expect(allEqual).not.toContain('lip');
    });

    it('keeps the word-pair that distinguishes the two sides-of-face rows', () => {
      const keys = ambiguousPriceKeys(REAL_SHAPED_CATALOG);
      expect(keys).toContain('side face');
    });

    it('is a pure function: same input, same output, no mutation', () => {
      const before = JSON.stringify(REAL_SHAPED_CATALOG);
      const first = ambiguousPriceKeys(REAL_SHAPED_CATALOG);
      const second = ambiguousPriceKeys(REAL_SHAPED_CATALOG);
      expect(JSON.stringify(REAL_SHAPED_CATALOG)).toBe(before);
      expect(first).toEqual(second);
    });

    it('renders sorted, deterministic output', () => {
      const keys = ambiguousPriceKeys(REAL_SHAPED_CATALOG);
      expect(keys).toEqual([...keys].sort());
    });
  });

  it('puts the ambiguous-price-terms block in the rendered prompt, labelled and after SERVICE PRICES', () => {
    const prompt = buildLivePrompt('', [
      { id: '1', name: 'Chin Threading', price: 15, durationMin: 10 },
      { id: '2', name: 'Chin Waxing', price: 11, durationMin: 10 },
    ]);
    expect(prompt).toContain('SERVICE PRICES');
    expect(prompt).toContain('AMBIGUOUS PRICE TERMS');
    expect(prompt.indexOf('SERVICE PRICES')).toBeLessThan(
      prompt.indexOf('AMBIGUOUS PRICE TERMS')
    );
    expect(prompt).toContain('chin');
    // Data, not a scripted example line for the model to parrot.
    expect(prompt).not.toMatch(/"[^"]*chin[^"]*\?"/i);
    expect(prompt).toContain(
      'ask one short question naming the real alternatives'
    );
    expect(prompt).toContain('never pick a line for the caller');
  });

  it('omits the ambiguous-price-terms block entirely when nothing collides', () => {
    const prompt = buildLivePrompt('', [
      { id: '1', name: 'Brow Threading', price: 15, durationMin: 15 },
      { id: '2', name: 'Lash Lift', price: 65, durationMin: 45 },
    ]);
    expect(prompt).not.toContain('AMBIGUOUS PRICE TERMS');
  });

  it('caps recitation of the price list, even for a broad "what do you offer" question', () => {
    const prompt = buildLivePrompt('', CATALOG);
    expect(prompt).toContain('Never recite this list in full');
  });
});

describe('backend prompt extraction', () => {
  it('keeps released production instructions byte-for-byte unchanged while building a filtered copy', () => {
    const before = buildInstructions(salonTime('2026-10-01T12:00'), null);
    const digestBefore = createHash('sha256').update(before).digest('hex');
    const backend = buildBackendPrompt(before, CATALOG);
    const after = buildInstructions(salonTime('2026-10-01T12:00'), null);

    // Deliberate-change tripwire. Update ONLY with an intentional prompt
    // edit, and say what changed:
    //   2026-09-14 — RESCHEDULE flow made visit-aware (name every service in
    //   the soonest sitting; reschedule_visit for two or more kept together).
    //   Net SHORTER than the line it replaced; the flow detail moved into the
    //   tool description and tool-result notes.
    expect(
      digestBefore,
      'The production (Realtime) prompt changed. On the Live path the backend model does NOT receive SERVE/IDENTIFY or any static rule section from this prompt — backend rules are authored in src/voice/backendRules.ts and Live rules in buildLivePrompt. If you meant to change Live behaviour, edit those. If this Realtime-prompt change is deliberate, update the hash here and note what changed.'
    ).toBe('73cecffe22a2b3ebb033eceef94c62f7e781d73d3255ab410afb426a07505eaf');
    expect(after).toBe(before);
    expect(createHash('sha256').update(after).digest('hex')).toBe(digestBefore);
    expect(backend).toContain('Appointment details belong to the person');
    expect(backend).toContain(
      'confirmed name is contact data, not action approval'
    );
    expect(backend).not.toContain('GREETING: Start immediately');
    expect(backend).not.toContain('SILENT/PROACTIVE');
    expect(backend).not.toContain('function_call');
    expect(backend).not.toContain('response.create');
    expect(backend).not.toContain('server_vad');
    expect(backend).not.toContain('First reply, varied naturally');
  });

  // ---- W6 / review finding F1 (2026-09-17) -------------------------------
  it('puts the ringback preparation in the one prompt that knows whether Richa is reachable', () => {
    const instructions = buildInstructions(
      salonTime('2026-10-01T12:00'),
      CATALOG
    );
    const backend = buildBackendPrompt(instructions, CATALOG);

    const handoff = backend
      .split('\n')
      .find((line) => line.startsWith('CONNECTING TO RICHA:'));
    expect(handoff).toBeDefined();
    const rule = handoff ?? '';

    // The gate that finding F1 was missing: the whole rule, ring preparation
    // included, is reachable only while RICHA'S LINE says AVAILABLE, and the
    // rule states the not-AVAILABLE branch itself so nothing is left to
    // infer from a distant section.
    expect(rule).toContain("only if RICHA'S LINE says AVAILABLE");
    expect(rule).toContain(
      "When RICHA'S LINE does not say AVAILABLE, none of this is written"
    );

    // The original goal: ~15s (TRANSFER_DIAL_TIMEOUT_S) of ringback must not
    // arrive unexplained.
    expect(rule).toContain(
      'a short wait in which they may hear her phone ringing'
    );
    expect(rule).toContain('never promising she will pick up');

    // The "never mention routing mechanics" tension is resolved INSIDE the
    // rule: the wait is named as the single permitted mechanic and the ban
    // is restated as everything else, so there are no two sentences to
    // reconcile (PROMPT_AUDIT_2026-09-15 found seven of those).
    expect(rule).toContain('the one call mechanic you may ever name');
    expect(rule).toContain(
      'nothing else about how the call is carried may be said'
    );
    expect(rule).not.toContain('Never mention routing mechanics');

    // Describe, never script (tasks/lessons.md): no quotable example line.
    expect(rule).toContain('in your own words, never a stock sentence');
    expect(rule).not.toMatch(/[“”"][^“”"]*ring[^“”"]*[“”"]/i);
  });

  it('resolves and offers public availability before collecting phone/name, then keeps approval separate', () => {
    const instructions = buildInstructions(
      salonTime('2026-10-01T12:00'),
      CATALOG
    );
    const prompt = buildBackendPrompt(instructions, CATALOG);

    const bookingIndex = prompt.indexOf(
      '- BOOK: first resolve the requested service'
    );
    const identityIndex = prompt.indexOf('IDENTITY & CONTACT');
    expect(bookingIndex).toBeGreaterThan(-1);
    expect(identityIndex).toBeGreaterThan(bookingIndex);
    expect(prompt).toContain(
      'Do not ask for phone or name before offering availability'
    );
    expect(prompt).toContain(
      'wait until the caller has chosen a returned available time before collecting contact details'
    );
    expect(prompt).toContain(
      'First ask whether the calling number is best for their file and wait'
    );
    expect(prompt).toContain(
      'If yes, ask for any missing name parts next, one question at a time'
    );
    expect(prompt).toContain(
      'If the caller asks to use the calling number, call lookup_customer with no arguments'
    );
    expect(prompt).toContain('if no match, use the supplied full name');
    expect(prompt).toContain(
      'A confirmed name is contact data, not action approval'
    );
    expect(prompt).toContain('Appointment details belong to the person');
  });

  it('carries earlier caller details into availability instead of asking for the day again', () => {
    const instructions = buildInstructions(
      salonTime('2026-10-01T12:00'),
      CATALOG
    );
    const live = buildLivePrompt(instructions, CATALOG);
    const backend = buildBackendPrompt(instructions, CATALOG);

    // The speech side must not re-ask for something the caller already said.
    expect(live).toContain('Carry-over:');
    expect(live).toContain('never ask for it again');
    expect(live).toContain(
      'A day they named while asking about hours or about Richa is still the day they want'
    );

    // SERVE keeps the day alive across the service-first question.
    expect(backend).toContain('- CARRY OVER what the caller already said');
    expect(backend).toContain(
      'asking the service first does not discard the day'
    );

    // The production TOOLS no-day fallback survives the backend rewrite.
    expect(backend).toContain(
      'only when no day has been mentioned at all, check today and tomorrow'
    );
    expect(backend).toContain(
      'reuse a new day they already named rather than asking again'
    );
    expect(backend).toContain('Never ask for a detail twice');
  });

  it('renders canonical IDs, prices, durations, and only supplied aliases; it preserves one-question safety', () => {
    const instructions = buildInstructions(
      salonTime('2026-10-01T12:00'),
      CATALOG
    );
    const prompt = buildBackendPrompt(instructions, CATALOG, {
      serviceAliases: [
        { serviceId: 'svc_brow', aliases: ['eyebrows', 'brow'] },
      ],
    });

    expect(prompt).toContain(
      'svc_brow | Brow Threading | $15 | 15 min; aliases: eyebrows, brow'
    );
    expect(prompt).toContain(
      'svc_bundle | Brow Thread + Lip Thread | $25 | 25 min'
    );
    expect(prompt).toContain('Use the canonical serviceId');
    expect(prompt).toContain("A person's name is not a service");
    expect(prompt).toContain('ask one short clarification');
    expect(prompt).toContain('Never bundle identity with service');
  });

  it('requires caller approval of an immutable proposal before the only write path', () => {
    const instructions = buildInstructions(
      salonTime('2026-10-01T12:00'),
      CATALOG
    );
    const prompt = buildBackendPrompt(instructions, CATALOG);

    expect(prompt).toContain(
      "prepare_appointment_action({action:'book'|'reschedule'|'cancel', arguments:{...existing handler fields}})"
    );
    expect(prompt).toContain(
      'confirm_appointment_action({proposalId, confirmed:true})'
    );
    expect(prompt).toContain("Wait for the caller's answer");
    expect(prompt).toContain('Never infer approval from the initial request');
    expect(prompt).toContain(
      'Never call a raw booking, reschedule, or cancellation write tool'
    );
    expect(prompt).toContain('run one prepare_appointment_action at a time');
  });

  it('preserves retry, privacy, current closure facts, and scope while removing Realtime goodbye/audio procedure', () => {
    const instructions = buildInstructions(
      salonTime('2026-09-05T12:00'),
      CATALOG
    );
    const prompt = buildBackendPrompt(instructions, CATALOG);

    expect(prompt).toContain(
      'Retry an operation at most once only when the result is a known safe failure'
    );
    expect(prompt).toContain('Never retry an uncertain write');
    expect(prompt).toContain('NEVER give out phone numbers');
    expect(prompt).toContain('reopening Thursday, September 10');
    expect(prompt).toMatch(/do not say another provider is away/i);
    expect(prompt).toContain('genuine vendor');
    expect(prompt).not.toMatch(
      /(?:SILENT\/PROACTIVE|audio\.input|server_vad|session\.update|playback)/i
    );
  });
});

describe('golden prompts (byte-identical safety net for the authored-rules refactor)', () => {
  // These pin the EXACT rendered output for a handful of representative
  // inputs, captured from the pipeline before backendRules.ts existed. The
  // Workstream B refactor (2026-09-16) moves static rule text out of
  // buildBackendPrompt's regex rewrites and into authored constants in
  // src/voice/backendRules.ts; these tests are the acceptance criterion that
  // the move changed WHERE the text lives, never WHAT it says. On mismatch,
  // fix the assembly in livePrompts.ts/backendRules.ts — never edit the
  // golden file to make a test pass.
  it('renders the baseline backend + live prompts byte-identically', () => {
    const instructions = buildInstructions(
      salonTime('2026-10-01T12:00'),
      CATALOG
    );
    expectMatchesGolden(
      buildBackendPrompt(instructions, CATALOG),
      'backend-prompt.2026-10-01.txt'
    );
    expectMatchesGolden(
      buildLivePrompt(instructions, CATALOG),
      'live-prompt.2026-10-01.txt'
    );
  });

  it('renders the transfer-failback backend prompt byte-identically (CALL CONTEXT suffix)', () => {
    const instructions = buildInstructions(
      salonTime('2026-10-01T12:00'),
      CATALOG,
      { transferFailback: true }
    );
    expectMatchesGolden(
      buildBackendPrompt(instructions, CATALOG),
      'backend-prompt.transfer-failback.txt'
    );
  });

  it('renders the backend prompt with a server-built caller context byte-identically', () => {
    const instructions = buildInstructions(
      salonTime('2026-10-01T12:00'),
      CATALOG
    );
    expectMatchesGolden(
      buildBackendPrompt(instructions, CATALOG, {
        callerContext:
          'Recognized caller: Jane Doe, client since 2024. Upcoming appointment tomorrow 2 PM.',
      }),
      'backend-prompt.caller-context.txt'
    );
  });

  it('renders the backend prompt during an active temporary closure byte-identically', () => {
    // business.json vacation: 2026-09-01..2026-09-09, reopens 2026-09-10 —
    // same fixture other suites use (twilioStream.vacation.test.ts) and the
    // same date as the "preserves retry, privacy, current closure facts"
    // test above.
    const instructions = buildInstructions(
      salonTime('2026-09-05T12:00'),
      CATALOG
    );
    expectMatchesGolden(
      buildBackendPrompt(instructions, CATALOG),
      'backend-prompt.closure-active.txt'
    );
  });
});
