import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  resolveService,
  suggestSlots,
  bookAppointment,
} from '../services/booking.js';
import { phorest } from '../services/phorest.js';

// NODE_ENV=test forces the mock Phorest (see services/phorest.ts) — never hits
// real Phorest. These tests lock in the Lane-C contracts the per-call
// orchestrator (twilioStream.ts) consumes: the get_prices "closest few, never
// the full menu" guarantee on a miss (CT-5), and the recognized-caller clientId
// being threaded straight through booking (CT-1).

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CT-5 — get_prices never returns the full catalog on a miss', () => {
  it('an unmatched service query resolves to a bounded closest[] (not the whole menu)', async () => {
    // "eyelash extensions" is not a mock catalog service; resolveService must
    // report notOffered (or ambiguous) with a SHORT list — this is exactly what
    // handleGetPrices maps to its `services` reply, so it can never flood Erica
    // with all ~10 (prod: 63) rows.
    const totalServices = (await phorest.listServices()).length;
    const match = await resolveService('eyelash extensions');

    expect(match.kind).not.toBe('match');
    const near =
      match.kind === 'ambiguous'
        ? match.candidates
        : match.kind === 'notOffered'
          ? match.closest
          : [];
    // The orchestrator caps at 3; the resolver itself must already stay well
    // under the full catalog size.
    expect(near.length).toBeLessThanOrEqual(3);
    expect(near.length).toBeLessThan(totalServices);
  });

  it('an ambiguous fragment ("wax") returns candidates, not a single silent pick', async () => {
    const match = await resolveService('wax');
    expect(match.kind).toBe('ambiguous');
    if (match.kind === 'ambiguous') {
      expect(match.candidates.length).toBeGreaterThan(1);
      // handleGetPrices/handleSuggestAvailability slice(0,3) — assert the raw
      // candidate list is still a handful, never the whole menu.
      const total = (await phorest.listServices()).length;
      expect(match.candidates.length).toBeLessThan(total);
    }
  });

  it('a clean service name still resolves to exactly one match (single price path)', async () => {
    const match = await resolveService('Lash Lift');
    expect(match.kind).toBe('match');
    if (match.kind === 'match') {
      expect(match.service.name).toBe('Lash Lift');
    }
  });
});

describe('CT-1 — recognized-caller clientId is threaded straight into the booking', () => {
  it('bookAppointment passes clientId through to phorest.createAppointment (skips client resolution)', async () => {
    const spy = vi.spyOn(phorest, 'createAppointment');

    await bookAppointment({
      serviceName: 'Lash Lift',
      date: '2025-10-01',
      time: '13:20',
      clientId: 'client_from_prefetch',
      // A recognized caller: name only, NO phone — the orchestrator no longer
      // fabricates one because the clientId identifies the account.
      customer: { name: 'Jane Smith' },
    });

    expect(spy).toHaveBeenCalledTimes(1);
    // Signature: (serviceId, startIso, customer, clientId)
    const call = spy.mock.calls[0]!;
    expect(call[3]).toBe('client_from_prefetch');
    // And we never invented a phone for the known caller.
    expect((call[2] as { phone?: string }).phone).toBeUndefined();
  });

  it('a brand-new caller books with no clientId (undefined 4th arg)', async () => {
    const spy = vi.spyOn(phorest, 'createAppointment');

    await bookAppointment({
      serviceName: 'Lash Lift',
      date: '2025-10-01',
      time: '13:20',
      customer: { name: 'New Person', phone: '5551234567' },
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![3]).toBeUndefined();
  });
});

describe('CT-4 — suggestSlots surfaces alternatives instead of throwing on no clean match', () => {
  it('returns notOffered/ambiguous (never throws "Service not found") for an unknown service', async () => {
    const result = await suggestSlots({
      serviceName: 'hovercraft detailing',
      date: '2025-10-01',
    });
    expect('notOffered' in result || 'ambiguous' in result).toBe(true);
  });
});
