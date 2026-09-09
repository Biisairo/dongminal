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

async function panelState(page: Page) {
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

    await page.evaluate(`(() => {${PANEL}
      const p2 = window.app._gitPanel(p.root, 1);
      p2._pollOk = () => false;     // 이 칸의 표면만 사라졌다
      p2._reschedule();
    })()`);

    expect((await panelState(page)).pollOn, '보이는 칸의 폴링이 꺼졌다').toBe(true);
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

    const woke = await page.evaluate(`(() => {${PANEL}
      p._stop();
      p._lastObsAt = Date.now() - 5 * 60 * 1000;
      const orig = p._pollOk.bind(p);
      p._pollOk = () => false;
      window.app._gitWdAt = 0;
      const r = p._watchdog();
      p._pollOk = orig;
      return r;
    })()`);

    expect(woke, '보이지 않는 표면을 깨웠다').toBe(false);
    expect((await panelState(page)).pollOn).toBe(false);
    await page.waitForTimeout(500);
    expect(box.n, '깨우지 않았는데 요청이 나갔다').toBe(0);
  });
});
