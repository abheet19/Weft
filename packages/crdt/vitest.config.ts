// Vitest configuration for @weft/crdt. The coverage thresholds are a GATE, not a report:
// vitest exits non-zero when any of them is missed, so `npm run check` (and CI) fails.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The partitioned-network property test runs 10 000 cases under CI=1; give it room.
    testTimeout: 600_000,
    // `convergence.prop.test.ts` alone runs 60-70s of synchronous fast-check work under CI=1. On a
    // slow/contended shared runner (observed on windows-latest) that single long stretch can outlast
    // the default worker_threads pool's inter-process heartbeat, surfacing as an unrelated-looking
    // "Timeout calling onTaskUpdate" — every test still passes, but the run still exits non-zero. The
    // `forks` pool runs each file in its own OS process (IPC, not a shared-memory worker), which does
    // not exhibit this heartbeat class of failure; parallelism across the package's other 13 files is
    // unchanged (this is not singleFork). Mirrors the same fix already proven in
    // packages/client/vitest.config.latency.ts.
    pool: 'forks',
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
