import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DateTime } from 'luxon';

// Regression tests for the REAL Phorest client URL construction + the
// timeout/retry behaviour added to harden the conversational hot path.
// We drive realPhorest directly with a mocked global fetch.

const TEST_ENV: Record<string, string> = {
  PHOREST_BASE_URL: 'https://example.test/third-party-api-server',
  PHOREST_API_USERNAME: 'user',
  PHOREST_API_SECRET: 'secret',
  PHOREST_BUSINESS_ID: 'BIZ',
  PHOREST_BRANCH_ID: 'BRANCH',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const EMPTY_APPTS = {
  _embedded: { appointments: [] },
  page: { number: 0, totalPages: 1 },
};

async function loadRealPhorest() {
  for (const [k, v] of Object.entries(TEST_ENV)) process.env[k] = v;
  vi.resetModules();
  const mod = await import('../services/phorest.client.js');
  return mod.realPhorest;
}

describe('realPhorest hot-path hardening', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('listAppointments always sends BOTH from_date and to_date (the 400 that crashed a real call)', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(EMPTY_APPTS));
    const phorest = await loadRealPhorest();

    await phorest.listAppointments('CLIENT1');

    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain('from_date=');
    expect(url).toContain('to_date=');

    // Phorest caps the range at 31 days ("Max date range allowed is 31 days").
    const from = new URL(url).searchParams.get('from_date')!;
    const to = new URL(url).searchParams.get('to_date')!;
    const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
    expect(days).toBeGreaterThan(0);
    expect(days).toBeLessThanOrEqual(31);
  });

  it('retries once on a network error, then succeeds', async () => {
    // listAppointments scans two ~30-day windows (PH-3); the first window's
    // first attempt fails and retries. Any later call just returns empty.
    fetchMock
      .mockRejectedValueOnce(new Error('network down'))
      .mockImplementation(async () => jsonResponse(EMPTY_APPTS));
    const phorest = await loadRealPhorest();

    const result = await phorest.listAppointments('CLIENT1');

    // 1 (fail) + 1 (retry success) for window 1, + 1 for window 2 = 3 calls.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result).toEqual([]);
  });

  it('does NOT retry a 4xx — surfaces the error after a single call', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ detail: 'bad request' }, 400));
    const phorest = await loadRealPhorest();

    await expect(phorest.listAppointments('CLIENT1')).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('passes an abort signal so a hung request cannot hang forever', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(EMPTY_APPTS));
    const phorest = await loadRealPhorest();

    await phorest.listAppointments('CLIENT1');

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('listAppointments: LOCAL times, only upcoming BOOKED, soonest first', async () => {
    // Far-future July dates (clearly EDT) so the upcoming filter always keeps them.
    fetchMock.mockImplementation(async () =>
      jsonResponse({
        _embedded: {
          appointments: [
            {
              appointmentId: 'PAID1',
              state: 'PAID',
              activationState: 'ACTIVE',
              appointmentDate: '2030-07-10',
              startTime: '11:00:00',
              endTime: '11:15:00',
              serviceName: 'Completed',
            },
            {
              appointmentId: 'LATER',
              state: 'BOOKED',
              activationState: 'ACTIVE',
              appointmentDate: '2030-07-12',
              startTime: '14:30:00',
              endTime: '14:45:00',
              serviceName: 'Brow Threading',
            },
            {
              appointmentId: 'SOON',
              state: 'BOOKED',
              activationState: 'ACTIVE',
              appointmentDate: '2030-07-10',
              startTime: '09:15:00',
              endTime: '09:20:00',
              serviceName: 'Lip Threading',
            },
          ],
        },
        page: { number: 0, totalPages: 1 },
      })
    );
    const phorest = await loadRealPhorest();

    const res = await phorest.listAppointments('C');

    // PAID (completed) excluded; sorted soonest-first.
    expect(res.map((r) => r.appointmentId)).toEqual(['SOON', 'LATER']);
    // Parsed as LOCAL salon time: 14:30 -> "2:30 PM" (the UTC bug would give 10:30 AM).
    expect(res.find((r) => r.appointmentId === 'LATER')!.timeDisplay).toBe(
      '2:30 PM'
    );
  });

  it('listAppointments uses client_id and NEVER returns another client appointment', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({
        _embedded: {
          appointments: [
            // "THEIRS" is sooner, so without the client filter it would be returned first (the bug).
            {
              appointmentId: 'THEIRS',
              clientId: 'OTHER',
              state: 'BOOKED',
              activationState: 'ACTIVE',
              appointmentDate: '2030-07-10',
              startTime: '12:30:00',
              endTime: '12:35:00',
              serviceName: 'Someone Else',
            },
            {
              appointmentId: 'MINE',
              clientId: 'C',
              state: 'BOOKED',
              activationState: 'ACTIVE',
              appointmentDate: '2030-07-10',
              startTime: '13:00:00',
              endTime: '13:05:00',
              serviceName: 'Brow Threading',
            },
          ],
        },
        page: { number: 0, totalPages: 1 },
      })
    );
    const phorest = await loadRealPhorest();

    const res = await phorest.listAppointments('C');

    expect(res.map((r) => r.appointmentId)).toEqual(['MINE']); // foreign client excluded
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain('client_id=C');
    expect(url).not.toContain('clientId=');
  });

  it('getAvailability converts UTC slot times to salon-local (3 PM not 7 PM)', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: [
          { startTime: '2026-06-19T19:00:00.000Z' }, // 19:00 UTC = 3:00 PM EDT
          { startTime: '2026-06-19T22:55:00.000Z' }, // 22:55 UTC = 6:55 PM EDT
        ],
      })
    );
    const phorest = await loadRealPhorest();

    const slots = await phorest.getAvailability('svc', '2026-06-19');

    expect(slots).toHaveLength(2);
    // Local wall-clock, not the raw UTC hour.
    expect(slots.some((s) => s.startsWith('2026-06-19T15:00:00'))).toBe(true); // 3 PM
    expect(slots.some((s) => s.startsWith('2026-06-19T18:55:00'))).toBe(true); // 6:55 PM
  });

  it('paginates the ENTIRE client list (finds a client on a later page)', async () => {
    const pageOf = (url: string) => {
      const m = url.match(/[?&]page=(\d+)/);
      return m ? Number(m[1]) : 0;
    };
    // 3 pages; the target client only appears on the last page.
    fetchMock.mockImplementation(async (url: unknown) => {
      const page = pageOf(String(url));
      const clients =
        page === 2
          ? [
              {
                clientId: 'C-LATE',
                firstName: 'Late',
                lastName: 'Client',
                mobile: '4105551234',
              },
            ]
          : [];
      return jsonResponse({
        _embedded: { clients },
        page: { number: page, totalPages: 3 },
      });
    });
    const phorest = await loadRealPhorest();

    const result = await phorest.lookupCustomerByPhone('410-555-1234');

    expect(result?.clientId).toBe('C-LATE');
    const pages = fetchMock.mock.calls.map((c) => pageOf(String(c[0]))).sort();
    expect(pages).toEqual([0, 1, 2]);
  });

  // PH-1: a single failed index load must NOT poison the process forever. The
  // rejected in-flight promise has to be cleared so the next call retries.
  it('PH-1: a failed client-index load does not break every later lookup', async () => {
    let indexBuildFailed = false;
    let page0Calls = 0;
    fetchMock.mockImplementation(async (url: unknown) => {
      const u = String(url);
      if (u.includes('/client?') && u.includes('page=0')) {
        page0Calls += 1;
        // The FIRST index build fails — including its one retry (page 0 is a
        // retriable GET, so it's fetched twice). Only after both attempts of the
        // first build have failed do we let a later build succeed.
        if (!indexBuildFailed) {
          if (page0Calls >= 2) indexBuildFailed = true;
          throw new Error('boom: phorest down');
        }
        return jsonResponse({
          _embedded: {
            clients: [
              {
                clientId: 'C-OK',
                firstName: 'A',
                lastName: 'B',
                mobile: '4105559999',
              },
            ],
          },
          page: { number: 0, totalPages: 1 },
        });
      }
      return jsonResponse({ _embedded: { clients: [] } });
    });
    const phorest = await loadRealPhorest();

    // First lookup blows up (index build rejects, retry included).
    await expect(
      phorest.lookupCustomerByPhone('410-555-9999')
    ).rejects.toThrow();

    // The rejected promise must have been cleared — the SECOND lookup rebuilds
    // and resolves instead of replaying the cached rejection.
    const result = await phorest.lookupCustomerByPhone('410-555-9999');
    expect(result?.clientId).toBe('C-OK');
  });

  // PH-4: a timed-out write (booking POST) must NOT be retried — a retry could
  // double-book if the first request actually landed server-side.
  it('PH-4: booking POST fires exactly ONE request even on timeout-then-success', async () => {
    let bookingCalls = 0;
    fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (u.includes('/service?')) {
        return jsonResponse({
          _embedded: {
            services: [
              {
                serviceId: 'svc1',
                name: 'Brow Threading',
                duration: 15,
                price: 15,
              },
            ],
          },
          page: { number: 0, totalPages: 1 },
        });
      }
      if (u.includes('/staff?')) {
        return jsonResponse({
          _embedded: { staffs: [{ staffId: 'staff1' }] },
        });
      }
      if (u.includes('/booking') && method === 'POST') {
        bookingCalls += 1;
        // First (and only) booking attempt "times out". If the retry logic
        // wrongly applied to writes, a second POST would fire here.
        throw new Error('AbortError: timed out');
      }
      // Client CREATE (POST /client) — return a fresh id so we actually reach
      // the booking POST (the code under test). GET /client index/lookups fall
      // through to an empty list so getOrCreateClient creates a new client.
      if (u.endsWith('/client') && method === 'POST') {
        return jsonResponse({ clientId: 'NEW-CLIENT' });
      }
      return jsonResponse({ _embedded: { clients: [] } });
    });
    const phorest = await loadRealPhorest();

    await expect(
      phorest.createAppointment('svc1', '2030-07-10T13:00:00', {
        name: 'Jane Doe',
        phone: '4105551212',
      })
    ).rejects.toThrow();

    // Exactly one booking POST — never retried.
    expect(bookingCalls).toBe(1);
  });

  // 2026-09-07 production loss: Phorest answers POST /client with
  // 400 EMAIL_REQUIRED when the body carries no email (its docs say optional —
  // the live tenant disagrees). A first-time caller never gives one over the
  // phone, so the create MUST send a placeholder and opt it out of email
  // marketing/reminders (a placeholder mailbox can never receive mail).
  it('new-caller create sends a placeholder email with email consents opted out', async () => {
    let clientBody: Record<string, unknown> | undefined;
    fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (u.includes('/service?')) {
        return jsonResponse({
          _embedded: {
            services: [
              {
                serviceId: 'svc1',
                name: 'Brow Threading',
                duration: 15,
                price: 15,
              },
            ],
          },
          page: { number: 0, totalPages: 1 },
        });
      }
      if (u.includes('/staff?')) {
        return jsonResponse({ _embedded: { staffs: [{ staffId: 'staff1' }] } });
      }
      if (u.endsWith('/client') && method === 'POST') {
        clientBody = JSON.parse(String(init?.body));
        return jsonResponse({ clientId: 'NEW-CLIENT' });
      }
      if (u.includes('/booking') && method === 'POST') {
        // The create is what's under test; stop before the booking write.
        throw new Error('stop after client create');
      }
      return jsonResponse({ _embedded: { clients: [] } });
    });
    const phorest = await loadRealPhorest();
    const { PLACEHOLDER_EMAIL_DOMAIN, isPlaceholderEmail } = await import(
      '../services/phorest.client.js'
    );

    await expect(
      phorest.createAppointment('svc1', '2030-07-10T13:00:00', {
        name: 'Jesenia Martinez',
        phone: '4105558919',
      })
    ).rejects.toThrow('stop after client create');

    expect(clientBody).toBeDefined();
    expect(clientBody).toMatchObject({
      firstName: 'Jesenia',
      lastName: 'Martinez',
      mobile: '4105558919',
      email: `4105558919@${PLACEHOLDER_EMAIL_DOMAIN}`,
      emailMarketingConsent: false,
      emailReminderConsent: false,
    });
    expect(isPlaceholderEmail(String(clientBody!.email))).toBe(true);
    expect(isPlaceholderEmail('jesenia@gmail.com')).toBe(false);
  });

  // CONTRACT #2: a recognized caller's clientId short-circuits phone/name
  // resolution — no /client lookup, no getOrCreateClient, book straight to it.
  it('CONTRACT #2: createAppointment with clientId skips client resolution', async () => {
    const clientLookups: string[] = [];
    fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (u.includes('/service?')) {
        return jsonResponse({
          _embedded: {
            services: [
              { serviceId: 'svc1', name: 'Brow', duration: 15, price: 15 },
            ],
          },
          page: { number: 0, totalPages: 1 },
        });
      }
      if (u.includes('/staff?')) {
        return jsonResponse({
          _embedded: { staffs: [{ staffId: 'staff1' }] },
        });
      }
      if (u.includes('/client')) {
        clientLookups.push(u);
        return jsonResponse({ _embedded: { clients: [] } });
      }
      if (u.includes('/booking') && method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}'));
        return jsonResponse({
          bookingId: 'bk1',
          clientAppointmentSchedules: [
            { serviceSchedules: [{ appointmentId: 'appt1' }] },
          ],
          _sentClientId: body.clientId,
        });
      }
      return jsonResponse({});
    });
    const phorest = await loadRealPhorest();

    const res = await phorest.createAppointment(
      'svc1',
      '2030-07-10T13:00:00',
      { name: 'Ignored Name', phone: '4105551212' },
      'KNOWN-CLIENT-ID'
    );

    expect(res.appointmentId).toBe('appt1');
    // No phone/email/name client lookups happened — the clientId bypassed them.
    expect(clientLookups).toEqual([]);
    // And the booking was made against the supplied clientId.
    const bookingCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes('/booking')
    )!;
    const sentBody = JSON.parse(String((bookingCall[1] as RequestInit).body));
    expect(sentBody.clientId).toBe('KNOWN-CLIENT-ID');
  });

  // CT-1 (data half): a shared/family phone whose owner has a DIFFERENT name
  // must not silently book under the phone owner. A provided name that doesn't
  // match the phone record falls through to name lookup / create.
  it('CT-1: shared phone + different name does NOT book under the phone owner', async () => {
    fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (u.includes('/service?')) {
        return jsonResponse({
          _embedded: {
            services: [
              { serviceId: 'svc1', name: 'Brow', duration: 15, price: 15 },
            ],
          },
          page: { number: 0, totalPages: 1 },
        });
      }
      if (u.includes('/staff?')) {
        return jsonResponse({
          _embedded: { staffs: [{ staffId: 'staff1' }] },
        });
      }
      // Phone index: the number belongs to "Mom".
      if (u.includes('/client?size=200')) {
        return jsonResponse({
          _embedded: {
            clients: [
              {
                clientId: 'MOM',
                firstName: 'Mom',
                lastName: 'Owner',
                mobile: '4105551212',
              },
            ],
          },
          page: { number: 0, totalPages: 1 },
        });
      }
      // Name lookup for the DAUGHTER finds her own record.
      if (u.includes('/client?firstName=')) {
        return jsonResponse({
          _embedded: {
            clients: [
              { clientId: 'DAUGHTER', firstName: 'Priya', lastName: 'Owner' },
            ],
          },
        });
      }
      if (u.includes('/client?email=')) {
        return jsonResponse({ _embedded: { clients: [] } });
      }
      if (u.includes('/booking') && method === 'POST') {
        return jsonResponse({
          bookingId: 'bk1',
          clientAppointmentSchedules: [
            { serviceSchedules: [{ appointmentId: 'appt1' }] },
          ],
        });
      }
      return jsonResponse({});
    });
    const phorest = await loadRealPhorest();

    await phorest.createAppointment('svc1', '2030-07-10T13:00:00', {
      name: 'Priya Owner',
      phone: '4105551212',
    });

    const bookingCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes('/booking')
    )!;
    const sentBody = JSON.parse(String((bookingCall[1] as RequestInit).body));
    // Booked under DAUGHTER (name match), never MOM (phone owner).
    expect(sentBody.clientId).toBe('DAUGHTER');
  });

  // PH-3: an appointment 45 days out lives in the SECOND window; a single
  // 30-day scan would miss it (→ duplicate-booking offer).
  it('PH-3: an appointment ~45 days out is returned (two-window scan)', async () => {
    const future = DateTime.now().plus({ days: 45 });
    fetchMock.mockImplementation(async (url: unknown) => {
      const u = String(url);
      const from = new URL(u, 'https://x/').searchParams.get('from_date');
      // Only the second window (starts ~30 days out) covers day 45.
      const windowStart = from ? DateTime.fromISO(from) : DateTime.now();
      const inThisWindow =
        future >= windowStart && future <= windowStart.plus({ days: 30 });
      return jsonResponse({
        _embedded: {
          appointments: inThisWindow
            ? [
                {
                  appointmentId: 'FAR',
                  clientId: 'C',
                  state: 'BOOKED',
                  activationState: 'ACTIVE',
                  appointmentDate: future.toISODate(),
                  startTime: '14:00:00',
                  endTime: '14:15:00',
                  serviceName: 'Brow Threading',
                },
              ]
            : [],
        },
        page: { number: 0, totalPages: 1 },
      });
    });
    const phorest = await loadRealPhorest();

    const res = await phorest.listAppointments('C');
    expect(res.map((r) => r.appointmentId)).toContain('FAR');
  });

  // PH-2: an appointment that already STARTED (running-late call) but hasn't
  // ended must still be returned — the old `start >= now` filter dropped it.
  it('PH-2: an in-progress / just-started appointment is still returned', async () => {
    const now = DateTime.now().setZone('America/New_York');
    const start = now.minus({ minutes: 5 }); // started 5 min ago
    const end = now.plus({ minutes: 10 }); // still running
    fetchMock.mockImplementation(async (url: unknown) => {
      const from = new URL(String(url), 'https://x/').searchParams.get(
        'from_date'
      );
      // Return it only in the window that contains today.
      const inFirstWindow = from === now.toISODate();
      return jsonResponse({
        _embedded: {
          appointments: inFirstWindow
            ? [
                {
                  appointmentId: 'LATE',
                  clientId: 'C',
                  state: 'BOOKED',
                  activationState: 'ACTIVE',
                  appointmentDate: now.toISODate(),
                  startTime: start.toFormat('HH:mm:ss'),
                  endTime: end.toFormat('HH:mm:ss'),
                  serviceName: 'Brow Threading',
                },
              ]
            : [],
        },
        page: { number: 0, totalPages: 1 },
      });
    });
    const phorest = await loadRealPhorest();

    const res = await phorest.listAppointments('C');
    expect(res.map((r) => r.appointmentId)).toContain('LATE');
  });

  // PH-7: a TTL-expired service refresh that FAILS serves the stale cached copy
  // instead of throwing mid-call.
  it('PH-7: service-catalog refresh failure serves the stale cache', async () => {
    let servicePage0Calls = 0;
    fetchMock.mockImplementation(async (url: unknown) => {
      const u = String(url);
      if (u.includes('/service?')) {
        servicePage0Calls += 1;
        // First load succeeds (warms the cache); every later refresh fails.
        if (servicePage0Calls === 1) {
          return jsonResponse({
            _embedded: {
              services: [
                { serviceId: 'svc1', name: 'Brow', duration: 15, price: 15 },
              ],
            },
            page: { number: 0, totalPages: 1 },
          });
        }
        throw new Error('phorest down on refresh');
      }
      return jsonResponse({});
    });
    const phorest = await loadRealPhorest();

    // Warm the cache.
    const first = await phorest.listServices();
    expect(first).toHaveLength(1);

    // Force the TTL to be considered expired by advancing time far ahead.
    const realNow = Date.now;
    Date.now = () => realNow() + 1000 * 60 * 60 * 24 * 365; // +1 year
    try {
      // Refresh fails, but we still get the stale catalog rather than a throw.
      const second = await phorest.listServices();
      expect(second).toHaveLength(1);
      expect(second[0]!.id).toBe('svc1');
    } finally {
      Date.now = realNow;
    }
  });
});
