// src/services/phorest.ts
import { env } from '../config/env.js';
import type { PhorestPort } from './phorest.types.js';

// Value imports (runtime)
import { mockPhorest } from './phorest.mock.js';
import { realPhorest } from './phorest.client.js';

// Fail fast in production if the mock flag is missing/empty. USE_MOCK_PHOREST
// defaults to 'true' at the env layer, so a prod deploy that forgot to set it
// would silently serve FAKE data (fake availability, fake bookings). Refuse to
// boot instead — a loud crash beats a receptionist inventing appointments.
if (
  env.NODE_ENV === 'production' &&
  process.env.NODE_ENV !== 'test' &&
  !process.env.USE_MOCK_PHOREST
) {
  throw new Error(
    'USE_MOCK_PHOREST must be set explicitly in production (set it to "false" to use real Phorest). Refusing to boot with a defaulted mock flag.'
  );
}

// Choose implementation based on env flag (tests always use the mock)
const useMock =
  process.env.NODE_ENV === 'test' || env.USE_MOCK_PHOREST !== 'false';

export const phorest: PhorestPort = useMock ? mockPhorest : realPhorest;
