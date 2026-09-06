// helpers.ts — what every browser flow (03-UI §7) shares: the preview origin global-setup published,
// the locators for the editor, the pill and its suffix, the Simulate-offline switch and the notice
// strip, and `open`, which waits for the pill to read `Saved` — the only proof a fresh tab is live
// and acknowledged. Every wait here is on visible state, never on time.
import { expect, type Page } from '@playwright/test';

export const base = (): string => {
  const b = process.env['WEFT_E2E_BASE'];
  if (b === undefined) throw new Error('WEFT_E2E_BASE is not set: global-setup did not run');
  return b;
};

export const editor = (page: Page) => page.locator('.doc .ProseMirror');
export const pill = (page: Page) => page.getByTestId('pill-text');
export const pillSuffix = (page: Page) => page.getByTestId('pill-suffix');
export const offlineSwitch = (page: Page) => page.getByRole('switch', { name: 'Simulate offline' });
export const notice = (page: Page) => page.locator('.notice');

export async function open(page: Page, docId: string): Promise<void> {
  await page.goto(`${base()}/d/${docId}`);
  await expect(editor(page)).toBeVisible();
  await expect(pill(page)).toHaveText('Saved');
}

/** Record every text the pill shows from now on, so a state that lasts milliseconds (Catching up) can still be asserted. */
export async function recordPill(page: Page): Promise<void> {
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="pill-text"]');
    if (el === null) throw new Error('no pill');
    const seen: string[] = [el.textContent ?? ''];
    (window as unknown as { __pillSeen: string[] }).__pillSeen = seen;
    new MutationObserver(() => seen.push(el.textContent ?? '')).observe(el, { childList: true, characterData: true, subtree: true });
  });
}
export const pillSeen = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as { __pillSeen: string[] }).__pillSeen);
