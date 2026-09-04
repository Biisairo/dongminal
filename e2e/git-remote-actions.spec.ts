import { execFileSync } from 'child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { Page } from '@playwright/test';

import { test, expect, waitForInit, GIT_VIEW_TABS } from './fixtures';

// GIT_ACTIONS_SRS §3.5 묶음 E — 원격 동작. 검증 V196·V197·V198.
//
// 원격은 **로컬 bare** 다 (design/README.md 의 with-remote + remote.git). 네트워크를
// 쓰지 않으므로 테스트가 외부에 의존하지 않는다. 쓰기를 하므로 저장소와 원격을
// 매 테스트마다 **복사본**으로 만든다 — 원본을 밀면 다음 테스트가 무너진다.
//
// 형태는 git-remote.spec.ts 를 그대로 본뜬다 — 원격 표면의 e2e 규약이 두 벌이면
// 한쪽만 고쳐진다.

const FIXTURES = '/tmp/dm-git-fx-remact-' + process.pid;

test.beforeAll(() => {
  execFileSync('bash', ['e2e/git_fixture.sh', FIXTURES], { stdio: 'ignore' });
});
test.afterAll(() => {
  execFileSync('bash', ['e2e/git_fixture.sh', '--clean', FIXTURES], { stdio: 'ignore' });
});

const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args]).toString().trim();

// 저장소와 원격을 한 벌로 복사하고 origin 을 그 복사본으로 돌린다.
function copyPair(tag: string) {
  const dst = join(FIXTURES, 'copy-' + tag);
  const bare = join(FIXTURES, 'bare-' + tag + '.git');
  rmSync(dst, { recursive: true, force: true });
  rmSync(bare, { recursive: true, force: true });
  execFileSync('cp', ['-R', join(FIXTURES, 'with-remote'), dst]);
  execFileSync('cp', ['-R', join(FIXTURES, 'remote.git'), bare]);
  const repo = realpathSync(dst);
  const remote = realpathSync(bare);
  git(repo, 'remote', 'set-url', 'origin', remote);
  return { repo, remote };
}

// 원격을 한 커밋 앞세운다 — 별도 클론에서 밀어야 bare 를 정직하게 움직인다.
function advanceRemote(remote: string, text: string) {
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'dm-git-adv-')));
  const clone = join(work, 'c');
  execFileSync('git', ['clone', '-q', remote, clone]);
  git(clone, 'config', 'user.name', 'dm');
  git(clone, 'config', 'user.email', 'dm@example.com');
  git(clone, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(clone, 'remote-side.txt'), text + '\n');
  git(clone, 'add', '-A');
  git(clone, 'commit', '-qm', text);
  git(clone, 'push', '-q', 'origin', 'HEAD:main');
  rmSync(work, { recursive: true, force: true });
}

// 원격이 같은 줄을 다르게 고치게 한다 — pull 이 충돌로 끝나는 유일한 정직한 방법이다.
function conflictRemote(remote: string) {
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'dm-git-cf-')));
  const clone = join(work, 'c');
  execFileSync('git', ['clone', '-q', remote, clone]);
  git(clone, 'config', 'user.name', 'dm');
  git(clone, 'config', 'user.email', 'dm@example.com');
  git(clone, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(clone, 'f.txt'), 'a\nfrom-remote\n');
  git(clone, 'commit', '-qam', 'remote edit');
  git(clone, 'push', '-q', 'origin', 'HEAD:main');
  rmSync(work, { recursive: true, force: true });
}

async function openGit(page: Page, repo: string) {
  await page.evaluate((r: string) => (window as any).app.openGitWindow(r), repo);
  // REPO_TAB_UNIFY_SRS: 창의 모양이 바뀌었다 — `Changes` 는 **사이드**에 살고
  // 나머지 여섯 뷰는 **본문 탭**으로 필요할 때 열린다 (FR-RTU-30·32). 스펙들이
  // "탭을 클릭한다" 로 뷰를 고르므로 여기서 여섯을 미리 세운다.
  await page.waitForSelector('#area .ed-win .ed-side', { timeout: 15000 });
  await page.evaluate(() => {
    const a = (window as any).app;
    a._edSetSide(a._aw(), 'changes');
    const p = a.gitPanel;
    for (const v of ['diff', 'history', 'branches', 'stash', 'console', 'worktrees']) p.openView(v);
  });
  await expect(page.locator('#area .pn-tab[data-git-view]')).toHaveCount(GIT_VIEW_TABS);
  await expect(page.locator('#area .ed-side .git-view.git-changes')).toBeVisible({ timeout: 10000 });
}

const changes = (page: Page) => page.locator('#area .ed-side .git-view.git-changes');
const head = (page: Page) => changes(page).locator('.git-head');
const btn = (page: Page, kind: string) =>
  head(page).locator(`.git-remote-btn[data-remote="${kind}"]`);
const syncBtn = (page: Page) => head(page).locator('.git-remote-sync');
const previewBtn = (page: Page) => head(page).locator('.git-push-preview');
const job = (page: Page) => changes(page).locator('.git-job');
const confirm = (page: Page) => page.locator('#git-confirm .gc-box');
const preview = (page: Page) => page.locator('#git-push-preview .gpp-box');
const addDlg = (page: Page) => page.locator('#git-remote-add .gra-box');

// Branches 탭의 원격 목록.
const branches = (page: Page) => page.locator('#area .pn-body .git-view.git-branches');
const remotes = (page: Page) => branches(page).locator('.git-br-remotes');
const remoteRows = (page: Page) => remotes(page).locator('.git-rm-row');

async function openBranches(page: Page) {
  await page.click('#area .pn-tab[data-git-view="branches"]');
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

  test('E4 (V197 / FR-GIT-270): Sync 는 pull → push 순서로 돌고 ahead/behind 를 지운다', async ({ page }) => {
    test.setTimeout(60000);
    const { repo, remote } = copyPair('e4');
    // 양쪽이 서로 앞선 상태를 만든다 — pull 이 뜻을 갖고, 그 뒤 push 가 뜻을 갖는다.
    advanceRemote(remote, 'from-remote');
    // git 2.34+ 는 갈라진 브랜치에서 **합치는 방식을 정해 두지 않으면 pull 을
    // 거부한다.** 버튼은 기본 동작만 하므로(FR-GIT-99) 그 거부는 git 의 것이지
    // 우리 것이 아니다 — 방식을 정해 둔 저장소가 이 시험의 전제다.
    git(repo, 'config', 'pull.rebase', 'false');
    await waitForInit(page);
    await openGit(page, repo);
    await ready(page);

    await expect(syncBtn(page)).toBeEnabled({ timeout: 20000 });
    await syncBtn(page).click();

    // **순서는 서버가 정한다** (write.SyncNext) — 그것은 단위로 고정돼 있고, 여기서
    // 1단계를 화면으로 잡으려 하면 pull 이 빨리 끝나는 저장소에서 놓친다(실제로
    // 그렇게 헛짚었다). 화면이 답할 것은 **두 단계가 묶여 돌았다**는 사실이다:
    // 라벨이 Sync 이고, 끝난 자리에 확인을 거치는 push 가 있다.
    await expect(job(page).locator('.git-job-kind')).toContainText('Sync', { timeout: 20000 });
    await jobArgv(page, 'git push --progress');
    await expect(job(page).locator('.git-job-kind')).toContainText('2/2');
    await jobEnded(page, '완료');

    expect(git(repo, 'rev-parse', 'main')).toBe(git(remote, 'rev-parse', 'main'));
    await expect(head(page).locator('.git-head-ab')).toHaveText('', { timeout: 20000 });
  });

  test('E5 (V197 / FR-GIT-270): pull 이 실패하면 push 를 돌리지 않고 그 사실을 말한다', async ({ page }) => {
    test.setTimeout(60000);
    const { repo, remote } = copyPair('e5');
    // 원격이 같은 줄을 다르게 고쳤다 — pull 이 충돌로 멈춘다.
    conflictRemote(remote);
    await waitForInit(page);
    await openGit(page, repo);
    await ready(page);

    // push 요청이 아예 나가지 않는 것이 이 검증의 본체다 (V197).
    let pushes = 0;
    page.on('request', (req) => {
      const u = req.url();
      if (u.includes('/api/git/push') && !u.includes('/push/preview')) pushes++;
    });

    await expect(syncBtn(page)).toBeEnabled({ timeout: 20000 });
    await syncBtn(page).click();
    await jobArgv(page, 'git pull --progress');
    await jobEnded(page, '실패');

    // 멈춘 사유가 그 자리에 남는다 — 조용히 끝내면 사용자는 push 가 돈 줄 안다.
    await expect(job(page).locator('.git-job-note')).toBeVisible({ timeout: 20000 });
    await expect(job(page).locator('.git-job-note')).toContainText('push');

    // 두 번째 단계는 시작조차 하지 않았다.
    expect(pushes, 'pull 이 실패했는데 push 가 돌았다').toBe(0);
    const jobs = await page.request.get('/api/git/jobs');
    expect(await jobs.text()).not.toContain('"kind":"push"');
  });

  test('E6 (V197 / FR-GIT-101): Sync 중에는 같은 리포의 원격 버튼 전부가 막힌다', async ({ page }) => {
    const { repo } = copyPair('e6');
    await waitForInit(page);
    await openGit(page, repo);
    await ready(page);

    // 로컬 bare 로의 작업은 즉시 끝난다 — 진행 중 상태를 정직하게 보려면 작업이
    // 끝나지 않아야 하므로 응답만 흉내 내고 출력 스트림을 매달아 둔다.
    await page.route('**/api/git/sync', (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          requested: repo,
          repo,
          sync: { id: 'stub-sync', step: 'pull', steps: ['pull', 'push'], done: false },
          job: { id: 'stub-job', repo, kind: 'pull', argv: ['pull', '--progress'], done: false },
        }),
      });
    });
    await page.route('**/api/git/job/events*', () => {});
    await page.route('**/api/git/jobs', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          jobs: [{ id: 'stub-job', repo, kind: 'pull', argv: ['pull', '--progress'], done: false }],
        }),
      }));

    await syncBtn(page).click();
    await expect(job(page)).toHaveClass(/vis/);
    for (const kind of ['fetch', 'pull', 'push']) {
      await expect(btn(page, kind)).toBeDisabled();
    }
    await expect(syncBtn(page)).toBeDisabled();
    await expect(previewBtn(page)).toBeDisabled();
    // 사유 없이 꺼진 버튼은 사용자가 해소할 수 없다.
    await expect(syncBtn(page)).toHaveAttribute('title', /진행 중/);
  });

  // ── V198: Push preview ──

  test('E7 (V198 / FR-GIT-271): 미리보기가 outgoing 커밋을 보이고 대상을 고르게 한다', async ({ page }) => {
    const { repo, remote } = copyPair('e7');
    await waitForInit(page);
    await openGit(page, repo);
    await ready(page);

    // with-remote 는 ahead 1 이다 — 그 커밋 하나가 목록에 있어야 한다.
    const subject = git(repo, 'log', '-1', '--pretty=%s');
    await expect(previewBtn(page)).toBeEnabled({ timeout: 20000 });
    await previewBtn(page).click();
    await expect(preview(page)).toBeVisible();
    await expect(preview(page).locator('.gpp-note')).toContainText('올라갈 커밋 1개');
    await expect(preview(page).locator('.gpp-note')).toContainText(subject);

    // 대상은 고칠 수 있다 — 원격은 목록에서 고르고 브랜치는 이름으로 받는다.
    await expect(preview(page).locator('.gpp-field[data-key="remote"] input[value="origin"]'))
      .toBeChecked();
    await expect(preview(page).locator('.gpp-branch')).toHaveValue('main');

    await preview(page).locator('.gpp-go').click();
    await jobArgv(page, 'git push --progress origin main');
    await jobEnded(page, '완료');
    expect(git(repo, 'rev-parse', 'main')).toBe(git(remote, 'rev-parse', 'main'));
  });

  test('E8 (V198 / FR-GIT-271·106): 미리보기의 force-with-lease 는 기존 확인 규약을 그대로 탄다', async ({ page }) => {
    test.setTimeout(60000);
    const { repo, remote } = copyPair('e8');
    // 원격을 앞세워 일반 push 가 거부되게 한다 — force 가 뜻을 갖는 유일한 상태다.
    advanceRemote(remote, 'from-remote');
    await waitForInit(page);
    await openGit(page, repo);
    await ready(page);

    await previewBtn(page).click();
    await expect(preview(page)).toBeVisible();
    await preview(page).locator('.gpp-field[data-key="lease"] input').check();
    await preview(page).locator('.gpp-go').click();

    // force 는 파괴적이다 — 이름이 서버의 목록에 있으므로 확인을 거친다
    // (FR-GIT-106·89). 걸음은 하나이며 미리보기가 그것을 정하지 않는다.
    await expect(confirm(page)).toHaveAttribute('data-action', 'force_push');
    await confirm(page).locator('.gc-go').click();

    await jobArgv(page, /git push --progress --force-with-lease origin main/);
  });

  test('E9 (V198 / FR-GIT-271): 원격에 없는 브랜치는 publish 로 알리고 upstream 설정을 그 자리에서 켠다', async ({ page }) => {
    const { repo, remote } = copyPair('e9');
    git(repo, 'checkout', '-q', '-b', 'brand-new');
    await waitForInit(page);
    await openGit(page, repo);
    await ready(page);

    await previewBtn(page).click();
    await expect(preview(page)).toBeVisible();
    // 원격에 이 브랜치가 없다 = 미는 순간 만들어진다. 그 사실을 먼저 말한다.
    await expect(preview(page).locator('.gpp-note')).toContainText('원격에 이 브랜치가 없습니다');
    // upstream 설정은 **사용자가 명시할 때만** 붙는다 (FR-GIT-97·100).
    const up = preview(page).locator('.gpp-field[data-key="publish"] input');
    await expect(up).not.toBeChecked();
    await up.check();
    await preview(page).locator('.gpp-go').click();

    await jobArgv(page, 'git push --progress -u origin brand-new');
    await jobEnded(page, '완료');
    expect(git(repo, 'config', '--get', 'branch.brand-new.remote')).toBe('origin');
    expect(git(remote, 'rev-parse', 'brand-new')).toBe(git(repo, 'rev-parse', 'brand-new'));
  });

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

    // 미리보기가 받는 것은 대상과 force 뿐이다.
    await previewBtn(page).click();
    await expect(preview(page)).toBeVisible();
    await expect(preview(page).locator('input[type="password"]')).toHaveCount(0);
    await preview(page).locator('.gpp-cancel').click();

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
