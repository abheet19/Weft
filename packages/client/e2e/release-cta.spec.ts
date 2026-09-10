import { expect, test, type Page } from '@playwright/test';
import { base, editor, open, openChaos, pill } from './helpers.ts';

let serial = 0;
const fresh = (label: string): string => `release-${label}-${Date.now().toString(36)}-${serial++}`;

async function runCommand(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: 'Open command palette (Ctrl+K)' }).click();
  const dialog = page.getByRole('dialog', { name: 'Command palette' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('combobox').fill(title);
  const option = dialog.getByRole('option').filter({ hasText: title });
  await expect(option).toHaveCount(1);
  await option.click();
  await expect(dialog).toBeHidden();
}

async function selectAll(page: Page): Promise<void> {
  await page.evaluate(() => {
    const root = document.querySelector('.doc .ProseMirror');
    if (root === null) throw new Error('no editor');
    const range = document.createRange();
    range.selectNodeContents(root);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
}

test('every command-palette action is present and stateful actions produce visible effects', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await open(page, fresh('commands'));

  await page.getByRole('button', { name: 'Open command palette (Ctrl+K)' }).click();
  const dialog = page.getByRole('dialog', { name: 'Command palette' });
  await expect(dialog.getByRole('option')).toHaveCount(12);
  for (const title of [
    'Rename via heading',
    'New document',
    'Theme',
    'Reduce transparency',
    'Set my name',
    'Follow…',
    'Time-travel',
    'Show authors',
    'Simulate offline',
    'Drop next N',
    'Toggle Inspector',
    'Copy state vector',
  ]) {
    await expect(dialog.getByRole('option').filter({ hasText: title })).toHaveCount(1);
  }
  await page.keyboard.press('Escape');

  await runCommand(page, 'Rename via heading');
  await expect(editor(page)).toBeFocused();

  await runCommand(page, 'Theme');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await runCommand(page, 'Theme');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  await runCommand(page, 'Reduce transparency');
  await expect(page.locator('html')).toHaveAttribute('data-flat', '1');
  await runCommand(page, 'Reduce transparency');
  await expect(page.locator('html')).not.toHaveAttribute('data-flat', '1');

  page.once('dialog', async (prompt) => prompt.accept('Ada Lovelace'));
  await runCommand(page, 'Set my name');
  await expect(page.locator('.pres')).toHaveAttribute('aria-label', /AL/);

  await page.getByRole('button', { name: 'Toggle sidebar' }).click();
  await expect(page.getByRole('tab', { name: 'Outline' })).toHaveCount(0);
  await runCommand(page, 'Time-travel');
  await expect(page.getByTestId('history-slider')).toBeVisible();

  await runCommand(page, 'Show authors');
  await expect(page.getByRole('checkbox', { name: 'Show authors' })).toBeChecked();
  await runCommand(page, 'Show authors');
  await expect(page.getByRole('checkbox', { name: 'Show authors' })).not.toBeChecked();

  await runCommand(page, 'Toggle Inspector');
  await expect(page.getByRole('tab', { name: 'Outline' })).toHaveCount(0);
  await runCommand(page, 'Toggle Inspector');
  await expect(page.getByRole('tab', { name: 'Outline' })).toBeVisible();

  await runCommand(page, 'Copy state vector');
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(() => JSON.parse(clipboard) as unknown).not.toThrow();

  await runCommand(page, 'Simulate offline');
  await expect(pill(page)).toHaveText('Offline · 0 changes on this device');
  await editor(page).click();
  await page.keyboard.type('offline');
  await expect(pill(page)).toHaveText(/Offline · 7 changes on this device/);
  await page.getByRole('button', { name: 'Toggle sidebar' }).click();
  await runCommand(page, 'Simulate offline');
  await expect(pill(page)).toHaveText('Saved');
  const merged = page.locator('.notice').filter({ hasText: 'Back online' });
  await merged.getByRole('button', { name: 'Open sidebar' }).click();
  await expect(page.getByRole('tab', { name: 'Outline' })).toBeVisible();
  await merged.getByRole('button', { name: 'Dismiss' }).click();
  await expect(merged).toHaveCount(0);

  const oldUrl = page.url();
  await runCommand(page, 'New document');
  await expect(page).not.toHaveURL(oldUrl);
  await expect(editor(page)).toBeVisible();
  await expect(pill(page)).toHaveText('Saved');
});

test('collaboration, sync diagnostics, status, presence, and sidebar CTAs execute end to end', async ({ browser }) => {
  const a = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const b = await browser.newContext();
  const pageA = await a.newPage();
  const pageB = await b.newPage();
  const docId = fresh('collaboration');
  await Promise.all([open(pageA, docId), open(pageB, docId)]);

  await pageA.locator('.pres').click();
  const presence = pageA.getByRole('dialog', { name: 'Who is here' });
  await expect(presence).toBeVisible();
  await expect(presence.getByRole('button', { name: 'Follow' })).toHaveCount(1);
  await pageA.keyboard.press('Escape');

  await runCommand(pageA, 'Follow…');
  await expect(pageA.locator('.editor-wrap.following')).toBeVisible();
  await editor(pageA).click();
  await expect(pageA.locator('.editor-wrap.following')).toHaveCount(0);

  await runCommand(pageA, 'Drop next N');
  await editor(pageA).click();
  await pageA.keyboard.type('repair', { delay: 80 });
  await expect(editor(pageB)).toHaveText('repair');
  await expect(pill(pageA)).toHaveText('Saved');
  await expect(pill(pageB)).toHaveText('Saved');

  await openChaos(pageA);
  const diagnostics = pageA.locator('details.diag');
  await pageA.getByRole('button', { name: 'More', exact: true }).click();
  await expect(diagnostics.locator('.stepper output')).toHaveText('4');
  await pageA.getByRole('button', { name: 'Fewer', exact: true }).click();
  await expect(diagnostics.locator('.stepper output')).toHaveText('3');

  const delay = pageA.getByRole('switch', { name: 'Delay 2 s' });
  await delay.click();
  await expect(delay).toHaveAttribute('aria-checked', 'true');
  await delay.click();
  await expect(delay).toHaveAttribute('aria-checked', 'false');

  await pageA.getByRole('button', { name: 'Trip' }).click();
  const alert = pageA.getByTestId('diverged');
  await expect(alert).toBeVisible();
  await alert.getByRole('button', { name: 'Copy report & dismiss' }).click();
  await expect(alert).toHaveCount(0);
  await expect.poll(() => pageA.evaluate(() => navigator.clipboard.readText())).toContain('Weft divergence report');

  await pageA.locator('.pill button').click();
  await expect(pageA.getByRole('dialog', { name: 'Sync details' })).toBeVisible();
  await pageA.keyboard.press('Escape');
  await expect(pageA.getByRole('dialog', { name: 'Sync details' })).toHaveCount(0);

  await pageA.getByRole('button', { name: 'Toggle sidebar' }).click();
  await expect(pageA.getByRole('tab', { name: 'Outline' })).toHaveCount(0);
  await pageA.getByRole('button', { name: 'Toggle sidebar' }).click();
  await expect(pageA.getByRole('tab', { name: 'Outline' })).toBeVisible();
  await Promise.all([a.close(), b.close()]);
});

for (const viewport of [
  { label: 'desktop', width: 1280, height: 900 },
  { label: 'mobile 320px', width: 320, height: 844 },
] as const) {
  test(`${viewport.label}: direct editor, formatting, link, history, and navigation CTAs remain usable`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await open(page, fresh(viewport.label.replace(/\W/g, '')));
    await editor(page).click();
    await page.keyboard.type('sample');
    await expect(pill(page)).toHaveText('Saved');

    await page.getByRole('button', { name: 'Undo (Ctrl+Z)' }).click();
    await expect(editor(page)).toHaveText('sampl');
    await page.getByRole('button', { name: 'Redo (Ctrl+Y)' }).click();
    await expect(editor(page)).toHaveText('sample');

    for (const [label, tag] of [
      ['Bold (Ctrl+B)', 'strong'],
      ['Italic (Ctrl+I)', 'em'],
      ['Underline (Ctrl+U)', 'u'],
      ['Strikethrough (Ctrl+Shift+S)', 's'],
      ['Inline code (Ctrl+E)', 'code'],
      ['Highlight (Ctrl+Shift+H)', 'mark'],
    ] as const) {
      await selectAll(page);
      await page.getByRole('button', { name: label }).click();
      await expect(editor(page).locator(tag)).toHaveText('sample');
      await selectAll(page);
      await page.getByRole('button', { name: label }).click();
      await expect(editor(page).locator(tag)).toHaveCount(0);
    }

    for (const [choice, selector] of [
      ['Heading 1', 'h1'],
      ['Heading 2', 'h2'],
      ['Heading 3', 'h3'],
      ['Paragraph', 'p'],
    ] as const) {
      await selectAll(page);
      await page.locator('#blockBtn').click();
      await page.getByRole('menuitemradio', { name: choice }).click();
      await expect(editor(page).locator(selector).filter({ hasText: 'sample' }).first()).toHaveText('sample');
    }

    for (const [choice, selector] of [
      ['Bullet list', 'li:not([data-ordered]):not([data-check])'],
      ['Numbered list', 'li[data-ordered]'],
      ['Checklist', 'li[data-check]'],
      ['Quote', 'blockquote'],
      ['Code block', 'pre'],
    ] as const) {
      await selectAll(page);
      await page.getByRole('button', { name: choice }).click();
      await expect(editor(page).locator(selector).filter({ hasText: 'sample' }).first()).toHaveText('sample');
    }
    await selectAll(page);
    await page.locator('#blockBtn').click();
    await page.getByRole('menuitemradio', { name: 'Paragraph' }).click();

    await selectAll(page);
    await page.getByRole('button', { name: 'Text colour' }).click();
    for (const color of ['#17242c', '#0e8ea0', '#7c5cf0', '#c77d16', '#d3524a', '#1f9d6b', '#2b6fd6', '#b23c8e']) {
      await page.getByRole('menuitem', { name: color }).click();
      const expectedColor = await page.evaluate((value) => {
        const probe = document.createElement('span');
        probe.style.color = value;
        return probe.style.color;
      }, color);
      const colored = editor(page).locator('span[style*="color"]').filter({ hasText: 'sample' }).first();
      await expect(colored).toHaveText('sample');
      await expect(colored).toHaveCSS('color', expectedColor);
      await selectAll(page);
      await page.getByRole('button', { name: 'Text colour' }).click();
    }
    await page.getByRole('menuitem', { name: 'Default' }).click();
    await expect(editor(page).locator('span[style*="color"]')).toHaveCount(0);

    await selectAll(page);
    await page.getByRole('button', { name: 'Highlight colour' }).click();
    await page.getByRole('menuitem', { name: '#ffe8a3' }).click();
    await expect(editor(page).locator('span[style*="background-color"]')).toHaveText('sample');
    await selectAll(page);
    await page.getByRole('button', { name: 'Highlight colour' }).click();
    await page.getByRole('menuitem', { name: 'None' }).click();

    await selectAll(page);
    await page.getByRole('button', { name: 'Link (Ctrl+K)' }).click();
    const destination = `${base()}/d/${fresh('linked')}`;
    await page.getByRole('textbox', { name: 'Link URL' }).fill(destination);
    await page.getByRole('textbox', { name: 'Link URL' }).press('Enter');
    await editor(page).locator('a').click();
    const linkDialog = page.getByRole('dialog', { name: 'Link' });
    const popupPromise = page.waitForEvent('popup');
    await linkDialog.getByRole('button', { name: 'Open link' }).click();
    const popup = await popupPromise;
    await expect(popup).toHaveURL(destination);
    await popup.close();
    await editor(page).locator('a').click();
    await page.getByRole('dialog', { name: 'Link' }).getByRole('button', { name: 'Edit link' }).click();
    await page.getByRole('textbox', { name: 'Edit link URL' }).fill(`${destination}-edited`);
    await page.getByRole('textbox', { name: 'Edit link URL' }).press('Enter');
    await expect(editor(page).locator(`a[href="${destination}-edited"]`)).toHaveText('sample');
    await editor(page).locator('a').click();
    await page.getByRole('dialog', { name: 'Link' }).getByRole('button', { name: 'Remove link' }).click();
    await expect(editor(page).locator('a')).toHaveCount(0);

    await editor(page).click();
    await page.keyboard.press('End');
    await page.getByRole('button', { name: 'Divider' }).click();
    await expect(editor(page).locator('hr')).toHaveCount(1);

    await page.getByRole('tab', { name: 'People' }).click();
    await expect(page.getByRole('tabpanel', { name: 'People' })).toContainText('(you)');
    await page.getByRole('tab', { name: 'Sync' }).click();
    await expect(page.getByRole('tabpanel', { name: 'Sync' })).toContainText('Saved');
    await page.getByRole('tab', { name: 'Outline' }).click();

    const slider = page.getByTestId('history-slider');
    const max = Number(await slider.getAttribute('max'));
    expect(max).toBeGreaterThan(0);
    await slider.fill('0');
    await expect(page.getByTestId('history-note')).toHaveText('Read-only — scrubbing');
    await slider.fill(String(max));
    await expect(page.getByTestId('history-note')).toHaveText('Live — editing');

    await page.locator('.pill button').click();
    await expect(page.getByRole('dialog', { name: 'Sync details' })).toBeVisible();
    await page.keyboard.press('Escape');

    const before = page.url();
    await page.getByRole('link', { name: 'Weft home' }).click();
    await expect(page).not.toHaveURL(before);
    await expect(editor(page)).toBeVisible();
  });
}


async function seedCorruptStore(page: Page, docId: string): Promise<void> {
  await open(page, fresh('seed-corrupt'));
  await page.evaluate(
    ({ id }) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open(`weft:${id}`, 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          for (const store of ['ops', 'meta', 'snapshot']) if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
        };
        request.onerror = () => reject(request.error ?? new Error('could not seed corrupt store'));
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('meta', 'readwrite');
          tx.objectStore('meta').put({ invalid: true }, 'me');
          tx.onabort = () => reject(tx.error ?? new Error('could not seed corrupt store'));
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
        };
      }),
    { id: docId },
  );
}

test('empty and corrupt-store states keep their recovery actions usable', async ({ page }) => {
  const emptyId = fresh('empty-state');
  await open(page, emptyId);
  await expect(page.locator('.page[data-mode="empty"]')).toBeVisible();
  await expect(editor(page)).toBeEditable();

  const corruptId = fresh('corrupt-state');
  await seedCorruptStore(page, corruptId);
  await page.goto(`${base()}/d/${corruptId}`);
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('Couldn’t open this document’s storage');
  await expect(page.locator('.page[data-mode="error"]')).toBeVisible();

  await alert.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Couldn’t open this document’s storage');

  const failedUrl = page.url();
  await page.getByRole('alert').getByRole('button', { name: 'Start fresh (keeps a copy)' }).click();
  await expect(page).not.toHaveURL(failedUrl);
  await expect(editor(page)).toBeEditable();
  await expect(pill(page)).toHaveText('Saved');
});
