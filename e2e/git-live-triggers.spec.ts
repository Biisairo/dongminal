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

const GITFX = tmpPath('otter-glw-' + process.pid);
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
 * 계기가 새어 관측(토픽 구독)이 멎은 상태를 만든다. 감시견은 없다 — 관측은 채널의 `git:<root>`
 * 토픽이고 그것을 다시 세우는 계기가 복귀 신호다 (PERF_OPTIMIZATION_SRS M1 C4).
 */
async function stopped(page: Page) {
  await page.evaluate(`(() => {${PANEL}
    p.poll._stop();
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
    await stopped(page);

    await page.evaluate(`window.dispatchEvent(new Event('focus'))`);

    await expect.poll(async () => (await panelState(page)).pollOn, { timeout: 10000 }).toBe(true);
  });

  // TC-GLW-2: 가시성 복귀도 같은 자리다. 버스는 `document.hidden` 이 거짓이면
  // `visible` 을 낸다 (`event-bus.js:124~126`).
  test('TC-GLW-2: 가시성 복귀도 부팅 관측기 밖의 폴링을 되살린다', async ({ page }) => {
    await settled(page);
    await stopped(page);

    await page.evaluate(`document.dispatchEvent(new Event('visibilitychange'))`);

    await expect.poll(async () => (await panelState(page)).pollOn, { timeout: 10000 }).toBe(true);
  });

  // TC-GLW-3: 넓힌 것이 되살리기뿐이어서는 안 된다 — **숨김도 전부에 닿아야**
  // 아무도 보지 않는 저장소가 폴링을 이어가지 않는다 (FR-GLW-3 · FR-GLR-3).
  test('TC-GLW-3: 숨김 신호는 부팅 관측기 밖의 폴링을 걷는다', async ({ page }) => {
    await settled(page);
    await page.evaluate(`(() => {
      Object.defineProperty(document, 'hidden', { get: () => true, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    })()`);

    await expect.poll(async () => (await panelState(page)).pollOn, { timeout: 10000 }).toBe(false);
  });
});
