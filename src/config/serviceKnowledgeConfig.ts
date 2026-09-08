import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CANDIDATES = [
  path.join(here, 'serviceKnowledge.json'),
  path.join(here, '../../src/config/serviceKnowledge.json'),
  path.resolve(process.cwd(), 'src/config/serviceKnowledge.json'),
];

export function loadServiceKnowledgeConfig(): unknown {
  for (const candidate of CANDIDATES) {
    if (!fs.existsSync(candidate)) continue;
    try {
      return JSON.parse(fs.readFileSync(candidate, 'utf8')) as unknown;
    } catch (error) {
      throw new Error(
        `Invalid service knowledge JSON at ${candidate}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
  throw new Error(
    `serviceKnowledge.json not found (tried: ${CANDIDATES.join(', ')})`
  );
}
