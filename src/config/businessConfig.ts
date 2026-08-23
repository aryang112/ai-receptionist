// Loads src/config/business.json at module init WITHOUT an ESM JSON import.
//
// Why (2026-08-23, first Railway deploy): `import x from './business.json'`
// works under tsx (dev) and vitest, but tsc-compiled output run by plain
// `node` throws ERR_IMPORT_ATTRIBUTE_MISSING on modern Node — JSON module
// imports require `with { type: 'json' }`, which our tsconfig
// (module: ES2020) cannot emit. A plain fs read sidesteps the whole class
// and behaves identically in dev, tests, and production.
//
// business.json remains the single source of truth for hours/closures/
// location — this file only loads and types it. It is read ONCE at boot;
// changing business.json requires a restart (same as the old import).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type BusinessConfig = {
  name: string;
  timezone: string;
  hours: Record<'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun', string[]>;
  closedDates: string[];
  vacations?: Array<{ from: string; to: string; note?: string }>;
  location: {
    address: string;
    city: string;
    state: string;
    zip: string;
  };
};

const here = path.dirname(fileURLToPath(import.meta.url));
// Candidate locations, first match wins:
//  1. alongside this module (src/config/ in dev/tests; dist/config/ if a
//     build step ever copies it),
//  2. the source tree relative to a compiled dist/config/ module,
//  3. cwd-relative (npm start / railway both run from the repo root).
const CANDIDATES = [
  path.join(here, 'business.json'),
  path.join(here, '../../src/config/business.json'),
  path.resolve(process.cwd(), 'src/config/business.json'),
];

function load(): BusinessConfig {
  for (const p of CANDIDATES) {
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8')) as BusinessConfig;
    } catch {
      // try the next candidate
    }
  }
  // Fail LOUD at boot — a server without hours config must not start and
  // quietly tell every caller the salon is closed.
  throw new Error(
    `business.json not found (tried: ${CANDIDATES.join(', ')})`
  );
}

export const businessHours: BusinessConfig = load();
