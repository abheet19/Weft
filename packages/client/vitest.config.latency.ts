// vitest.config.latency.ts — the per-keystroke micro-benchmark (test/binding/latency.test.ts) runs
// here, ALONE. The main vitest.config.ts excludes this file from its parallel worker pool because a
// wall-clock latency assertion measured while sibling workers (and this machine's background load)
// compete for the CPU measures the scheduler, not the binding. `singleFork` with file parallelism
// off gives the timing test the process to itself for its few seconds; `npm test` runs this as a
// second, serial step after the coverage run. No coverage here: every line this file touches is
// covered by the parallel run, and v8 coverage does not merge across two vitest invocations.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/binding/latency.test.ts'],
    testTimeout: 120_000,
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
