import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // See vitest.setup.ts — isolates CallStore/blocklist/digest file writes to
    // a per-run tmp dir so test runs can never pollute real data/ files.
    setupFiles: ['./vitest.setup.ts'],
  },
});
