import { execFileSync } from 'child_process';
import { realpathSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

import { APIRequestContext, Page } from '@playwright/test';

import { test, expect } from './fixtures';

// GIT_M1_STEP56_CONTRACT §4 — 변경 감지 3계층. 검증 V6·V18·V5·V4.

const FIXTURES = '/tmp/dm-git-fx-polling-' + process.pid;

test.beforeAll(() => {
  execFileSync('bash', ['e2e/git_fixture.sh', FIXTURES], { stdio: 'ignore' });
});
test.afterAll(() => {
  execFileSync('bash', ['e2e/git_fixture.sh', '--clean', FIXTURES], { stdio: 'ignore' });
});

const fx = (name: string) => realpathSync(join(FIXTURES, name));

function copyFx(name: string, tag: string) {
  const dst = join(FIXTURES, 'copy-' + tag);
  rmSync(dst, { recursive: true, force: true });
  execFileSync('cp', ['-R', join(FIXTURES, name), dst]);
  return realpathSync(dst);
}

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

async function waitForInit(page: Page) {
  await page.context().addInitScript(() => {
    sessionStorage.setItem('displayMode', 'desktop');
  });
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
}

async function openGit(page: Page, repo: string) {
  await page.evaluate((r) => (window as any).app.openGitWindow(r), repo);
  await expect(page.locator('#area .pn-tab[data-git-view]')).toHaveCount(6);
}

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
});
