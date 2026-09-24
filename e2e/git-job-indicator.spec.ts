import { execFileSync } from 'child_process';
import { chmodSync, writeFileSync } from 'fs';
import { join } from 'path';

import { Page } from '@playwright/test';

import { test, expect, makeCopyFx, waitForInit, openGit, gitFixture, cleanGitFixture } from './fixtures';
import { tmpPath, realPath } from './osenv';

// REPO_FIX 01 §6.4 — 일반화된 잡 표시기. 느린 쓰기(commit·merge…)는 잡으로 돌고
// 저장소의 index 칸 박스에 붙는다. 충돌·취소·index_locked·재부착을 본다.

const FIXTURES = tmpPath('dm-git-fx-jobs-' + process.pid);

test.beforeAll(() => {
  gitFixture(FIXTURES);
});
test.afterAll(() => {
  cleanGitFixture(FIXTURES);
});

const copyFx = makeCopyFx(FIXTURES);
const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commits = (repo: string) => Number(git(repo, 'rev-list', '--count', 'HEAD'));

const changes = (page: Page) => page.locator('#area .ed-side .git-view.git-changes');
const indexBox = (page: Page) => changes(page).locator('.git-job[data-slot="index"]');
const commitBox = (page: Page) => changes(page).locator('.git-commit');
const msg = (page: Page) => commitBox(page).locator('.git-commit-msg');
const btn = (page: Page) => commitBox(page).locator('.git-commit-btn');

// pre-commit 훅으로 커밋을 느리게 만든다 — 진행 중 상태를 결정적으로 본다.
function slowHook(repo: string, seconds: number) {
  const hook = join(repo, '.git', 'hooks', 'pre-commit');
  writeFileSync(hook, '#!/bin/sh\nsleep ' + seconds + '\n');
  chmodSync(hook, 0o755);
}

async function startCommit(page: Page, text: string) {
  await msg(page).fill(text);
  await expect(btn(page)).toBeEnabled({ timeout: 20000 });
  await btn(page).click();
}

test.describe('REPO_FIX 01 §6.4 — 잡 표시기', () => {
  test('커밋은 index 칸에 붙고, 도는 동안 동기 쓰기와 커밋 버튼이 막힌다', async ({ page }) => {
    const repo = realPath(copyFx('basic', 'job-busy'));
    slowHook(repo, 4);
    const before = commits(repo);
    await waitForInit(page);
    await openGit(page, repo);

    await startCommit(page, 'job-busy 커밋');
    await expect(indexBox(page)).toHaveClass(/vis/, { timeout: 10000 });
    await expect(indexBox(page).locator('.git-job-kind')).toHaveText('Commit');
    await expect(indexBox(page).locator('.git-job-cancel')).toBeVisible();
    // 도는 동안 같은 저장소의 동기 쓰기는 보내지 않는다 — 안내가 선다.
    const blocked = await page.evaluate(async (r) => {
      const res = await (window as any).app.gitPanel.post('/api/git/stage', { repo: r, paths: ['untracked.txt'] });
      return res.data && res.data.error;
    }, repo);
    expect(blocked).toBe('job_busy');

    await expect(indexBox(page).locator('.git-job-state')).toHaveText('완료', { timeout: 20000 });
    expect(commits(repo)).toBe(before + 1);
    await expect(msg(page)).toHaveValue('');
  });

  test('취소하면 잡이 끝나고 메시지는 남는다', async ({ page }) => {
    const repo = realPath(copyFx('basic', 'job-cancel'));
    slowHook(repo, 30);
    const before = commits(repo);
    await waitForInit(page);
    await openGit(page, repo);

    await startCommit(page, 'job-cancel 커밋');
    const cancel = indexBox(page).locator('.git-job-cancel');
    await expect(cancel).toBeVisible({ timeout: 10000 });
    await cancel.click();
    await page.locator('#git-confirm .gc-go').click();
    await expect(indexBox(page).locator('.git-job-state')).toHaveText('취소했습니다', { timeout: 20000 });
    expect(commits(repo)).toBe(before);
    await expect(msg(page)).toHaveValue('job-cancel 커밋');
  });

  test('충돌로 멈춘 merge 는 실패로 끝나고 충돌 안내가 선다', async ({ page }) => {
    const repo = realPath(copyFx('basic', 'job-conflict'));
    git(repo, 'stash', '-u');
    git(repo, 'checkout', '-q', '-b', 'side');
    writeFileSync(join(repo, 'tracked.txt'), 'side\n');
    git(repo, 'commit', '-qam', 'side');
    git(repo, 'checkout', '-q', '-');
    writeFileSync(join(repo, 'tracked.txt'), 'main\n');
    git(repo, 'commit', '-qam', 'main');
    await waitForInit(page);
    await openGit(page, repo);

    await expect(changes(page).locator('.git-head-branch')).not.toHaveText('', { timeout: 10000 });
    await page.evaluate(() => {
      const w = window as any;
      return w.GitBranches._run(w.app.gitPanel, '/api/git/branch/merge', { ref: 'side', mode: '' });
    });
    await expect(indexBox(page).locator('.git-job-state')).toHaveText('실패', { timeout: 20000 });
    await expect(indexBox(page).locator('.git-job-note')).toContainText('충돌이 남았습니다');
    // 진행 중 노트가 출구(계속·중단)를 준다.
    await expect(changes(page).locator('.git-op-bar')).toHaveClass(/vis/, { timeout: 10000 });
  });

  test('index.lock 에 막힌 커밋 잡은 "남은 lock 지우기" 를 준다', async ({ page }) => {
    const repo = realPath(copyFx('basic', 'job-lock'));
    await waitForInit(page);
    await openGit(page, repo);
    writeFileSync(join(repo, '.git', 'index.lock'), '');

    await startCommit(page, 'job-lock 커밋');
    await expect(indexBox(page).locator('.git-job-state')).toHaveText('실패', { timeout: 20000 });
    await expect(indexBox(page).locator('.git-job-lock')).toBeVisible();
    await expect(msg(page)).toHaveValue('job-lock 커밋');
  });

  test('새로고침 뒤에도 도는 커밋에 다시 붙고, 이기면 초안을 비운다', async ({ page }) => {
    const repo = realPath(copyFx('basic', 'job-reattach'));
    slowHook(repo, 5);
    const before = commits(repo);
    await waitForInit(page);
    await openGit(page, repo);

    // 새로고침 뒤에 같은 저장소가 열리도록 핀을 두고, 초안이 저장되기를 기다린다.
    await page.evaluate((r) => (window as any).app.testing.gitPin(r), repo);
    await msg(page).fill('job-reattach 커밋');
    await page.waitForFunction((r) => {
      const g = (window as any).app.ws.git;
      return !!(g && g.drafts && g.drafts[r as string]);
    }, repo, { timeout: 5000 });
    await page.evaluate(() => (window as any).app.testing.save());
    await expect(btn(page)).toBeEnabled({ timeout: 20000 });
    await btn(page).click();
    await expect(indexBox(page)).toHaveClass(/vis/, { timeout: 10000 });
    await page.reload();
    await page.waitForSelector('#area .ed-side .git-view.git-changes .git-commit-msg', { timeout: 15000 });
    await expect(indexBox(page).locator('.git-job-kind')).toHaveText('Commit', { timeout: 20000 });
    await expect.poll(() => commits(repo), { timeout: 30000 }).toBe(before + 1);
    await expect(msg(page)).toHaveValue('', { timeout: 20000 });
  });
});
