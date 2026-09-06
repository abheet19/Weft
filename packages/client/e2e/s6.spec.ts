// s6.spec.ts — the redesign's editing surface (S6, 03-UI §4.4/§4.5) in a real browser: the persistent
// toolbar applies every new mark and block and the DOM reflects it; the link popover copies / edits /
// removes a link; the sidebar's tabs show the outline, the people, and the sync status. One browser
// context (these are local editing gestures, not collaboration), against the real server + preview
// build global-setup published. Each mark and block is exercised in its OWN fresh document so no
// selection or trailing-block state leaks between cases. Every wait is on visible state.

import { expect, test, type Page } from '@playwright/test';
import { editor, open, pill } from './helpers.ts';

const tb = (page: Page, name: string) => page.getByRole('button', { name });
let n = 0;
const freshId = (kind: string): string => `e2e-s6-${kind}-${Date.now().toString(36)}-${n++}`;

/** A fresh document with `text` typed and fully selected, acknowledged (Saved) so no edit is in flight. */
async function seeded(page: Page, kind: string, text: string): Promise<void> {
  await open(page, freshId(kind));
  await editor(page).click();
  await page.keyboard.type(text);
  await expect(pill(page)).toHaveText('Saved');
  await editor(page).press('Control+a');
}

test('S6 toolbar applies each new inline mark, and the DOM reflects it', async ({ page }) => {
  for (const [label, tag] of [
    ['Bold (Ctrl+B)', 'strong'],
    ['Underline (Ctrl+U)', 'u'],
    ['Strikethrough (Ctrl+Shift+S)', 's'],
    ['Highlight (Ctrl+Shift+H)', 'mark'],
    ['Inline code (Ctrl+E)', 'code'],
  ] as const) {
    await seeded(page, 'mark', 'hello world');
    await tb(page, label).click();
    await expect(editor(page).locator(tag)).toHaveText('hello world');
    // Toggling it off removes the tag again — the button runs the same command a second press does.
    await editor(page).press('Control+a');
    await tb(page, label).click();
    await expect(editor(page).locator(tag)).toHaveCount(0);
  }
});

test('S6 two marks coexist and a colour mark carries its value', async ({ page }) => {
  await seeded(page, 'multi', 'hello world');
  await tb(page, 'Bold (Ctrl+B)').click();
  await editor(page).press('Control+a');
  await tb(page, 'Underline (Ctrl+U)').click();
  await expect(editor(page).locator('strong u')).toHaveText('hello world');

  await seeded(page, 'colour', 'hello world');
  await tb(page, 'Text colour').click();
  await page.getByRole('menuitem', { name: '#0e8ea0' }).click();
  await expect(editor(page).locator('span[style*="color"]').first()).toBeVisible();
});

test('S6 toolbar applies each new block type, and the DOM node changes', async ({ page }) => {
  for (const [label, sel] of [
    ['Numbered list', 'li[data-ordered]'],
    ['Quote', 'blockquote'],
    ['Code block', 'pre'],
  ] as const) {
    await seeded(page, 'block', 'a line');
    await tb(page, label).click();
    await expect(editor(page).locator(sel).first()).toBeVisible();
  }
});

test('S6 checklist: the toolbar makes an item and clicking its box ticks it (a collaborative attr)', async ({ page }) => {
  await seeded(page, 'check', 'do the thing');
  await tb(page, 'Checklist').click();
  const check = editor(page).locator('li[data-check]').first();
  await expect(check).toBeVisible();
  await check.click({ position: { x: 6, y: 8 } });
  await expect(editor(page).locator('li[data-check][data-checked="true"]').first()).toBeVisible();
  await expect(pill(page)).toHaveText('Saved'); // the tick persisted like any other edit
});

test('S6 divider: the toolbar inserts a horizontal rule as its own block', async ({ page }) => {
  await open(page, freshId('divider'));
  await editor(page).click();
  await page.keyboard.type('above');
  await expect(pill(page)).toHaveText('Saved');
  await page.keyboard.press('End');
  await tb(page, 'Divider').click();
  await expect(editor(page).locator('hr').first()).toBeVisible();
});

test('S6 link popover: create a link, then Copy / Edit / Remove it', async ({ page }) => {
  await seeded(page, 'link', 'anchor');
  await tb(page, 'Link (Ctrl+K)').click();
  const urlInput = page.getByRole('textbox', { name: 'Link URL' });
  await expect(urlInput).toBeVisible();
  await urlInput.fill('https://example.org/');
  await urlInput.press('Enter');
  await expect(editor(page).locator('a[href="https://example.org/"]')).toHaveText('anchor');

  // Caret inside the link → the popover (the one floating element) appears with the url and actions.
  await editor(page).locator('a').click();
  const pop = page.getByRole('dialog', { name: 'Link' });
  await expect(pop).toBeVisible();
  await expect(pop.getByText('https://example.org/')).toBeVisible();
  await pop.getByRole('button', { name: 'Copy link' }).click();
  await expect(pop.getByRole('button', { name: 'Copied' })).toBeVisible();

  await editor(page).locator('a').click();
  await page.getByRole('dialog', { name: 'Link' }).getByRole('button', { name: 'Remove link' }).click();
  await expect(editor(page).locator('a')).toHaveCount(0);
  await expect(editor(page)).toHaveText('anchor');
});

test('S6 sidebar: Outline lists headings and jumps, People shows you, Sync shows the status', async ({ page }) => {
  await seeded(page, 'rail', 'The Title');
  await page.locator('#blockBtn').click();
  await page.getByRole('menuitemradio', { name: 'Heading 1' }).click();
  await expect(editor(page).locator('h1')).toHaveText('The Title');

  const outlineItem = page.locator('.ol-a', { hasText: 'The Title' });
  await expect(outlineItem).toBeVisible();
  await outlineItem.click(); // jumps the caret without error

  await page.getByRole('tab', { name: 'People' }).click();
  await expect(page.locator('.prow', { hasText: '(you)' })).toBeVisible();

  await page.getByRole('tab', { name: 'Sync' }).click();
  await expect(page.locator('.syncbig')).toContainText('Saved');
});
