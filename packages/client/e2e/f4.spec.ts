// f4.spec.ts — flow F4 of 03-UI §7, "kill the tab, reopen" (design §4.3 and §7 at 1:10): offline,
// type until the pill counts every keystroke on this device — that count is drawn from the IndexedDB
// `complete` events, so it IS the statement "these reached IndexedDB" — then close the page without
// ceremony and open the same URL in the same browser context. The text is there, the pill reads
// `Offline · N changes on this device` with the same N, the Simulate-offline toggle is still on (it
// was persisted for this replica), and flipping it back ends on Saved with a second context reading
// the same text from the server. What a kill BEFORE the commit loses is the §4.3 bound, measured by
// the 1 000-kill test in `test/store/tabKill.test.ts`; this flow is the demo's promise about what the
// pill counted.
import { expect, test } from '@playwright/test';
import { base, editor, offlineSwitch, open, pill } from './helpers.ts';

test('F4 kill the tab, reopen: the offline edits the pill counted are back with the same Offline · N, the toggle is still on, and going online ends on Saved', async ({ browser }) => {
  const docId = `e2e-f4-${Date.now().toString(36)}`;
  const context = await browser.newContext();
  const first = await context.newPage();
  await open(first, docId);
  await offlineSwitch(first).click();
  await expect(pill(first)).toHaveText('Offline · 0 changes on this device');
  await editor(first).click();
  const typed = 'seven ch';
  await first.keyboard.type(typed);
  await expect(pill(first)).toHaveText(`Offline · ${typed.length} changes on this device`); // every keystroke committed to IndexedDB
  await first.close({ runBeforeUnload: false }); // no save, no flush

  const again = await context.newPage();
  await again.goto(`${base()}/d/${docId}`);
  await expect(editor(again)).toBeVisible();
  await expect(pill(again)).toHaveText(`Offline · ${typed.length} changes on this device`);
  await expect(offlineSwitch(again)).toHaveAttribute('aria-checked', 'true');
  await expect(editor(again)).toHaveText(typed);

  await offlineSwitch(again).click();
  await expect(pill(again)).toHaveText('Saved');
  await expect(editor(again)).toHaveText(typed);

  // A second context proves the edits reached the server, not just this profile.
  const other = await browser.newContext();
  const verify = await other.newPage();
  await open(verify, docId);
  await expect(editor(verify)).toHaveText(typed);
  await Promise.all([context.close(), other.close()]);
});
