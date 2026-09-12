import { execFileSync } from 'child_process';
import { writeFileSync } from 'fs';
import { join } from 'path';

import { Page } from '@playwright/test';

import {
  test, expect, makeCopyFx, openGit, clickGitView, waitForInit, gitFixture, cleanGitFixture,
  freshDir,
} from './fixtures';
import { tmpPath, realPath } from './osenv';

/**
 * GIT_DETECT_TIER_SRS §5 — V-GDT-7~12·14.
 *
 * **감지의 구멍**이다. signature 가 보지 않던 자리들(`.git/config`·
 * `logs/refs/stash`·`.git/worktrees`)과 `obsMark` 가 싣지 않던 것(진행 중 작업),
 * 그리고 특수 상태 셋(`am`·`bisect`·빈 저장소).
 *
 * 전부 **터미널에서 친 것이 화면에 오는가**를 잰다 — 그것이 이 SRS 가 닫는 사용자
 * 증상이다 ("화면이 낡았다").
 */

const FIXTURES = tmpPath('dm-git-fx-gdt-' + process.pid);

test.beforeAll(() => { gitFixture(FIXTURES) });
test.afterAll(() => { cleanGitFixture(FIXTURES) });

const copyFx = makeCopyFx(FIXTURES);
const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args]).toString().trim();

// 감지 회차는 2단이다 — signature 가 그대로면 워크트리 회차를 기다린다.
// `GitWatchWorktreeEvery`(4) × `GitWatchInterval`(1s) 을 넉넉히 넘긴다.
const DETECT_WAIT = 20000;

const opBar = (page: Page) => page.locator('#area .ed-side .git-op-bar.vis');

test('V-GDT-7 (FR-GDT-12): 터미널의 git remote add 가 Branches 원격 목록에 온다',
  async ({ page }) => {
    const repo = copyFx('basic', 'gdt-remote');
    await waitForInit(page);
    await openGit(page, repo);
    await clickGitView(page, 'branches');
    const rows = page.locator('#area .pn-body .git-view.git-branches .git-rm-row');
    const before = await rows.count();

    // `.git/config` 만 바뀐다 — 종전 signature 는 그 파일을 **한 톨도** 보지
    // 않았으므로 이 변화는 감지되지 않았고, 목록은 낡은 채 남았다 (`11 GP-11b`).
    git(repo, 'remote', 'add', 'gdt', 'https://example.invalid/x.git');

    await expect(rows).toHaveCount(before + 1, { timeout: DETECT_WAIT });
  });

test('V-GDT-8 (FR-GDT-13·15): 터미널의 git stash drop 이 Stash 목록에 온다',
  async ({ page }) => {
    const repo = copyFx('stashes', 'gdt-stash');
    await waitForInit(page);
    await openGit(page, repo);
    await clickGitView(page, 'stash');
    const rows = page.locator('#area .pn-body .git-view.git-stash .git-stash-row');
    await expect(rows.first()).toBeVisible({ timeout: 20000 });
    const before = await rows.count();
    expect(before).toBeGreaterThan(1);

    // `refs/stash` 와 `logs/refs/stash` 의 **내용**만 바뀐다. `refsTree` 는
    // 디렉터리 mtime 과 이름만 보므로 그 둘 다 그대로였다 (`11 GP-11a`).
    git(repo, 'stash', 'drop', 'stash@{0}');

    await expect(rows).toHaveCount(before - 1, { timeout: DETECT_WAIT });
  });

test('V-GDT-9 (FR-GDT-17): cherry-pick --quit 뒤 진행 바가 사라진다',
  async ({ page }) => {
    const repo = copyFx('conflict', 'gdt-quit');
    await waitForInit(page);
    await openGit(page, repo);
    // `conflict` 픽스처는 머지가 멈춘 상태다. 같은 기전을 재려면 sequencer 표식이
    // 필요하므로 머지를 끝내고 체리픽을 멈춘 상태를 만든다.
    git(repo, 'merge', '--abort');
    const head = git(repo, 'rev-parse', 'HEAD');
    await expect(opBar(page)).toHaveCount(0, { timeout: DETECT_WAIT });
    // 충돌하는 체리픽을 만든다 — 없으면 표식이 남지 않는다.
    writeFileSync(join(repo, 'gdt-quit.txt'), 'a\n');
    git(repo, 'add', '-A');
    git(repo, '-c', 'user.name=dm', '-c', 'user.email=dm@example.com',
      '-c', 'commit.gpgsign=false', 'commit', '-qm', 'gdt base');
    const pick = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'reset', '-q', '--hard', head);
    writeFileSync(join(repo, 'gdt-quit.txt'), 'b\n');
    git(repo, 'add', '-A');
    git(repo, '-c', 'user.name=dm', '-c', 'user.email=dm@example.com',
      '-c', 'commit.gpgsign=false', 'commit', '-qm', 'gdt other');
    try { git(repo, 'cherry-pick', pick) } catch { /* 충돌이 이 검사의 전제다 */ }

    await expect(opBar(page)).toBeVisible({ timeout: DETECT_WAIT });

    // **표식만 사라진다.** HEAD 도 index 도 파일 목록도 그대로이므로 종전
    // `obsMark` 는 한 글자도 바뀌지 않았고, "진행 중" 바가 굳은 채 남았다.
    git(repo, 'cherry-pick', '--quit');
    await expect(opBar(page)).toHaveCount(0, { timeout: DETECT_WAIT });
  });

test('V-GDT-10 (FR-GDT-18·20): bisect 가 화면에 뜨고 출구가 bisect 다',
  async ({ page }) => {
    const repo = copyFx('many-commits', 'gdt-bisect');
    await waitForInit(page);
    await openGit(page, repo);
    await expect(opBar(page)).toHaveCount(0, { timeout: DETECT_WAIT });

    // 종전에는 감지·표시·출구가 전부 없었다 — detached HEAD 로만 보였다.
    git(repo, 'bisect', 'start');
    git(repo, 'bisect', 'bad');
    git(repo, 'bisect', 'good', 'HEAD~5');

    await expect(opBar(page)).toBeVisible({ timeout: DETECT_WAIT });
    await expect(opBar(page).locator('.git-op-kind')).toContainText('bisect');
    // 출구는 **그 상태의 명령**이어야 한다 (FR-GDT-20). bisect 는 `reset` 하나다.
    const acts = opBar(page).locator('.git-op-act.vis');
    await expect(acts).toHaveCount(1, { timeout: 10000 });
    await expect(acts).toHaveAttribute('data-act', 'abort');
  });

test('V-GDT-11 (FR-GDT-19): git am 진행 중이 am 으로 표시된다', async ({ page }) => {
  const repo = copyFx('basic', 'gdt-am');
  await waitForInit(page);
  await openGit(page, repo);
  await expect(opBar(page)).toHaveCount(0, { timeout: DETECT_WAIT });

  // `git am` 은 `rebase-apply/` 를 만든다. 종전에는 그것을 "리베이스 중" 으로
  // 읽고 출구가 `git rebase --continue/--abort` 를 냈다 — 맞지 않는 명령이다.
  //
  // 충돌하는 패치를 만든다: 없는 내용을 고치는 패치는 적용에 실패하고 멈춘다.
  const mbox = join(repo, 'gdt.mbox');
  writeFileSync(mbox, [
    'From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001',
    'From: dm <dm@example.com>',
    'Date: Thu, 1 Jan 2026 00:00:00 +0000',
    'Subject: [PATCH] gdt am',
    '',
    '---',
    ' gdt-am.txt | 2 +-',
    ' 1 file changed, 1 insertion(+), 1 deletion(-)',
    '',
    'diff --git a/gdt-am.txt b/gdt-am.txt',
    'index 1111111..2222222 100644',
    '--- a/gdt-am.txt',
    '+++ b/gdt-am.txt',
    '@@ -1 +1 @@',
    '-was',
    '+now',
    '-- ',
    '2.50.1',
    '',
  ].join('\n'));
  try { git(repo, 'am', '--3way', mbox) } catch { /* 실패가 이 검사의 전제다 */ }

  await expect(opBar(page)).toBeVisible({ timeout: DETECT_WAIT });
  await expect(opBar(page).locator('.git-op-kind')).toContainText('am');
});

test('V-GDT-12 (FR-GDT-21): 빈 저장소에서 History 가 "커밋이 아직 없습니다" 다',
  async ({ page }) => {
    // 픽스처 `empty-no-commit` 은 staged 파일을 하나 갖는다 — History 목록에
    // "커밋하지 않은 변경" 행이 서므로 목록이 비지 않는다. 여기서 재는 것은
    // **빈 목록의 문구**이므로 아무것도 없는 저장소를 만든다.
    const dir = freshDir(join(FIXTURES, 'copy-gdt-empty'));
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    // **`realPath` 를 지난다** — 서버가 저장하는 것과 같은 모양이어야
    // `edWindowFor` 가 방금 더한 창을 찾는다 (`makeCopyFx` 와 같은 규약).
    const repo = realPath(dir);
    await waitForInit(page);
    await openGit(page, repo);
    await clickGitView(page, 'history');
    const empty = page.locator('#area .pn-body .git-view.git-history .git-hist-empty');
    // 종전에는 `git log` 가 exit 128 로 실패해 "불러오지 못했습니다" 가 떴다 —
    // **"아직 없다" 와 "읽지 못했다" 가 같은 문구**였다.
    await expect(empty).toBeVisible({ timeout: 20000 });
    await expect(empty).toHaveText('커밋이 아직 없습니다');
  });

test('V-GDT-14 (회귀): 작업 트리에 파일을 만들면 여전히 방송이 온다',
  async ({ page }) => {
    const repo = copyFx('basic', 'gdt-worktree');
    await waitForInit(page);
    await openGit(page, repo);
    const rows = page.locator('#area .ed-side .git-view.git-changes .git-file');
    await expect(rows.first()).toBeVisible({ timeout: 20000 });
    const before = await rows.count();

    // **이 검사가 2단 게이트의 안전벨트다.** signature 는 작업 트리를 보지
    // 못하므로, 워크트리 회차를 없애면 이 변화가 영영 오지 않는다 — 첫 구현이
    // 정확히 그 실수를 했고 e2e 가 그것을 잡았다 (GIT_PUSH_OBSERVE_SRS §2.7).
    writeFileSync(join(repo, 'gdt-new.txt'), 'x\n');

    await expect(rows).toHaveCount(before + 1, { timeout: DETECT_WAIT });
  });

test('V-GDT-14b (FR-GDT-5): `.git` 안의 변화는 1초 반응을 유지한다',
  async ({ page }) => {
    const repo = copyFx('basic', 'gdt-fast');
    await waitForInit(page);
    await openGit(page, repo);
    const branch = page.locator('#area .ed-side .git-view.git-changes .git-head-branch');
    await expect(branch).toHaveText('main', { timeout: 20000 });

    // 체크아웃은 `.git/HEAD` 를 바꾼다 — signature 가 그것을 본다. 워크트리
    // 회차를 기다릴 필요가 없으므로 **짧은 상한**으로 잰다.
    git(repo, 'checkout', '-q', '-b', 'gdt-fast-branch');
    await expect(branch).toHaveText('gdt-fast-branch', { timeout: 6000 });
  });
