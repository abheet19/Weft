// Vitest configuration for @weft/client. The coverage thresholds are a GATE, not a report:
// vitest exits non-zero when any of them is missed, so `npm run check` (and CI) fails. The React
// components (`src/ui/*.tsx`, the `useSession` hook, `src/main.tsx`) are excluded as LLD §6 allows;
// the binding, the session and the store are held to 90/80 each (S4 gate), and so are the pure UI
// words (`pillCopy`, `copy`). Tests that need a DOM declare `@vitest-environment jsdom`.
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    // The per-keystroke micro-benchmark runs alone, under vitest.config.latency.ts, not in this
    // parallel worker pool — a wall-clock timing assertion measured against competing workers
    // measures the scheduler, not the code. Its lines are covered by the rest of the suite (the
    // catch-up/burst paths by binding/hardening.test.ts, the hot paths by positions/hardening), so
    // excluding it here does not move the coverage gate; `npm test` runs it as a second step.
    exclude: [...configDefaults.exclude, 'test/binding/latency.test.ts'],
    testTimeout: 120_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/ui/**/*.tsx', 'src/ui/useSession.ts', 'src/main.tsx'],
      reporter: ['text-summary'],
      thresholds: {
        lines: 90,
        branches: 80,
        functions: 90,
        'src/store/**': { lines: 90, branches: 80, functions: 90 },
        'src/session/**': { lines: 90, branches: 80, functions: 90 },
      },
    },
  },
});
