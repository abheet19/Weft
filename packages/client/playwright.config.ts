// Playwright configuration for the browser e2e flows (03-UI §7, F1 onward): Chromium only, two
// browser contexts per test, against a REAL @weft/server on an ephemeral port and a Vite preview
// build pointed at it — both started by global-setup.ts, nothing on a fixed port. Dev-only, $0.
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  // One retry for real-browser timing: F3 asserts a sub-frame pill transition ("Catching up · N in,
  // M out") captured by a MutationObserver, which React can coalesce past when catch-up completes
  // within one commit. A retry never changes what a test proves — a pass still requires that exact
  // text to have been observed — it only re-attempts a timing miss. Every assertion waits on state.
  retries: 1,
  timeout: 60_000,
  reporter: [['list']],
  // One `use`: the device preset once, at the top level, inherited by the single project.
  use: { ...devices['Desktop Chrome'], trace: 'retain-on-failure' },
  projects: [{ name: 'chromium' }],
});
