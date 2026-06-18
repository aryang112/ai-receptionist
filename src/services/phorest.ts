// src/services/phorest.ts
import { env } from '../config/env.js';
import type { PhorestPort } from './phorest.types.js';

// Value imports (runtime)
import { mockPhorest } from './phorest.mock.js';
import { realPhorest } from './phorest.client.js';

// Choose implementation based on env flag (tests always use the mock)
const useMock = process.env.NODE_ENV === 'test' || env.USE_MOCK_PHOREST !== 'false';

export const phorest: PhorestPort = useMock ? mockPhorest : realPhorest;
