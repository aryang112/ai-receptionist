// src/services/phorest.ts
import { env } from '../config/env.js';
import type { PhorestPort } from './phorest.types.js';

// Value imports (runtime)
import { mockPhorest } from './phorest.mock.js';
import { realPhorest } from './phorest.client.js';

// Choose which implementation to expose based on env flag
export const phorest: PhorestPort =
  env.USE_MOCK_PHOREST === 'true' ? mockPhorest : realPhorest;
