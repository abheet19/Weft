// f2-f3.spec.ts — flows F2 and F3 of 03-UI §7 in two real browser contexts against the real relay.
// F2 "go offline and type at the same spot": A flips Simulate offline (the socket closes for
// real), both type at the same position; A's pill counts its edits on this device with the exact N,
// B's reads Saved. F3 "reconnect and converge": A flips back; its pill passes through Catching up
// with the exact in/out counts and both end on Saved with identical text, the two runs intact and
// not interleaved (I8), and the strip reads "Back online — N offline edits merged." with A's N.
import { expect, test } from '@playwright/test';
import { editor, notice, offlineSwitch, open, openSync, pill, pillSeen, recordPill } from './helpers.ts';

test('F2 go offline and type at the same spot: A reads Offline · N changes on this device with the exact N, B reads Saved', async ({ browser }) => {
  const docId = `e2e-f2-${Date.now().toString(36)}`;
  const [a, b] = await Promise.all([browser.newContext(), browser.newContext()]);
  const pageA = await a.newPage();
  const pageB = await b.newPage();
  await open(pageA, docId);
  await open(pageB, docId);

  await openSync(pageA);
  await offlineSwitch(pageA).click();
  await expect(offlineSwitch(pageA)).toHaveAttribute('aria-checked', 'true');
  await expect(pill(pageA)).toHaveText('Offline · 0 changes on this device');

  await editor(pageA).click();
  await pageA.keyboard.type('AAAA');
  await editor(pageB).click();
  await pageB.keyboard.type('BBB');

  await expect(pill(pageA)).toHaveText('Offline · 4 changes on this device');
  await expect(pill(pageB)).toHaveText('Saved');
  await expect(editor(pageA)).toHaveText('AAAA');
  await expect(editor(pageB)).toHaveText('BBB');
  await Promise.all([a.close(), b.close()]);
});

test('F3 reconnect and converge: the pill passes through Catching up · 3 in, 4 out, ends Saved on both, texts identical and not interleaved, strip says Back online — 4 offline edits merged.', async ({ browser }) => {
  const docId = `e2e-f3-${Date.now().toString(36)}`;
  const [a, b] = await Promise.all([browser.newContext(), browser.newContext()]);
  const pageA = await a.newPage();
  const pageB = await b.newPage();
  await open(pageA, docId);
  await open(pageB, docId);

  await openSync(pageA);
  await offlineSwitch(pageA).click();
  await expect(pill(pageA)).toHaveText('Offline · 0 changes on this device');
  await editor(pageA).click();
  await pageA.keyboard.type('AAAA');
  await editor(pageB).click();
  await pageB.keyboard.type('BBB');
  await expect(pill(pageA)).toHaveText('Offline · 4 changes on this device');
  await expect(pill(pageB)).toHaveText('Saved');

  await recordPill(pageA);
  await offlineSwitch(pageA).click();
  await expect(pill(pageA)).toHaveText('Saved');
  await expect(pill(pageB)).toHaveText('Saved');
  expect(await pillSeen(pageA)).toContain('Catching up · 3 in, 4 out');

  await expect(editor(pageB)).toHaveText(/^(AAAABBB|BBBAAAA)$/);
  await expect(editor(pageA)).toHaveText(/^(AAAABBB|BBBAAAA)$/); // retrying: the editor mirrors the document on a microtask after the pill's state
  expect(await editor(pageA).innerText()).toBe(await editor(pageB).innerText());
  const merged = notice(pageA).filter({ hasText: 'Back online' }); // the storage strip may be on screen too
  await expect(merged).toContainText('Back online — 4 offline edits merged.');
  await expect(merged.getByRole('button', { name: 'Open sidebar' })).toBeVisible();
  await Promise.all([a.close(), b.close()]);
});
