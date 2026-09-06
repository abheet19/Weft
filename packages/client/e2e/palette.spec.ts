// palette.spec.ts — flow F-palette (03-UI §4.8, F11) in a real browser: the ⌘K command palette is a
// real <dialog>, so this exercises the browser's own focus trap and Esc that jsdom cannot. Ctrl+K
// opens it and focuses the search box; typing "offline" filters to one row; Enter runs Debug ›
// Simulate offline — the same action the rail's switch and F2 use — and the pill goes amber. Then a
// second open via the top-bar button closes on Esc with focus returned to that button. Extends the
// existing flow set; every wait is on visible state.
import { expect, test } from '@playwright/test';
import { editor, offlineSwitch, open, pill } from './helpers.ts';

test('F-palette: Ctrl+K opens the palette, typing "offline" then Enter runs Simulate offline and the pill goes amber', async ({ page }) => {
  const docId = `e2e-palette-${Date.now().toString(36)}`;
  await open(page, docId);

  // A collapsed cursor in the editor: Ctrl+K there is not "insert link" (that needs a selection), so it opens the palette.
  await editor(page).click();
  await page.keyboard.press('Control+k');

  const dialog = page.getByRole('dialog', { name: 'Command palette' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.k-search input')).toBeFocused();

  await page.keyboard.type('offline');
  await expect(page.locator('.k-it')).toHaveText(['Simulate offlineOff']);

  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(pill(page)).toHaveText('Offline · 0 changes on this device');
  await expect(offlineSwitch(page)).toHaveAttribute('aria-checked', 'true');
});

test('F-palette: Esc closes the palette and returns focus to the trigger button', async ({ page }) => {
  const docId = `e2e-palette-esc-${Date.now().toString(36)}`;
  await open(page, docId);

  const button = page.getByRole('button', { name: 'Open command palette (Ctrl+K)' });
  await button.click();
  const dialog = page.getByRole('dialog', { name: 'Command palette' });
  await expect(dialog).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(button).toBeFocused();
});
