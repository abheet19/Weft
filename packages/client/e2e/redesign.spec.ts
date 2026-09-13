// redesign.spec.ts — the glass redesign's app shell: the NavRail's four destinations, reached by
// CLICKING the rail itself (release-cta.spec.ts already proves the same screens are reachable from
// the ⌘K palette). Documents is the one genuinely new data surface — this file is its release
// inventory: it is built only from real documents this browser actually opened (never a fabricated
// roster), New/Open/Search/Forget all work, and "forget" removes only the local listing, never the
// document itself. Settings proves its Appearance choices are the same tokens the rest of the app
// reads (`<html data-theme>`/`data-accent`/`data-flat>`) and that they survive a reload, and that its
// Debug section drives the exact same session the Sync tab's Diagnostics does.
import { expect, test, type Page } from '@playwright/test';
import { base, editor, open, pill } from './helpers.ts';

let serial = 0;
const fresh = (label: string): string => `redesign-${label}-${Date.now().toString(36)}-${serial++}`;

const navTab = (page: Page, name: string) => page.getByRole('tab', { name });

test('NavRail switches Editor ↔ History ↔ Settings without losing the open document', async ({ page }) => {
  await open(page, fresh('navrail'));
  await editor(page).click();
  await page.keyboard.type('Rail-driven navigation');
  await expect(pill(page)).toHaveText('Saved');

  await navTab(page, 'Settings').click();
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  await expect(navTab(page, 'Settings')).toHaveAttribute('aria-selected', 'true');

  await navTab(page, 'History').click();
  await expect(page.getByRole('heading', { name: 'History', level: 1 })).toBeVisible();
  await expect(page.getByTestId('history-slider')).toBeVisible();

  await navTab(page, 'Editor').click();
  await expect(editor(page)).toHaveText('Rail-driven navigation');
  await expect(pill(page)).toHaveText('Saved');
});

test('Documents: lists only documents this browser opened, New/Open/Search/Forget all work, and Forget never touches the document itself', async ({ page }) => {
  const first = fresh('docs-a');
  await open(page, first);
  await editor(page).click();
  await page.keyboard.type('First document body');

  await navTab(page, 'Documents').click();
  await expect(page.getByRole('heading', { name: 'Documents', level: 1 })).toBeVisible();
  const firstCard = page.locator('.doc-card', { hasText: 'First document body' });
  await expect(firstCard).toBeVisible();
  await expect(firstCard).toContainText('3 words');
  await expect(firstCard).toContainText(first);

  // New document: a real navigation to a fresh id, then it appears in the list too.
  const beforeUrl = page.url();
  await page.getByRole('button', { name: 'New document' }).first().click();
  await expect(page).not.toHaveURL(beforeUrl);
  await expect(editor(page)).toBeVisible();
  await expect(pill(page)).toHaveText('Saved');
  const secondId = new URL(page.url()).pathname.split('/').pop()!;

  await navTab(page, 'Documents').click();
  await expect(page.getByText('2 of 2')).toBeVisible();
  await expect(page.locator('.doc-card')).toHaveCount(2);

  // Search narrows to one, by id.
  await page.getByRole('textbox', { name: 'Search documents' }).fill(first);
  await expect(page.locator('.doc-card')).toHaveCount(1);
  await expect(page.locator('.doc-card')).toContainText(first);
  await page.getByRole('textbox', { name: 'Search documents' }).fill('');

  // Forget removes it from THIS list only — the document itself is untouched.
  await firstCard.hover();
  await firstCard.locator('.doc-card-forget').click();
  await expect(page.locator('.doc-card')).toHaveCount(1);
  await expect(page.getByText(first)).toHaveCount(0);

  await open(page, first); // still a real, readable document
  await expect(editor(page)).toHaveText('First document body');

  await navTab(page, 'Documents').click();
  await expect(page.locator('.doc-card')).toHaveCount(2); // re-opening it above re-listed it
  await expect(page.getByText(secondId)).toBeVisible();
});

test('Documents: the empty state offers New document when nothing has been opened yet', async ({ page }) => {
  await page.goto(`${base()}/d/${fresh('empty-docs')}`);
  await expect(editor(page)).toBeVisible();
  // Forget every entry this fresh context's own load just created, to reach the true empty state.
  await navTab(page, 'Documents').click();
  for (const btn of await page.locator('.doc-card-forget').all()) await btn.click({ force: true });
  await expect(page.getByRole('heading', { name: 'Nothing opened yet on this device' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New document' }).first()).toBeVisible();
});

test('Settings: Appearance sets the same tokens the rest of the app reads, and it survives a reload', async ({ page }) => {
  const docId = fresh('settings');
  await open(page, docId);
  await navTab(page, 'Settings').click();

  await page.getByRole('radio', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('radio', { name: 'amber' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'amber');
  await page.getByRole('switch', { name: 'Reduce transparency' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-flat', '1');

  await page.reload();
  await expect(editor(page)).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'amber');
  await expect(page.locator('html')).toHaveAttribute('data-flat', '1');

  await navTab(page, 'Settings').click();
  await page.getByRole('button', { name: 'Shortcuts' }).click();
  await expect(page.getByText('Command palette')).toBeVisible();
  await expect(page.locator('.shortcut-row', { hasText: 'Bold' }).locator('kbd')).toHaveText('⌘B');
});

test('Settings › Debug drives the same session the Sync tab’s Diagnostics does', async ({ page }) => {
  await open(page, fresh('settings-debug'));
  await navTab(page, 'Settings').click();
  await page.getByRole('button', { name: 'Debug' }).click();
  await expect(page.getByRole('heading', { name: /Debug — this document/ })).toBeVisible();

  await page.getByRole('button', { name: 'Trip' }).click();
  await navTab(page, 'Editor').click();
  await expect(page.getByTestId('diverged')).toBeVisible();
  await page.getByRole('button', { name: 'Copy report & dismiss' }).click();
  await expect(page.getByTestId('diverged')).toHaveCount(0);
});
