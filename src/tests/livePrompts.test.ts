import { createHash } from 'node:crypto';
import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { buildInstructions } from '../realtime/twilioStream.js';
import type { Service } from '../services/phorest.types.js';
import { buildBackendPrompt, buildLivePrompt } from '../voice/livePrompts.js';

const salonTime = (iso: string) =>
  DateTime.fromISO(iso, { zone: 'America/New_York' });

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

    expect(Math.ceil(prompt.length / 4)).toBeLessThanOrEqual(900);
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
    expect(digestBefore).toBe(
      '73cecffe22a2b3ebb033eceef94c62f7e781d73d3255ab410afb426a07505eaf'
    );
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
    expect(prompt).toContain('at most one appointment action at a time');
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
