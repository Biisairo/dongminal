import { writeFileSync } from 'fs';
import { join } from 'path';

import { APIRequestContext, Page } from '@playwright/test';

import { test, expect, makeCopyFx, openGit, waitForInit, gitFixture, cleanGitFixture, setSafetyNet, scopedSettings, nextFrames } from './fixtures';
import { tmpPath, realPath } from './osenv';

/**
 * **고정 대기의 예외 (`TEST-16`).** 남은 `waitForTimeout` 은 전부 **그 창(窓)
 * 동안 요청이 몇 건인가**를 잰다 — 재려는 것이 "일어나지 않음" 이므로 기다릴
 * 신호가 없다. 창은 그 안에 회차가 실제로 들도록 안전망을 줄인 주기에 맞췄다
 * (E2E_PRUNE_REPORT §8.6). 가라앉기를 기다리던 대기는 요청이 끝났음을 보는
 * 대기(`quiet`)로 바꿨다.
 */

// GIT_M1_STEP56_CONTRACT §4 — 변경 감지. 검증 V6·V18·V5·V4.
//
// **GIT_PUSH_OBSERVE_SRS 로 감지의 주체가 바뀌었다.** 종전에는 브라우저가
// signature(500ms)와 status(1s)를 물어 변화를 스스로 찾았다. 이제 서버가 관측해
// 바뀌었을 때만 `git_changed` 를 방송하고, 브라우저의 status 폴링은 **안전망**
// (30초)으로 남는다.
//
// 그래서 아래 검사들은 **"폴링이 도는가" 대신 "변화가 화면에 따라오는가"** 를
// 잰다 — 그것이 애초에 재려던 계약이고, 폴링은 그 계약을 재던 수단이었다.
// 관측의 **경계**(누가 언제 관측하는가)를 재는 검사는 그대로 남는다: 그것은
// 수단이 아니라 계약이며(NFR-RTU-1), 안전망 폴링에도 같은 경계가 적용된다.

// 안전망 주기를 검사용으로 줄인다. 재는 것은 "폴링이 경계를 지키는가" 이지
// 30초라는 값이 아니다 — 값을 재면 상수를 바꿀 때 검사가 깨진다.
const FAST_SAFETY_MS = 300;
const fastSafetyNet = (page: Page) => setSafetyNet(page, FAST_SAFETY_MS);

const FIXTURES = tmpPath('otter-git-fx-polling-' + process.pid);

test.beforeAll(() => {
  gitFixture(FIXTURES);
});
test.afterAll(() => {
  cleanGitFixture(FIXTURES);
});

const fx = (name: string) => realPath(join(FIXTURES, name));

const copyFx = makeCopyFx(FIXTURES);
// 설정은 서버의 단일 블롭이다 — 읽어 합친 뒤 되돌려 준다. 다른 스펙의 테마·단축키를
// 지우지 않는다.
// 요청 수는 가로채기로 센다 — 클라이언트 내부 카운터를 믿으면 "요청을 실제로
// 보내지 않았다"를 증명할 수 없다. `done` 은 끝난(응답·실패) 요청 수다.
function counter(page: Page, needle: string) {
  const state = { n: 0, done: 0 };
  page.on('request', (r) => { if (r.url().includes(needle)) state.n++ });
  const end = (r: any) => { if (r.url().includes(needle)) state.done++ };
  page.on('requestfinished', end);
  page.on('requestfailed', end);
  return state;
}

// 나간 요청이 하나 이상이고 전부 끝났다 — 고정 시간 대신 이것을 보고 기준을 잡는다.
const quiet = (c: { n: number; done: number }) =>
  expect.poll(() => c.n >= 1 && c.done >= c.n, { timeout: 5000 }).toBe(true);

// 새 파일은 서버의 워크트리 회차가 잡는다 — 기본 4초를 하한 1초로 줄인다 (§8.2 (b)).
// 바꾼 시험은 `restoreSettings` 에 복원 함수를 남기고 afterEach 가 되돌린다.
let restoreSettings: (() => Promise<void>) | null = null;
const fastWorktree = async (request: APIRequestContext) => {
  restoreSettings = await scopedSettings(request, { gitWorktreeInterval: 1000 });
};
test.afterEach(async () => {
  if (restoreSettings) await restoreSettings();
  restoreSettings = null;
});

const switchToWindow = (page: Page, id: string) =>
  page.evaluate((i) => (window as any).app.layout.switchWindow(i), id);

/**
 * **개정 (REPO_TAB_UNIFY_SRS FR-RTU-70).** 옛 `WINDOW_TYPE_GIT` 창은 로드에
 * 사라지므로 `app.testing.gitWindow()` 는 `null` 이다. git 표면을 든 창은 **그 저장소의
 * Repo 창**이며 `edWindowFor(repo)` 가 그것을 준다.
 */
const repoWindowId = (page: Page, repo: string) => page.evaluate((r) => {
  const w = (window as any).app.testing.edWindowFor(r);
  return w ? w.id : null;
}, repo);

const otherWindowId = (page: Page, repo: string) => page.evaluate((r) => {
  const app = (window as any).app;
  const w = app.testing.edWindowFor(r);
  const gid = w ? w.id : null;
  // 그 Repo 창이 아닌 아무 창. 다른 Repo 창이어도 된다 — 재는 것은 "떠난 창의
  // 패널이 폴링을 멈추는가" 이므로 목적지의 종류는 상관없다.
  return (app.ws.windows.find((x: any) => x && x.id !== gid) || {}).id || null;
}, repo);

test.describe('묶음 C 클라 — 변경 감지', () => {
  // V6 이 재려던 것은 "활성 창의 저장소가 계속 관측된다" 이고, 종전에는 그것을
  // 폴링 횟수로 셌다. 이제 관측은 서버가 밀어 주므로 **화면이 따라오는가**로 잰다 —
  // 폴링이 도는지가 아니라, 이 창이 살아 있는 관측을 갖는지가 계약이다.
  test('P1 (V6): Git 창이 활성이면 변화가 화면에 따라온다', async ({ page, request }) => {
    await fastWorktree(request);
    const repo = copyFx('basic', 'p1');
    await waitForInit(page);
    const c = counter(page, '/api/git/status');
    await openGit(page, repo);

    // 창을 열면 곧 첫 관측이 온다 — 그 하나는 여전히 브라우저가 받아 간다.
    await expect.poll(() => c.n, { timeout: 5000 }).toBeGreaterThanOrEqual(1);

    const rows = page.locator(
      '#area .ed-side .git-view.git-changes .git-group[data-group="working"] .git-file');
    const before = await rows.count();
    writeFileSync(join(repo, 'p1-new.txt'), 'x\n');

    // 안전망(30초)보다 훨씬 짧은 창에서 따라와야 한다 — 그보다 오래 걸리면
    // 관측을 살린 것은 푸시가 아니라 폴링이다.
    await expect.poll(() => rows.count(), { timeout: 8000 }).toBeGreaterThan(before);
  });

  // PERF_OPTIMIZATION_SRS M1 C4: 주기 status 는 없다. 보는 동안은 채널의 `git:<root>` 토픽을 구독하고,
  // 떠나면 그 구독을 놓는다 — 그 뒤로는 서버가 변화를 밀어도 status 요청이 나가지 않는다.
  test('P2 (V6): 다른 창으로 전환하면 git 토픽을 놓고 status 요청이 0건이 된다', async ({ page, request }) => {
    const repo = copyFx('basic', 'p2-leave');
    await waitForInit(page);
    const c = counter(page, '/api/git/status');
    await openGit(page, repo);
    await expect.poll(() => c.n, { timeout: 5000 }).toBeGreaterThanOrEqual(1);
    const watching = () => page.evaluate(() => [...(window as any).app.git.topics._m.keys()].length);
    await expect.poll(watching, { timeout: 5000 }).toBeGreaterThanOrEqual(1);

    const other = await otherWindowId(page, repo);
    expect(other, '비교할 다른 창이 없다').toBeTruthy();
    await switchToWindow(page, other!);
    await expect.poll(watching, { timeout: 5000 }).toBe(0);

    await quiet(c);
    const base = c.n;
    writeFileSync(join(repo, 'p2-after-leave.txt'), 'x');
    await page.waitForTimeout(3000);
    expect(c.n - base, '창을 떠난 뒤에도 status 를 묻는다').toBe(0);
  });

  test('P3 (V6): Git 창으로 돌아오면 즉시 1건이 온다', async ({ page, request }) => {
    const repo = fx('basic');
    await waitForInit(page);
    const c = counter(page, '/api/git/status');
    await openGit(page, repo);
    await expect.poll(() => c.n, { timeout: 5000 }).toBeGreaterThanOrEqual(1);

    const gid = await repoWindowId(page, repo);
    const other = await otherWindowId(page, repo);
    await switchToWindow(page, other!);
    await quiet(c);
    const base = c.n;

    await switchToWindow(page, gid!);
    // 주기(1000ms)보다 이르게 와야 "즉시 1회 수집"이다.
    await expect.poll(() => c.n - base, { timeout: 800 }).toBeGreaterThanOrEqual(1);
  });

  test('P4 (V18): 평상시에는 status 폴링이 돌지 않는다', async ({ page }) => {
    const repo = fx('basic');
    await waitForInit(page);
    const st = counter(page, '/api/git/status');
    // FR-PIS-1: signature 계층은 사라졌다.
    const sig = counter(page, '/api/git/signature');
    await openGit(page, repo);

    // 여는 순간의 첫 수집이 끝난 뒤부터 센다.
    await quiet(st);
    const base = st.n;
    // 평상시 주기는 없다(PERF 1.15 — 실패 재시도만 남았다). 되풀이가 생기는 회귀는 1초 안에 드러난다.
    await page.waitForTimeout(1000);
    expect(st.n - base, '평상시인데 status 폴링이 돈다').toBe(0);
    expect(sig.n, '지워진 signature 폴링이 되살아났다').toBe(0);
  });

  test('P5 (V5): 같은 순간의 신호 여러 개가 status 1건으로 합쳐진다', async ({ page, request }) => {
    // 평상시에는 주기가 없다 — 즉시 신호만 남으므로 디바운스만 측정한다.
    const repo = fx('basic');
    await waitForInit(page);
    const c = counter(page, '/api/git/status');
    await openGit(page, repo);
    await quiet(c);
    const base = c.n;

    await page.evaluate(() => {
      const app = (window as any).app;
      for (let i = 0; i < 6; i++) app.testing.gitSignal('test');
    });
    await expect.poll(() => c.n - base, { timeout: 3000 }).toBe(1);
    // 남은 신호는 첫 요청이 끝난 뒤에 다시 나간다 — 그 끝을 보고 디바운스(150ms)의
    // 두 배 남짓을 더 본다.
    await quiet(c);
    await page.waitForTimeout(300);
    expect(c.n - base, '디바운스 뒤에도 신호가 남아 다시 요청했다').toBe(1);
  });

  test('P6 (V4): 활성 리포를 바꾸면 이전 리포의 응답이 화면에 닿지 않는다', async ({ page, request }) => {
    const slow = copyFx('basic', 'p6-slow');
    const fast = copyFx('basic', 'p6-fast');
    writeFileSync(join(slow, 'only-in-slow.txt'), 'x');
    writeFileSync(join(fast, 'only-in-fast.txt'), 'x');

    await waitForInit(page);
    const slowReq = { n: 0, done: 0 };
    page.on('requestfinished', (r) => {
      if (r.url().includes('/api/git/status') && decodeURIComponent(r.url()).includes(slow)) slowReq.done++;
    });
    // slow 리포의 응답만 늦춘다 — 응답이 뒤바뀌어 도착하는 상황을 만든다.
    await page.route('**/api/git/status*', async (route) => {
      if (decodeURIComponent(route.request().url()).includes(slow)) {
        slowReq.n++;
        await new Promise((r) => setTimeout(r, 2000));
      }
      await route.continue();
    });

    await openGit(page, slow);
    // **리포 전환은 창 전환이다** (FR-RTU-72). `gitPanel.setRepo` 는 Repo 창의
    // 패널에서 조기 반환하므로 그 자리에 두면 아무 일도 하지 않는다.
    await openGit(page, fast);

    const view = page.locator('#area .ed-side .git-view.git-changes');
    await expect(view.locator('.git-file[data-path="only-in-fast.txt"]')).toBeVisible({ timeout: 15000 });

    // slow 의 응답이 전부 도착하고 한 프레임이 지난 뒤에도 화면은 fast 다.
    await expect.poll(() => slowReq.n >= 1 && slowReq.done >= slowReq.n, { timeout: 10000 }).toBe(true);
    await nextFrames(page);
    await expect(view.locator('.git-file[data-path="only-in-slow.txt"]')).toHaveCount(0);
    await expect(view.locator('.git-head-repo')).toHaveAttribute('title', fast);
  });

  /**
   * 회귀 (D-POLL-1): signature 계층이 status 폴링과 **공존한 채로 계속 돈다.**
   *
   * `_pollSignature` 가 단일 비행 플래그를 status 의 일련번호(`_seq`)로 되돌리던
   * 동안, `collect()` 가 관측마다 그 값을 올려 signature 응답은 늘 "내 것이 아니다"
   * 로 판정됐다. 플래그가 참으로 굳어 감지 계층이 첫 1초에 죽었다.
   *
   * 두 주기가 겹치는 순간(1000ms)마다 재현되므로, 첫 회차만 세면 통과해 버린다 —
   * **기준 구간을 지난 뒤의 증가분**을 본다.
   */
  /**
   * P7 (회귀): **관측이 겹쳐도 고착되지 않는다.**
   *
   * 원래 이 검사는 signature 폴링(500ms)과 status 폴링(1s)이 겹칠 때 단일 비행
   * 플래그(`_busy`)가 참으로 남아 signature 가 멎는 것을 잡았다. signature 계층은
   * GIT_PUSH_OBSERVE_SRS 로 사라졌지만 **재던 계약은 그대로다** — 겹친 수집이
   * 잠금을 남기면 그 뒤 모든 수집이 조용히 되돌아간다.
   *
   * 겹침을 만드는 자리가 바뀌었다: 이제 푸시와 안전망 폴링이 겹친다. 안전망을
   * 짧게 줄여 그 겹침을 촘촘히 만든 뒤, 잠금이 풀린 채로 남는지 본다.
   */
  test('P7 (회귀): 관측이 겹쳐도 단일 비행 잠금이 고착되지 않는다', async ({ page, request }) => {
    await fastWorktree(request);
    const repo = copyFx('basic', 'p7');
    await waitForInit(page);
    await openGit(page, repo);
    await fastSafetyNet(page);

    // 폴링과 푸시가 여러 번 겹칠 만큼 파일을 연달아 만든다. 간격은 안전망 한 주기다.
    for (let i = 0; i < 4; i++) {
      writeFileSync(join(repo, `p7-${i}.txt`), 'x\n');
      await page.waitForTimeout(FAST_SAFETY_MS);
    }

    // 짧은 주기에서는 비행 중인 수집이 늘 있다 — 한 순간의 `_busy` 는 고착이 아니다.
    // 고착은 **풀리지 않는** 것이므로 풀리기를 기다린다.
    await expect.poll(() => page.evaluate(() => {
      const app = (window as any).app;
      for (const o of app.testing.gitObservers.values()) {
        const p = o.any();
        if (p && o._busy) return true;
      }
      return false;
    }), { timeout: 5000, message: '겹친 수집이 단일 비행 잠금을 남겼다 — 그 뒤 수집이 전부 멎는다' })
      .toBe(false);

    // 잠금이 살아 있으면 다음 변화가 화면에 오지 않는다 — 값으로 확인한다.
    const rows = page.locator(
      '#area .ed-side .git-view.git-changes .git-group[data-group="working"] .git-file');
    const before = await rows.count();
    writeFileSync(join(repo, 'p7-last.txt'), 'x\n');
    await expect.poll(() => rows.count(), { timeout: 8000 }).toBeGreaterThan(before);
  });

  /**
   * 회귀 (D-POLL-2): 뷰의 `reload()` 가 동기 throw 해도 새로고침이 잠기지 않는다.
   *
   * `refresh()` 는 `_refreshing` 을 세운 뒤 jobs 배열을 만들면서 **async 가 아닌**
   * `reload()` 들을 부른다. 그 자리의 throw 는 `Promise.allSettled` 앞이라 아무것도
   * 삼켜 주지 못했고, 플래그가 참으로 남아 버튼이 disabled 로 굳었다.
   */
  test('P8 (회귀): 뷰의 reload() 가 터져도 새로고침 진입점이 잠기지 않는다', async ({ page, request }) => {
    const repo = fx('basic');
    await waitForInit(page);
    await openGit(page, repo);

    // 탭을 한 번도 열지 않으면 뷰가 없어 refresh 의 대상이 아니다 — 사용자가
    // History 를 둘러본 상태를 만든 뒤 그 reload 만 터지게 한다.
    await page.evaluate(() => {
      const p = (window as any).app.gitPanel;
      p.views._history().reload = () => { throw new Error('reload boom') };
    });

    // UX_AUDIT_FIX_SRS FR-UXF-27 로 개정: 이전 사이드 단추를 눌러 disabled 가 풀리는지 봤다 / 지금 갱신 함수를 부르고
    // `_refreshing` 이 풀리는지 본다 / 이유 단추가 없다. 진입점(`refresh()`)은 남아 패널 열기·창 전환이 부른다.
    await page.evaluate(() => (window as any).app.gitPanel.viewReload.refresh());

    expect(await page.evaluate(() => (window as any).app.gitPanel._refreshing),
      '_refreshing 이 참으로 남았다').toBe(false);

    // 잠기지 않았음의 증명은 "두 번째 누름이 실제로 요청을 낸다" 다.
    const st = counter(page, '/api/git/status');
    await page.evaluate(() => (window as any).app.gitPanel.viewReload.refresh());
    await expect.poll(() => st.n, { timeout: 3000 }).toBeGreaterThanOrEqual(1);
  });

  /**
   * 회귀 (D-POLL-3): `_paint()` 가 터진 회차는 다시 그리기 근거를 남기지 않는다.
   *
   * `_obsSig` 를 `_paint()` **전에** 기록하던 동안, 한 번의 throw 로 그 관측이
   * "이미 그렸다" 로 남았다. 같은 값이 계속 와도 가드가 걸러 화면이 낡은 채로
   * 굳었고, 사유는 어디에도 보이지 않았다.
   */
  test('P9 (회귀): _paint 가 한 번 터져도 다음 관측이 다시 그린다', async ({ page, request }) => {
    await fastWorktree(request);
    const repo = copyFx('basic', 'p9-paint');
    await waitForInit(page);
    await openGit(page, repo);
    // **다음 관측**이 필요한 검사다. 주기 status 는 없으므로(PERF_OPTIMIZATION_SRS M1 C4) 다음
    // 관측은 다음 변화가 부른다 — 예외 뒤에 변화를 하나 더 만든다. 재는 것은 "한 번 터진 그리기가
    // 뒤의 관측을 잠그지 않는가" 다.

    const view = page.locator('#area .ed-side .git-view.git-changes');
    // 첫 관측이 그려진 뒤부터 시작한다 — 그래야 뒤이은 변경이 "새 관측" 이다.
    await expect(view.locator('.git-head-repo')).toHaveAttribute('title', repo);

    // **새 파일을 담은 관측의 첫 그리기만** 터지게 한다. 아무 _paint 나 터뜨리면
    // 다른 계기(탭 전환·신호)가 그 한 번을 소모해 결함이 있어도 통과한다.
    await page.evaluate((needle) => {
      const p = (window as any).app.gitPanel;
      const orig = p.changes._paint.bind(p.changes);
      let left = 1;
      p.changes._paint = function () {
        const st = p._status && p._status.status;
        if (left > 0 && st && JSON.stringify(st).includes(needle)) {
          left--;
          throw new Error('paint boom');
        }
        return orig();
      };
    }, 'after-paint-throw.txt');

    writeFileSync(join(repo, 'after-paint-throw.txt'), 'x');
    await expect.poll(() => page.evaluate(() => JSON.stringify((window as any).app.gitPanel._status || {})
      .includes('after-paint-throw.txt')), { timeout: 10000 }).toBe(true);
    writeFileSync(join(repo, 'after-paint-throw-2.txt'), 'x');

    await expect(view.locator('.git-file[data-path="after-paint-throw.txt"]'),
      '_paint 가 한 번 터진 뒤 화면이 낡은 채로 굳었다')
      .toBeVisible({ timeout: 10000 });
  });
});
