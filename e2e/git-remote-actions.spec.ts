import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

import { Page } from '@playwright/test';

import { test, expect, waitForInit, GIT_VIEW_TABS, clickGitView, openGit, gitFixture, cleanGitFixture, copyDir } from './fixtures';
import { TMP, tmpPath, realPath } from './osenv';

// GIT_ACTIONS_SRS §3.5 묶음 E — 원격 동작. 검증 V196·V197·V198.
//
// 원격은 **로컬 bare** 다 (design/README.md 의 with-remote + remote.git). 네트워크를
// 쓰지 않으므로 테스트가 외부에 의존하지 않는다. 쓰기를 하므로 저장소와 원격을
// 매 테스트마다 **복사본**으로 만든다 — 원본을 밀면 다음 테스트가 무너진다.
//
// 형태는 git-remote.spec.ts 를 그대로 본뜬다 — 원격 표면의 e2e 규약이 두 벌이면
// 한쪽만 고쳐진다.

const FIXTURES = tmpPath('dm-git-fx-remact-' + process.pid);

test.beforeAll(() => {
  gitFixture(FIXTURES);
});
test.afterAll(() => {
  cleanGitFixture(FIXTURES);
});

const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args]).toString().trim();

// 저장소와 원격을 한 벌로 복사하고 origin 을 그 복사본으로 돌린다.
function copyPair(tag: string) {
  const dst = join(FIXTURES, 'copy-' + tag);
  const bare = join(FIXTURES, 'bare-' + tag + '.git');
  rmSync(dst, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  rmSync(bare, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  copyDir(join(FIXTURES, 'with-remote'), dst);
  copyDir(join(FIXTURES, 'remote.git'), bare);
  const repo = realPath(dst);
  const remote = realPath(bare);
  git(repo, 'remote', 'set-url', 'origin', remote);
  return { repo, remote };
}

// 원격을 한 커밋 앞세운다 — 별도 클론에서 밀어야 bare 를 정직하게 움직인다.
function advanceRemote(remote: string, text: string) {
  const work = realPath(mkdtempSync(join(TMP, 'dm-git-adv-')));
  const clone = join(work, 'c');
  execFileSync('git', ['clone', '-q', remote, clone]);
  git(clone, 'config', 'user.name', 'dm');
  git(clone, 'config', 'user.email', 'dm@example.com');
  git(clone, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(clone, 'remote-side.txt'), text + '\n');
  git(clone, 'add', '-A');
  git(clone, 'commit', '-qm', text);
  git(clone, 'push', '-q', 'origin', 'HEAD:main');
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

// 원격이 같은 줄을 다르게 고치게 한다 — pull 이 충돌로 끝나는 유일한 정직한 방법이다.
function conflictRemote(remote: string) {
  const work = realPath(mkdtempSync(join(TMP, 'dm-git-cf-')));
  const clone = join(work, 'c');
  execFileSync('git', ['clone', '-q', remote, clone]);
  git(clone, 'config', 'user.name', 'dm');
  git(clone, 'config', 'user.email', 'dm@example.com');
  git(clone, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(clone, 'f.txt'), 'a\nfrom-remote\n');
  git(clone, 'commit', '-qam', 'remote edit');
  git(clone, 'push', '-q', 'origin', 'HEAD:main');
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

const changes = (page: Page) => page.locator('#area .ed-side .git-view.git-changes');
const head = (page: Page) => changes(page).locator('.git-head');
const btn = (page: Page, kind: string) =>
  head(page).locator(`.git-remote-btn[data-remote="${kind}"]`);
const job = (page: Page) => changes(page).locator('.git-job');
const confirm = (page: Page) => page.locator('#git-confirm .gc-box');
const addDlg = (page: Page) => page.locator('#git-remote-add .gra-box');

// Branches 탭의 원격 목록.
const branches = (page: Page) => page.locator('#area .pn-body .git-view.git-branches');
const remotes = (page: Page) => branches(page).locator('.git-br-remotes');
const remoteRows = (page: Page) => remotes(page).locator('.git-rm-row');

async function openBranches(page: Page) {
  await clickGitView(page, 'branches');
  await expect(page.locator('#area .pn-body .git-view.vis')).toHaveClass(/git-branches/);
}

// 버튼이 살아났음 = status 를 읽었음이다. 이것을 기다리지 않고 클릭하면 disabled
// 버튼을 눌러 아무 일도 일어나지 않는다.
async function ready(page: Page) {
  await expect(btn(page, 'push')).toBeEnabled({ timeout: 20000 });
}

async function jobEnded(page: Page, state: string) {
  await expect(job(page).locator('.git-job-state')).toHaveText(state, { timeout: 30000 });
}
async function jobArgv(page: Page, argv: string | RegExp) {
  await expect(job(page).locator('.git-job-argv')).toHaveText(argv, { timeout: 30000 });
}

test.describe('묶음 E — 원격 동작 (FR-GIT-269~271)', () => {
  // ── V196: remote 목록 · add / remove ──

  test('E1 (V196 / FR-GIT-269): remote add/remove 가 목록에 반영되고, remove 는 되살릴 명령을 남긴다', async ({ page }) => {
    const { repo } = copyPair('e1');
    await waitForInit(page);
    await openGit(page, repo);
    await ready(page);
    await openBranches(page);

    // 픽스처의 origin 하나가 보인다. URL 도 함께 보인다 — 어느 원격인지 이름만으로
    // 가릴 수 없다.
    await expect(remoteRows(page)).toHaveCount(1, { timeout: 20000 });
    await expect(remotes(page).locator('.git-rm-row[data-remote="origin"] .git-rm-url'))
      .toContainText('bare-e1.git');

    // add — 이름과 URL 을 받는다. **자격증명을 따로 묻는 입력은 없다** (FR-GIT-104).
    await remotes(page).locator('.git-rm-add').click();
    await expect(addDlg(page)).toBeVisible();
    await expect(addDlg(page).locator('input[type="password"]')).toHaveCount(0);
    await addDlg(page).locator('.gra-name').fill('upstream');
    await addDlg(page).locator('.gra-url').fill('/tmp/dm-upstream.git');
    await addDlg(page).locator('.gra-go').click();

    await expect(remoteRows(page)).toHaveCount(2, { timeout: 20000 });
    expect(git(repo, 'config', '--get', 'remote.upstream.url')).toBe('/tmp/dm-upstream.git');

    // remove — **되살릴 명령**을 그 자리에 보인다 (FR-GIT-92·269).
    await remotes(page).locator('.git-rm-row[data-remote="upstream"] .git-rm-del').click();
    await expect(confirm(page)).toHaveAttribute('data-action', 'remote_remove');
    await expect(confirm(page).locator('.gc-hint-cmd'))
      .toContainText('remote add upstream /tmp/dm-upstream.git');
    await confirm(page).locator('.gc-go').click();

    await expect(remoteRows(page)).toHaveCount(1, { timeout: 20000 });
    expect(git(repo, 'config', '--list')).not.toContain('remote.upstream.url');
  });

  test('E2 (V196 / FR-GIT-104): 원격 목록의 URL 에서 자격증명 자리가 지워진다', async ({ page }) => {
    const { repo } = copyPair('e2');
    // 자격증명이 박힌 URL 을 저장소 설정에 직접 심는다 — 사용자가 터미널에서
    // 이렇게 만들어 둔 저장소를 우리가 열 수 있어야 한다.
    git(repo, 'remote', 'add', 'creds', 'https://alice:sesame@example.test/x.git');
    await waitForInit(page);
    await openGit(page, repo);
    await ready(page);
    await openBranches(page);

    const row = remotes(page).locator('.git-rm-row[data-remote="creds"] .git-rm-url');
    await expect(row).toBeVisible({ timeout: 20000 });
    await expect(row).toContainText('example.test');
    // 비밀은 화면 어디에도 없다 (FR-GIT-104, V43).
    await expect(row).not.toContainText('sesame');
    await expect(row).toContainText('***');
    // 응답 자체에도 없다 — 화면만 가리면 브라우저 캐시로 흐른다.
    const res = await page.request.get('/api/git/remotes?repo=' + encodeURIComponent(repo));
    expect(await res.text()).not.toContain('sesame');
  });

  test('E3 (V196 / FR-GIT-250.3): 잘못된 원격 이름은 실행 전에 막히고 사유가 남는다', async ({ page }) => {
    const { repo } = copyPair('e3');
    await waitForInit(page);
    await openGit(page, repo);
    await ready(page);
    await openBranches(page);
    await expect(remoteRows(page)).toHaveCount(1, { timeout: 20000 });

    await remotes(page).locator('.git-rm-add').click();
    await expect(addDlg(page)).toBeVisible();
    // 슬래시가 든 이름은 원격 이름이 아니다 — 서버가 거부하고 다이얼로그는 닫히지
    // 않는다 (FR-GIT-175).
    await addDlg(page).locator('.gra-name').fill('bad/name');
    await addDlg(page).locator('.gra-url').fill('/tmp/dm-bad.git');
    await addDlg(page).locator('.gra-go').click();
    await expect(addDlg(page).locator('.git-dialog-err')).toBeVisible({ timeout: 10000 });
    await expect(addDlg(page)).toBeVisible();
    expect(git(repo, 'config', '--list')).not.toContain('bad/name');
    await addDlg(page).locator('.gra-cancel').click();

    // 같은 이름을 두 번 더하지 않는다.
    await remotes(page).locator('.git-rm-add').click();
    await addDlg(page).locator('.gra-name').fill('origin');
    await addDlg(page).locator('.gra-url').fill('/tmp/dm-other.git');
    await addDlg(page).locator('.gra-go').click();
    await expect(addDlg(page).locator('.git-dialog-err')).toBeVisible({ timeout: 10000 });
    expect(git(repo, 'config', '--get', 'remote.origin.url')).not.toBe('/tmp/dm-other.git');
  });

  // ── V197: Sync ──

  test('E10 (V196·V198 / FR-GIT-104): 원격 표면의 새 화면에도 자격증명을 받는 자리가 없다', async ({ page }) => {
    // 만들지 않는 것이 유일한 보장이다 — 소스에 그 자리가 없음을 고정한다.
    const r = await page.request.get('/js/git/remote.js');
    expect(r.ok()).toBe(true);
    const src = await r.text();
    expect(src).not.toMatch(/password|passphrase|secret/i);
    expect(src).not.toMatch(/type=["']password/);

    const { repo } = copyPair('e10');
    await waitForInit(page);
    await openGit(page, repo);
    await ready(page);

    // 원격 생성이 받는 것은 이름과 URL 뿐이다 — URL 은 `git remote add` 의 인자이며
    // dongminal 이 보관하거나 인증에 쓰는 값이 아니다.
    await openBranches(page);
    await remotes(page).locator('.git-rm-add').click();
    await expect(addDlg(page)).toBeVisible();
    await expect(addDlg(page).locator('input[type="password"]')).toHaveCount(0);
    await expect(addDlg(page).locator('.git-dialog-fields input')).toHaveCount(2);
    await addDlg(page).locator('.gra-cancel').click();
  });
});
