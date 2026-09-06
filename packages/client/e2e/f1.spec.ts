// f1.spec.ts — flow F1 of 03-UI §7, "open and type together", in two real browser contexts against
// the real relay: both open the same /d/<id>, both type — one at the start, one at the end, in
// alternation — and the assertions are the design's: both editors show the same text, and both pills
// read `Saved`, which is drawn from the server's acknowledgements (I11), not from a timer. The wait
// is for the pill text itself; a fixed sleep would prove nothing about where the work is.
import { expect, test, type Page } from '@playwright/test';

const base = (): string => {
  const b = process.env['WEFT_E2E_BASE'];
  if (b === undefined) throw new Error('WEFT_E2E_BASE is not set: global-setup did not run');
  return b;
};

const editor = (page: Page) => page.locator('.doc .ProseMirror');
const pill = (page: Page) => page.getByTestId('pill-text');

async function open(page: Page, docId: string): Promise<void> {
  await page.goto(`${base()}/d/${docId}`);
  await expect(editor(page)).toBeVisible();
  await expect(pill(page)).toHaveText('Saved');
}

test('F1 open and type together: two windows on one document type at different positions, see identical text, and both read Saved', async ({ browser }) => {
  const docId = `e2e-f1-${Date.now().toString(36)}`;
  const [a, b] = await Promise.all([browser.newContext(), browser.newContext()]);
  const pageA = await a.newPage();
  const pageB = await b.newPage();
  await open(pageA, docId);
  await open(pageB, docId);

  await editor(pageA).click();
  await pageA.keyboard.type('Hello from A. ');
  await expect(editor(pageB)).toHaveText('Hello from A. ');

  await editor(pageB).click();
  await pageB.keyboard.press('End');
  await pageB.keyboard.type('And B replies.');
  await expect(editor(pageA)).toHaveText('Hello from A. And B replies.');

  // Interleaved: A types at the very start while B keeps typing at the end.
  await pageA.keyboard.press('Home');
  await Promise.all([pageA.keyboard.type('>> '), pageB.keyboard.type(' <<')]);

  // Convergence first, and awaited: `Saved` says the server acknowledged MY ops, not that the peer's
  // have arrived here, so the text is asserted with a retrying matcher on both editors before the pills.
  const converged = '>> Hello from A. And B replies. <<';
  await expect(editor(pageA)).toHaveText(converged);
  await expect(editor(pageB)).toHaveText(converged);
  await expect(pill(pageA)).toHaveText('Saved');
  await expect(pill(pageB)).toHaveText('Saved');
  const textA = await editor(pageA).innerText();
  const textB = await editor(pageB).innerText();
  expect(textA).toBe(textB);
  expect(textA).toBe(converged);

  await Promise.all([a.close(), b.close()]);
});

test('/ redirects to a fresh document and the pill reads Saved once the relay has acknowledged the empty session', async ({ page }) => {
  await page.goto(`${base()}/`);
  await expect(page).toHaveURL(/\/d\/[a-z0-9]{12}$/);
  await expect(pill(page)).toHaveText('Saved');
});
