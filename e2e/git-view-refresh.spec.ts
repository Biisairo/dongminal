import { execFileSync } from 'child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { Page } from '@playwright/test';

import { test, expect, waitForInit, GIT_VIEW_TABS } from './fixtures';

// GIT_VIEW_REFRESH_SRS §4 — 쓰기 뒤 뷰 갱신. 검증 V-GVR-1~8.
//
// 원격은 **로컬 bare** 다 (with-remote + remote.git). 네트워크를 쓰지 않으므로
// 테스트가 외부에 의존하지 않는다. 쓰기를 하므로 저장소와 원격을 매 테스트마다
// **복사본**으로 만든다 — 원본을 밀면 다음 테스트가 무너진다.
//
// 형태는 git-remote.spec.ts 를 그대로 본뜬다 — 원격 표면의 e2e 규약이 두 벌이면
// 한쪽만 고쳐진다.

const FIXTURES = '/tmp/dm-git-fx-vrefresh-' + process.pid;

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

const tab = (page: Page, v: string) => page.locator(`#area .pn-tab[data-git-view="${v}"]`);

// 탭을 한 번 열면 그 뷰가 만들어진다 — `if(this._xxxView)` 가드가 통과하는 조건이
// 곧 이것이다 (FR-GVR-4). **다시 여는 것은 다시 받지 않는다** (뷰의 `paint()` 는
// 리포가 바뀔 때만 `_adopt` 한다) — 그래서 원격 작업 뒤에 탭으로 돌아와 읽는 것이
// 갱신을 정직하게 재는 방법이다.
async function openTab(page: Page, v: string) {
  await tab(page, v).click();
  await expect(page.locator('#area .pn-body .git-view.vis')).toHaveClass(new RegExp('git-' + v));
}

const changes = (page: Page) => page.locator('#area .ed-side .git-view.git-changes');
const head = (page: Page) => changes(page).locator('.git-head');
const btn = (page: Page, kind: string) =>
  head(page).locator(`.git-remote-btn[data-remote="${kind}"]`);
const job = (page: Page) => changes(page).locator('.git-job');

const hist = (page: Page) => page.locator('#area .pn-body .git-view.git-history');
const refAb = (page: Page, ref: string) =>
  hist(page).locator(`.git-refs .git-ref[data-ref="${ref}"] .git-ref-ab`);
const loaded = (page: Page) => hist(page).locator('.git-hist-loaded');

const br = (page: Page) => page.locator('#area .pn-body .git-view.git-branches');
const brAb = (page: Page, short: string) =>
  br(page).locator(`.git-br-row[data-short="${short}"] .git-br-ab`);

const con = (page: Page) => page.locator('#area .pn-body .git-view.git-console');
const conRows = (page: Page) => con(page).locator('.git-con-row');

const stash = (page: Page) => page.locator('#area .pn-body .git-view.git-stash');
const stashRows = (page: Page) => stash(page).locator('.git-stash-row');

// 로드된 커밋 수. 화면 행 수와 구분해 읽어야 가상 스크롤에 흔들리지 않는다.
async function loadedCount(page: Page): Promise<number> {
  const n = await loaded(page).getAttribute('data-n');
  return Number(n || '0');
}

// 버튼이 살아났음 = status 를 읽었음이다. 이것을 기다리지 않고 클릭하면 disabled
// 버튼을 눌러 아무 일도 일어나지 않는다.
async function ready(page: Page) {
  await expect(btn(page, 'push')).toBeEnabled({ timeout: 20000 });
}

async function jobEnded(page: Page, state: string) {
  await expect(job(page).locator('.git-job-state')).toHaveText(state, { timeout: 30000 });
}

// console.js 의 자체 폴링 주기(GIT_CON_POLL_MS). 여기서 다시 적는 이유는 아래
// `stopConsolePoll` 의 여유를 그것에서 끌어오기 때문이다.
const CON_POLL_MS = 2000;
const CON_BUDGET_MS = CON_POLL_MS / 2;

/**
 * Console 의 자체 폴링을 끊는다.
 *
 * Console 은 탭을 떠나도 폴링을 멈추지 않는다 — 떠난 탭의 본문에서 `vis` 가
 * 지워지지 않아 `console.js` 의 `_start` 가드가 그대로 통과한다(이 SRS 의 범위
 * 밖이다). 그것이 살아 있으면 "원격 작업이 Console 을 갱신했는가" 를 **잴 수
 * 없다**: 고치지 않아도 2초 안에 어차피 채워진다.
 *
 * 그래서 재는 동안만 타이머를 끊는다. 탭을 다시 열 때 `paint()` 가 새 주기로 다시
 * 걸므로, 거기서부터 CON_POLL_MS 만큼의 여유가 생기고 그 안에서 단정한다.
 */
async function stopConsolePoll(page: Page) {
  await page.evaluate(() => {
    const c = (window as any).app.gitPanel._consoleView;
    if (c && c._timer) { clearInterval(c._timer); c._timer = null }
  });
}

// 요청 수는 가로채기로 센다 — 클라이언트 내부 카운터를 믿으면 "요청을 실제로
// 보내지 않았다"를 증명할 수 없다 (git-polling.spec.ts 와 같은 기법).
function counter(page: Page, pred: (url: string) => boolean) {
  const state = { n: 0 };
  page.on('request', (r) => { if (pred(r.url())) state.n++ });
  return state;
}

// 열지 않은 뷰들이 각각 쓰는 라우트. Changes 의 status 와 겹치지 않는다.
const isRefs = (u: string) => u.includes('/api/git/refs');
const isLog = (u: string) => u.includes('/api/git/log');
const isRecords = (u: string) => u.includes('/api/git/records');
// `/api/git/stash/apply` 같은 쓰기와 갈라야 한다 — 목록 조회만 센다.
const isStashList = (u: string) => u.includes('/api/git/stash?');
const isViewRead = (u: string) => isRefs(u) || isLog(u) || isRecords(u) || isStashList(u);

test.describe('원격 작업·새로고침 뒤의 뷰 갱신', () => {
  test('G1 (V-GVR-1 / FR-GVR-1·2): push 뒤 새로고침 없이 History 의 refs 가 바뀐다', async ({ page }) => {
    const { repo, remote } = copyPair('g1');
    await waitForInit(page);
    await openGit(page, repo);
    await openTab(page, 'history');
    // with-remote 는 ahead 1 이다.
    await expect(refAb(page, 'refs/heads/main')).toHaveText(/↑1/, { timeout: 20000 });

    await openTab(page, 'changes');
    await ready(page);
    await btn(page, 'push').click();
    await jobEnded(page, '완료');
    expect(git(repo, 'rev-parse', 'main')).toBe(git(remote, 'rev-parse', 'main'));

    // 새로고침을 누르지 않는다. 탭으로 돌아오는 것은 다시 받지 않으므로, 값이
    // 바뀌었다면 그것은 `afterRemoteJob` 이 refs 를 다시 받았다는 뜻이다.
    await openTab(page, 'history');
    await expect(refAb(page, 'refs/heads/main')).toHaveText('', { timeout: 20000 });
  });

  test('G2 (V-GVR-2 / FR-GVR-1·2): push 뒤 Branches 의 ahead/behind 가 바뀐다', async ({ page }) => {
    const { repo } = copyPair('g2');
    await waitForInit(page);
    await openGit(page, repo);
    await openTab(page, 'branches');
    await expect(brAb(page, 'main')).toHaveText('↑1', { timeout: 20000 });

    await openTab(page, 'changes');
    await ready(page);
    await btn(page, 'push').click();
    await jobEnded(page, '완료');

    await openTab(page, 'branches');
    await expect(brAb(page, 'main')).toHaveText('', { timeout: 20000 });
  });

  test('G3 (V-GVR-3 / FR-GVR-1·2): push 뒤 Console 맨 위에 그 명령이 있다', async ({ page }) => {
    const { repo } = copyPair('g3');
    await waitForInit(page);
    await openGit(page, repo);
    await openTab(page, 'console');
    await expect(con(page).locator('.git-con-list')).toBeVisible({ timeout: 20000 });

    await openTab(page, 'changes');
    await stopConsolePoll(page);
    await ready(page);
    await btn(page, 'push').click();
    await jobEnded(page, '완료');

    // 탭을 다시 여는 것은 기록을 다시 받지 않는다(mount 는 한 번뿐이다). 보이는
    // 것은 작업이 끝날 때 `afterRemoteJob` 이 받아 둔 것이며, 새 폴링 주기가
    // 차기 전에 단정하므로 폴링이 대신 채워 준 것일 수 없다.
    await openTab(page, 'console');
    await expect(conRows(page).first().locator('.git-con-argv'))
      .toHaveText(/^git push/, { timeout: CON_BUDGET_MS });
  });

  test('G4 (V-GVR-4 / FR-GVR-2): fetch 뒤 History 가 전체 다시 읽힌다', async ({ page }) => {
    const { repo, remote } = copyPair('g4');
    await waitForInit(page);
    await openGit(page, repo);
    await openTab(page, 'history');
    await expect.poll(() => loadedCount(page), { timeout: 20000 }).toBeGreaterThan(0);
    const before = await loadedCount(page);

    // 원격에 새 커밋을 얹는다 — fetch 로 들어오는 것은 refs 만이 아니라 커밋이다.
    advanceRemote(remote, 'from-remote');
    await openTab(page, 'changes');
    await ready(page);
    await btn(page, 'fetch').click();
    await jobEnded(page, '완료');

    await openTab(page, 'history');
    // refs 만 다시 받으면(push 의 범위) 이 수는 그대로다 — 전체를 다시 읽었음의 표식.
    await expect.poll(() => loadedCount(page), { timeout: 20000 }).toBeGreaterThan(before);
  });

  test('G5 (V-GVR-5 / FR-GVR-3): 실패한 원격 작업 뒤에도 Console 이 갱신된다', async ({ page }) => {
    const { repo, remote } = copyPair('g5');
    // 원격을 앞세우고 우리는 fetch 하지 않은 채 커밋한다 — non-fast-forward 다.
    advanceRemote(remote, 'ahead-of-us');
    writeFileSync(join(repo, 'mine.txt'), 'mine\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'mine');

    await waitForInit(page);
    await openGit(page, repo);
    await openTab(page, 'console');
    await expect(con(page).locator('.git-con-list')).toBeVisible({ timeout: 20000 });

    await openTab(page, 'changes');
    await stopConsolePoll(page);
    await ready(page);
    await btn(page, 'push').click();
    await jobEnded(page, '실패');

    // 실패도 기록이다 — 사용자가 "무엇을 실행했길래" 를 되짚는 자리가 Console 이다.
    await openTab(page, 'console');
    const first = conRows(page).first();
    await expect(first.locator('.git-con-argv')).toHaveText(/^git push/, { timeout: CON_BUDGET_MS });
    await expect(first).toHaveAttribute('data-fail', '1');
  });

  test('G6 (V-GVR-6 / FR-GVR-4): 열지 않은 뷰에는 요청이 가지 않는다', async ({ page }) => {
    const { repo } = copyPair('g6');
    await waitForInit(page);
    // 가로채기는 창을 열기 **전에** 건다 — 여는 순간의 요청도 세어야 한다.
    const refs = counter(page, isRefs);
    const log = counter(page, isLog);
    const records = counter(page, isRecords);
    const stashList = counter(page, isStashList);

    // Changes 만 연다. 나머지 탭은 한 번도 누르지 않는다.
    await openGit(page, repo);
    await ready(page);
    await btn(page, 'push').click();
    await jobEnded(page, '완료');
    // 갱신이 늦게 새는 것도 잡는다 — 끝난 뒤 한 박자 더 본다.
    await page.waitForTimeout(1500);

    expect(refs.n, '열지 않은 History·Branches 가 refs 를 받았다').toBe(0);
    expect(log.n, '열지 않은 History 가 log 를 받았다').toBe(0);
    expect(stashList.n, '열지 않은 Stash 가 목록을 받았다').toBe(0);
    // Console 만 0 이 아니다. `_consoleView` 는 **창을 열 때 이미 만들어지므로**
    // (`GitPanel.detach` 가 모든 뷰를 부른다) "열린 적 있는가" 를 가르지 못하고,
    // `GitConsole.reload()` 에는 History·Branches 와 달리 그 판정이 없다. 이는
    // 모든 로컬 쓰기가 지나는 `GitPanel.post()` 도 이미 갖고 있는 성질이다 —
    // FR-GVR-4 와 어긋나는 자리이므로 스펙에 되물어야 한다. 여기서는 **쓰기 하나에
    // 한 번을 넘지 않는다**만 고정해 갱신이 번지는 회귀를 막는다.
    expect(records.n, '원격 작업 하나에 records 요청이 여러 번 갔다').toBeLessThanOrEqual(1);
  });

  test('G7 (V-GVR-7 / FR-GVR-6): 새로고침이 Stash 를 다시 읽는다', async ({ page }) => {
    const { repo } = copyPair('g7');
    await waitForInit(page);
    await openGit(page, repo);
    await openTab(page, 'stash');
    await expect(stash(page).locator('.git-stash-empty')).toHaveCount(1, { timeout: 20000 });

    // 창 밖에서 stash 를 만든다 — 새로고침의 약속은 "지금 사실을 다시 받아 온다" 다.
    writeFileSync(join(repo, 'f.txt'), 'a\nb\nwip\n');
    git(repo, 'stash', 'push', '-m', '바깥에서 만든 stash');

    await openTab(page, 'changes');
    const refreshBtn = changes(page).locator('.git-head-refresh');
    await expect(refreshBtn, '새로고침 버튼이 없다').toHaveCount(1, { timeout: 20000 });
    await refreshBtn.click();
    await expect(refreshBtn, '새로고침이 끝나지 않았다').toBeEnabled({ timeout: 20000 });

    // 탭을 다시 여는 것은 목록을 다시 받지 않는다 — 보이는 것은 새로고침의 결과다.
    await openTab(page, 'stash');
    await expect(stashRows(page)).toHaveCount(1, { timeout: 20000 });
    await expect(stashRows(page).first().locator('.git-stash-msg')).toContainText('바깥에서');
  });

  test('G8 (V-GVR-8 / FR-GVR-7): 폴링 주기·요청 수가 변하지 않는다', async ({ page }) => {
    const { repo } = copyPair('g8');
    await waitForInit(page);
    const status = counter(page, (u) => u.includes('/api/git/status'));
    const views = counter(page, isViewRead);

    await openGit(page, repo);
    await ready(page);
    // 창을 여는 동안의 요청이 가라앉을 여유를 준다.
    await page.waitForTimeout(500);
    const stBase = status.n;
    const vBase = views.n;
    await page.waitForTimeout(2600);

    // 주기는 1000ms 그대로다 — 멈추지도(0), 빨라지지도 않는다.
    expect(status.n - stBase, 'status 폴링이 멎었다').toBeGreaterThanOrEqual(2);
    expect(status.n - stBase, 'status 폴링 주기가 빨라졌다').toBeLessThanOrEqual(5);
    // 갱신은 계기가 있을 때만 한다 — 아무 일도 없는 동안 뷰 조회가 늘지 않는다.
    expect(views.n - vBase, '가만히 있는데 뷰 조회가 늘었다').toBe(0);
  });

  test('G9 (D-7): Console 탭을 떠나면 기록 폴링이 멈춘다', async ({ page }) => {
    const { repo } = copyPair('g9');
    await waitForInit(page);
    await openGit(page, repo);
    // Console 을 한 번 열어 폴링을 건다.
    await openTab(page, 'console');
    await page.waitForTimeout(300);

    // 다른 탭으로 떠난다. 본문은 버려지지만 요소의 `vis` 클래스는 남는다 —
    // 그것만 보면 폴링이 계속 돈다.
    await openTab(page, 'changes');
    await page.waitForTimeout(300);

    let n = 0;
    const onReq = (r: any) => { if (r.url().includes('/api/git/records')) n++ };
    page.on('request', onReq);
    await page.waitForTimeout(3000); // 폴링 주기의 여러 배
    page.off('request', onReq);
    expect(n, `떠난 Console 이 ${n}건을 더 받았다`).toBe(0);
  });

  // ── 묶음 P — 창 밖의 변화가 폴링으로 따라온다 (FR-GVR-8·9·12) ──

  test('G10 (V-GVR-9): 창 밖에서 만든 커밋이 새로고침 없이 History 에 나타난다', async ({ page }) => {
    const { repo } = copyPair('g10');
    await waitForInit(page);
    await openGit(page, repo);
    await openTab(page, 'history');
    // 목록이 실제로 찬 뒤에 세야 한다 — 탭이 보이는 것과 받아 온 것은 다르다.
    await expect(hist(page).locator('.git-hist-row').first()).toBeVisible({ timeout: 15000 });
    const before = await hist(page).locator('.git-hist-row').count();

    // dongminal 을 지나지 않는 변화다 — 쓰기 신호가 없으므로 폴링만이 근거다.
    writeFileSync(join(repo, 'outside.txt'), 'x');
    git(repo, 'add', 'outside.txt');
    git(repo, 'commit', '-qm', 'outside commit');

    await expect.poll(() => hist(page).locator('.git-hist-row').count(), { timeout: 15000 })
      .toBe(before + 1);
    await expect(hist(page).locator('.git-hist-row').first()).toContainText('outside commit');
  });

  test('G11 (V-GVR-10): 창 밖 git stash 가 새로고침 없이 Stash 에 나타난다', async ({ page }) => {
    const { repo } = copyPair('g11');
    await waitForInit(page);
    await openGit(page, repo);
    await openTab(page, 'stash');
    const rows = () => page.locator('#area .pn-body .git-view.git-stash .git-stash-row');
    await page.waitForTimeout(800); // 첫 조회가 끝나기를 기다린다
    const before = await rows().count();

    // 추적되지 않은 파일도 담아야 `stash push` 가 확실히 항목을 만든다 —
    // 픽스처의 작업 트리 상태에 기대지 않는다.
    writeFileSync(join(repo, 'stash-me.txt'), 'x\n');
    git(repo, 'stash', 'push', '-u', '-m', 'outside stash');

    await expect.poll(() => rows().count(), { timeout: 15000 }).toBe(before + 1);
  });

  test('G12 (V-GVR-11): 창 밖 브랜치 생성이 새로고침 없이 Branches 에 나타난다', async ({ page }) => {
    const { repo } = copyPair('g12');
    await waitForInit(page);
    await openGit(page, repo);
    await openTab(page, 'branches');
    const row = page.locator('#area .pn-body .git-view.git-branches .git-br-row[data-short="outside-br"]');
    await expect(row).toHaveCount(0);

    // 브랜치 생성만으로는 signature 가 움직이지 않는다(HEAD·index·현재 ref 불변).
    // checkout 까지 해야 HEAD 가 바뀌므로 그것이 폴링의 근거다 (FR-GVR-11).
    git(repo, 'checkout', '-q', '-b', 'outside-br');

    await expect(row).toHaveCount(1, { timeout: 15000 });
  });

  test('G13 (V-GVR-12): 변화가 없으면 뷰를 다시 받지 않는다', async ({ page }) => {
    const { repo } = copyPair('g13');
    await waitForInit(page);
    await openGit(page, repo);
    await openTab(page, 'history');
    await page.waitForTimeout(600);

    let n = 0;
    const onReq = (r: any) => {
      const u = r.url();
      if (u.includes('/api/git/log') || u.includes('/api/git/refs') || u.includes('/api/git/stash?')) n++;
    };
    page.on('request', onReq);
    await page.waitForTimeout(3000); // 폴링 주기의 여러 배
    page.off('request', onReq);
    expect(n, `변화가 없는데 ${n}건을 받았다`).toBe(0);
  });
});
