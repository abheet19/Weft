// live-smoke.mjs — immutable-release proof against the public origin. It checks the release SHA,
// then exercises the deployed HTTP/WebSocket/editor path with two isolated peers, offline merge,
// reconnect actions, the command palette, and the 320 px shell. It never uses a fixed sleep.
import { chromium, expect } from '@playwright/test';

const baseUrl = (process.env['WEFT_BASE_URL'] ?? 'https://weft-abheet.fly.dev').replace(/\/$/u, '');
const expectedRelease = process.env['WEFT_RELEASE_SHA'];
if (expectedRelease === undefined || !/^[0-9a-f]{40}$/u.test(expectedRelease)) {
  throw new Error('WEFT_RELEASE_SHA must be the full 40-character commit deployed to the public origin');
}

const check = expect.configure({ timeout: 20_000 });
const documentId = `live-smoke-${Date.now().toString(36)}`;
const pageErrors = [];

const editor = (page) => page.locator('.doc .ProseMirror');
const pill = (page) => page.getByTestId('pill-text');
const offlineSwitch = (page) => page.getByRole('switch', { name: 'Simulate offline' });

function observe(page, label) {
  page.on('pageerror', (error) => pageErrors.push(`${label}: ${error.message}`));
}

async function open(page) {
  await page.goto(`${baseUrl}/d/${documentId}`, { waitUntil: 'domcontentloaded' });
  await check(editor(page)).toBeVisible();
  await check(pill(page)).toHaveText('Saved');
}

const healthResponse = await fetch(`${baseUrl}/health`, {
  headers: { accept: 'application/json' },
  signal: AbortSignal.timeout(20_000),
});
if (!healthResponse.ok) throw new Error(`health returned HTTP ${healthResponse.status}`);
const health = await healthResponse.json();
if (health.status !== 'ok' || health.release !== expectedRelease) {
  throw new Error(`health identifies ${JSON.stringify(health)}, expected release ${expectedRelease}`);
}

const browser = await chromium.launch();
try {
  const [contextA, contextB] = await Promise.all([browser.newContext(), browser.newContext()]);
  const [pageA, pageB] = await Promise.all([contextA.newPage(), contextB.newPage()]);
  observe(pageA, 'peer-a');
  observe(pageB, 'peer-b');
  await Promise.all([open(pageA), open(pageB)]);

  await editor(pageA).click();
  await pageA.keyboard.type('online-a ');
  await check(editor(pageB)).toHaveText('online-a ');
  await editor(pageB).click();
  await pageB.keyboard.press('End');
  await pageB.keyboard.type('online-b ');
  await check(editor(pageA)).toHaveText('online-a online-b ');

  await pageA.getByRole('tab', { name: 'Sync' }).click();
  await offlineSwitch(pageA).click();
  await check(pill(pageA)).toHaveText('Offline · 0 changes on this device');
  await editor(pageA).click();
  await pageA.keyboard.press('End');
  await pageA.keyboard.type('offline-a ');
  await editor(pageB).click();
  await pageB.keyboard.press('End');
  await pageB.keyboard.type('online-b2');
  await check(pill(pageB)).toHaveText('Saved');

  await offlineSwitch(pageA).click();
  await check(pill(pageA)).toHaveText('Saved');
  await check
    .poll(async () => (await editor(pageA).innerText()) === (await editor(pageB).innerText()))
    .toBe(true);
  const converged = await editor(pageA).innerText();
  for (const fragment of ['online-a', 'online-b', 'offline-a', 'online-b2']) {
    if (!converged.includes(fragment)) throw new Error(`converged document lost ${fragment}: ${converged}`);
  }
  const reconnectNotice = pageA.locator('.notice').filter({ hasText: 'Back online' });
  await reconnectNotice.getByRole('button', { name: 'Open sidebar' }).click();
  await check(pageA.getByRole('tab', { name: 'Outline' })).toBeVisible();
  await reconnectNotice.getByRole('button', { name: 'Dismiss' }).click();
  await check(reconnectNotice).toHaveCount(0);

  await pageA.getByRole('button', { name: 'Open command palette (Ctrl+K)' }).click();
  const palette = pageA.getByRole('dialog', { name: 'Command palette' });
  await check(palette.getByRole('option')).toHaveCount(12);
  await pageA.keyboard.press('Escape');
  await check(palette).toBeHidden();

  await Promise.all([contextA.close(), contextB.close()]);

  const mobile = await browser.newContext({ viewport: { width: 320, height: 844 } });
  const phone = await mobile.newPage();
  observe(phone, 'mobile');
  await open(phone);
  await check(editor(phone)).toContainText('online-a');
  const mobileLayout = await phone.evaluate(() => ({
    pageOverflows: document.documentElement.scrollWidth > window.innerWidth,
    controlsInside: [...document.querySelectorAll('.topbar > *')].every((node) => {
      const { left, right } = node.getBoundingClientRect();
      return left >= 0 && right <= window.innerWidth;
    }),
  }));
  check(mobileLayout).toEqual({ pageOverflows: false, controlsInside: true });
  await phone.getByRole('button', { name: 'Open command palette (Ctrl+K)' }).click();
  await check(phone.getByRole('dialog', { name: 'Command palette' }).getByRole('option')).toHaveCount(12);
  await phone.keyboard.press('Escape');
  await phone.getByRole('button', { name: 'Toggle sidebar' }).click();
  await check(phone.getByRole('tab', { name: 'Outline' })).toHaveCount(0);
  await phone.getByRole('button', { name: 'Toggle sidebar' }).click();
  await check(phone.getByRole('tab', { name: 'Outline' })).toBeVisible();
  await mobile.close();

  if (pageErrors.length > 0) throw new Error(`browser page errors:\n${pageErrors.join('\n')}`);
  console.log(
    JSON.stringify(
      {
        status: 'passed',
        baseUrl,
        release: health.release,
        documentId,
        checks: ['health SHA', 'two-peer WebSocket convergence', 'offline merge', 'reconnect actions', 'palette', '320 px shell'],
        pageErrors: 0,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
