// f9.spec.ts — flow F9 of 03-UI §7, rewritten for the honest storage behaviour. The proactive
// "storage may be evicted" popup and the pill's `· storage may be evicted` suffix were removed:
// `navigator.storage.persist()` never prompts on Chrome and returns false on localhost, so the
// warning was alarmist and a dead end. Durable storage is now requested SILENTLY on load — the call
// is made once and its answer discarded for UI. The genuinely important warning stays: when
// IndexedDB cannot be opened and the store falls back to this tab's memory, the pill carries
// `· not persisted on this device`, a real data-loss risk. The browser globals are stubbed at
// document start because a headless profile's real answers are not under the test's control; the
// product code path is the real one.
import { expect, test, type BrowserContext } from '@playwright/test';
import { notice, open, pill, pillSuffix } from './helpers.ts';

/** Replace `navigator.storage` so `persist()` records that it was called and resolves the given answer. */
async function spyPersist(context: BrowserContext, answer: boolean): Promise<void> {
  await context.addInitScript((granted: boolean) => {
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: {
        persist: async () => {
          (window as unknown as { __persistCalls: number }).__persistCalls = ((window as unknown as { __persistCalls?: number }).__persistCalls ?? 0) + 1;
          return granted;
        },
        persisted: async () => granted,
        estimate: async () => ({ usage: 0, quota: 0 }),
      },
    });
  }, answer);
}

test('F9 a normal load requests durable storage silently: persist() is called, and there is no notice and no pill suffix', async ({ browser }) => {
  const context = await browser.newContext();
  await spyPersist(context, true);
  const page = await context.newPage();
  await open(page, `e2e-f9-${Date.now().toString(36)}`);
  await expect(pill(page)).toHaveText('Saved');
  // Durable storage was requested — but silently: no popup, no suffix.
  await page.waitForFunction(() => ((window as unknown as { __persistCalls?: number }).__persistCalls ?? 0) >= 1);
  await expect(notice(page)).toHaveCount(0);
  await expect(pillSuffix(page)).toHaveCount(0);
  await context.close();
});

test('F9 IndexedDB cannot be opened: the store falls back to memory and the pill says · not persisted on this device', async ({ browser }) => {
  const context = await browser.newContext();
  // Make even reading `indexedDB` throw, as a privacy setting can: browserDeps guards the access and
  // reports null, so the session opens the memory store — the one real, surfaced storage warning.
  await context.addInitScript(() => {
    Object.defineProperty(window, 'indexedDB', {
      configurable: true,
      get() {
        throw new Error('e2e: indexedDB unavailable');
      },
    });
  });
  const page = await context.newPage();
  await open(page, `e2e-f9mem-${Date.now().toString(36)}`);
  await expect(pill(page)).toHaveText('Saved');
  await expect(pillSuffix(page)).toHaveText('· not persisted on this device');
  await context.close();
});
