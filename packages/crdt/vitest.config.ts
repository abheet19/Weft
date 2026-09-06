// Vitest configuration for @weft/crdt. The coverage thresholds are a GATE, not a report:
// vitest exits non-zero when any of them is missed, so `npm run check` (and CI) fails.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The partitioned-network property test runs 10 000 cases under CI=1; give it room.
    testTimeout: 600_000,
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
