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

  it('does not mistake Richa’s transfer window for her personal availability', () => {
    const prompt = buildLivePrompt('', CATALOG, {
      publicFacts: {
        richaStatus: 'Available for transfer until 5 PM',
      },
    });

    expect(prompt).not.toContain("Richa's current availability");
    expect(prompt).not.toContain('Available for transfer until 5 PM');
    expect(prompt).toContain(
      'Never infer that Richa is personally available from a transfer window or salon status'
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

    expect(livePrompt).toContain(
      'Ending the phone connection is an application action: always delegate'
    );
    expect(livePrompt).toContain('For clear spam, delegate the spam-close');
    expect(backendPrompt).toContain(
      "Call end_call({reason:'done'}) for a caller who is clearly done"
    );
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

    expect(digestBefore).toBe(
      'ee00677bfaaa921f59745ac9081088019ffe58ed61f0bf630328d3d9c7131d61'
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
      'For an unrecognized existing client who wants appointment records or an account-specific action, ask for their phone number and wait'
    );
    expect(prompt).toContain(
      'if no match, ask for first and last name and wait'
    );
    expect(prompt).toContain(
      'A confirmed name is contact data, not action approval'
    );
    expect(prompt).toContain('Appointment details belong to the person');
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
