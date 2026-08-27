import { execFileSync } from 'child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { Page } from '@playwright/test';

import { test, expect } from './fixtures';

// GIT_M3_STEP1213_CONTRACT §3 — 원격 작업 클라이언트. 검증 V40·V41·V42·V44·V62·V63.
//
// 원격은 **로컬 bare** 다 (design/README.md 의 with-remote + remote.git). 네트워크를
// 쓰지 않으므로 테스트가 외부에 의존하지 않는다. 쓰기를 하므로 저장소와 원격을
// 매 테스트마다 **복사본**으로 만든다 — 원본을 밀면 다음 테스트가 무너진다.

const FIXTURES = '/tmp/dm-git-fx-remote-' + process.pid;

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

async function waitForInit(page: Page) {
  await page.context().addInitScript(() => {
    sessionStorage.setItem('displayMode', 'desktop');
  });
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
}

async function openGit(page: Page, repo: string) {
  await page.evaluate((r) => (window as any).app.openGitWindow(r), repo);
  await expect(page.locator('#area .pn-tab[data-git-view]')).toHaveCount(7);
  await expect(page.locator('#area .pn-body .git-view.vis')).toHaveClass(/git-changes/);
}

const changes = (page: Page) => page.locator('#area .pn-body .git-view.git-changes');
const head = (page: Page) => changes(page).locator('.git-head');
const btn = (page: Page, kind: string) =>
  head(page).locator(`.git-remote-btn[data-remote="${kind}"]`);
const more = (page: Page, kind: string) =>
  head(page).locator(`.git-remote-more[data-remote="${kind}"]`);
const group = (page: Page, key: string) =>
  changes(page).locator(`.git-group[data-group="${key}"]`);
const job = (page: Page) => changes(page).locator('.git-job');
const log = (page: Page) => job(page).locator('.git-job-log');
const lines = (page: Page) => log(page).locator('.git-job-line');
const opts = (page: Page) => job(page).locator('.git-job-opt');
const confirm = (page: Page) => page.locator('#git-confirm .gc-box');
const dialog = (page: Page) => page.locator('#git-remote-opts .gro-box');
const jobChip = (page: Page) => page.locator('#sb-items .sb-git-job');

// 버튼이 살아났음 = status 를 읽었음이다. 이것을 기다리지 않고 클릭하면 disabled
// 버튼을 눌러 아무 일도 일어나지 않는다.
async function ready(page: Page) {
  await expect(btn(page, 'push')).toBeEnabled({ timeout: 20000 });
}

// 작업 하나의 종료는 상태 문구로 판정한다. `.git-job-close` 는 앞선 작업의 것도
// 보이므로 연속 실행에서 새 작업의 종료를 가르지 못한다.
async function jobEnded(page: Page, state: string) {
  await expect(job(page).locator('.git-job-state')).toHaveText(state, { timeout: 30000 });
}
// argv 는 작업이 붙는 순간 화면에 온다 — 무엇이 돌기 시작했는지의 기준이다.
async function jobArgv(page: Page, argv: string | RegExp) {
  await expect(job(page).locator('.git-job-argv')).toHaveText(argv, { timeout: 30000 });
}

test.describe('13단계 — 원격 작업', () => {
  test('R11 (V40 / FR-GIT-98·107): fetch·pull·push 기본 동작이 ahead/behind 를 갱신한다', async ({ page }) => {
    const { repo, remote } = copyPair('r11');
    await waitForInit(page);
    await openGit(page, repo);
    await ready(page);

    // with-remote 는 ahead 1 이다.
    await expect(head(page).locator('.git-head-ab')).toHaveText(/↑1/, { timeout: 20000 });

    // Push — 기본 동작이므로 다이얼로그 없이 바로 돈다 (FR-GIT-99).
    await btn(page, 'push').click();
    await jobEnded(page, '완료');
    expect(git(repo, 'rev-parse', 'main')).toBe(git(remote, 'rev-parse', 'main'));
    // FR-GIT-107: 작업이 끝나면 상태가 갱신된다 — 폴링 주기를 기다리지 않는다.
    await expect(head(page).locator('.git-head-ab')).toHaveText('', { timeout: 20000 });

    // 원격을 앞세우고 Fetch — behind 가 보여야 한다.
    advanceRemote(remote, 'from-remote');
    await btn(page, 'fetch').click();
    await jobArgv(page, 'git fetch --progress');
    await jobEnded(page, '완료');
    await expect(head(page).locator('.git-head-ab')).toHaveText(/↓1/, { timeout: 20000 });

    // Pull — fast-forward 로 따라잡는다.
    await btn(page, 'pull').click();
    await jobArgv(page, 'git pull --progress');
    await jobEnded(page, '완료');
    await expect(head(page).locator('.git-head-ab')).toHaveText('', { timeout: 20000 });
    expect(git(repo, 'rev-parse', 'main')).toBe(git(remote, 'rev-parse', 'main'));
  });

  test('R12 (V40 / FR-GIT-101·102): 진행 중에는 같은 리포의 다른 원격 버튼이 막히고 취소가 보인다', async ({ page }) => {
    const { repo } = copyPair('r12');
    await waitForInit(page);
    await openGit(page, repo);
    await ready(page);

    // 로컬 bare 로의 push 는 즉시 끝난다 — 진행 중 상태를 정직하게 보려면 작업이
    // 끝나지 않아야 하므로 응답만 흉내 내고 출력 스트림을 매달아 둔다.
    await page.route('**/api/git/push', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          requested: repo,
          repo,
          job: { id: 'stub-job', repo, kind: 'push', argv: ['push', '--progress'], done: false },
        }),
      }));
    // 스트림을 열어 두면 작업이 끝나지 않는다.
    await page.route('**/api/git/job/events*', () => {});
    // 상태바 폴링이 "진행 중 없음" 을 주면 화면이 작업을 놓는다 — 진행 중으로 답한다.
    await page.route('**/api/git/jobs', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          jobs: [{ id: 'stub-job', repo, kind: 'push', argv: ['push', '--progress'], done: false }],
        }),
      }));

    await btn(page, 'push').click();

    await expect(job(page)).toHaveClass(/vis/);
    await expect(job(page).locator('.git-job-state')).toHaveText('진행 중…');
    // FR-GIT-101: 같은 리포의 원격 버튼 전부가 막힌다 — push 만이 아니다.
    for (const kind of ['fetch', 'pull', 'push']) {
      await expect(btn(page, kind)).toBeDisabled();
      await expect(more(page, kind)).toBeDisabled();
    }
    // 사유 없이 꺼진 버튼은 사용자가 해소할 수 없다.
    await expect(btn(page, 'fetch')).toHaveAttribute('title', /진행 중/);
    // FR-GIT-102: 취소가 나타난다.
    await expect(job(page).locator('.git-job-cancel')).toBeVisible();

    // 취소는 **부분 적용 가능성을 알린다**.
    await job(page).locator('.git-job-cancel').click();
    await expect(confirm(page)).toHaveAttribute('data-action', 'job_cancel');
    await expect(confirm(page).locator('.gc-hint-note')).toContainText('일부가 적용된 채로');
  });

  test('R13 (V42 / FR-GIT-103): 출력이 줄 단위로 화면에 도착한다', async ({ page }) => {
    const { repo } = copyPair('r13');
    await waitForInit(page);
    await openGit(page, repo);
    await ready(page);

    await btn(page, 'push').click();
    await jobEnded(page, '완료');

    // 끝난 작업의 로그는 접힌다 (FR-GIT-221) — 여기서 보는 것은 "줄 단위로
    // 도착했는가" 이지 "끝난 뒤에도 펼쳐져 있는가" 가 아니다. 펼쳐서 본다.
    await job(page).locator('.git-job-bar').click();
    // git 은 진행 표시를 \r 로 덮어쓴다 — 서버가 그것을 개별 줄로 가르므로
    // 화면에도 여러 줄이 온다.
    await expect(lines(page).first()).toBeVisible();
    expect(await lines(page).count()).toBeGreaterThan(1);
    await expect(log(page)).toContainText('main');
    // seq 는 단조 증가한다 — 재연결이 겹쳐 보낸 줄을 두 번 그리지 않는다.
    const seqs = await lines(page).evaluateAll((els) =>
      els.map((e) => Number((e as HTMLElement).dataset.seq)));
    expect(seqs.length).toBeGreaterThan(1);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
  });

  test('R14 (V41 / FR-GIT-100): upstream 이 없으면 Publish 임을 알리고 실행 후 upstream 이 설정된다', async ({ page }) => {
    const { repo } = copyPair('r14');
    git(repo, 'checkout', '-q', 'no-upstream');
    await waitForInit(page);
    await openGit(page, repo);
    await ready(page);
    await expect(head(page).locator('.git-badge-noupstream')).toBeVisible({ timeout: 20000 });

    await btn(page, 'push').click();

    // 서버가 실행 **전에** 되묻고, 무엇이 설정되는지를 계획으로 보인다.
    await expect(confirm(page)).toHaveAttribute('data-action', 'publish');
    await expect(confirm(page).locator('.gc-target')).toHaveText('origin/no-upstream');
    await confirm(page).locator('.gc-go').click();

    // `-u <remote> <branch>` 로 돌았음이 argv 에 남는다.
    await jobArgv(page, /-u origin no-upstream/);
    await jobEnded(page, '완료');
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'no-upstream@{u}')).toBe('origin/no-upstream');
  });

  test('R15 (V44 / FR-GIT-105·106): 거부되면 force 가 기본 제안이 아니다', async ({ page }) => {
    const { repo, remote } = copyPair('r15');
    // 원격을 앞세우고 우리는 fetch 하지 않은 채 커밋한다 — non-fast-forward 다.
    advanceRemote(remote, 'ahead-of-us');
    writeFileSync(join(repo, 'mine.txt'), 'mine\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'mine');
    await waitForInit(page);
    await openGit(page, repo);
    await ready(page);

    await btn(page, 'push').click();
    await jobEnded(page, '실패');
    // FR-GIT-108: stderr 를 보존해 보인다.
    await expect(job(page).locator('.git-job-tail')).toContainText('rejected');

    // FR-GIT-105: **순서가 곧 우선순위다.** force 는 마지막이다.
    await expect(opts(page)).toHaveCount(3);
    expect(await opts(page).evaluateAll((els) =>
      els.map((e) => (e as HTMLElement).dataset.fix)))
      .toEqual(['fetch_rebase', 'fetch_merge', 'force_with_lease']);
    // 하나도 강조하지 않는다 — 생김새를 달리 주는 것이 곧 force 를 기본 제안하는
    // 것이다. 클래스가 전부 같음으로 그것을 고정한다.
    const classes = await opts(page).evaluateAll((els) => els.map((e) => e.className));
    expect(new Set(classes).size).toBe(1);
    // 기본 제안(첫 선택지)은 force 가 아니다.
    await expect(opts(page).first()).toHaveAttribute('data-fix', 'fetch_rebase');

    // force 는 2단계 확인을 거친다 (FR-GIT-106) — 기본은 --force-with-lease 다.
    await opts(page).nth(2).click();
    await expect(confirm(page)).toHaveAttribute('data-action', 'force_push');
    await expect(confirm(page)).toHaveAttribute('data-stage', '1');
    await confirm(page).locator('.gc-go').click();
    await expect(confirm(page)).toHaveAttribute('data-stage', '2');
    await expect(confirm(page).locator('.gc-hint-note')).toContainText('reflog');
    await confirm(page).locator('.gc-go').click();

    await jobArgv(page, /--force-with-lease/);
    // 자격증명을 받는 자리는 어디에도 없다 (FR-GIT-104).
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
  });

  // ── FR-GIT-221 (V98): 끝난 작업의 로그가 자리를 계속 차지하지 않는다 ──
  //
  // 진행 중에 출력을 보이는 것은 요구사항이다 (FR-GIT-103). 끝난 뒤에도 그런
  // 이유는 없다 — 성공은 접고, 실패는 사유·후속 선택지가 거기 있으므로 남긴다.
  test('R20 (V98 / FR-GIT-221): 성공한 작업은 로그를 접고 바만 남긴다', async ({ page }) => {
    const { repo, remote } = copyPair('r20');
    // 받아올 것이 있어야 로그에 줄이 생긴다 — 빈 로그는 펼쳐도 높이가 0 이라
    // "접혔는지" 를 가리지 못한다.
    advanceRemote(remote, 'for-r20');
    await waitForInit(page);
    await openGit(page, repo);
    await ready(page);

    await btn(page, 'fetch').click();
    await jobEnded(page, '완료');

    // 무엇을 실행했고 어떻게 끝났는지는 남는다.
    await expect(job(page)).toHaveClass(/vis/);
    await expect(job(page).locator('.git-job-argv')).toBeVisible();
    // 로그는 접힌다.
    await expect(lines(page).first()).toHaveCount(1); // 받아온 줄이 있다
    await expect(log(page)).toBeHidden();

    // 사라지는 것이 아니라 접히는 것이다 — 바를 누르면 다시 펼쳐진다.
    await job(page).locator('.git-job-bar').click();
    await expect(log(page)).toBeVisible();
    await job(page).locator('.git-job-bar').click();
    await expect(log(page)).toBeHidden();
  });

  test('R21 (V98 / FR-GIT-221): 실패한 작업은 접지 않는다', async ({ page }) => {
    const { repo, remote } = copyPair('r21');
    advanceRemote(remote, 'ahead-of-us');
    writeFileSync(join(repo, 'mine.txt'), 'mine\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'mine');
    await waitForInit(page);
    await openGit(page, repo);
    await ready(page);

    await btn(page, 'push').click();
    await jobEnded(page, '실패');
    // 사유와 후속 선택지가 거기 있다 — 그것이 이 화면을 보는 이유다.
    await expect(log(page)).toBeVisible();
    await expect(job(page).locator('.git-job-tail')).toContainText('rejected');
    await expect(opts(page).first()).toBeVisible();
  });

  test('R16 (V63 / FR-GIT-112): 진행 중 작업이 상태바에 보인다', async ({ page }) => {
    const { repo } = copyPair('r16');
    await waitForInit(page);
    await openGit(page, repo);
    await ready(page);

    // 상태바는 /api/git/jobs 를 딛는다 — Git 창의 폴링과 독립이어야 한다.
    await page.route('**/api/git/jobs', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          jobs: [{ id: 'sb-job', repo, kind: 'fetch', argv: ['fetch', '--progress'], done: false }],
        }),
      }));
    await page.route('**/api/git/job/events*', () => {});

    await expect(jobChip(page)).toHaveCount(1, { timeout: 20000 });
    await expect(jobChip(page)).toHaveText('⇅ fetch…');
    await expect(jobChip(page)).toHaveAttribute('title', /fetch/);
  });

  test('R17 (V62 / FR-GIT-109·110): fetch·pull 다이얼로그의 옵션이 argv 에 반영된다', async ({ page }) => {
    const { repo } = copyPair('r17');
    await waitForInit(page);
    await openGit(page, repo);
    await ready(page);

    // Fetch 다이얼로그 — 기본은 안전한 쪽이므로 아무 플래그도 붙지 않는다.
    await more(page, 'fetch').click();
    await expect(dialog(page)).toBeVisible();
    // 자격증명을 받는 입력이 없다 (FR-GIT-104) — 체크박스와 라디오뿐이다.
    await expect(dialog(page).locator('input:not([type="checkbox"]):not([type="radio"])'))
      .toHaveCount(0);
    await dialog(page).locator('.gro-field[data-key="prune"] input').check();
    await dialog(page).locator('.gro-field[data-key="tags"] input[value="no"]').check();
    await dialog(page).locator('.gro-go').click();

    await jobArgv(page, 'git fetch --progress --prune --no-tags');
    await jobEnded(page, '완료');

    // Pull 다이얼로그 — rebase 를 고른다.
    await more(page, 'pull').click();
    await expect(dialog(page)).toBeVisible();
    await dialog(page).locator('.gro-field[data-key="mode"] input[value="rebase"]').check();
    await dialog(page).locator('.gro-go').click();

    await jobArgv(page, 'git pull --progress --rebase');
    await jobEnded(page, '완료');
  });

  test('R18 (V43 / FR-GIT-104): 원격 표면에 자격증명을 받는 자리가 없다', async ({ page, request }) => {
    // 만들지 않는 것이 유일한 보장이다 — 소스에 그 자리가 없음을 고정한다.
    const r = await request.get('/js/git/remote.js');
    expect(r.ok()).toBe(true);
    const src = await r.text();
    expect(src).not.toMatch(/password|passphrase|secret/i);
    expect(src).not.toMatch(/type=["']password/);

    const { repo } = copyPair('r18');
    await waitForInit(page);
    await openGit(page, repo);
    await ready(page);
    for (const kind of ['fetch', 'pull', 'push']) {
      await more(page, kind).click();
      await expect(dialog(page)).toBeVisible();
      await expect(dialog(page).locator('input:not([type="checkbox"]):not([type="radio"])'))
        .toHaveCount(0);
      await dialog(page).locator('.gro-cancel').click();
    }
  });
  test('R19 (V62 / FR-GIT-111): pull 이 충돌로 끝나면 Changes 탭으로 보내고 충돌 그룹을 펼친다', async ({ page }) => {
    // 클론 + 지연 응답 + 두 번의 탭 전환이 겹쳐 기본 상한으로는 빡빡하다.
    test.setTimeout(60000);
    const { repo, remote } = copyPair('r19');
    conflictRemote(remote);
    await waitForInit(page);
    await openGit(page, repo);
    await ready(page);

    // 빈 충돌 그룹을 접어 둔다 — 펼치는 것이 동작임을 여기서 가른다.
    await group(page, 'conflicts').locator('.git-group-head').click();
    await expect(group(page, 'conflicts')).toHaveClass(/collapsed/);

    // 로컬 pull 은 즉시 끝난다. 작업 식별자가 늦게 도착하게 해 두면 그 사이에
    // 다른 탭으로 옮겨 갈 수 있고, 되돌아오는 것이 동작임을 볼 수 있다.
    await page.route('**/api/git/pull', async (route) => {
      const res = await route.fetch();
      await new Promise((r) => setTimeout(r, 1000));
      await route.fulfill({ response: res });
    });

    // 갈라진 두 갈래는 머지 방식을 정해 줘야 git 이 합치려 든다 — `▾` 에서
    // `--no-ff` 를 고른다 (FR-GIT-110).
    await more(page, 'pull').click();
    await dialog(page).locator('.gro-field[data-key="mode"] input[value="no-ff"]').check();
    await dialog(page).locator('.gro-go').click();
    await page.click('#area .pn-tab[data-git-view="stash"]');
    await expect(page.locator('#area .pn-body .git-view.vis')).toHaveClass(/git-stash/);

    // FR-GIT-111: 충돌이 남았으면 Changes 로 되돌리고 충돌 그룹을 펼친다.
    await expect(page.locator('#area .pn-body .git-view.vis'))
      .toHaveClass(/git-changes/, { timeout: 30000 });
    await expect(group(page, 'conflicts')).not.toHaveClass(/collapsed/);
    await expect(group(page, 'conflicts').locator('.git-file')).not.toHaveCount(0);
    await expect(job(page).locator('.git-job-note')).toContainText('충돌이 남았습니다');
    // 해결 UI 는 제공하지 않는다 — 안내까지다.
    await expect(job(page).locator('.git-job-state')).toHaveText('실패');
  });

});
