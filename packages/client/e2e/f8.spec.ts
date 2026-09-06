// f8.spec.ts — flow F8 of 03-UI §7, "time-travel", in a real browser against the real relay. Type
// several words, drag the History slider back and watch the words disappear (the page re-renders
// `fold(apply, ∅, ops[0..n])`, read-only), drag partway to see a prefix, then return to the end and
// confirm live editing is restored by typing more. Every wait is on visible DOM, never on time.
import { expect, test, type Page } from '@playwright/test';
import { editor, open } from './helpers.ts';

const slider = (page: Page) => page.getByTestId('history-slider');

test('F8 time-travel: drag the slider back and the words disappear, then return to the end and keep editing', async ({ page }) => {
  const docId = `e2e-f8-${Date.now().toString(36)}`;
  await open(page, docId);
  await editor(page).click();
  await page.keyboard.type('one two three'); // 13 code points → 13 ops
  await expect(editor(page)).toHaveText('one two three');

  // The slider's maximum is the op count; dragging to 0 replays the empty base — the words vanish.
  await expect(slider(page)).toHaveAttribute('max', '13');
  await slider(page).fill('0');
  await expect(editor(page)).toHaveText('');
  await expect(page.getByTestId('history-note')).toHaveText('Read-only — scrubbing');

  // A middle position shows exactly the first n characters.
  await slider(page).fill('7');
  await expect(editor(page)).toHaveText('one two');

  // Back to the end: live editing is restored and a new keystroke lands.
  await slider(page).fill('13');
  await expect(page.getByTestId('history-note')).toHaveText('Live — editing');
  await editor(page).click();
  await page.keyboard.type(' four');
  await expect(editor(page)).toHaveText('one two three four');
});

test('F8 Show authors overlay tints the historical text without changing it', async ({ page }) => {
  const docId = `e2e-f8a-${Date.now().toString(36)}`;
  await open(page, docId);
  await editor(page).click();
  await page.keyboard.type('hello');
  await expect(editor(page)).toHaveText('hello');

  await expect(slider(page)).toHaveAttribute('max', '5'); // wait for the op log to register before scrubbing
  await slider(page).fill('3');
  await page.getByRole('checkbox', { name: 'Show authors' }).check();
  // The overlay colours each character (an inline style set from the author's hue) but the text is unchanged.
  await expect(editor(page)).toHaveText('hel');
  await expect(page.locator('.doc.history .ProseMirror [style*="color"]').first()).toBeVisible();
});
