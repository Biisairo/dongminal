// UX_AUDIT_FIX_SRS §3.15 (D-41) — 두 패널(메인·작업) 탭의 같은 동작 (TC-UXF-120~123).
import * as path from 'path';

import { Page } from '@playwright/test';

import { test, expect, waitForInit, openGit, gitFixture, cleanGitFixture } from './fixtures';
import { realPath, tmpPath } from './osenv';

const FIXTURES = tmpPath('dm-git-fx-ptu-' + process.pid);
test.beforeAll(() => { gitFixture(FIXTURES) });
test.afterAll(() => { cleanGitFixture(FIXTURES) });

const agTab = (page: Page, sec: string) => page.locator(`#agents-panel .ag-tab[data-sec="${sec}"]`);
const sbTab = (page: Page, id: string) => page.locator(`#sb-tabs .sb-tab[data-panel="${id}"]`);

/**
 * 스크롤할 내용이 없으면 자리를 잴 수 없다 — 시험에서만 그 컨테이너의 자식들 아래에 여백을 붙인다(첫 자식이 감춰져 있을 수 있다).
 * 컨테이너 자신에 여백을 주면 그 높이가 함께 커져 스크롤 여유가 생기지 않는다.
 */
async function tall(page: Page, sel: string) {
  await page.addStyleTag({ content: `${sel}>*{margin-bottom:1500px !important}` });
}

async function openAgents(page: Page) {
  await page.locator('#agents-panel .ag-collapse').click();
  await expect(page.locator('#agents-panel.open')).toBeVisible();
}

test('TC-UXF-120: 메인 패널은 고른 탭에도 배지를 보인다', async ({ page }) => {
  await waitForInit(page);
  await sbTab(page, 'windows').click();
  await expect(sbTab(page, 'windows')).toHaveClass(/\bactive\b/);
  await page.evaluate(() => {
    const a = (window as any).app;
    const id = [...a.tools.keys()][0];
    a.testing.attn.set(id, { reason: 'test' });
    a.testing.attnRefresh();
  });
  await expect(sbTab(page, 'windows').locator('.sb-tab-badge')).toHaveText('1', { timeout: 10000 });
});

test('TC-UXF-121: 작업 패널은 탭마다 보던 자리로 돌아온다', async ({ page }) => {
  await waitForInit(page);
  await tall(page, '#agents-body');
  await openAgents(page);
  await agTab(page, 'agents').click();
  const body = page.locator('#agents-body');
  await body.evaluate((e) => { e.scrollTop = 400 });
  await agTab(page, 'bg').click();
  await expect(agTab(page, 'bg')).toHaveClass(/\bactive\b/);
  expect(await body.evaluate((e) => e.scrollTop)).toBe(0);
  await agTab(page, 'agents').click();
  await expect.poll(() => body.evaluate((e) => e.scrollTop)).toBe(400);
});

test('TC-UXF-121: 저장소 사이드의 변경·탐색기도 보던 자리로 돌아온다', async ({ page }) => {
  await waitForInit(page);
  await tall(page, '.ed-side .git-files');
  await tall(page, '.ed-side .ed-tree');
  await openGit(page, realPath(path.join(FIXTURES, 'basic')));
  const side = page.locator('#area .ed-side').first();
  const files = side.locator('.git-files');
  await expect(files).toBeVisible({ timeout: 20000 });
  await files.evaluate((e) => { e.scrollTop = 300 });
  await side.locator('.ed-side-tab[data-side="explorer"]').click();
  const tree = side.locator('.ed-tree');
  await expect(tree).toBeVisible();
  await tree.evaluate((e) => { e.scrollTop = 200 });
  await side.locator('.ed-side-tab[data-side="changes"]').click();
  await expect.poll(() => files.evaluate((e) => e.scrollTop)).toBe(300);
  await side.locator('.ed-side-tab[data-side="explorer"]').click();
  await expect.poll(() => tree.evaluate((e) => e.scrollTop)).toBe(200);
});

test('TC-UXF-122: 메인 패널 직행 키는 보고 있는 탭이면 접고, 다시 누르면 그 탭으로 편다', async ({ page }) => {
  await waitForInit(page);
  await sbTab(page, 'windows').click();
  const collapsed = () => page.evaluate(() => document.documentElement.classList.contains('sb-collapsed'));
  expect(await collapsed()).toBe(false);
  await page.keyboard.press('Control+Shift+Digit1');
  await expect.poll(collapsed).toBe(true);
  await page.keyboard.press('Control+Shift+Digit1');
  await expect.poll(collapsed).toBe(false);
  await expect(sbTab(page, 'windows')).toHaveClass(/\bactive\b/);
});

test('TC-UXF-122: 작업 패널에서 손으로 고른 탭의 직행 키를 누르면 접힌다', async ({ page }) => {
  await waitForInit(page);
  await openAgents(page);
  await agTab(page, 'bg').click();
  await expect(agTab(page, 'bg')).toHaveClass(/\bactive\b/);
  await page.keyboard.press('Control+Shift+KeyB');
  await expect(page.locator('#agents-panel.open')).toHaveCount(0);
});

test('TC-UXF-123: 작업 패널의 탭 단추는 탭을 바꾸고 수가 바뀌어도 같은 요소다', async ({ page }) => {
  await waitForInit(page);
  await openAgents(page);
  await page.evaluate(() => { (document.querySelector('#agents-panel .ag-tab[data-sec="agents"]') as any).__mark = 1 });
  await agTab(page, 'bg').click();
  await expect(agTab(page, 'bg')).toHaveClass(/\bactive\b/);
  const pid = await page.locator('#area .pn.focused .pn-tab.active').getAttribute('data-toolid');
  await page.evaluate(async (toolId) => {
    await fetch('/api/tools/activity/set', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolId, state: 'working', tool: 'Bash', detail: 'x' }) });
  }, pid);
  await expect(agTab(page, 'agents').locator('.ag-tab-n')).toHaveText('1', { timeout: 10000 });
  expect(await page.evaluate(() => (document.querySelector('#agents-panel .ag-tab[data-sec="agents"]') as any).__mark)).toBe(1);
});
