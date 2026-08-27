import { Page } from '@playwright/test';
import { test, expect } from './fixtures';

// 진단 오버레이는 ?diag=1 에서만 동작하고, 그 밖에는 어떤 흔적도 남기지 않는다.

async function goto(page: Page, q = '') {
  await page.context().addInitScript(() => { sessionStorage.setItem('displayMode', 'mobile') });
  await page.goto('/' + q);
  await page.waitForSelector('body.mobile', { timeout: 15000 });
}

test('진단 오버레이는 ?diag=1 없이는 뜨지 않는다', async ({ page }) => {
  await goto(page);
  await page.waitForTimeout(500);
  await expect(page.locator('#diag-ov')).toHaveCount(0);
});

test('?diag=1 이면 오버레이가 뜨고 환경을 기록한다', async ({ page }) => {
  await goto(page, '?diag=1');
  await expect(page.locator('#diag-ov')).toHaveCount(1);
  await page.waitForTimeout(1200);
  const txt = await page.locator('#diag-ov .dg-log').textContent();
  expect(txt).toContain('isMobile=');
  expect(txt).toContain('tp.touchAction=');
  expect(txt).toContain('hasTouchScrollHook=true');
});

test('전송이 /api/upload 로 로그를 올린다', async ({ page }) => {
  await goto(page, '?diag=1');
  await page.waitForTimeout(1000);
  const [req] = await Promise.all([
    page.waitForRequest((r) => r.url().includes('/api/upload') && r.method() === 'POST', { timeout: 10000 }),
    page.locator('#diag-ov .dg-b[data-a="send"]').click(),
  ]);
  expect(req.url()).toContain('dir=');
});
