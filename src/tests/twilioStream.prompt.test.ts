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

  it('closed-hours: never promise a live transfer; the FYI to Richa is automatic, never a transfer_to_owner call', () => {
    const instructions = buildInstructions();
    expect(instructions).toMatch(/NEVER say "let me get her"/);
    // AUDIT FIX (2026-09-01): the old "send Richa an FYI via
    // transfer_to_owner" clause live-dialed her cell whenever the salon was
    // closed but her window was open. The FYI is server-side now.
    expect(instructions).not.toMatch(
      /handled a schedule change yourself while the salon is closed/
    );
    expect(instructions).toMatch(/texted to Richa AUTOMATICALLY/);
    expect(instructions).toMatch(
      /never call transfer_to_owner just to send her an FYI/
    );
  });

  it('no contradicting "use the tool" rules for hours/prices; identity confirmed once', () => {
    const instructions = buildInstructions();
    expect(instructions).not.toMatch(
      /Never guess at hours — use get_business_hours/
    );
    expect(instructions).not.toMatch(/Never guess prices — call get_prices/);
    expect(instructions).toMatch(
      /Confirm who you're speaking with at most ONCE per call/
    );
    // Running-late no longer scripts a cold phone-number ask.
    expect(instructions).not.toMatch(
      /"No problem! What's your phone number\?"/
    );
    // "Is Richa available?" is an availability question, not a service name.
    expect(instructions).toMatch(/Never pass "Richa"/);
  });
});

// AUDIT FIX (2026-09-01): the precomputed RICHA'S LINE must agree with the
// handler's vacation gate, and the weekly table must list the vacation as
// closed days.
describe('buildInstructions — active vacation', () => {
  it("RICHA'S LINE says NOT possible while she's away, even inside the window", () => {
    // Tue Sept 1 2026, 2 PM — inside the 9–21 window, vacation Sept 1–9 active.
    const instructions = buildInstructions(at('2026-09-01T14:00'));
    expect(instructions).toMatch(/Richa is away right now/);
    expect(instructions).not.toMatch(/live transfer to Richa is POSSIBLE/);
    expect(instructions).toMatch(
      /live transfer to Richa is NOT possible right now \(Richa is away until September 10/
    );
  });

  it('the HOURS line lists the vacation range under Closed on', () => {
    const instructions = buildInstructions(at('2026-08-20T14:00'));
    expect(instructions).toMatch(
      /Closed on: 2026-09-01 through 2026-09-09 \(Richa is away\), 2026-11-26, 2026-12-25\./
    );
  });

  it('next-open carries a date when it is a week or more away', () => {
    const instructions = buildInstructions(at('2026-09-01T14:00'));
    expect(instructions).toMatch(/next open Thursday, September 10 at 12 PM/);
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
      failback.indexOf('NEVER LEAVE SILENCE:')
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
    const from = (s: string) => s.slice(s.indexOf('NEVER LEAVE SILENCE:'));
    expect(upTo(failback)).toBe(upTo(standard));
    expect(from(failback)).toBe(from(standard));

    // Spot-check one untouched section explicitly: TRANSFER TO RICHA still
    // reads exactly as it does on a normal call.
    const transferSection = (s: string) =>
      s.slice(
        s.indexOf('═══ TRANSFER TO RICHA ═══'),
        s.indexOf('═══ ENDING THE CALL ═══')
      );
    expect(transferSection(failback)).toBe(transferSection(standard));
    expect(transferSection(standard).length).toBeGreaterThan(0);
  });

  it('default/omitted opts keep the standard greeting (no behavior change for normal calls)', () => {
    expect(buildInstructions(NOW, null, {})).toBe(buildInstructions(NOW));
    expect(buildInstructions(NOW, null, { transferFailback: false })).toBe(
      buildInstructions(NOW)
    );
  });
});
