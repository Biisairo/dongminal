import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, appendFileSync } from 'fs';
import { join } from 'path';

import { Page } from '@playwright/test';

import {
  test, expect, waitForInit, GIT_VIEW_TABS, openGit, clickGitView, gitFixture, cleanGitFixture, copyDir, rmTree, freshDir, makeCopyFx, nextFrames,
} from './fixtures';
import { TMP, tmpPath, realPath } from './osenv';

// GIT_VIEW_REFRESH_SRS §4 — 쓰기 뒤 뷰 갱신. 검증 V-GVR-1~8.
//
// 원격은 **로컬 bare** 다 (with-remote + remote.git). 네트워크를 쓰지 않으므로
// 테스트가 외부에 의존하지 않는다. 쓰기를 하므로 저장소와 원격을 매 테스트마다
// **복사본**으로 만든다 — 원본을 밀면 다음 테스트가 무너진다.
//
// 형태는 git-remote.spec.ts 를 그대로 본뜬다 — 원격 표면의 e2e 규약이 두 벌이면
// 한쪽만 고쳐진다.

const FIXTURES = tmpPath('dm-git-fx-vrefresh-' + process.pid);

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
  let dst = join(FIXTURES, 'copy-' + tag);
  let bare = join(FIXTURES, 'bare-' + tag + '.git');
  dst = freshDir(dst);
  bare = freshDir(bare);
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
  rmTree(work);
}

const tab = (page: Page, v: string) => page.locator(`#area .pn-tab[data-git-view="${v}"]`);

// 탭을 한 번 열면 그 뷰가 만들어진다 — `if(this._xxxView)` 가드가 통과하는 조건이
// 곧 이것이다 (FR-GVR-4). **다시 여는 것은 다시 받지 않는다** (뷰의 `paint()` 는
// 리포가 바뀔 때만 `_adopt` 한다) — 그래서 원격 작업 뒤에 탭으로 돌아와 읽는 것이
// 갱신을 정직하게 재는 방법이다.
async function openTab(page: Page, v: string) {
  // REPO_TAB_UNIFY_SRS FR-RTU-32: `Changes` 는 본문 탭이 아니라 **창의 사이드**다.
  // 그 자리로 "돌아가는" 것은 사이드를 그쪽으로 돌리는 일이며, `openGit` 이 이미
  // 그렇게 두었으므로 여기서는 보이는지만 확인한다.
  if (v === 'changes') {
    await expect(changes(page)).toBeVisible({ timeout: 10000 });
    return;
  }
  // 나머지는 공용 헬퍼가 한다 (E2E_HELPER_RECLAIM_SRS FR-EHR-1·2).
  //
  // **여기 있던 복제가 한 겹을 놓치고 있었다.** 재렌더를 견디는 재시도는 같았지만,
  // `clickGitView` 가 그 뒤에 배운 것 — **탭이 아예 없으면 먼저 연다** — 이 없었다.
  // 창이 바뀌거나 워크스페이스가 다시 적용되면 그 탭이 통째로 사라질 수 있고,
  // 그때 클릭만 되풀이하면 없는 것을 20초 동안 기다리다 끝난다. G2 가 그 자리를
  // 간헐로 잡았다 (DRIFT_RECLAIM_SRS §7.5).
  await clickGitView(page, v);
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

    /**
     * Changes 만 연다. 나머지 뷰는 **한 번도 만들지 않는다** — 그래서 여섯을
     * 미리 세우는 `openGit` 을 쓰지 않고 창만 연다 (FR-RTU-72). 그 헬퍼를 쓰면
     * 이 시험이 재려는 조건("열지 않은 뷰")이 성립하지 않는다.
     */
    await page.evaluate((r: string) => (window as any).app.openGitWindow(r), repo);
    await page.waitForSelector('#area .ed-win .ed-side', { timeout: 15000 });
    await page.evaluate(() => {
      const a = (window as any).app;
      a.testing.edSetSide(a.testing.aw(), 'changes');
    });
    await expect(changes(page)).toBeVisible({ timeout: 10000 });
    await ready(page);
    await btn(page, 'push').click();
    await jobEnded(page, '완료');
    // **예외 (`TEST-16`): 일어나지 않는 것을 잰다.** 갱신이 늦게 새는 것을
    // 잡으므로 기다릴 신호가 없다 — 끝난 뒤 한 박자 더 보는 것이 검사다.
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
    // FR-GCC-10 / D-7a: 새로고침은 사이드 **탭 줄**의 오른쪽 끝이다 — 머리에서
    // 올라왔고 클래스 이름은 그대로다 (D-8).
    const refreshBtn = page.locator('#area .ed-side .ed-side-tabs .git-head-refresh');
    await expect(refreshBtn, '새로고침 버튼이 없다').toHaveCount(1, { timeout: 20000 });
    await refreshBtn.click();
    await expect(refreshBtn, '새로고침이 끝나지 않았다').toBeEnabled({ timeout: 20000 });

    // 탭을 다시 여는 것은 목록을 다시 받지 않는다 — 보이는 것은 새로고침의 결과다.
    await openTab(page, 'stash');
    await expect(stashRows(page)).toHaveCount(1, { timeout: 20000 });
    await expect(stashRows(page).first().locator('.git-stash-msg')).toContainText('바깥에서');
  });

  /**
   * FR-GVR-7 이 지키는 것은 **"뷰 갱신이 요청을 늘리지 않는다"** 다. 종전에는
   * 그것을 status 폴링 횟수와 함께 쟀는데, 관측이 서버 푸시로 바뀌며 그 횟수는
   * 더 이상 상수가 아니다 (GIT_PUSH_OBSERVE_SRS).
   *
   * 그래서 두 축을 나눈다: **관측은 살아 있다**(안전망을 줄여 짧은 창에서 확인)와
   * **가만히 있으면 뷰 조회가 늘지 않는다**(원래의 계약).
   */
  test('G8 (V-GVR-8 / FR-GVR-7): 관측은 살아 있고 뷰 조회는 늘지 않는다', async ({ page }) => {
    const { repo } = copyPair('g8');
    await waitForInit(page);
    const status = counter(page, (u) => u.includes('/api/git/status'));
    const views = counter(page, isViewRead);

    await openGit(page, repo);
    await ready(page);
    await page.evaluate(() => {
      (window as any).gitStatusInterval = 600;
      const app = (window as any).app;
      if (app.testing.gitPanels) for (const p of app.testing.gitPanels.values()) p._reschedule();
    });
    // **예외 (`TEST-16`)**: 창을 여는 동안의 요청이 가라앉을 여유를 준다 —
    // 아래가 세는 것은 그 뒤의 증가분이다.
    await page.waitForTimeout(500);
    const stBase = status.n;
    const vBase = views.n;
    await page.waitForTimeout(2600);

    // 관측이 멎지도, 폭주하지도 않는다.
    expect(status.n - stBase, '관측이 멎었다').toBeGreaterThanOrEqual(2);
    expect(status.n - stBase, '관측이 폭주한다').toBeLessThanOrEqual(8);
    // 갱신은 계기가 있을 때만 한다 — 아무 일도 없는 동안 뷰 조회가 늘지 않는다.
    expect(views.n - vBase, '가만히 있는데 뷰 조회가 늘었다').toBe(0);
  });

  test('G9 (D-7): Console 탭을 떠나면 기록 폴링이 멈춘다', async ({ page }) => {
    const { repo } = copyPair('g9');
    await waitForInit(page);
    await openGit(page, repo);
    // Console 을 한 번 열어 폴링을 건다. **한 건이 실제로 온 것**이 그 신호다 —
    // 폴링이 걸리지 않았는데 떠나면 아래의 `0` 은 아무것도 말하지 않는다.
    const lit = counter(page, (u) => u.includes('/api/git/records'));
    await openTab(page, 'console');
    await expect.poll(() => lit.n, { timeout: 10000, message: 'Console 폴링이 걸리지 않았다' })
      .toBeGreaterThan(0);

    // 다른 탭으로 떠난다. 본문은 버려지지만 요소의 `vis` 클래스는 남는다 —
    // 그것만 보면 폴링이 계속 돈다.
    //
    // **떠나는 자리는 본문의 다른 뷰여야 한다** (FR-RTU-32): `Changes` 는 이제
    // 사이드에 있어 그리로 가는 것이 본문 탭을 바꾸지 않는다 — Console 은 계속
    // 활성이고, 그때 폴링이 도는 것은 옳다.
    await openTab(page, 'history');
    await expect(page.locator('#area .pn-body .git-view.git-history')).toHaveClass(/vis/, { timeout: 10000 });

    let n = 0;
    const onReq = (r: any) => { if (r.url().includes('/api/git/records')) n++ };
    page.on('request', onReq);
    // **예외 (`TEST-16`)**: 이 창 동안 몇 건인지가 답이다.
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
    await expect(page.locator('#area .pn-body .git-view.git-stash')).toHaveClass(/vis/, { timeout: 10000 });
    /**
     * **예외 (`TEST-16`): 첫 조회가 끝난 것을 말해 주는 신호가 화면에 없다.**
     *
     * 기준은 "조회가 끝난 뒤의 행 수" 여야 한다 — 조회 전에 세면 아래의
     * `before + 1` 이 엉뚱한 수를 가리킨다. 그런데 그 시점을 잡을 방법이 없다:
     * 행 수로는 알 수 없고(이 픽스처에 stash 가 하나도 없으면 조회 뒤에도 `0`
     * 이다), 요청으로도 알 수 없다(`openGit` 이 이미 받아 두므로 탭을 여는
     * 것만으로는 새 요청이 나가지 않는다 — 실측).
     */
    await page.waitForTimeout(800);
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
    await expect(page.locator('#area .pn-body .git-view.git-history')).toHaveClass(/vis/, { timeout: 10000 });
    // 첫 조회가 끝난 뒤부터 센다 — 그 전부터 세면 여는 요청이 결과에 섞인다.
    await expect(page.locator('#area .pn-body .git-view.git-history .git-hist-row').first())
      .toBeVisible({ timeout: 15000 });

    let n = 0;
    const onReq = (r: any) => {
      const u = r.url();
      if (u.includes('/api/git/log') || u.includes('/api/git/refs') || u.includes('/api/git/stash?')) n++;
    };
    page.on('request', onReq);
    // **예외 (`TEST-16`)**: 이 창 동안 몇 건인지가 답이다.
    await page.waitForTimeout(3000); // 폴링 주기의 여러 배
    page.off('request', onReq);
    expect(n, `변화가 없는데 ${n}건을 받았다`).toBe(0);
  });
});

/**
 * 묶음 GLV — **열어 둔 뷰가 변화를 따라온다** (FR-GLV-1·2·4·6).
 *
 * 이 파일의 주제 그대로다 — 열어 둔 diff 가 파일 수정을 따라오고, 칸을 줄여도
 * 남은 패널의 관측이 살며, 거부당한 대상은 되풀이해 받지 않는다.
 *
 * `TEST-7` 로 `ux-batch6` 에서 옮겨 왔다 — 납품 묶음이 아니라 **이 기능**이
 * 주제인 자리다. 단정은 옮기면서 바꾸지 않았다.
 */

const B6FX = tmpPath('dm-b6-git-view-refresh-' + process.pid);
test.beforeAll(() => { gitFixture(B6FX) });
test.afterAll(() => { cleanGitFixture(B6FX) });
const copyFx = makeCopyFx(B6FX);

// ── 묶음 V — 실시간 갱신 ─────────────────────────────

// V-GLV-1 (FR-GLV-1·2): diff 를 연 채 파일을 고치면 화면이 따라온다.
//
// 파일 **내용**의 변화는 관측으로 알 수 없다 — `git status` 는 이미 수정된 파일이
// 또 수정돼도 같은 줄을 낸다. 그래서 열려 있는 diff 는 관측 회차마다 다시 받는다.
test('V-GLV-1 (FR-GLV-1·2): 열어 둔 diff 가 파일 수정을 따라온다', async ({ page }) => {
  const repo = copyFx('basic', 'b6-diff-live');
  await waitForInit(page);
  await openGit(page, repo);
  await page.evaluate(() => {
    const a = (window as any).app;
    a.gitPanel.openView('diff');
  });
  await page.evaluate(() => {
    const row = document.querySelector('#area .ed-side .git-file[data-path="tracked.txt"]') as HTMLElement;
    if (row) row.click();
  });
  await expect(page.locator('#area .pn-body .git-view.git-diff .monaco-diff-editor'))
    .toBeVisible({ timeout: 30000 });

  const seen = async () => page.evaluate(() => {
    const p = (window as any).app.gitPanel;
    const v = p && p._diffView;
    return v && v._mod ? v._mod.getValue() : '';
  });
  await expect.poll(seen, { timeout: 20000 }).toContain('two');

  appendFileSync(join(repo, 'tracked.txt'), 'BATCH6-LIVE\n');
  // 폴링이 나르는 자리다 — 예산은 실패 백오프 상한을 견딘다 (FR-CEM-31).
  await expect.poll(seen, { timeout: 45000 }).toContain('BATCH6-LIVE');
});

// V-GLV-2 (FR-GLV-4): 칸을 늘렸다 줄여도 관측이 계속된다.
//
// `GitPanel.destroy()` 의 `_stop()` 이 **관측자의 공유 타이머**를 껐고, 다시 거는
// 자리가 없었다 — 남은 칸의 Git 창이 눈앞에 있는데도 갱신이 멎었다.
test('V-GLV-2 (FR-GLV-4): 칸을 줄여도 남은 패널의 관측이 산다', async ({ page }) => {
  const repo = copyFx('basic', 'b6-resettle');
  await waitForInit(page);
  await openGit(page, repo);
  const on = () => page.evaluate((r: string) => {
    const a = (window as any).app;
    const p = a.testing.gitPanelAt(r, 0);
    return { pollOn: !!p._pollOn, ok: !!p._pollOk() };
  }, repo);
  expect((await on()).pollOn, '전제가 깨졌다 — 처음부터 관측이 멎어 있다').toBe(true);

  await page.evaluate(() => {
    const a = (window as any).app;
    a.slotAdd();
    a.render();
  });
  await expect(page.locator('#area .slot')).toHaveCount(2, { timeout: 10000 });
  await page.evaluate(() => {
    const a = (window as any).app;
    a.slotRemove();
    a.render();
  });
  // 칸이 하나로 돌아가면 `.slot` 래퍼 자체가 사라진다 — 하나뿐인 칸은 감싸지
  // 않는다 (둘일 때 2개, 하나로 줄면 0개).
  await expect(page.locator('#area .slot')).toHaveCount(0, { timeout: 10000 });
  const got = await on();
  expect(got.ok, '칸을 줄인 뒤 관측 조건이 거짓이 됐다').toBe(true);
  expect(got.pollOn, '남은 패널이 있는데 폴링이 멎었다').toBe(true);

  // 그리고 실제로 따라온다 — 조건뿐 아니라 결과를 잰다.
  writeFileSync(join(repo, 'resettle.txt'), 'x\n');
  await expect(page.locator('#area .ed-side .git-file[data-path="resettle.txt"]'))
    .toHaveCount(1, { timeout: 45000 });
});

//
// FR-GLV-1 을 넣고 실측했을 때 잘못된 대상의 `/api/git/diff-content` 가 **매초
// 400 을 냈다** — 자동 재적재가 실패를 그만큼 되풀이한 것이다.
test('V-GLV-3 (FR-GLV-6): 거부당한 diff 는 폴링이 되풀이하지 않는다', async ({ page }) => {
  const repo = copyFx('basic', 'b6-refused');
  let hits = 0;
  await page.route('**/api/git/diff-content**', (route) => {
    hits++;
    route.fulfill({
      status: 500, contentType: 'application/json',
      body: JSON.stringify({ error: 'internal' }),
    });
  });
  await waitForInit(page);
  await openGit(page, repo);
  await page.evaluate(() => (window as any).app.gitPanel.openView('diff'));
  await page.evaluate(() => {
    const row = document.querySelector('#area .ed-side .git-file[data-path="tracked.txt"]') as HTMLElement;
    if (row) row.click();
  });
  // 거부 응답이 **온 것**이 전제다 — 그것을 보고 나서 되풀이 여부를 잰다.
  await expect.poll(() => hits, { timeout: 15000 }).toBeGreaterThan(0);
  const first = hits;
  expect(first, '거부 응답이 한 번도 오지 않았다 — 전제가 깨졌다').toBeGreaterThan(0);
  // **예외 (`TEST-16`)**: 되풀이해 받지 **않음**을 잰다 — 관측 주기(기본 3초)를
  // 두 바퀴 넘게 기다리는 것이 곧 검사다.
  await page.waitForTimeout(8000);
  expect(hits, `거부당한 대상을 되풀이해 받았다 (${first} → ${hits})`).toBe(first);
});
