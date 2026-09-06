// presence.spec.ts — the S5 flows of 03-UI §7 in two real browser contexts against the real relay.
// F-presence (F6 groundwork): two tabs on one doc see each other as a peer avatar and a named remote
// caret. Follow: clicking a peer's Follow frames the editor in their hue and a local keystroke exits.
// I13 (F5 divergence tripwire): the Inspector's "Force divergence" injects a peer whose hash differs
// at an equal state vector; the red Diverged alert appears, carries only an explicit action (no
// dismiss cross), and clears only when that action is taken. Every wait is on visible DOM, never time.
import { expect, test, type Page } from '@playwright/test';
import { editor, open, pill } from './helpers.ts';

const stack = (page: Page) => page.getByTestId('presence-stack');
const presenceLabel = (page: Page) => page.getByTestId('presence-label');
const diverged = (page: Page) => page.getByTestId('diverged');

test('F-presence: two tabs on one doc see each other as a peer avatar and a named remote caret', async ({ browser }) => {
  const docId = `e2e-pres-${Date.now().toString(36)}`;
  const [a, b] = await Promise.all([browser.newContext(), browser.newContext()]);
  const pageA = await a.newPage();
  const pageB = await b.newPage();
  await open(pageA, docId);
  await open(pageB, docId);

  // Each tab publishes presence on going live: the other stops being "Only you".
  await expect(presenceLabel(pageA)).toHaveCount(0);
  await expect(stack(pageA).locator('.av')).toHaveCount(2); // self + one peer

  // A types, moving its caret; B renders A's caret with A's name on the flag.
  await editor(pageA).click();
  await pageA.keyboard.type('hello from A');
  await expect(pageB.locator('.rcaret')).toHaveCount(1);
  await expect(pageB.locator('.rcaret .flag').first()).toHaveText(/.+/); // the caret is named
  await Promise.all([a.close(), b.close()]);
});

test('follow: clicking a peer frames the editor and a local keystroke exits', async ({ browser }) => {
  const docId = `e2e-follow-${Date.now().toString(36)}`;
  const [a, b] = await Promise.all([browser.newContext(), browser.newContext()]);
  const pageA = await a.newPage();
  const pageB = await b.newPage();
  await open(pageA, docId);
  await open(pageB, docId);
  await expect(stack(pageA).locator('.av')).toHaveCount(2);

  await stack(pageA).click(); // open the presence popover
  await pageA.getByRole('button', { name: /Follow/ }).first().click();
  await expect(pageA.locator('.editor-wrap.following')).toBeVisible();
  await expect(pageA.locator('.follow-tag')).toBeVisible();

  // Any local keystroke exits follow.
  await editor(pageA).click();
  await pageA.keyboard.type('x');
  await expect(pageA.locator('.editor-wrap.following')).toHaveCount(0);
  await Promise.all([a.close(), b.close()]);
});

test('I13 divergence tripwire: a peer disagreeing at an equal state vector raises a red alert that cannot be dismissed casually', async ({ browser }) => {
  const docId = `e2e-i13-${Date.now().toString(36)}`;
  const context = await browser.newContext();
  const page = await context.newPage();
  await open(page, docId);
  await editor(page).click();
  await page.keyboard.type('converge');
  await expect(pill(page)).toHaveText('Saved');

  // Force divergence is enabled once this replica has computed its own hash (after quiet).
  const trip = page.getByRole('button', { name: 'Trip' });
  await expect(trip).toBeEnabled();
  await trip.click();

  const alert = diverged(page);
  await expect(alert).toBeVisible();
  await expect(page.getByTestId('inspector-footer')).toHaveText(/hashes differ/);
  // The alert offers ONLY an explicit action — no casual dismiss cross.
  await expect(alert.locator('.xbtn')).toHaveCount(0);
  // A click elsewhere does not clear it.
  await editor(page).click();
  await expect(alert).toBeVisible();
  // The explicit action clears it.
  await alert.getByRole('button', { name: /Copy report/ }).click();
  await expect(diverged(page)).toHaveCount(0);
  await context.close();
});
