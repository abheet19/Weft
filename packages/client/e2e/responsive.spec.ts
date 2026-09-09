// Phone regression for the real editor shell. It guards the failure that previously clipped the
// presence label and let the persistent sync pill cover the sidebar tabs at narrow widths.
import { expect, test } from '@playwright/test';
import { base, editor, pill } from './helpers.ts';

test('phone shell keeps every top-bar action in view and the sync pill clear of the sidebar tabs', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto(`${base()}/d/e2e-phone-${Date.now().toString(36)}`);
  await expect(editor(page)).toBeVisible();
  await expect(pill(page)).toHaveText('Saved');

  const layout = await page.evaluate(() => {
    const controls = [...document.querySelectorAll<HTMLElement>('.topbar > *')].map((el) => {
      const box = el.getBoundingClientRect();
      return { left: box.left, right: box.right };
    });
    const status = document.querySelector<HTMLElement>('.pill')?.getBoundingClientRect();
    const tabs = document.querySelector<HTMLElement>('.railtabs')?.getBoundingClientRect();
    return {
      pageOverflows: document.documentElement.scrollWidth > window.innerWidth,
      controlsInside: controls.every(({ left, right }) => left >= 0 && right <= window.innerWidth),
      statusClearsTabs: status === undefined || tabs === undefined || status.bottom <= tabs.top || status.top >= tabs.bottom,
    };
  });
  expect(layout).toEqual({ pageOverflows: false, controlsInside: true, statusClearsTabs: true });

  await editor(page).click();
  await page.keyboard.type('Phone draft');
  await expect(editor(page)).toHaveText('Phone draft');
  await expect(pill(page)).toHaveText('Saved');

  await page.getByRole('button', { name: 'Open command palette' }).click();
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
});
