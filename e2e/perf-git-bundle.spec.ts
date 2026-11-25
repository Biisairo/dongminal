import { join } from 'path';

import { test, expect, waitForInit, openGit, clickGitView, gitFixture, cleanGitFixture } from './fixtures';
import { tmpPath, realPath } from './osenv';

// PERF 3.4.6 — git 화면은 `git` 묶음으로 처음 쓸 때 실린다 (D-30·D-31, perf/M3_DESIGN.md §3.4).

const FIXTURES = tmpPath('otter-git-fx-bundle-' + process.pid);
test.beforeAll(() => gitFixture(FIXTURES));
test.afterAll(() => cleanGitFixture(FIXTURES));
const fx = (name: string) => realPath(join(FIXTURES, name));

const GIT_JS = /\/b\/git\.js(\?|$)/;
const GIT_CSS = /\/b\/git\.css(\?|$)|\/style-git[\w-]*\.css/;

test('TC-GITB-1: 부팅 때 git 묶음을 싣지 않고, git 창을 열면 실려 그려진다', async ({ page }) => {
  const js: string[] = [];
  const css: string[] = [];
  page.on('request', (r) => {
    if (GIT_JS.test(r.url())) js.push(r.url());
    if (GIT_CSS.test(r.url())) css.push(r.url());
  });
  await waitForInit(page);
  expect(js).toEqual([]);
  expect(css).toEqual([]);
  expect(await page.evaluate(() => Screens.ready('git'))).toBe(false);

  await openGit(page, fx('basic'));
  await expect(page.locator('#area .ed-side .git-view.git-changes')).toBeVisible();
  expect(js).toHaveLength(1);
  expect(css.filter((u) => /\/b\/git\.css/.test(u))).toHaveLength(1);
  expect(await page.evaluate(() => Screens.ready('git'))).toBe(true);
});

test('TC-GITB-2: 부팅 때 복원된 git 탭은 자리표시 뒤 실리면 그려진다', async ({ page }) => {
  await waitForInit(page);
  await openGit(page, fx('basic'));
  await clickGitView(page, 'history');
  // 탭이 서버 워크스페이스에 실린 뒤에 새로 연다 — 저장은 디바운스된다.
  await page.evaluate(() => (window as any).app.testing.save());

  let release: () => void = () => {};
  const held = new Promise<void>((res) => { release = res });
  await page.route(GIT_JS, async (r) => {
    await held;
    await r.continue();
  });
  await page.reload();
  const body = page.locator('#area .pn-body').filter({ has: page.locator('.ui-empty.ui-empty-center, .git-view.git-history') });
  await expect(body.locator('.ui-empty.ui-empty-center')).toBeVisible({ timeout: 15000 });
  await expect(body.locator('.git-view.git-history')).toHaveCount(0);
  release();
  const hist = page.locator('#area .pn-body').filter({ has: page.locator('.git-view.git-history.vis') });
  await expect(hist).toHaveCount(1, { timeout: 15000 });
  await expect(hist.locator('.ui-empty.ui-empty-center')).toHaveCount(0);
});
