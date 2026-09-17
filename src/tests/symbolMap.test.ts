import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generateSymbolMap, OUTPUT_RELATIVE_PATH } from '../tools/symbolMap.js';

// Two levels up from src/tests/ is the repo root.
const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('docs/SYMBOLS.md staleness', () => {
  it('matches the committed generated file', () => {
    const generated = generateSymbolMap(ROOT_DIR);
    const committed = readFileSync(
      join(ROOT_DIR, OUTPUT_RELATIVE_PATH),
      'utf8'
    );

    expect(
      generated,
      'docs/SYMBOLS.md is stale — run `npm run symbols` and commit it'
    ).toBe(committed);
  });

  it('carries the symbols agents rely on to jump straight to code', () => {
    const generated = generateSymbolMap(ROOT_DIR);

    for (const symbol of [
      'handleCancelVisit',
      'resolveService',
      'buildBackendPrompt',
    ]) {
      expect(generated, `expected ${symbol} in docs/SYMBOLS.md`).toContain(
        symbol
      );
    }

    // Tool surface: registerTrackedTool('cancel_visit', ...) resolves to its
    // handler method, derived from the AST rather than assumed by name.
    expect(generated).toMatch(
      /registered_tool {2}cancel_visit -> handleCancelVisit\b/
    );
  });
});
