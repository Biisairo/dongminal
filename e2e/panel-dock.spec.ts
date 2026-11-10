import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

import { Page } from '@playwright/test';

import { test, expect, waitForInit as fxWaitForInit, nextFrames } from './fixtures';
import { tmpPath, realPath } from './osenv';

// PANEL_DOCK_SRS §5 — 패널 좌우 도킹 (드래그 앤 드롭).

const ROOT = tmpPath('dm-pdk-' + process.pid);
const fx = () => realPath(ROOT);

test.beforeAll(() => {
  mkdirSync(ROOT, { recursive: true });
  writeFileSync(join(ROOT, 'a.txt'), 'A\n');
});

async function waitForInit(page: Page, opts?: { mobile?: boolean; readySelector?: string }) {
  await fxWaitForInit(page, {
    mode: opts && opts.mobile ? 'mobile' : 'desktop',
    clearOnFirstLoad: ['panelDock', 'repoSideDock', 'agentsPanelOpen', 'sidebarCollapsed'],
    // 새로고침 뒤 활성 창이 Repo 창이면 터미널이 없다.
    ...(opts && opts.readySelector ? { readyFor: { selector: opts.readySelector } } : {}),
  });
}

const box = async (page: Page, sel: string) => {
  const b = await page.locator(sel).first().boundingBox();
  if (!b) throw new Error(sel + ' 이 보이지 않는다');
  return b;
};
const dock = (page: Page) => page.evaluate(() => (window as any).app.testing.panelDock());

/** 손잡이를 `#app` 의 x 좌표로 끌어 놓는다. */
async function dragTo(page: Page, source: string, target: string, x: number) {
  const t = await box(page, target);
  await page.locator(source).first().dragTo(page.locator(target).first(), {
    targetPosition: { x: x - t.x, y: t.height / 2 },
  });
  await nextFrames(page);
}

async function openActivity(page: Page) {
  await page.locator('#agents-toggle').click();
  await expect(page.locator('#agents-panel')).toBeVisible();
}

test.describe('묶음 PDK — 앱 패널', () => {
  test('PDK1 (FR-PDK-2·NFR-PDK-2): 기본 배치는 지금과 같다', async ({ page }) => {
    await waitForInit(page);
    await openActivity(page);
    const sb = await box(page, '#sidebar'), ct = await box(page, '#content'), ag = await box(page, '#agents-panel');
    expect(sb.x).toBe(0);
    expect(sb.x < ct.x && ct.x < ag.x).toBe(true);
    expect(await dock(page)).toEqual({ left: ['sidebar'], right: ['activity'] });
  });

  test('PDK2 (FR-PDK-31·3): 사이드바를 오른쪽에 놓으면 오른쪽에 서고 새로고침 뒤에도 남는다', async ({ page }) => {
    await waitForInit(page);
    await openActivity(page);
    const app = await box(page, '#app');
    // 오른쪽, Activity 중앙보다 안쪽 → Activity 안쪽에 선다.
    await dragTo(page, '#sb-tabs', '#app', app.x + app.width * 0.6);
    expect(await dock(page)).toEqual({ left: [], right: ['activity', 'sidebar'] });
    const check = async () => {
      const sb = await box(page, '#sidebar'), ct = await box(page, '#content'), ag = await box(page, '#agents-panel');
      expect(ct.x).toBe(0);
      expect(ct.x < sb.x && sb.x < ag.x).toBe(true);
      expect(await page.evaluate(() => document.documentElement.dataset.sbSide)).toBe('right');
    };
    await check();
    await page.reload();
    await waitForInit(page);
    await check();
  });

  test('PDK3 (FR-PDK-32·33): Activity 를 왼쪽 바깥에 놓는다 — 끄는 동안 막대가 보인다', async ({ page }) => {
    await waitForInit(page);
    await openActivity(page);
    const head = await box(page, '.ag-head');
    await page.mouse.move(head.x + head.width / 2, head.y + head.height / 2);
    await page.mouse.down();
    await page.mouse.move(5, head.y + 200, { steps: 10 });
    await expect(page.locator('#dock-indicator')).toHaveClass(/\bon\b/);
    await page.mouse.up();
    await nextFrames(page);
    await expect(page.locator('#dock-indicator')).not.toHaveClass(/\bon\b/);
    expect(await dock(page)).toEqual({ left: ['activity', 'sidebar'], right: [] });
    const ag = await box(page, '#agents-panel'), sb = await box(page, '#sidebar'), ct = await box(page, '#content');
    expect(ag.x).toBe(0);
    expect(ag.x < sb.x && sb.x < ct.x).toBe(true);
  });

  test('PDK4 (FR-PDK-30): 손잡이 안의 탭은 누르면 여전히 탭을 바꾼다', async ({ page }) => {
    await waitForInit(page);
    const tabs = page.locator('#sb-tabs .sb-tab');
    await tabs.nth(1).click();
    await expect(tabs.nth(1)).toHaveClass(/\bactive\b/);
    await tabs.nth(0).click();
    await expect(tabs.nth(0)).toHaveClass(/\bactive\b/);
    expect(await dock(page)).toEqual({ left: ['sidebar'], right: ['activity'] });
  });

  test('PDK5 (FR-PDK-20·12): 오른쪽 사이드바는 왼쪽으로 끌면 넓어지고 경계선이 왼쪽에 선다', async ({ page }) => {
    await waitForInit(page);
    await page.evaluate(() => (window as any).app.testing.setPanelDock({ left: [], right: ['sidebar', 'activity'] }));
    await nextFrames(page);
    const w0 = (await box(page, '#sidebar')).width;
    const h = await box(page, '#sb-handle');
    const sb = await box(page, '#sidebar');
    expect(h.x < sb.x).toBe(true);
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
    await page.mouse.down();
    await page.mouse.move(h.x + h.width / 2 - 40, h.y + h.height / 2, { steps: 6 });
    await page.mouse.up();
    await nextFrames(page);
    expect(Math.round((await box(page, '#sidebar')).width - w0)).toBe(40);
    const border = await page.evaluate(() => getComputedStyle(document.getElementById('sidebar')!).borderLeftWidth);
    expect(border).toBe('1px');
  });

  test('PDK6 (FR-PDK-36): 같은 자리에 놓으면 저장하지 않는다', async ({ page }) => {
    await waitForInit(page);
    const app = await box(page, '#app');
    await dragTo(page, '#sb-tabs', '#app', app.x + 10);
    expect(await page.evaluate(() => localStorage.getItem('panelDock'))).toBeNull();
  });

  test('PDK7 (FR-PDK-15·37): 모바일에서는 저장된 배치를 적용하지 않는다', async ({ page }) => {
    await waitForInit(page);
    await page.evaluate(() => (window as any).app.testing.setPanelDock({ left: [], right: ['sidebar', 'activity'] }));
    await page.reload();
    await waitForInit(page, { mobile: true });
    const ord = await page.evaluate(() => getComputedStyle(document.getElementById('sidebar')!).order);
    expect(ord).toBe('0');
    expect(await dock(page)).toEqual({ left: [], right: ['sidebar', 'activity'] });
  });
});

test.describe('묶음 PDK — Repo 사이드', () => {
  async function openRepo(page: Page) {
    await page.evaluate(async (p: string) => {
      await fetch('/api/editors/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p }) });
    }, fx());
    await expect.poll(async () => page.evaluate(async (p: string) => {
      const app = (window as any).app;
      await app.testing.edReconcile?.();
      await app.testing.edOpenWindow(p);
      return app.testing.edSearchRoot();
    }, fx()), { timeout: 15000 }).not.toBe('');
    await expect(page.locator('.ed-win>.ed-side-tabs, .ed-win .ed-side-tabs').first()).toBeVisible();
  }

  test('PDK8 (FR-PDK-34·13·6): Changes/Explorer 를 오른쪽 절반에 놓으면 편집기 오른쪽에 선다', async ({ page }) => {
    await waitForInit(page);
    await openRepo(page);
    const win = await box(page, '.ed-win');
    await dragTo(page, '.ed-side-tabs', '.ed-win', win.x + win.width * 0.8);
    expect(await page.evaluate(() => (window as any).app.testing.repoSideDock())).toBe('right');
    const side = await box(page, '.ed-win>.ed-side'), area = await box(page, '.ed-win>.ed-area');
    expect(area.x < side.x).toBe(true);
    await page.reload();
    await waitForInit(page, { readySelector: '.ed-win>.ed-side' });
    const side2 = await box(page, '.ed-win>.ed-side'), area2 = await box(page, '.ed-win>.ed-area');
    expect(area2.x < side2.x).toBe(true);
  });

  test('PDK9 (FR-PDK-20): 오른쪽 Repo 사이드는 왼쪽으로 끌면 넓어진다', async ({ page }) => {
    await waitForInit(page);
    await page.evaluate(() => (window as any).app.testing.setRepoSideDock('right'));
    await openRepo(page);
    const w0 = (await box(page, '.ed-win>.ed-side')).width;
    const h = await box(page, '.ed-win>.ed-ex-handle');
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
    await page.mouse.down();
    await page.mouse.move(h.x + h.width / 2 - 30, h.y + h.height / 2, { steps: 6 });
    await page.mouse.up();
    await nextFrames(page);
    expect(Math.round((await box(page, '.ed-win>.ed-side')).width - w0)).toBe(30);
  });

  test('PDK10 (FR-PDK-38): Repo 사이드를 창 밖에 놓으면 바뀌지 않는다', async ({ page }) => {
    await waitForInit(page);
    await openRepo(page);
    const sb = await box(page, '#sidebar');
    await dragTo(page, '.ed-side-tabs', '#sidebar', sb.x + sb.width / 2);
    expect(await page.evaluate(() => (window as any).app.testing.repoSideDock())).toBe('left');
    expect(await page.evaluate(() => localStorage.getItem('repoSideDock'))).toBeNull();
  });
});

// 사용자 보고(2026-11-10): 한 탭에서 좌우 배치를 바꾸면 같은 브라우저의 다른 탭에 반영되지 않았고,
// 그 탭에서 같은 배치로 다시 바꿔도 먹히지 않았다. 새로고침하면 풀렸다.
test.describe('묶음 PDK — 같은 브라우저의 다른 탭', () => {
  const side = (page: Page, key: 'sbSide' | 'agSide' | 'repoSide') =>
    page.evaluate((k) => document.documentElement.dataset[k], key);
  const SWAP = { left: ['activity'], right: ['sidebar'] };

  test('PDK-X1: 한 탭에서 바꾼 좌우 배치를 다른 탭이 따라간다', async ({ page, context }) => {
    await waitForInit(page);
    const other = await context.newPage();
    await waitForInit(other);
    await page.evaluate((s) => (window as any).app.testing.setPanelDock(s), SWAP);
    await page.evaluate(() => (window as any).app.testing.setRepoSideDock('right'));
    await expect.poll(() => side(other, 'sbSide')).toBe('right');
    await expect.poll(() => side(other, 'agSide')).toBe('left');
    await expect.poll(() => side(other, 'repoSide')).toBe('right');
  });

  test('PDK-X2: 저장소와 화면이 어긋나 있어도 다시 바꾸면 화면에 실린다', async ({ page }) => {
    await waitForInit(page);
    // 다른 탭이 저장소만 바꾼 상태를 만든다 — 이 탭은 알림을 받지 못했다.
    await page.evaluate((s) => {
      localStorage.setItem('panelDock', JSON.stringify(s));
      localStorage.setItem('repoSideDock', 'right');
    }, SWAP);
    expect(await side(page, 'sbSide')).toBe('left');
    await page.evaluate((s) => (window as any).app.testing.setPanelDock(s), SWAP);
    await page.evaluate(() => (window as any).app.testing.setRepoSideDock('right'));
    expect(await side(page, 'sbSide'), '같은 배치로 다시 바꿨는데 화면이 그대로다').toBe('right');
    expect(await side(page, 'repoSide')).toBe('right');
  });
});
