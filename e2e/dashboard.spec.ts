// Browser checks: 4K projector layout with 20 synthetic tiles, normal desktop, phone,
// detail view, and per-user tab visibility. Screenshots go to test-results/screens/.
import { expect, test, type Page } from '@playwright/test';

const OWNER = 'owner@dev.test';
const RENATA = 'renata@dev.test';
const VIEWER = 'colleague.viewer@dev.test';

async function signIn(page: Page, email: string, next = '/') {
  await page.goto(`/__dev/login?email=${encodeURIComponent(email)}&next=${encodeURIComponent(next)}`);
}

async function layoutReport(page: Page) {
  return page.evaluate(() => {
    const tiles = [...document.querySelectorAll<HTMLElement>('.board .tile')];
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const overflowing: string[] = [];
    for (const t of tiles) {
      // Children never shrink, so any overflow shows up as scrollHeight > clientHeight (i.e. clipped text).
      const inner = t.querySelector<HTMLElement>('.tile-in')!;
      if (inner.scrollHeight > inner.clientHeight + 1) overflowing.push(`${t.querySelector('.t-name')?.textContent}`);
    }
    const rects = tiles.map((t) => t.getBoundingClientRect());
    return {
      count: tiles.length,
      allInViewport: rects.every((r) => r.top >= 0 && r.left >= 0 && r.bottom <= vh + 0.5 && r.right <= vw + 0.5),
      scrollable: document.documentElement.scrollHeight > vh + 1 || document.documentElement.scrollWidth > vw + 1,
      overflowing,
      minTile: { w: Math.min(...rects.map((r) => r.width)), h: Math.min(...rects.map((r) => r.height)) },
      nameFontPx: parseFloat(getComputedStyle(document.querySelector('.t-name')!).fontSize),
      bodyFontPx: parseFloat(getComputedStyle(document.querySelector('.tile-in')!).fontSize),
      editControls: document.querySelectorAll('.topbar .btn').length,
      compacted: tiles.filter((t) => /\bc[1-5]\b/.test(t.className)).map((t) => t.querySelector('.t-name')?.textContent),
    };
  });
}

test('4K projector: 20 Work tiles on one screen, readable, no editing controls', async ({ page }) => {
  await page.setViewportSize({ width: 3840, height: 2160 });
  await signIn(page, OWNER, '/?space=work&projector=1');
  await expect(page.locator('.board .tile')).toHaveCount(20);
  await page.waitForTimeout(400);
  const r = await layoutReport(page);
  console.log('projector 4K', JSON.stringify(r));
  expect(r.count).toBe(20);
  expect(r.allInViewport).toBe(true);
  expect(r.scrollable).toBe(false);
  expect(r.overflowing).toEqual([]);
  expect(r.minTile.w).toBeGreaterThan(600);
  expect(r.minTile.h).toBeGreaterThan(400);
  expect(r.nameFontPx).toBeGreaterThanOrEqual(30);
  expect(r.bodyFontPx).toBeGreaterThanOrEqual(20);
  expect(r.editControls).toBe(0); // projector hides Refresh/Ask/Add/Settings
  await page.screenshot({ path: 'test-results/screens/projector-4k-work-20.png' });
});

test('projector at 200% scaling (1920×1080 CSS px) still fits', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await signIn(page, OWNER, '/?space=work&projector=1');
  await expect(page.locator('.board .tile')).toHaveCount(20);
  await page.waitForTimeout(300);
  const r = await layoutReport(page);
  console.log('projector 1080p', JSON.stringify(r));
  expect(r.count).toBe(20);
  expect(r.minTile.w).toBeGreaterThan(300);
  expect(r.minTile.h).toBeGreaterThan(200);
  expect(r.nameFontPx).toBeGreaterThanOrEqual(15);
  expect(r.allInViewport).toBe(true);
  expect(r.scrollable).toBe(false);
  expect(r.overflowing).toEqual([]);
  await page.screenshot({ path: 'test-results/screens/projector-1080p-work-20.png' });
});

test('desktop: tiles, detail drawer, map and summary', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await signIn(page, OWNER, '/?space=work');
  await expect(page.locator('.board .tile')).toHaveCount(20);
  const names = await page.locator('.t-name').allTextContents();
  expect(names[0]).toBe('Warehouse Robotics Pilot'); // pinned first
  expect(names.at(-1)).toBe('Travel Expense Policy Bot'); // paused last
  await page.screenshot({ path: 'test-results/screens/desktop-work.png' });
  await page.locator('.tile', { hasText: 'Customer Portal Redesign' }).click();
  await expect(page.locator('.drawer h2')).toHaveText('Customer Portal Redesign');
  await expect(page.locator('.drawer')).toContainText('Actual blockers');
  await expect(page.locator('.drawer')).toContainText('Anticipated risks');
  await page.waitForTimeout(200);
  await page.screenshot({ path: 'test-results/screens/desktop-detail.png' });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Summary' }).click();
  await expect(page.locator('.page h2')).toHaveText('Daily summary');
  await page.screenshot({ path: 'test-results/screens/desktop-summary.png', fullPage: true });
});

test('phone: single column, scrolls, no horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, OWNER, '/?space=personal');
  await expect(page.locator('.board .tile')).toHaveCount(4);
  const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  expect(wide).toBe(false);
  await page.screenshot({ path: 'test-results/screens/phone-personal.png', fullPage: true });
});

test('tabs only show spaces the person may see', async ({ page }) => {
  await signIn(page, RENATA);
  await expect(page.getByRole('tab')).toHaveCount(1);
  await expect(page.getByRole('tab')).toContainText('Personal');
  await signIn(page, VIEWER);
  await expect(page.getByRole('tab')).toHaveCount(1);
  await expect(page.getByRole('tab')).toContainText('Work');
  await expect(page.getByRole('button', { name: 'Ask' })).toHaveCount(0); // view-only
});

test('natural-language command: preview then confirm', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await signIn(page, OWNER, '/?space=work');
  await page.locator('.tile', { hasText: 'Office Move Planning' }).click();
  await page.locator('.drawer').getByRole('button', { name: 'Ask about this project' }).click();
  await page.locator('.cmd-box input').fill('Pin this project');
  await page.locator('.cmd-box input').press('Enter');
  await expect(page.locator('.cmd-ops .item')).toHaveText('Pin "Office Move Planning"');
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.locator('.toast')).toContainText('Pinned');
  await page.locator('.drawer').getByRole('button', { name: 'Close' }).click();
  await expect(page.locator('.t-name').nth(1)).toHaveText('Office Move Planning');
  // Undo so other tests see the original order.
  await page.locator('.tile', { hasText: 'Office Move Planning' }).click();
  await page.locator('.drawer').getByRole('button', { name: 'Unpin' }).click();
});
