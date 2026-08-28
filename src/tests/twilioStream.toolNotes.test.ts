import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import WebSocket from 'ws';
import { phorest } from '../services/phorest.js';

// Prompt-rework Phase 1 (2026-08-26, the Glenda call): situational coaching
// moves OUT of the global prompt and INTO tool results, arriving at the
// decision moment. These tests drive the real handlers (above the zod seam,
// lessons.md F1) against the mock Phorest port and lock in:
//  - staff-name-as-service detection (serviceName "Richa" → coached result,
//    never a bare notOffered the model verbalizes as "not in the system")
//  - `note` coaching on notOffered / ambiguous / success states / errors
//  - list_appointments empty/success notes

process.env.OPENAI_REALTIME_API_KEY ||= 'test-key';

let TwilioRealtimeCall: typeof import('../realtime/twilioStream.js').TwilioRealtimeCall;
let matchStaffName: typeof import('../realtime/twilioStream.js').matchStaffName;
beforeAll(async () => {
  ({ TwilioRealtimeCall, matchStaffName } = await import(
    '../realtime/twilioStream.js'
  ));
});

afterEach(() => vi.restoreAllMocks());

function buildCall() {
  const socket: any = {
    readyState: WebSocket.OPEN,
    send: () => {},
    close: () => {},
    on: () => {},
  };
  const call: any = new TwilioRealtimeCall(socket);
  call.session = {
    appendTwilioAudio: () => {},
    truncateActiveResponse: vi.fn(),
    close: vi.fn(),
  };
  call.streamSid = 'S';
  call.callSid = 'CA_test_notes';
  return call;
}

// A Wednesday with 12:00–19:00 hours per business.json (same as freshCheck).
const DATE = '2025-10-01';

describe('matchStaffName — staff-name detection', () => {
  const STAFF = ['Richa'];
  it('matches exact and case-insensitive', () => {
    expect(matchStaffName('Richa', STAFF)).toBe('Richa');
    expect(matchStaffName('richa', STAFF)).toBe('Richa');
  });
  it('matches transcription mangles within edit distance 2 (the "Rishka" case)', () => {
    expect(matchStaffName('Rishka', STAFF)).toBe('Richa');
    expect(matchStaffName('Risha', STAFF)).toBe('Richa');
  });
  it('does not swallow real service words or empty input', () => {
    expect(matchStaffName('Brow Threading', STAFF)).toBeNull();
    expect(matchStaffName('Lash Lift', STAFF)).toBeNull();
    expect(matchStaffName('', STAFF)).toBeNull();
    expect(matchStaffName('wax', STAFF)).toBeNull();
  });
  it('matches the staff name inside a phrase (the "Richa availability" call, 2026-08-27 9:56 PM)', () => {
    expect(matchStaffName('Richa availability', STAFF)).toBe('Richa');
    expect(matchStaffName('with Risha', STAFF)).toBe('Richa');
    expect(matchStaffName('Richa appointment tomorrow', STAFF)).toBe('Richa');
    // tiny tokens can never false-hit a name
    expect(matchStaffName('at a wax', STAFF)).toBeNull();
  });
});

describe('suggest_availability — staff member passed as serviceName', () => {
  it('returns a coached staffMember result, not notOffered', async () => {
    const call = buildCall();
    const result = await call.handleSuggestAvailability({
      serviceName: 'Richa',
      date: DATE,
      preferredTime: '17:30',
    });
    expect(result.staffMember).toBe('Richa');
    expect(result.notOffered).toBeUndefined();
    // Coaching must tell the model to ask for the service and to never
    // surface the lookup/system to the caller.
    expect(result.note).toMatch(/staff member, not a service/);
    expect(result.note).toMatch(/never|not mention/i);
  });

  it('a staff fetch failure degrades to the normal notOffered path (never throws)', async () => {
    // listStaffNames is optional on PhorestPort — spy through a cast.
    vi.spyOn(
      phorest as { listStaffNames: () => Promise<string[]> },
      'listStaffNames'
    ).mockRejectedValue(new Error('down'));
    const call = buildCall();
    const result = await call.handleSuggestAvailability({
      serviceName: 'Richa',
      date: DATE,
    });
    expect(result.staffMember).toBeUndefined();
    expect(result.notOffered).toBe(true);
    expect(result.note).toBeTruthy();
  });
});

describe('suggest_availability — note coaching per result state', () => {
  it('notOffered carries never-say-not-in-system coaching', async () => {
    const call = buildCall();
    const result = await call.handleSuggestAvailability({
      serviceName: 'quantum haircut',
      date: DATE,
    });
    expect(result.notOffered).toBe(true);
    expect(result.note).toMatch(/[Nn]ever tell the caller/);
    expect(result.note).toMatch(/system or catalog/);
  });

  it('ambiguous carries ask-which-they-meant coaching', async () => {
    const call = buildCall();
    const result = await call.handleSuggestAvailability({
      serviceName: 'wax',
      date: DATE,
    });
    expect(result.ambiguous).toBe(true);
    expect(result.note).toMatch(/which of the candidates/);
  });

  it('a normal open day with slots carries offer-only-from-slots coaching', async () => {
    // On-grid starts (the mock's raw 13:20/13:50/14:20 all get dropped by
    // snapSlotsToGrid's lone-tail rule — see core/slots.ts).
    vi.spyOn(phorest, 'getAvailability').mockResolvedValue([
      `${DATE}T14:00:00`,
      `${DATE}T14:15:00`,
    ]);
    const call = buildCall();
    const result = await call.handleSuggestAvailability({
      serviceName: 'Lash Lift',
      date: DATE,
    });
    expect(result.slots.length).toBeGreaterThan(0);
    expect(result.note).toMatch(/only times from slots/i);
    expect(result.note).toMatch(/never invent/);
  });

  it('a closed day says closed-not-fully-booked in the note', async () => {
    // business.json: Sunday closed. 2025-10-05 is a Sunday.
    const call = buildCall();
    const result = await call.handleSuggestAvailability({
      serviceName: 'Lash Lift',
      date: '2025-10-05',
    });
    expect(result.salonOpenThatDay).toBe(false);
    expect(result.note).toMatch(/does not open that day/);
    expect(result.note).toMatch(/[Nn]ever call a closed day fully booked/);
  });

  it('an open day with zero slots says genuinely fully booked', async () => {
    vi.spyOn(phorest, 'getAvailability').mockResolvedValue([]);
    const call = buildCall();
    const result = await call.handleSuggestAvailability({
      serviceName: 'Lash Lift',
      date: DATE,
    });
    expect(result.salonOpenThatDay).toBe(true);
    expect(result.slots).toEqual([]);
    expect(result.note).toMatch(/fully booked/);
  });

  it('a tool error carries retry-once coaching', async () => {
    vi.spyOn(phorest, 'getAvailability').mockRejectedValue(
      new Error('phorest 500')
    );
    const call = buildCall();
    const result = await call.handleSuggestAvailability({
      serviceName: 'Lash Lift',
      date: DATE,
    });
    expect(result.error).toBeTruthy();
    expect(result.note).toMatch(/retry this tool once/);
    expect(result.note).toMatch(/Richa/);
  });
});

describe('list_appointments — note coaching', () => {
  it('empty list: offer-to-book coaching, never-invent, never-transfer', async () => {
    vi.spyOn(phorest, 'listAppointments').mockResolvedValue([]);
    const call = buildCall();
    const result = await call.handleListAppointments({ clientId: 'c1' });
    expect(result.appointments).toEqual([]);
    expect(result.note).toMatch(/offer to book/i);
    expect(result.note).toMatch(/[Nn]ever invent/);
    expect(result.note).toMatch(/never transfer/i);
  });

  it('non-empty list: soonest-first, quote-fields-exactly coaching', async () => {
    vi.spyOn(phorest, 'listAppointments').mockResolvedValue([
      {
        appointmentId: 'a1',
        serviceName: 'Lash Lift',
        date: '2025-10-03',
        timeDisplay: '2:00 PM',
        startTimeRaw: '14:00:00',
        endTimeRaw: '14:45:00',
      },
    ]);
    const call = buildCall();
    const result = await call.handleListAppointments({ clientId: 'c1' });
    expect(result.appointments).toHaveLength(1);
    expect(result.note).toMatch(/soonest/i);
    expect(result.note).toMatch(/exactly as given/);
  });

  it('error: retry-once coaching', async () => {
    vi.spyOn(phorest, 'listAppointments').mockRejectedValue(
      new Error('phorest 500')
    );
    const call = buildCall();
    const result = await call.handleListAppointments({ clientId: 'c1' });
    expect(result.error).toBeTruthy();
    expect(result.note).toMatch(/retry this tool once/);
  });
});
