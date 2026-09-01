import { execFileSync } from 'child_process';
import { realpathSync, writeFileSync } from 'fs';
import { join } from 'path';

import { APIRequestContext, Page } from '@playwright/test';

import { test, expect, makeCopyFx, openGit, waitForInit } from './fixtures';

// GIT_M1_STEP56_CONTRACT §4 — 변경 감지 3계층. 검증 V6·V18·V5·V4.

const FIXTURES = '/tmp/dm-git-fx-polling-' + process.pid;

test.beforeAll(() => {
  execFileSync('bash', ['e2e/git_fixture.sh', FIXTURES], { stdio: 'ignore' });
});
test.afterAll(() => {
  execFileSync('bash', ['e2e/git_fixture.sh', '--clean', FIXTURES], { stdio: 'ignore' });
});

const fx = (name: string) => realpathSync(join(FIXTURES, name));

const copyFx = makeCopyFx(FIXTURES);
// 설정은 서버의 단일 블롭이다 — 읽어 합친 뒤 되돌려 준다. 다른 스펙의 테마·단축키를
// 지우지 않는다.
async function patchSettings(request: APIRequestContext, patch: Record<string, unknown>) {
  const cur = await (await request.get('/api/settings')).json();
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete cur[k];
    else cur[k] = v;
  }
  const r = await request.put('/api/settings', { data: cur });
  expect(r.ok(), `설정 저장 실패: ${await r.text()}`).toBeTruthy();
}

const defaultIntervals = (request: APIRequestContext) =>
  patchSettings(request, { gitStatusInterval: undefined, gitSignatureInterval: undefined });

// 요청 수는 가로채기로 센다 — 클라이언트 내부 카운터를 믿으면 "요청을 실제로
// 보내지 않았다"를 증명할 수 없다.
function counter(page: Page, needle: string) {
  const state = { n: 0 };
  page.on('request', (r) => { if (r.url().includes(needle)) state.n++ });
  return state;
}

const switchToWindow = (page: Page, id: string) =>
  page.evaluate((i) => (window as any).app.switchWindow(i), id);

const otherWindowId = (page: Page) => page.evaluate(() => {
  const app = (window as any).app;
  const g = app._gitWindow().id;
  return (app.ws.windows.find((w: any) => w.id !== g) || {}).id || null;
});

const gitWindowId = (page: Page) => page.evaluate(() => (window as any).app._gitWindow().id);

test.describe('묶음 C 클라 — 변경 감지', () => {
  test('P1 (V6): Git 창이 활성일 때 status 폴링이 돈다', async ({ page, request }) => {
    await defaultIntervals(request);
    const repo = fx('basic');
    await waitForInit(page);
    const c = counter(page, '/api/git/status');
    await openGit(page, repo);

    await expect.poll(() => c.n, { timeout: 5000 }).toBeGreaterThanOrEqual(1);
    const first = c.n;
    await page.waitForTimeout(2200);
    expect(c.n, 'status 폴링이 이어지지 않는다').toBeGreaterThan(first);
  });

  test('P2 (V6): 다른 창으로 전환하면 status 요청이 0건이 된다', async ({ page, request }) => {
    await defaultIntervals(request);
    const repo = fx('basic');
    await waitForInit(page);
    const c = counter(page, '/api/git/status');
    await openGit(page, repo);
    await expect.poll(() => c.n, { timeout: 5000 }).toBeGreaterThanOrEqual(1);

    const other = await otherWindowId(page);
    expect(other, '비교할 다른 창이 없다').toBeTruthy();
    await switchToWindow(page, other!);

    // 떠나는 순간 진행 중이던 요청이 하나 남을 수 있다 — 가라앉을 여유를 준다.
    await page.waitForTimeout(400);
    const base = c.n;
    await page.waitForTimeout(2600);
    expect(c.n - base, '창을 떠난 뒤에도 폴링이 돈다 (타이머가 살아 있다)').toBe(0);
  });

  test('P3 (V6): Git 창으로 돌아오면 즉시 1건이 온다', async ({ page, request }) => {
    await defaultIntervals(request);
    const repo = fx('basic');
    await waitForInit(page);
    const c = counter(page, '/api/git/status');
    await openGit(page, repo);
    await expect.poll(() => c.n, { timeout: 5000 }).toBeGreaterThanOrEqual(1);

    const gid = await gitWindowId(page);
    const other = await otherWindowId(page);
    await switchToWindow(page, other!);
    await page.waitForTimeout(400);
    const base = c.n;

    await switchToWindow(page, gid);
    // 주기(1000ms)보다 이르게 와야 "즉시 1회 수집"이다.
    await expect.poll(() => c.n - base, { timeout: 800 }).toBeGreaterThanOrEqual(1);
  });

  test('P4 (V18): 주기 0 이면 폴링이 돌지 않는다', async ({ page, request }) => {
    await patchSettings(request, { gitStatusInterval: 0, gitSignatureInterval: 0 });
    const repo = fx('basic');
    await waitForInit(page);
    const st = counter(page, '/api/git/status');
    const sig = counter(page, '/api/git/signature');
    await openGit(page, repo);

    await page.waitForTimeout(800);
    const base = st.n;
    await page.waitForTimeout(2600);
    expect(st.n - base, '주기 0 인데 status 폴링이 돈다').toBe(0);
    expect(sig.n, '주기 0 인데 signature 폴링이 돈다').toBe(0);
    await defaultIntervals(request);
  });

  test('P5 (V5): 같은 순간의 신호 여러 개가 status 1건으로 합쳐진다', async ({ page, request }) => {
    // 폴링을 끄고 즉시 신호만 남긴다 — 디바운스만 측정한다.
    await patchSettings(request, { gitStatusInterval: 0, gitSignatureInterval: 0 });
    const repo = fx('basic');
    await waitForInit(page);
    const c = counter(page, '/api/git/status');
    await openGit(page, repo);
    await page.waitForTimeout(800);
    const base = c.n;

    await page.evaluate(() => {
      const app = (window as any).app;
      for (let i = 0; i < 6; i++) app._gitSignal('test');
    });
    await expect.poll(() => c.n - base, { timeout: 3000 }).toBe(1);
    await page.waitForTimeout(700);
    expect(c.n - base, '디바운스 뒤에도 신호가 남아 다시 요청했다').toBe(1);
    await defaultIntervals(request);
  });

  test('P6 (V4): 활성 리포를 바꾸면 이전 리포의 응답이 화면에 닿지 않는다', async ({ page, request }) => {
    await defaultIntervals(request);
    const slow = copyFx('basic', 'p6-slow');
    const fast = copyFx('basic', 'p6-fast');
    writeFileSync(join(slow, 'only-in-slow.txt'), 'x');
    writeFileSync(join(fast, 'only-in-fast.txt'), 'x');

    await waitForInit(page);
    // slow 리포의 응답만 늦춘다 — 응답이 뒤바뀌어 도착하는 상황을 만든다.
    await page.route('**/api/git/status*', async (route) => {
      if (decodeURIComponent(route.request().url()).includes(slow)) {
        await new Promise((r) => setTimeout(r, 2000));
      }
      await route.continue();
    });

    await openGit(page, slow);
    await page.evaluate((r) => (window as any).app.gitPanel.setRepo(r), fast);

    const view = page.locator('#area .pn-body .git-view.git-changes');
    await expect(view.locator('.git-file[data-path="only-in-fast.txt"]')).toBeVisible({ timeout: 15000 });

    // slow 의 응답이 도착할 시간을 준 뒤에도 화면은 fast 다.
    await page.waitForTimeout(2600);
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
  test('P7 (회귀): status 폴링과 함께 돌아도 signature 폴링이 죽지 않는다', async ({ page, request }) => {
    await defaultIntervals(request);
    const repo = fx('basic');
    await waitForInit(page);
    const sig = counter(page, '/api/git/signature');
    await openGit(page, repo);

    // 두 주기가 최소 두 번 겹칠 만큼 기다린다 — 고착은 그 겹침에서 일어난다.
    await page.waitForTimeout(2200);
    const base = sig.n;
    await page.waitForTimeout(2600);
    // 500ms 주기면 2.6초에 5회다. 절반만 와도 "살아 있다" 로 본다.
    expect(sig.n - base, 'signature 폴링이 멈췄다 (단일 비행 플래그 고착)')
      .toBeGreaterThanOrEqual(3);
  });

  /**
   * 회귀 (D-POLL-2): 뷰의 `reload()` 가 동기 throw 해도 새로고침이 잠기지 않는다.
   *
   * `refresh()` 는 `_refreshing` 을 세운 뒤 jobs 배열을 만들면서 **async 가 아닌**
   * `reload()` 들을 부른다. 그 자리의 throw 는 `Promise.allSettled` 앞이라 아무것도
   * 삼켜 주지 못했고, 플래그가 참으로 남아 버튼이 disabled 로 굳었다.
   */
  test('P8 (회귀): 뷰의 reload() 가 터져도 새로고침 진입점이 잠기지 않는다', async ({ page, request }) => {
    await defaultIntervals(request);
    const repo = fx('basic');
    await waitForInit(page);
    await openGit(page, repo);

    // 탭을 한 번도 열지 않으면 뷰가 없어 refresh 의 대상이 아니다 — 사용자가
    // History 를 둘러본 상태를 만든 뒤 그 reload 만 터지게 한다.
    await page.evaluate(() => {
      const p = (window as any).app.gitPanel;
      p._history().reload = () => { throw new Error('reload boom') };
    });

    const btn = page.locator('#area .pn-body .git-view.git-changes .git-head-refresh');
    await btn.click();

    await expect(btn, '새로고침 버튼이 disabled 로 굳었다').toBeEnabled({ timeout: 3000 });
    expect(await page.evaluate(() => (window as any).app.gitPanel._refreshing),
      '_refreshing 이 참으로 남았다').toBe(false);

    // 잠기지 않았음의 증명은 "두 번째 누름이 실제로 요청을 낸다" 다.
    const st = counter(page, '/api/git/status');
    await btn.click();
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
    await defaultIntervals(request);
    const repo = copyFx('basic', 'p9-paint');
    await waitForInit(page);
    await openGit(page, repo);

    const view = page.locator('#area .pn-body .git-view.git-changes');
    // 첫 관측이 그려진 뒤부터 시작한다 — 그래야 뒤이은 변경이 "새 관측" 이다.
    await expect(view.locator('.git-head-repo')).toHaveAttribute('title', repo);

    // **새 파일을 담은 관측의 첫 그리기만** 터지게 한다. 아무 _paint 나 터뜨리면
    // 다른 계기(탭 전환·신호)가 그 한 번을 소모해 결함이 있어도 통과한다.
    await page.evaluate((needle) => {
      const p = (window as any).app.gitPanel;
      const orig = p._paint.bind(p);
      let left = 1;
      p._paint = function () {
        const st = this._status && this._status.status;
        if (left > 0 && st && JSON.stringify(st).includes(needle)) {
          left--;
          throw new Error('paint boom');
        }
        return orig();
      };
    }, 'after-paint-throw.txt');

    writeFileSync(join(repo, 'after-paint-throw.txt'), 'x');

    await expect(view.locator('.git-file[data-path="after-paint-throw.txt"]'),
      '_paint 가 한 번 터진 뒤 화면이 낡은 채로 굳었다')
      .toBeVisible({ timeout: 10000 });
  });
});
