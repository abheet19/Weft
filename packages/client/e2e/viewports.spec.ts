import { expect, test, type Page } from '@playwright/test';
import { base, editor, pill } from './helpers.ts';

const VIEWPORTS = [
  { label: 'phone', width: 320, height: 844 },
  { label: 'tablet', width: 768, height: 1024 },
  { label: 'laptop', width: 1366, height: 768 },
  { label: 'wide', width: 1920, height: 1080 },
] as const;

async function assertLayout(page: Page): Promise<void> {
  const result = await page.evaluate(() => {
    const visible = (element: HTMLElement): boolean => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const controls = [...document.querySelectorAll<HTMLElement>('button, a[href], input, textarea, select, [role="tab"], [role="button"]')].filter(visible);
    const nameless = controls.filter((element) => {
      const labelled = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement ? (element.labels?.length ?? 0) > 0 : false;
      return !(labelled || element.getAttribute('aria-label') || element.getAttribute('aria-labelledby') || element.textContent?.trim() || element.title);
    });
    const ids = [...document.querySelectorAll<HTMLElement>('[id]')].map((element) => element.id);
    return {
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      nameless: nameless.length,
      duplicateIds: ids.length - new Set(ids).size,
      mains: document.querySelectorAll('main').length,
    };
  });
  expect(result).toEqual({ overflow: false, nameless: 0, duplicateIds: 0, mains: 1 });
}

for (const viewport of VIEWPORTS) {
  test(`${viewport.label}: Documents, Editor, History, and Settings stay usable`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(`page: ${error.message}`));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
    page.on('requestfailed', (request) => {
      const reason = request.failure()?.errorText ?? 'unknown';
      if (!reason.includes('ERR_ABORTED')) errors.push(`request: ${request.method()} ${request.url()} ${reason}`);
    });
    page.on('response', (response) => { if (response.status() >= 400) errors.push(`http: ${response.status()} ${response.url()}`); });

    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(base());
    await expect(page.getByRole('heading', { name: 'Documents', level: 1 })).toBeVisible();
    await assertLayout(page);
    await page.getByRole('button', { name: 'New document' }).last().click();
    await expect(editor(page)).toBeVisible();
    await expect(pill(page)).toHaveText('Saved');
    await editor(page).click();
    await page.keyboard.type(`${viewport.label} draft`);
    await expect(pill(page)).toHaveText('Saved');
    await assertLayout(page);
    await page.locator('.navrail').getByRole('tab', { name: 'History' }).click();
    await expect(page.getByRole('heading', { name: 'History', level: 1 })).toBeVisible();
    await assertLayout(page);
    await page.locator('.navrail').getByRole('tab', { name: 'Settings' }).click();
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
    await assertLayout(page);
    await page.getByRole('button', { name: 'Collaboration' }).click();
    await expect(page.getByRole('textbox', { name: 'Your name' })).toBeVisible();
    await page.getByRole('button', { name: 'Shortcuts' }).click();
    await expect(page.locator('.shortcut-row').first()).toBeVisible();
    await page.getByRole('button', { name: 'Debug' }).click();
    await expect(page.getByRole('heading', { name: /Debug — this document/ })).toBeVisible();
    expect(errors).toEqual([]);
  });
}
