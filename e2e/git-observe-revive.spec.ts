import { join } from 'path';

import { Page } from '@playwright/test';

import { test, expect, waitForInit, openGit, gitFixture, cleanGitFixture } from './fixtures';
import { tmpPath, realPath } from './osenv';

// GIT_OBSERVE_REVIVE_SRS — 멈춘 관측이 **실제로** 되살아나는가.
//
// UX_BATCH9 의 TC-GLR-1~4 는 `poll=off` 갈래만 잰다. 접수된 결함은 그 반대편이다:
// 폴링은 켜져 있는데 관측이 오지 않는 회차에서 워치독이 경고만 찍고 물러났다
// (SRS §2.1). 그리고 폴링을 켤지 정하는 판정이 패널 하나의 것이라, 보이지 않는
// 칸이 보이는 칸의 폴링을 껐다 (§2.3).

const GITFX = tmpPath('dm-gor-' + process.pid);
const gfx = (name: string) => realPath(join(GITFX, name));

test.beforeAll(() => { gitFixture(GITFX) });
test.afterAll(() => { cleanGitFixture(GITFX) });

const PANEL = `const p = window.app.gitPanel;`;

async function panelState(page: Page): Promise<{ pollOn: boolean; lastObsAt: number; root: string; repo: string }> {
  return await page.evaluate(`(() => {${PANEL}
    return { pollOn: !!p._pollOn, lastObsAt: p._lastObsAt, root: p.root, repo: p.repo };
  })()`);
}

/** 관측이 한 번 선 뒤에 시작한다 — 그 전에는 잴 기준이 없다. */
async function settled(page: Page) {
  await waitForInit(page, { clearLocalStorage: true });
  await openGit(page, gfx('basic'));
  await expect.poll(async () => (await panelState(page)).lastObsAt, { timeout: 15000 })
    .toBeGreaterThan(0);
}

/**
 * 폴링은 **켜 둔 채** 관측만 낡힌다. 워치독의 검사 문턱도 연다 — 방금 그린 직후라
 * 닫혀 있고, 재려는 것은 문턱이 아니라 되살리기다 (TC-GLR-1 과 같은 준비).
 */
async function staleButPolling(page: Page) {
  await page.evaluate(`(() => {${PANEL}
    p._lastObsAt = Date.now() - 5 * 60 * 1000;
    window.app._gitWdAt = 0;
  })()`);
  expect((await panelState(page)).pollOn, '폴링이 켜져 있어야 이 검사가 성립한다').toBe(true);
}

function countStatus(page: Page) {
  const box = { n: 0 };
  page.on('request', (r) => { if (r.url().includes('/api/git/status')) box.n++ });
  return box;
}

test.describe('GIT_OBSERVE_REVIVE — 되살리기는 수집까지 간다', () => {
  // TC-GOR-1: 종전에는 `_applyCadence()` 가 "주기가 그대로다" 로 거짓을 돌려주면
  // 수집이 통째로 빠졌다 — 워치독이 경고만 찍는 회차다 (FR-GOR-1).
  test('TC-GOR-1: 폴링이 켜져 있어도 관측이 낡았으면 그 자리에서 수집한다', async ({ page }) => {
    await settled(page);
    const before = (await panelState(page)).lastObsAt;
    const box = countStatus(page);
    await staleButPolling(page);

    await page.evaluate('window.app.render()');

    await expect.poll(() => box.n, { timeout: 10000 }).toBeGreaterThan(0);
    await expect
      .poll(async () => (await panelState(page)).lastObsAt, { timeout: 15000 })
      .toBeGreaterThan(before);
  });

  // TC-GOR-2: 되살리기가 새 요청원이 되어서는 안 된다 (FR-GOR-2 · R-B9-1).
  // 응답을 끊어 두면 관측은 영영 낡은 채이므로, 문턱이 없으면 렌더마다 한 건씩
  // 나간다. 시한(20s)에 걸리는 hang 이 아니라 즉시 실패시키는 이유는 그것이다 —
  // hang 은 `_busy` 가 대신 막아 문턱의 유무를 가린다.
  test('TC-GOR-2: 되살리기 요청은 주기당 한 건을 넘지 않는다', async ({ page }) => {
    await settled(page);
    await page.route('**/api/git/status*', (route) => route.abort());
    const box = countStatus(page);
    await staleButPolling(page);

    for (let i = 0; i < 4; i++) {
      await page.evaluate('window.app.render()');
      await page.waitForTimeout(1300);   // GIT_WATCHDOG_CHECK_MS(1s) 를 넘긴다
    }
    await page.unroute('**/api/git/status*');

    expect(box.n, '주기(30s) 안에 되살리기가 여러 번 나갔다').toBeLessThanOrEqual(1);
  });

  // TC-GOR-3: 정상 상태에서는 한 건도 더하지 않는다 (FR-GOR-3 · TC-GLR-4 계승).
  test('TC-GOR-3: 관측이 싱싱하면 렌더가 요청을 만들지 않는다', async ({ page }) => {
    await settled(page);
    const box = countStatus(page);
    for (let i = 0; i < 10; i++) {
      await page.evaluate('window.app.render()');
      await page.waitForTimeout(60);
    }
    await page.waitForTimeout(500);
    expect(box.n, 'render 만으로 status 요청이 나갔다').toBe(0);
  });

  // TC-GOR-7: 로그가 어느 관측기인지 말해야 한다 (FR-GOR-7 · §2.4).
  test('TC-GOR-7: 되살리기 로그에 루트가 실린다', async ({ page }) => {
    const lines: string[] = [];
    page.on('console', (m) => { if (m.text().includes('관측이 멈춰 있어')) lines.push(m.text()) });
    await settled(page);
    const root = (await panelState(page)).root as string;
    await staleButPolling(page);

    await page.evaluate('window.app.render()');
    await expect.poll(() => lines.length, { timeout: 10000 }).toBeGreaterThan(0);
    expect(lines[0], lines[0]).toContain('root=' + root);
  });
});

test.describe('GIT_OBSERVE_REVIVE — 폴링 여부는 관측기가 정한다', () => {
  /**
   * 같은 관측기에 패널을 하나 더 세운다. 관측기는 **루트마다**이고 패널은
   * **(루트, 칸)마다**이므로, 칸만 다른 패널은 같은 관측기를 빌려 본다
   * (FR-SVS-30 · FR-RTU-60).
   */
  async function secondPanel(page: Page) {
    return await page.evaluate(`(() => {${PANEL}
      const p2 = window.app._gitPanel(p.root, 1);
      return p2 !== p && p2.obs === p.obs;
    })()`);
  }

  // TC-GOR-4: 보이지 않는 칸이 보이는 칸의 폴링을 끄지 못한다 (FR-GOR-4 · §2.3).
  test('TC-GOR-4: 패널 하나가 조건 거짓이어도 관측기는 계속 돈다', async ({ page }) => {
    await settled(page);
    expect(await secondPanel(page), '같은 관측기의 둘째 패널을 세우지 못했다').toBe(true);

    /**
     * 판정을 **같은 evaluate 안에서** 읽는다.
     *
     * GIT_LIVE_TRIGGERS_SRS FR-GLW-3 이후 생명주기 신호 하나(`life:hidden`)가
     * `_gitRescheduleAll()` 을 태워 **모든** 관측기의 폴링을 걷는다. 그것은 의도된
     * 새 동작이고, 재려는 것(둘째 패널의 판정이 첫째를 끄지 못한다)과는 다른
     * 사건이다. 호출과 판독 사이에 그 신호가 끼면 이 검사가 남의 동작을 잰다.
     */
    const on = await page.evaluate(`(() => {${PANEL}
      const p2 = window.app._gitPanel(p.root, 1);
      p2._pollOk = () => false;     // 이 칸의 표면만 사라졌다
      p2._reschedule();
      return !!p._pollOn;
    })()`);

    expect(on, '보이는 칸의 폴링이 꺼졌다').toBe(true);
  });

  // TC-GOR-5: 전부 거짓이면 종전대로 완전히 멈춘다 (FR-GOR-5 · NFR-RTU-1).
  test('TC-GOR-5: 딸린 패널 전부가 조건 거짓이면 멈춘다', async ({ page }) => {
    await settled(page);
    expect(await secondPanel(page)).toBe(true);

    await page.evaluate(`(() => {${PANEL}
      const p2 = window.app._gitPanel(p.root, 1);
      p._pollOk = () => false;
      p2._pollOk = () => false;
      p2._reschedule();
    })()`);

    expect((await panelState(page)).pollOn, '아무도 보지 않는데 폴링이 남았다').toBe(false);
  });

  // TC-GOR-6: 되살리기의 진입 판정은 **그 패널의** 것으로 남는다 (FR-GOR-6).
  test('TC-GOR-6: 보이지 않는 표면의 워치독은 깨우지 않는다', async ({ page }) => {
    await settled(page);
    const box = countStatus(page);

    /**
     * `_pollOk` 은 **재는 동안 계속 거짓**이다.
     *
     * 종전에는 `_watchdog()` 직후 되돌렸는데, 그러면 뒤이은 500ms 동안 남는 상태가
     * "보이는 표면 + 낡은 관측 + 꺼진 폴링" — 즉 되살리기의 조건 그 자체다.
     * GIT_LIVE_TRIGGERS_SRS 이후 그 자리를 지나는 계기가 둘 늘었다(주기 워치독
     * FR-GLW-4, 생명주기 복귀 FR-GLW-1). 되돌리기는 이 검사의 준비가 아니라
     * 뒷정리였고, 그 뒷정리가 재려는 상황을 깨뜨린다.
     *
     * 상황을 유지하는 것이 더 정확하다 — 재는 것은 "보이지 않는 표면은 깨우지
     * 않는다" 이고, 그 표면은 재는 동안 보이지 않아야 한다.
     */
    const woke = await page.evaluate(`(() => {${PANEL}
      p._stop();
      p._lastObsAt = Date.now() - 5 * 60 * 1000;
      p._pollOk = () => false;
      window.app._gitWdAt = 0;
      return p._watchdog();
    })()`);

    expect(woke, '보이지 않는 표면을 깨웠다').toBe(false);
    expect((await panelState(page)).pollOn).toBe(false);
    await page.waitForTimeout(500);
    expect(box.n, '깨우지 않았는데 요청이 나갔다').toBe(0);
  });
});
