// undo.spec.ts — local-only undo (design §0 A3, S7) in real browsers against the real relay. First:
// type, then Ctrl+Z removes your last edit and the work stays saved. Second, the invariant that makes
// undo honest in a collaborative editor — undo is scoped to YOUR ops: with two contexts on one doc,
// an undo in A never reverts B's edit. Every wait is on visible DOM, never on time.
import { expect, test } from '@playwright/test';
import { editor, open, pill } from './helpers.ts';

const count = (s: string, ch: string): number => [...s].filter((c) => c === ch).length;

test('undo: Ctrl+Z removes your last edit and the work stays saved', async ({ page }) => {
  const docId = `e2e-undo-${Date.now().toString(36)}`;
  await open(page, docId);
  await editor(page).click();
  await page.keyboard.type('cat');
  await expect(editor(page)).toHaveText('cat');

  await page.keyboard.press('Control+z'); // one keystroke = one action; the last character goes
  await expect(editor(page)).toHaveText('ca');
  await expect(pill(page)).toHaveText('Saved');

  // Redo brings it back.
  await page.keyboard.press('Control+Shift+z');
  await expect(editor(page)).toHaveText('cat');
});

test('undo in A never reverts B’s edit (undo is scoped to your own operations)', async ({ browser }) => {
  const docId = `e2e-undo2-${Date.now().toString(36)}`;
  const [ca, cb] = await Promise.all([browser.newContext(), browser.newContext()]);
  const a = await ca.newPage();
  const b = await cb.newPage();
  await open(a, docId);
  await open(b, docId);

  // A types a run of A's at the start; B types a run of B's at the start. Each replica's run stays
  // contiguous (I8), so both editors converge to a text with five A's and five B's.
  await editor(a).click();
  await a.keyboard.type('AAAAA');
  await editor(b).click();
  await b.keyboard.type('BBBBB');
  await expect.poll(async () => count(await editor(a).innerText(), 'B')).toBe(5);
  await expect.poll(async () => count(await editor(b).innerText(), 'A')).toBe(5);

  // A undoes once: exactly one of A's own characters goes; B's five B's are untouched on both.
  await a.keyboard.press('Control+z');
  await expect.poll(async () => count(await editor(a).innerText(), 'A')).toBe(4);
  await expect.poll(async () => count(await editor(a).innerText(), 'B')).toBe(5);
  await expect.poll(async () => count(await editor(b).innerText(), 'A')).toBe(4);
  await expect.poll(async () => count(await editor(b).innerText(), 'B')).toBe(5);

  await Promise.all([ca.close(), cb.close()]);
});
