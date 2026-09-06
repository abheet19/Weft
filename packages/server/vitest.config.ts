// Vitest configuration for @weft/server. The coverage thresholds are a GATE, not a report:
// vitest exits non-zero when any of them is missed, so `npm run check` (and CI) fails.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 60000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text-summary'],
      thresholds: {
        lines: 90,
        branches: 80,
        functions: 90,
      },
    },
  },
});
