// f7.spec.ts — flow F7 of 03-UI §7, "format text", and the W-8 concurrent-formatting case, in real
// browser contexts against the real relay. F7: select a word, apply Bold from the floating bar and
// with Ctrl+B, and assert the DOM shows <strong> while the document TEXT is unchanged (a mark is not
// a character). W-8: two windows bold overlapping ranges of one sentence at the same time and
// converge to identical rendered marks; and the design §2.5 anomaly — a character typed just after a
// bold word is not bold — converges too. Every wait is on visible state, never on a fixed timeout.
// The selection is set through the DOM Selection API (which ProseMirror reads) rather than by a run
// of Shift+Arrow presses, because the format bar re-renders on every selection change and a stream of
// key events races that re-render; one atomic range does not.
import { expect, test, type Page } from '@playwright/test';
import { editor, open, pill } from './helpers.ts';

const strong = (page: Page) => page.locator('.doc strong');
const boldButton = (page: Page) => page.getByRole('button', { name: 'Bold (Ctrl+B)' });

/** Select code points [from, to) of the editor's text via the DOM Selection API; ProseMirror reads it. */
async function selectRange(page: Page, from: number, to: number): Promise<void> {
  await page.evaluate(
    ({ from, to }) => {
      const root = document.querySelector('.doc .ProseMirror');
      if (root === null) throw new Error('no editor');
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let acc = 0;
      let startNode: Text | null = null;
      let startOff = 0;
      let endNode: Text | null = null;
      let endOff = 0;
      for (let node = walker.nextNode() as Text | null; node !== null; node = walker.nextNode() as Text | null) {
        const len = node.data.length;
        if (startNode === null && acc + len >= from) {
          startNode = node;
          startOff = from - acc;
        }
        if (acc + len >= to) {
          endNode = node;
          endOff = to - acc;
          break;
        }
        acc += len;
      }
      if (startNode === null || endNode === null) throw new Error('range out of text');
      const range = document.createRange();
      range.setStart(startNode, startOff);
      range.setEnd(endNode, endOff);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    },
    { from, to },
  );
}

test('F7 format text: select a word, apply Bold from the bar and with Ctrl+B; the DOM shows <strong> and the text is unchanged', async ({ page }) => {
  const docId = `e2e-f7-${Date.now().toString(36)}`;
  await open(page, docId);
  await editor(page).click();
  await page.keyboard.type('hello world');
  await expect(editor(page)).toHaveText('hello world');

  // Select "hello" and click the bar's Bold button.
  await selectRange(page, 0, 5);
  await expect(boldButton(page)).toBeVisible();
  await boldButton(page).click();
  await expect(strong(page)).toHaveText('hello');

  // Select "world" and apply bold with the keyboard shortcut instead.
  await selectRange(page, 6, 11);
  await page.keyboard.press('Control+b');
  await expect(strong(page)).toHaveText(['hello', 'world']);

  // The document TEXT is unchanged — a mark is not a character — and the work is Saved.
  await expect(editor(page)).toHaveText('hello world');
  await expect(pill(page)).toHaveText('Saved');
});

test('W-8 concurrent formatting: two windows bold overlapping ranges of one sentence and converge to the same marks', async ({ browser }) => {
  const docId = `e2e-w8-${Date.now().toString(36)}`;
  const [ca, cb] = await Promise.all([browser.newContext(), browser.newContext()]);
  const a = await ca.newPage();
  const b = await cb.newPage();
  await open(a, docId);
  await open(b, docId);

  await editor(a).click();
  await a.keyboard.type('abcdef');
  await expect(editor(a)).toHaveText('abcdef');
  await expect(editor(b)).toHaveText('abcdef');

  // A bolds "abcd" while B bolds "cdef" — overlapping on "cd", at once.
  await selectRange(a, 0, 4);
  await selectRange(b, 2, 6);
  await Promise.all([a.keyboard.press('Control+b'), b.keyboard.press('Control+b')]);

  // Both converge: the union "abcdef" is one bold run on each editor. `toHaveText` retries until the
  // peer's fmt op has round-tripped through the relay.
  await expect(strong(a)).toHaveText('abcdef');
  await expect(strong(b)).toHaveText('abcdef');
  await expect(editor(a)).toHaveText('abcdef');
  await expect(editor(b)).toHaveText('abcdef');

  await Promise.all([ca.close(), cb.close()]);
});

test('the §2.5 anomaly converges: a character typed just after a bold word is not bold on either window', async ({ browser }) => {
  const docId = `e2e-anom-${Date.now().toString(36)}`;
  const [ca, cb] = await Promise.all([browser.newContext(), browser.newContext()]);
  const a = await ca.newPage();
  const b = await cb.newPage();
  await open(a, docId);
  await open(b, docId);

  await editor(a).click();
  await a.keyboard.type('Hello');
  await expect(editor(a)).toHaveText('Hello');
  await selectRange(a, 0, 5);
  await a.keyboard.press('Control+b');
  await expect(strong(a)).toHaveText('Hello');

  // Type "!" right after the bold "o": it inherits the stored mark in the editor, but the CRDT does
  // not, so it is corrected to plain — and the peer shows the same.
  await a.keyboard.press('End');
  await a.keyboard.type('!');
  await expect(editor(a)).toHaveText('Hello!');
  await expect(editor(b)).toHaveText('Hello!');
  // "Hello" is bold on both; the "!" is not part of the bold run.
  await expect(strong(a)).toHaveText('Hello');
  await expect(strong(b)).toHaveText('Hello');

  await Promise.all([ca.close(), cb.close()]);
});
