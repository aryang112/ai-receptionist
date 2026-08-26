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

  it('sits in the safety region: after SAFETY & ESCALATION, before NON-CLIENT CALLS', () => {
    const instructions = buildInstructions();
    const safetyIdx = instructions.indexOf('SAFETY & ESCALATION');
    const spamIdx = instructions.indexOf('SPAM & TELEMARKETING');
    const nonClientIdx = instructions.indexOf('NON-CLIENT CALLS');
    expect(safetyIdx).toBeGreaterThan(-1);
    expect(spamIdx).toBeGreaterThan(safetyIdx);
    expect(nonClientIdx).toBeGreaterThan(spamIdx);
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

  // 2026-08-25 (Aryan): fillers are BEHAVIOR, not script — the section must
  // describe a varied, own-words filler and must not quote a canned phrase
  // (a quoted phrase gets parroted verbatim on every call).
  it('with services=null (default), the tool-first section describes filler behavior without a scripted phrase', () => {
    const instructions = buildInstructions();
    expect(instructions).toContain('call get_prices WITH the serviceName');
    expect(instructions).toMatch(/filler in your own words/);
    expect(instructions).not.toContain('say a quick filler ("');
    expect(instructions).toContain('Quote ONLY what get_prices returns');
  });
});

// LIVE FIX 2026-08-23: today's open/closed status is precomputed server-side
// — a live Sunday call showed the model anchoring on the weekly table's first
// row and quoting Monday's hours as "today". The prompt must hand over
// finished facts, never weekday homework.
describe("buildInstructions — TODAY'S STATUS precompute", () => {
  it('Sunday afternoon: CLOSED all day, next open tomorrow, tomorrow = Monday hours', () => {
    const instructions = buildInstructions(at('2026-08-23T17:37')); // Sunday
    expect(instructions).toMatch(
      /today is Sunday and the salon is CLOSED all day/
    );
    expect(instructions).toMatch(
      /At this moment we are CLOSED — next open tomorrow at 12 PM/
    );
    expect(instructions).toMatch(/Tomorrow \(Monday\): 12 PM to 5 PM/);
  });
  it('Tuesday 2pm: open today and OPEN right now', () => {
    const instructions = buildInstructions(at('2026-08-25T14:00')); // Tuesday
    expect(instructions).toMatch(
      /today is Tuesday and the salon is open 12 PM to 7 PM/
    );
    expect(instructions).toMatch(/At this moment we are OPEN/);
  });
  it('Tuesday 9pm: open today but CLOSED right now', () => {
    const instructions = buildInstructions(at('2026-08-25T21:00'));
    expect(instructions).toMatch(/At this moment we are CLOSED/);
  });
});

// 2026-08-24 — lessons from Erica's first real customer call (Holly, message
// mode): (1) she took a "can't make my appointment" purely as a message and
// never offered to reschedule/cancel — SELF-SERVICE FIRST rule; (2) she said
// the scripted "let me get Richa for you" handoff sentence while the salon
// was CLOSED, then had to walk it back — the handoff script is now gated to
// live-transfer-actually-possible, and the closed-hours rule is absolute.
describe('buildInstructions — TRANSFER self-service + closed-hours rules', () => {
  it('has the SELF-SERVICE FIRST rule: intent over keywords, tools before message-taking', () => {
    const instructions = buildInstructions();
    expect(instructions).toContain('SELF-SERVICE FIRST');
    // callers don't say the magic words — the rule must call that out
    expect(instructions).toMatch(/almost never use words like "cancel"/);
    // offer another time before accepting a cancellation
    expect(instructions).toMatch(/first be offered another time/);
  });

  it('gates the scripted handoff sentence to live-transfer-actually-possible', () => {
    const instructions = buildInstructions();
    expect(instructions).toMatch(
      /ONLY when a live transfer is actually possible RIGHT NOW/
    );
  });

  it('greeting is never re-delivered after a noise/brief-word interruption (both variants)', () => {
    // 2026-08-24 post-deploy calls: pickup noise triggered barge-in and the
    // model re-delivered the greeting ("stops, then continues"). The rule
    // must exist in the standard AND transfer-failback greeting paragraphs.
    const standard = buildInstructions();
    expect(standard).toMatch(/never deliver the greeting a second time/);
    const failback = buildInstructions(undefined, null, {
      transferFailback: true,
    });
    expect(failback).toMatch(/never deliver the opening again/);
  });

  it('closed-hours: never promise a live transfer, FYI Richa after self-handled changes', () => {
    const instructions = buildInstructions();
    expect(instructions).toMatch(/NEVER say "let me get her"/);
    expect(instructions).toMatch(
      /handled a schedule change yourself while the salon is closed/
    );
  });
});

// 2026-08-24 (the Holly call, round 2): the transfer gate moved from salon
// hours to Richa's waking hours (isWithinTransferWindow) — and a caller who
// explicitly asks for Richa gets honored promptly, not probed. The RICHA'S
// LINE status is precomputed server-side (never re-derived by the model),
// same principle as TODAY'S STATUS.
describe("buildInstructions — transfer window (RICHA'S LINE)", () => {
  it('inside the window (Mon 11:46am, salon still closed): line says POSSIBLE', () => {
    const instructions = buildInstructions(at('2026-08-24T11:46'));
    expect(instructions).toMatch(/RICHA'S LINE/);
    expect(instructions).toMatch(
      /live transfer to Richa is POSSIBLE right now/
    );
    // ...even though the salon itself is CLOSED at that moment
    expect(instructions).toMatch(/At this moment we are CLOSED/);
  });

  it('outside the window (Tue 10pm): line says NOT possible', () => {
    const instructions = buildInstructions(at('2026-08-25T22:00'));
    expect(instructions).toMatch(
      /live transfer to Richa is NOT possible right now/
    );
  });

  it('asked-for-Richa fast path: honor promptly, never promise-then-walk-back', () => {
    const instructions = buildInstructions();
    expect(instructions).toMatch(/ASKED FOR RICHA/);
    expect(instructions).toMatch(/honor it promptly/);
    expect(instructions).toMatch(/never promise the transfer first/);
  });
});

// 2026-08-24 — owner-approved GREETING compression, and a fix for a real
// call pattern: a caller before opening time asking to book "today" must
// hear openings, not a volunteered "we're closed right now."
describe('buildInstructions — GREETING compression + never-volunteer-closed', () => {
  it('greeting: compressed recorded-line phrasing, no old scripted line', () => {
    const instructions = buildInstructions();
    expect(instructions).toContain('on a recorded line');
    expect(instructions).toContain('What can I do for you?');
    expect(instructions).not.toContain('this call may be recorded');
  });

  it('never volunteers closed status — pre-open booking goes straight to availability', () => {
    const instructions = buildInstructions();
    expect(instructions).toMatch(/NEVER volunteer that we're currently closed/);
    expect(instructions).toContain(
      'without commenting on us being closed right now'
    );
  });
});

// 2026-08-24 — transfer failback. When the live transfer rings out, the caller
// is reconnected to a fresh Erica session mid-call (transferFailed=1). That
// session must NOT re-greet them: they already heard the greeting and the
// recording notice on segment 1 of the SAME phone call. Exactly one paragraph
// changes — everything else is byte-identical, which is what makes this safe
// to ship on a prompt this load-bearing.
describe('buildInstructions — transfer failback greeting', () => {
  const NOW = at('2026-10-01T14:00'); // no vacation block either side

  it('replaces the greeting with an apologize-and-take-a-message opening', () => {
    const failback = buildInstructions(NOW, null, { transferFailback: true });
    expect(failback).toContain('GREETING (transfer failback');
    expect(failback).toMatch(/her phone did not pick up/);
    expect(failback).toMatch(/reaches her as a text/);
    // The standard greeting — recorded-line notice and all — must be GONE:
    // repeating it mid-call is the exact defect this branch exists to avoid.
    expect(failback).not.toContain('on a recorded line');
    expect(failback).not.toContain('What can I do for you?');
    expect(failback).not.toMatch(/^GREETING: Open the call yourself/m);
  });

  it('describes the opening instead of scripting it — no quotable sentence to parrot (lessons.md)', () => {
    const failback = buildInstructions(NOW, null, { transferFailback: true });
    const greeting = failback.slice(
      failback.indexOf('GREETING (transfer failback'),
      failback.indexOf('IDENTIFY (required before any account action')
    );
    // A double-quoted fragment inside the paragraph would be a ready-made
    // line the model can lift verbatim into the wrong moment.
    expect(greeting).not.toMatch(/"/);
  });

  it('changes ONLY the greeting paragraph — every other section is byte-identical', () => {
    const standard = buildInstructions(NOW);
    const failback = buildInstructions(NOW, null, { transferFailback: true });
    expect(failback).not.toBe(standard);

    const upTo = (s: string) => s.slice(0, s.indexOf('GREETING'));
    const from = (s: string) =>
      s.slice(s.indexOf('IDENTIFY (required before any account action'));
    expect(upTo(failback)).toBe(upTo(standard));
    expect(from(failback)).toBe(from(standard));

    // Spot-check one untouched section explicitly: SAFETY & ESCALATION still
    // reads exactly as it does on a normal call.
    const safetySection = (s: string) =>
      s.slice(
        s.indexOf('═══ SAFETY & ESCALATION ═══'),
        s.indexOf('═══ CURRENT STATUS')
      );
    expect(safetySection(failback)).toBe(safetySection(standard));
    expect(safetySection(standard).length).toBeGreaterThan(0);
  });

  it('default/omitted opts keep the standard greeting (no behavior change for normal calls)', () => {
    expect(buildInstructions(NOW, null, {})).toBe(buildInstructions(NOW));
    expect(buildInstructions(NOW, null, { transferFailback: false })).toBe(
      buildInstructions(NOW)
    );
  });
});

// N1: NON-CLIENT CALLS section (2026-08-25, Aryan-approved after the 8/25
// job-seeker call) — one triage principle for calls that aren't about salon
// services: brief + warm, one pointer, no transfer, wrap up. Job seekers get
// the website pointer; premises emergencies are the explicit exception.
describe('buildInstructions — NON-CLIENT CALLS (N1)', () => {
  it('includes the section with the job-seeker website pointer', () => {
    const instructions = buildInstructions();
    expect(instructions).toContain('NON-CLIENT CALLS');
    expect(instructions).toMatch(/hiring/i);
    expect(instructions).toMatch(/website/i);
    expect(instructions).toMatch(/wrong number/i);
  });

  it('carves out premises emergencies as NOT off-topic', () => {
    const instructions = buildInstructions();
    expect(instructions).toMatch(/EXCEPTION[\s\S]*premises/);
    expect(instructions).toMatch(/break-in/);
  });
});

// P1: PRIVACY section (same approval) — blanket never-disclose: no phone
// numbers for anyone, no schedules/whereabouts, appointments only discussed
// with the identified owner of the appointment.
describe('buildInstructions — PRIVACY (P1)', () => {
  it('includes the never-give-out-numbers and whereabouts rules', () => {
    const instructions = buildInstructions();
    expect(instructions).toContain('PRIVACY');
    expect(instructions).toMatch(/NEVER give out phone numbers/i);
    expect(instructions).toMatch(/schedule or whereabouts/i);
    expect(instructions).toMatch(/whether anyone is at the salon/i);
  });

  it('restricts appointment details to the identified owner of the appointment', () => {
    const instructions = buildInstructions();
    expect(instructions).toMatch(/someone ELSE's appointment/);
    expect(instructions).toMatch(/don't confirm or deny/i);
  });

  it('is present in the transfer-failback variant too (byte-identical outside the greeting)', () => {
    const failback = buildInstructions(undefined, null, {
      transferFailback: true,
    });
    expect(failback).toContain('NON-CLIENT CALLS');
    expect(failback).toContain('PRIVACY');
  });
});

// Prompt rework (2026-08-26, docs/PROMPT_REWORK_PROPOSAL_2026-08-26.md):
// restructured to the OpenAI Realtime guide skeleton. These lock the
// architecture so it doesn't silently regrow into sediment.
describe('buildInstructions — reworked skeleton (2026-08-26)', () => {
  it('follows the guide section order, with dynamic CURRENT STATUS dead last', () => {
    const p = buildInstructions();
    const order = [
      '═══ PERSONALITY & TONE ═══',
      '═══ REFERENCE PRONUNCIATIONS ═══',
      '═══ CONTEXT ═══',
      '═══ SERVICES & PRICES ═══',
      '═══ TOOLS ═══',
      '═══ INSTRUCTIONS ═══',
      '═══ PRIVACY',
      '═══ CONVERSATION FLOW ═══',
      '═══ SAFETY & ESCALATION ═══',
      '═══ CURRENT STATUS',
    ];
    const idx = order.map((s) => p.indexOf(s));
    idx.forEach((i, n) => {
      expect(i, `section missing: ${order[n]}`).toBeGreaterThan(-1);
      if (n > 0)
        expect(i, `out of order: ${order[n]}`).toBeGreaterThan(idx[n - 1]!);
    });
    // Dynamic values (clock/status) must live at the END — a stable static
    // prefix is what makes the instructions cache-friendly.
    expect(p.indexOf('CURRENT DATE & TIME')).toBeGreaterThan(
      p.indexOf('SAFETY & ESCALATION')
    );
  });

  it('has the guide-prescribed blocks: unclear audio, pronunciations, numeric escalation threshold', () => {
    const p = buildInstructions();
    expect(p).toContain('UNCLEAR AUDIO');
    expect(p).toMatch(/never guess at what they said/);
    expect(p).toMatch(/REE-cha/);
    expect(p).toMatch(/MORE THAN 2 tool failures/);
  });

  it('moved-to-tools content is GONE from the prompt (single source of truth)', () => {
    const p = buildInstructions();
    // READING RESULTS coaching now rides in suggest_availability results.
    expect(p).not.toContain('READING suggest_availability RESULTS');
    expect(p).not.toContain('salonOpenThatDay');
    // Wire formats live in tool parameter descriptions now.
    expect(p).not.toMatch(/pass (that|the chosen) slot's value/);
    // Factually wrong since Phorest enforces its own lead time — deleted.
    expect(p).not.toContain('No minimum notice');
    // The old numbered flow scripts are replaced by SERVE states.
    expect(p).not.toContain('═══ BOOKING ═══');
    expect(p).not.toContain('═══ CUSTOMER IDENTIFICATION');
  });

  it('stays under the token budget (was ~5.5k before the rework)', () => {
    const p = buildInstructions();
    // chars/4 ≈ tokens; ceiling leaves headroom over the ~3.5k target so
    // legitimate additions fit, but sediment-scale regrowth fails the build.
    expect(Math.round(p.length / 4)).toBeLessThan(4200);
  });

  it('keeps every load-bearing rule family (semantic pin, not position)', () => {
    const p = buildInstructions();
    // never-invent family
    expect(p).toMatch(/NEVER INVENT/);
    expect(p).toMatch(/EXACTLY as given/);
    // confirm-before-write
    expect(p).toMatch(/explicitly confirmed the exact service, day, and time/);
    // caller-leads + let-finish
    expect(p).toMatch(/LET THE CALLER LEAD/);
    expect(p).toMatch(/Let the caller FINISH/);
    // filler-before-tools (described, never scripted — lessons.md parrot rule)
    expect(p).toMatch(/filler in your own words/);
    // English-only + fixed persona
    expect(p).toMatch(/English only/);
    expect(p).toMatch(/not a rule change/);
    // recognized-caller: never ask for the number, never re-lookup a changed one
    expect(p).toMatch(/NEVER ask for their phone number/);
    expect(p).toMatch(/number CHANGED/);
    // multi-service stays normal, no transfer
    expect(p).toMatch(/second or third/);
    // mid-flow pivot
    expect(p).toMatch(/ABANDON the old flow/);
    // end_call discipline
    expect(p).toMatch(/SAME turn/);
    expect(p).toMatch(/never just because the line went quiet/i);
  });
});
