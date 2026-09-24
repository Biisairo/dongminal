import { existsSync, writeFileSync } from 'fs';
import { join } from 'path';

import { Page } from '@playwright/test';

import { test, expect, makeCopyFx, waitForInit, openGit, gitFixture, cleanGitFixture, clickRowAct } from './fixtures';
import { tmpPath, realPath, cssPath } from './osenv';

// REPO_FIX 01 §7.2 — index.lock 은 자동으로 지우지 않는다. 쓰기가 409 index_locked
// 로 막히면 안내 줄에 "남은 lock 지우기" 가 서고, 확인 뒤에만 지운다.

const FIXTURES = tmpPath('dm-git-fx-lock-' + process.pid);

test.beforeAll(() => {
  gitFixture(FIXTURES);
});
test.afterAll(() => {
  cleanGitFixture(FIXTURES);
});

const copyFx = makeCopyFx(FIXTURES);
const changes = (page: Page) => page.locator('#area .ed-side .git-view.git-changes');
const row = (page: Page, key: string, path: string) =>
  changes(page).locator(`.git-group[data-group="${key}"] .git-file[data-path="${cssPath(path)}"]`);
const note = (page: Page) => changes(page).locator('.git-partial-note');
const lockBtn = (page: Page) => note(page).locator('.git-lock-remove');

test.describe('REPO_FIX 01 §7.2 — 남은 index.lock', () => {
  test('막힌 쓰기 → 버튼 → 확인 → 삭제, 원래 동작은 다시 하지 않는다', async ({ page }) => {
    const repo = realPath(copyFx('basic', 'lock'));
    const lock = join(repo, '.git', 'index.lock');
    writeFileSync(lock, '');
    await waitForInit(page);
    await openGit(page, repo);

    const r = row(page, 'working', 'untracked.txt');
    await expect(r).toBeVisible({ timeout: 10000 });
    const staged = page.waitForResponse(
      (res) => res.url().includes('/api/git/stage') && res.request().method() === 'POST',
    );
    await clickRowAct(page, r, 'stage');
    const res = await staged;
    expect(res.status()).toBe(409);
    expect((await res.json()).error).toBe('index_locked');

    await expect(note(page)).toBeVisible();
    await expect(lockBtn(page)).toBeVisible();
    await lockBtn(page).click();
    await expect(page.locator('#git-confirm .gc-box')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#git-confirm .gc-box')).toContainText('index.lock');
    const removed = page.waitForResponse(
      (res2) => res2.url().includes('/api/git/lock/remove') && res2.request().method() === 'POST',
    );
    await page.locator('#git-confirm .gc-go').click();
    const rr = await removed;
    expect(rr.status()).toBe(200);
    expect((await rr.json()).removed).toBe(true);

    await expect(note(page)).toBeHidden({ timeout: 5000 });
    expect(existsSync(lock)).toBe(false);
    // 자동 재시도는 없다 — 파일은 여전히 working 에 있다.
    await expect(row(page, 'working', 'untracked.txt')).toBeVisible();
  });

  test('취소하면 지우지 않는다', async ({ page }) => {
    const repo = realPath(copyFx('basic', 'lock-cancel'));
    const lock = join(repo, '.git', 'index.lock');
    writeFileSync(lock, '');
    await waitForInit(page);
    await openGit(page, repo);

    const r = row(page, 'working', 'untracked.txt');
    await expect(r).toBeVisible({ timeout: 10000 });
    await clickRowAct(page, r, 'stage');
    await expect(lockBtn(page)).toBeVisible({ timeout: 10000 });
    await lockBtn(page).click();
    await expect(page.locator('#git-confirm .gc-box')).toBeVisible({ timeout: 10000 });
    await page.locator('#git-confirm .gc-cancel').click();
    await expect(page.locator('#git-confirm')).toHaveCount(0);
    expect(existsSync(lock)).toBe(true);
    await expect(lockBtn(page)).toBeVisible();
  });
});
