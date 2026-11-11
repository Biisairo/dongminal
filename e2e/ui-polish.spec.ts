import { execFileSync } from 'child_process';
import { join } from 'path';

import { Page } from '@playwright/test';

import {
  test, expect, waitForInit, openGit, gitFixture, cleanGitFixture, makeCopyFx, SPLIT_H,
} from './fixtures';
import { tmpPath, realPath } from './osenv';

// UI_POLISH_SRS — 화면 다듬기. TC-UIP-1~6·8~12.

const FIXTURES = tmpPath('dm-git-fx-uip-' + process.pid);
test.beforeAll(() => { gitFixture(FIXTURES); });
test.afterAll(() => { cleanGitFixture(FIXTURES); });
const fx = (name: string) => realPath(join(FIXTURES, name));
const copyFx = makeCopyFx(FIXTURES);

const changes = (page: Page) => page.locator('#area .ed-side .git-view.git-changes');

test('TC-UIP-1: 터미널 본문은 위아래 4px, 좌우 8px 의 안쪽 여백을 갖는다', async ({ page }) => {
  await waitForInit(page);
  const pad = await page.evaluate(() => {
    const cs = getComputedStyle(document.querySelector('#area .pn.focused .tp.vis')!);
    return [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft];
  });
  expect(pad).toEqual(['4px', '8px', '4px', '8px']);
});

test('TC-UIP-2: 저장된 폭이 없으면 사이드바는 200px 이다', async ({ page }) => {
  await waitForInit(page);
  await page.evaluate(() => sessionStorage.removeItem('sidebarWidth'));
  await page.reload();
  await waitForInit(page);
  const w = await page.evaluate(() => Math.round(document.getElementById('sidebar')!.getBoundingClientRect().width));
  expect(w).toBe(200);
});

test('TC-UIP-3: Git 진입점은 아이콘 16px·히트 30px 이고, 폭이 남을 때만 이름을 보인다', async ({ page }) => {
  await waitForInit(page);
  await openGit(page, fx('basic'));
  const acts = changes(page).locator('xpath=ancestor::*[contains(@class,"ed-side")]').first().locator('.ed-side-acts');
  const icon = await acts.locator('.ed-side-act .ui-icon').first().evaluate((e) => Math.round(e.getBoundingClientRect().width));
  expect(icon).toBe(16);
  // Changes 패널의 아이콘 버튼(원격·보기 전환·그룹·행 동작)도 같은 16px 이다.
  const sizes = await changes(page).locator('.ui-btn-lg.ui-btn-icon > .ui-icon')
    .evaluateAll((els) => [...new Set(els.map((e) => Math.round(e.getBoundingClientRect().width)).filter((w) => w > 0))]);
  expect(sizes).toEqual([16]);
  const h = await acts.locator('.ed-side-act').first().evaluate((e) => e.getBoundingClientRect().height);
  expect(h).toBeGreaterThanOrEqual(30);
  const side = page.locator('#area .ed-side').first();
  await side.evaluate((e: HTMLElement) => { e.style.width = '640px'; e.style.flexBasis = '640px'; });
  await expect(acts.locator('.ed-side-act-label').first()).toBeVisible();
  await expect(acts.locator('.ed-side-act-label').first()).toHaveText('History');
  await side.evaluate((e: HTMLElement) => { e.style.width = '200px'; e.style.flexBasis = '200px'; });
  await expect(acts.locator('.ed-side-act-label').first()).toBeHidden();
});

test('TC-UIP-4: 사이드바 하단 버튼은 테두리가 없다', async ({ page }) => {
  await waitForInit(page);
  const bd = await page.evaluate(() => ['soft-reload-btn', 'settings-btn'].map((id) =>
    getComputedStyle(document.getElementById(id)!).borderTopColor));
  for (const c of bd) expect(c).toBe('rgba(0, 0, 0, 0)');
});

test('TC-UIP-5: 개수가 0 이면 감추고, 개수는 accent 로 칠하지 않는다', async ({ page }) => {
  await waitForInit(page);
  // 레일(접힌 Activity)의 셋은 처음에 모두 0 이다.
  for (const n of await page.locator('#agents-panel .ag-sec-n').all()) await expect(n).toBeHidden();
  await openGit(page, fx('basic'));
  const counts = changes(page).locator('.git-group-head .git-group-count');
  await expect.poll(async () => counts.evaluateAll((els) =>
    els.map((e) => ({ t: e.textContent, vis: (e as HTMLElement).offsetParent !== null })))).toEqual(
    expect.arrayContaining([expect.objectContaining({ vis: true })]));
  const rows = await counts.evaluateAll((els) => els.map((e) => ({
    t: (e.textContent || '').trim(), vis: (e as HTMLElement).offsetParent !== null,
    bg: getComputedStyle(e).backgroundColor,
  })));
  for (const r of rows) {
    if (r.t === '0') expect(r.vis).toBe(false);
    else expect(r.bg).toBe('rgba(0, 0, 0, 0)');
  }
});

test('TC-UIP-6: 칸이 하나면 포커스 선이 없고, 나누면 있다', async ({ page }) => {
  await waitForInit(page);
  const shadow = () => page.evaluate(() =>
    getComputedStyle(document.querySelector('#area .pn.focused .pn-tabs')!).boxShadow);
  expect(await shadow()).toBe('none');
  await page.locator(SPLIT_H).click();
  await expect(page.locator('#area .pn')).toHaveCount(2);
  await expect.poll(shadow).not.toBe('none');
});

test.describe('커밋 (FR-UIP-14·20)', () => {
  test('TC-UIP-8a: 메시지가 비었다는 사유는 줄에 띄우지 않고 버튼 title 로 알린다', async ({ page }) => {
    await waitForInit(page);
    await openGit(page, fx('basic'));
    const c = changes(page).locator('.git-commit');
    await expect(c.locator('.git-commit-btn')).toBeDisabled();
    await expect(c.locator('.git-commit-btn')).not.toHaveAttribute('title', '');
    await expect(c.locator('.git-commit-why')).toBeHidden();
  });

  test('TC-UIP-8b: 메시지 입력에서 Ctrl+Enter 로 커밋한다', async ({ page }) => {
    const repo = copyFx('basic', 'uip-commit');
    const count = () => Number(execFileSync('git', ['-C', repo, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim());
    const before = count();
    await waitForInit(page);
    await openGit(page, repo);
    const c = changes(page).locator('.git-commit');
    await c.locator('.git-commit-msg').fill('uip: 단축키 커밋');
    await expect(c.locator('.git-commit-btn')).toBeEnabled({ timeout: 20000 });
    await c.locator('.git-commit-msg').press('Control+Enter');
    await expect.poll(count, { timeout: 20000 }).toBe(before + 1);
  });
});

test('TC-UIP-9: Changes 탭의 빈 편집 영역 안내는 Diff 를 말한다', async ({ page }) => {
  await waitForInit(page);
  // `openGit` 은 git 뷰 탭 일곱을 연다 — 빈 편집 영역을 보려면 창만 연다.
  await page.evaluate((r: string) => (window as any).app.openGitWindow(r), fx('basic'));
  await page.waitForSelector('#area .ed-win .ed-side', { timeout: 15000 });
  const hint = page.locator('#area .ed-empty');
  await expect(hint).toContainText('변경 목록에서 파일을 고르면 여기에 Diff 가 열립니다');
});

test('TC-UIP-10: 저장소 추가 입력은 터미널 cwd 를 후보로 보이고 Tab 으로 채운다', async ({ page }) => {
  await waitForInit(page);
  const cwd = await page.evaluate(() => (window as any).app.testing.edTermCwd());
  expect(cwd).not.toBe('');
  await page.locator('#sb-tabs [role=tab]').nth(1).click();
  await page.locator('#repo-add').click();
  const input = page.locator('#editor-add-dlg input[data-key="path"]');
  await input.fill('');
  const list = page.locator('.path-suggest');
  await expect(list).toBeVisible();
  await expect(list.locator('.path-suggest-item').first()).toHaveText(cwd);
  await input.press('Tab');
  await expect(input).toHaveValue(cwd);
});

test('TC-UIP-11: 설정 탭은 세로 목록이고 검색으로 거른다', async ({ page }) => {
  await waitForInit(page);
  await page.locator('#settings-btn').click();
  const tabs = page.locator('#modal .modal-tabs');
  expect(await tabs.evaluate((e) => getComputedStyle(e).flexDirection)).toBe('column');
  const search = page.locator('#modal .modal-search');
  await search.fill('peer');
  await expect(page.locator('#modal .mtab:visible')).toHaveCount(1);
  await expect(page.locator('#modal .mtab.active')).toHaveAttribute('data-tab', 'peers');
  await search.fill('');
  await expect(page.locator('#modal .mtab:visible')).toHaveCount(13);
});

test('TC-UIP-12: Diff 보기 방식은 두 칸 선택 묶음이고 지금 방식이 선택돼 보인다', async ({ page }) => {
  await waitForInit(page);
  await openGit(page, fx('basic'));
  await page.evaluate(() => (window as any).app.gitPanel.openView('diff'));
  const seg = page.locator('#area .pn-body .git-diff-mode');
  await expect(seg.locator('button')).toHaveCount(2);
  await expect(seg.locator('button[aria-pressed="true"]')).toHaveCount(1);
  const other = seg.locator('button[aria-pressed="false"]');
  const label = await other.textContent();
  await other.click();
  await expect(seg.locator('button[aria-pressed="true"]')).toHaveText(label!);
});
