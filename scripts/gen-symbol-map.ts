// CLI entry point for docs/SYMBOLS.md. The actual TypeScript-compiler-API
// walk lives in src/tools/symbolMap.ts (generateSymbolMap) — kept under
// src/ rather than here so src/tests/symbolMap.test.ts can import it
// directly without pulling scripts/** into the tsc rootDir="src" graph.
//
// Run with: npm run symbols   (node --import tsx scripts/gen-symbol-map.ts)
//
// Line numbers shift on nearly every edit to the underlying source, so
// docs/SYMBOLS.md WILL go stale often — that is expected, not a bug.
// src/tests/symbolMap.test.ts regenerates the map in memory and diffs it
// against the committed file; when that test fails, run `npm run symbols`
// and commit the result.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  generateSymbolMap,
  OUTPUT_RELATIVE_PATH,
} from '../src/tools/symbolMap.js';

function isMainModule(): boolean {
  return process.argv[1] === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const rootDir = process.cwd();
  const output = generateSymbolMap(rootDir);
  writeFileSync(join(rootDir, OUTPUT_RELATIVE_PATH), output, 'utf8');
  console.log(
    `Wrote ${OUTPUT_RELATIVE_PATH} (${output.split('\n').length} lines)`
  );
}
