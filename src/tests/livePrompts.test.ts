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
    const [conversationRules] = prompt.split('\nSERVICE PRICES\n');
    expect(
      Math.ceil((conversationRules ?? prompt).length / 4)
    ).toBeLessThanOrEqual(1300);
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
      { id: 'b', name: 'Summer Beauty Bundle', price: 61.5, durationMin: 15 },
      // Real production rows. "Account Deposit is free" is a WRONG answer, not
      // a cheap one, so a $0 row must never be quotable; it falls through to
      // get_prices like any unlisted service.
      { id: 'c', name: 'Account Deposit', price: 0, durationMin: 5 },
      { id: 'd', name: 'Complimentary', price: 0, durationMin: 30 },
    ]);

    expect(prompt).toContain('- Chin Threading $15');
    expect(prompt).not.toContain('3) Chin');
    expect(prompt).toContain('- Summer Beauty Bundle $61.50');
    expect(prompt).not.toContain('Account Deposit');
    expect(prompt).not.toContain('Complimentary');
    expect(prompt).not.toContain('$0');
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

  // ---- Fix 3 (2026-09-17) ------------------------------------------------
  it('prepares the caller for the ringback before a transfer without promising one', () => {
    const prompt = buildLivePrompt('', CATALOG);

    // Production call CAb66df4eb8f3d3c4eced28f85c457a6c2: "Sure. Let me check
    // who's available" told the caller nothing about a transfer, so ~15s of
    // ringback arrived unexplained.
    expect(prompt).toContain('Reaching Richa:');
    expect(prompt).toContain('possibly hearing her phone ring');
    // The backend still owns the decision (her calling window, a closure), so
    // the line must not commit to a connection it may have to retract.
    expect(prompt).toContain('without promising that she is there');
    // Named exception, because the blanket no-narration rule would otherwise
    // silently forbid it (tasks/lessons.md).
    expect(prompt).toContain(
      'the rule against narrating your process covers every other case'
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
