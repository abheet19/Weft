// Vitest configuration for @weft/protocol. The coverage thresholds are a GATE, not a report:
// vitest exits non-zero when any of them is missed, so `npm run check` (and CI) fails.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text-summary'],
      thresholds: {
        lines: 95,
        branches: 90,
        functions: 95,
      },
    },
  },
});
