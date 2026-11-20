// UX_AUDIT_FIX_SRS §3.10 — 6묶음: diff 도구 줄 · 메뉴 단축키 (TC-UXF-80·81·84). TC-UXF-82·83 은 editor-lsp-nav.spec.ts 에 있다.
import * as path from 'path';

import { Page } from '@playwright/test';

import { test, expect, waitForInit, openGit, gitFixture, cleanGitFixture } from './fixtures';
import { cssPath, realPath, tmpPath } from './osenv';

const MOBILE = { width: 412, height: 839 };
const FIXTURES = tmpPath('dm-git-fx-uxf6-' + process.pid);

test.beforeAll(() => { gitFixture(FIXTURES) });
test.afterAll(() => { cleanGitFixture(FIXTURES) });

const fx = (name: string) => realPath(path.join(FIXTURES, name));
const diff = (page: Page) => page.locator('#area .pn-body .git-view.git-diff');
const bar = (page: Page) => diff(page).locator('.git-diff-bar');
const row = (page: Page, group: string, p: string) =>
  page.locator(`#area .ed-side .git-view.git-changes .git-group[data-group="${group}"] .git-file[data-path="${cssPath(p)}"]`);

test.describe('6묶음 — diff 도구 줄 (FR-UXF-80·81)', () => {
  test('TC-UXF-80: 데스크톱 도구 줄의 단추는 고스트 한 문법이고 높이가 같다', async ({ page }) => {
    await waitForInit(page);
    await openGit(page, fx('basic'));
    await row(page, 'working', 'tracked.txt').click();
    await expect(bar(page).locator('.git-diff-path')).toHaveText('tracked.txt', { timeout: 20000 });

    for (const nav of await bar(page).locator('.git-diff-nav').all()) {
      await expect(nav).toHaveClass(/\bui-btn-ghost\b/);
      await expect(nav.locator('svg')).toHaveCount(1);
    }
    const blame = bar(page).locator('.git-diff-blame');
    await expect(blame).toHaveClass(/\bui-btn-ghost\b/);
    await expect(blame).toHaveAttribute('aria-pressed', 'false');
    await blame.click();
    await expect(blame).toHaveAttribute('aria-pressed', 'true');
    await blame.click();
    await expect(blame).toHaveAttribute('aria-pressed', 'false');

    for (const sel of ['.git-diff-ws', '.git-diff-fold']) {
      await expect(bar(page).locator(sel)).toHaveClass(/\bui-btn-ghost\b/);
      await expect(bar(page).locator(sel + ' input[type="checkbox"]')).toHaveCount(1);
    }
    const hs = await bar(page).locator('.git-diff-nav, .git-diff-blame, .git-diff-mode > button, .git-diff-ws, .git-diff-fold')
      .evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
    expect(new Set(hs).size, `높이가 갈린다: ${hs.join(',')}`).toBe(1);
    await expect(bar(page).locator('.git-diff-more')).toBeHidden();
  });

  test('TC-UXF-81: 모바일 도구 줄은 한 줄이고 Blame·공백·접기는 ⋯ 메뉴로 간다', async ({ page }) => {
    await waitForInit(page, { mode: 'mobile', viewport: MOBILE });
    await openGit(page, fx('basic'));
    await page.locator('#m-repo-seg .m-seg-btn', { hasText: '변경' }).click();
    await row(page, 'working', 'tracked.txt').click();
    await expect(bar(page).locator('.git-diff-path')).toHaveText('tracked.txt', { timeout: 20000 });

    const touch = await page.evaluate(() =>
      parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--touch-min')));
    const h = await bar(page).evaluate((e) => e.getBoundingClientRect().height);
    expect(h, `도구 줄 높이 ${h}`).toBeLessThanOrEqual(touch + 9);

    await expect(bar(page).locator('.git-diff-axis')).toBeHidden();
    await expect(bar(page).locator('.git-diff-pos')).toBeHidden();
    await expect(bar(page).locator('.git-diff-blame')).toBeHidden();
    await expect(bar(page).locator('.git-diff-ws')).toBeHidden();
    await expect(bar(page).locator('.git-diff-fold')).toBeHidden();
    await expect(bar(page).locator('.git-diff-path')).toHaveAttribute('title', /작업 트리 ↔ 스테이지 · 변경 \d+\/\d+/);

    const more = bar(page).locator('.git-diff-more');
    await expect(more).toBeVisible();
    await expect(more).toHaveAttribute('title', 'More diff options');
    await more.click();
    const menu = page.locator('.ui-menu');
    await expect(menu.locator('.ui-menu-item')).toHaveCount(3);
    await expect(menu.locator('.ui-menu-item.cur')).toHaveCount(0);
    await menu.locator('.ui-menu-item[data-id="blame"]').click();
    await expect(diff(page).locator('.git-blame')).toBeVisible({ timeout: 20000 });

    await more.click();
    await expect(menu.locator('.ui-menu-item[data-id="blame"]')).toHaveClass(/\bcur\b/);
  });
});

test.describe('6묶음 — 메뉴의 단축키 (FR-UXF-84·85)', () => {
  test('TC-UXF-84: 칸 탭 메뉴의 닫기·새 탭에 키캡이 있고 이름 바꾸기에는 없다', async ({ page }) => {
    await waitForInit(page);
    await page.locator('#area .pn.focused .pn-tab').first().click({ button: 'right' });
    const menu = page.locator('.ui-menu.tab-menu');
    await expect(menu).toBeVisible();
    const key = await page.evaluate(() => (window as any).displayKey((window as any).shortcuts.closeTab));
    await expect(menu.locator('.ui-menu-item[data-id="close"] .ui-menu-key')).toHaveText(key);
    await expect(menu.locator('.ui-menu-item[data-id="new"] .ui-menu-key')).toHaveCount(1);
    await expect(menu.locator('.ui-menu-item[data-id="rename"] .ui-menu-key')).toHaveCount(0);
  });
});
