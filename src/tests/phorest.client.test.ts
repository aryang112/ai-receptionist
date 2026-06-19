import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
    fetchMock.mockResolvedValue(jsonResponse(EMPTY_APPTS));
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
    fetchMock
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(jsonResponse(EMPTY_APPTS));
    const phorest = await loadRealPhorest();

    const result = await phorest.listAppointments('CLIENT1');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual([]);
  });

  it('does NOT retry a 4xx — surfaces the error after a single call', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ detail: 'bad request' }, 400));
    const phorest = await loadRealPhorest();

    await expect(phorest.listAppointments('CLIENT1')).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('passes an abort signal so a hung request cannot hang forever', async () => {
    fetchMock.mockResolvedValue(jsonResponse(EMPTY_APPTS));
    const phorest = await loadRealPhorest();

    await phorest.listAppointments('CLIENT1');

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('listAppointments: LOCAL times, only upcoming BOOKED, soonest first', async () => {
    // Far-future July dates (clearly EDT) so the upcoming filter always keeps them.
    fetchMock.mockResolvedValue(
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
    fetchMock.mockResolvedValue(
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
});
