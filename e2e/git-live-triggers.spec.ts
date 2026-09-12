import { join } from 'path';

import { Page } from '@playwright/test';

import { test, expect, waitForInit, openGit, gitFixture, cleanGitFixture } from './fixtures';
import { tmpPath, realPath } from './osenv';

// GIT_LIVE_TRIGGERS_SRS — 되살리기의 **계기**.
//
// 되살리기의 몸통(`_watchdog`)은 UX_BATCH9 · GIT_OBSERVE_REVIVE 가 세웠고 그쪽
// 검사가 이미 잰다. 여기서 재는 것은 그것이 **불리는가**다.
//
//   ① 가시성·포커스 복귀 계기가 관측기 하나에만 결선돼 있었다 (§2.1)
//   ② 워치독이 렌더에만 얹혀 있어 주기가 없었다 (§2.2)

const GITFX = tmpPath('dm-glw-' + process.pid);
const gfx = (name: string) => realPath(join(GITFX, name));

test.beforeAll(() => { gitFixture(GITFX) });
test.afterAll(() => { cleanGitFixture(GITFX) });

const PANEL = `const p = window.app.gitPanel;`;

async function panelState(page: Page): Promise<{ pollOn: boolean; lastObsAt: number; root: string; repo: string }> {
  return await page.evaluate(`(() => {${PANEL}
    return { pollOn: !!p._pollOn, lastObsAt: p._lastObsAt, root: p.root, repo: p.repo };
  })()`);
}

/**
 * 관측이 한 번 선 뒤에 시작한다 — 그 전에는 잴 기준이 없다.
 *
 * 이 준비가 곧 §2.1 의 상황이다: 부팅의 `_initGitSection` 은 활성 창이 터미널일
 * 때 루트 `''` 의 패널을 잡고(`_gitRootOfActive`), 여기서 여는 저장소의 관측기는
 * 그 뒤에 선다. 아래 `root !== ''` 가 그 구도를 확인한다.
 */
async function settled(page: Page) {
  await waitForInit(page, { clearLocalStorage: true });
  await openGit(page, gfx('basic'));
  await expect.poll(async () => (await panelState(page)).lastObsAt, { timeout: 15000 })
    .toBeGreaterThan(0);
  const st = await panelState(page);
  expect(st.root, '부팅 패널과 다른 루트의 관측기여야 이 검사가 성립한다').not.toBe('');
  expect(st.pollOn, '폴링이 켜져 있어야 멎힘을 만들 수 있다').toBe(true);
}

/**
 * 계기가 새어 폴링이 멎은 상태를 만든다.
 *
 * **워치독을 함께 막는다.** 이 파일이 재려는 것은 복귀 계기 하나이고, 워치독은
 * 렌더 훅으로도 같은 자리를 되살린다 — `_gitWdAt` 을 미래에 두면 `gitWatchdogAll`
 * 의 문턱이 닫힌 채로 남아(`now - _gitWdAt < GIT_WATCHDOG_CHECK_MS`) 그 경로가
 * 결과에 섞이지 않는다.
 */
async function stoppedAndWatchdogMuted(page: Page) {
  await page.evaluate(`(() => {${PANEL}
    p._stop();
    window.app.testing.gitWdAt = Date.now() + 3600 * 1000;
  })()`);
  expect((await panelState(page)).pollOn).toBe(false);
}

test.describe('GIT_LIVE_TRIGGERS — 복귀 계기는 앱당 한 벌이고 전부에 닿는다', () => {
  // TC-GLW-1: 종전에는 `focus` 리스너가 `this.obs._inited` 가드로 **관측기마다**
  // 한 번 붙었고 `live=()=>this.obs.any()` 로 **그 관측기만** 되살렸다. 부팅 때
  // 잡힌 것은 루트 `''` 의 관측기이므로, 사용자가 실제로 보는 저장소는 이 계기를
  // 갖지 못했다 (FR-GLW-1·2 / §2.1).
  test('TC-GLW-1: 창 포커스 복귀가 부팅 관측기 밖의 폴링도 되살린다', async ({ page }) => {
    await settled(page);
    await stoppedAndWatchdogMuted(page);

    await page.evaluate(`window.dispatchEvent(new Event('focus'))`);

    await expect.poll(async () => (await panelState(page)).pollOn, { timeout: 10000 }).toBe(true);
  });

  // TC-GLW-2: 가시성 복귀도 같은 자리다. 버스는 `document.hidden` 이 거짓이면
  // `visible` 을 낸다 (`event-bus.js:124~126`).
  test('TC-GLW-2: 가시성 복귀도 부팅 관측기 밖의 폴링을 되살린다', async ({ page }) => {
    await settled(page);
    await stoppedAndWatchdogMuted(page);

    await page.evaluate(`document.dispatchEvent(new Event('visibilitychange'))`);

    await expect.poll(async () => (await panelState(page)).pollOn, { timeout: 10000 }).toBe(true);
  });

  // TC-GLW-3: 넓힌 것이 되살리기뿐이어서는 안 된다 — **숨김도 전부에 닿아야**
  // 아무도 보지 않는 저장소가 폴링을 이어가지 않는다 (FR-GLW-3 · FR-GLR-3).
  test('TC-GLW-3: 숨김 신호는 부팅 관측기 밖의 폴링을 걷는다', async ({ page }) => {
    await settled(page);
    await page.evaluate(`(() => {
      window.app.testing.gitWdAt = Date.now() + 3600 * 1000;
      Object.defineProperty(document, 'hidden', { get: () => true, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    })()`);

    await expect.poll(async () => (await panelState(page)).pollOn, { timeout: 10000 }).toBe(false);
  });
});

test.describe('GIT_LIVE_TRIGGERS — 워치독에 주기가 있다', () => {
  /**
   * 렌더 훅을 끊는다. `gitWatchdogAll` 의 종전 유일한 호출처가 `render()` 이므로
   * (renderer.js:155), 그것을 끊으면 남는 계기는 주기뿐이다 — 이 묶음이 재려는
   * 것이 정확히 그것이다.
   */
  const CUT_RENDER = `window.app.render = () => {};`;

  // TC-GLW-4: 사용자가 아무것도 누르지 않는 동안에도 되살아나야 한다 (FR-GLW-4).
  test('TC-GLW-4: 렌더가 없어도 주기 계기가 멎은 폴링을 되살린다', async ({ page }) => {
    await settled(page);
    await page.evaluate(`(() => {${PANEL}
      ${CUT_RENDER}
      p._stop();
      window.app.testing.gitWdAt = 0;
    })()`);
    expect((await panelState(page)).pollOn).toBe(false);

    await expect.poll(async () => (await panelState(page)).pollOn, { timeout: 10000 }).toBe(true);
  });

  // TC-GLW-5: 숨김 중에는 돌지 않는다 (FR-GLW-5). 판정은 등록 내용으로 잰다 —
  // `document.hidden` 을 참으로 만들면 재려는 정책과 다른 경로가 함께 움직인다.
  test('TC-GLW-5: 주기 계기는 whenHidden=pause 로 등록된다', async ({ page }) => {
    await settled(page);
    const job = await page.evaluate(`(() => {
      const j = window.app.timers._jobs.get('git.watchdog');
      return j ? { whenHidden: j.whenHidden, every: +j.every() } : null;
    })()`) as any;

    expect(job, '주기 워치독 job 이 등록되지 않았다').not.toBeNull();
    expect(job.whenHidden).toBe('pause');
    expect(job.every, '주기가 GIT_WATCHDOG_CHECK_MS 여야 한다').toBe(1000);
  });

  // TC-GLW-6: 정상 상태에서 이 계기가 내는 요청은 0 이다 (FR-GLW-6 · TC-GOR-3 계승).
  test('TC-GLW-6: 정상 상태에서 주기 계기가 요청을 만들지 않는다', async ({ page }) => {
    await settled(page);
    const box = { n: 0 };
    page.on('request', (r) => { if (r.url().includes('/api/git/status')) box.n++ });
    await page.evaluate(`(() => { ${CUT_RENDER} window.app.testing.gitWdAt = 0 })()`);

    // **예외 (`TEST-16`)**: 요청이 **나가지 않음**을 잰다.
    await page.waitForTimeout(4000);

    expect(box.n, '주기 워치독만으로 status 요청이 나갔다').toBe(0);
  });
});
