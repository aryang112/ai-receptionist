// src/services/phorest.ts
import { env } from '../config/env.js';
import type { PhorestPort } from './phorest.types.js';

// Value imports (runtime)
import { mockPhorest } from './phorest.mock.js';
import { realPhorest } from './phorest.client.js';

// Fail fast in production unless the mock flag is EXACTLY 'true' or 'false'.
// USE_MOCK_PHOREST defaults to 'true' at the env layer, and the selector below
// treats anything !== 'false' as mock — so both a missing var AND a typo like
// `USE_MOCK_PHOREST=flase` (F10b) would silently serve FAKE data (fake
// availability, fake bookings). Refuse to boot — a loud crash beats a
// receptionist inventing appointments.
if (env.NODE_ENV === 'production' && process.env.NODE_ENV !== 'test') {
  const flag = process.env.USE_MOCK_PHOREST;
  if (flag !== 'true' && flag !== 'false') {
    throw new Error(
      `USE_MOCK_PHOREST must be exactly "true" or "false" in production (got: ${
        flag ?? '<unset>'
      }). Refusing to boot — a defaulted or mistyped flag would silently serve mock data.`
    );
  }
}

// Choose implementation based on env flag (tests always use the mock)
const useMock =
  process.env.NODE_ENV === 'test' || env.USE_MOCK_PHOREST !== 'false';

export const phorest: PhorestPort = useMock ? mockPhorest : realPhorest;
