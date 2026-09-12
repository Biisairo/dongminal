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
  // **예외 (`TEST-16`)**: 오버레이가 **뜨지 않음**을 잰다.
  await page.waitForTimeout(500);
  await expect(page.locator('#diag-ov')).toHaveCount(0);
});

test('?diag=1 이면 오버레이가 뜨고 환경을 기록한다', async ({ page }) => {
  await goto(page, '?diag=1');
  await expect(page.locator('#diag-ov')).toHaveCount(1);
  // 로그가 그 줄들을 **담을 때까지** 기다린다 — 고정 대기로는 아직 비어 있는
  // 로그를 읽는다.
  await expect(page.locator('#diag-ov .dg-log')).toContainText('isMobile=', { timeout: 10000 });
  const txt = await page.locator('#diag-ov .dg-log').textContent();
  expect(txt).toContain('isMobile=');
  expect(txt).toContain('tp.touchAction=');
  expect(txt).toContain('hasTouchScrollHook=true');
});

test('전송이 /api/upload 로 로그를 올린다', async ({ page }) => {
  await goto(page, '?diag=1');
  // 보낼 내용이 쌓인 뒤 누른다 — 빈 로그를 올리면 이 검사가 아무것도 재지 않는다.
  await expect(page.locator('#diag-ov .dg-log')).toContainText('isMobile=', { timeout: 10000 });
  const [req] = await Promise.all([
    page.waitForRequest((r) => r.url().includes('/api/upload') && r.method() === 'POST', { timeout: 10000 }),
    page.locator('#diag-ov .dg-b[data-a="send"]').click(),
  ]);
  expect(req.url()).toContain('dir=');
});

// EVENT_TIMER_HUB_SRS FR-SCH-11 · FR-BUS-9 — 진단은 두 클래스를 들여다본다.
//
// 진단 계층은 피진단 계층에 **의존하지 않지만**(D-3: `diag.js` 는 게이트의
// 항구적 예외다) 읽을 수는 있어야 한다. "이벤트가 안 온다" 를 재현 대신
// 스냅샷으로 푸는 자리가 이것이다 — 종전 진단은 `console.error('[cmd] parse')`
// 한 줄이 전부였다.
test('허브가 대기 타이머와 topic 을 찍는다', async ({ page }) => {
  await page.goto('/?diag=1');
  await expect(page.locator('#diag-ov')).toHaveCount(1);
  await page.locator('#diag-ov .dg-b[data-a="hub"]').click();

  const log = page.locator('#diag-ov .dg-log');
  await expect(log).toContainText('HUB timers pending=', { timeout: 10000 });
  // 온 적 없는 topic 도 보여야 한다 — 그것이 곧 "안 오는 이벤트" 다.
  await expect(log).toContainText('HUB channels');
  await expect(log).toContainText('git_changed');
});
