import { join } from 'path';

import { Page } from '@playwright/test';

import {
  test, expect, plainWindows, waitForInit, gitFixture, cleanGitFixture, JSON_HDR, openGit, makeCopyFx, GIT_VIEW_TABS,
} from './fixtures';
import { tmpPath, realPath } from './osenv';

const FIXTURES = tmpPath('dm-git-fx-gitwin-' + process.pid);
test.beforeAll(() => {
  gitFixture(FIXTURES);
});
test.afterAll(() => {
  cleanGitFixture(FIXTURES);
});
const fx = (name: string) => realPath(join(FIXTURES, name));

/**
 * GIT_M1_STEP3_CONTRACT §6 — **Repo 창의 골격.** 검증 V8·V19·V21.
 *
 * **개정 (REPO_TAB_UNIFY_SRS FR-RTU-70 / D-RTU-1).** 이 묶음이 재던 것은 옛
 * `WINDOW_TYPE_GIT` 창의 성질이었다 — 워크스페이스에 하나, 고정 탭 일곱, 닫히지도
 * 끌리지도 쪼개지지도 않는 창. 그 창은 로드에 사라지고(FR-RTU-70) **저장소 하나가
 * 창 하나**가 됐다 (D-RTU-1: 타입 문자열은 `editor` 그대로).
 *
 * 그래서 각 시험의 운명이 갈린다.
 *
 *   E1  살린다 — 같은 경로를 두 번 열어도 창은 하나다 (FR-RTU-72)
 *   E2  살린다 — type 없는 옛 워크스페이스의 하위호환 (FR-GIT-25)
 *   E3  폐기 — 고정 탭 일곱이 없다. 여섯이 **필요할 때** 열린다 (FR-RTU-30·32)
 *   E4  폐기 — 위와 같은 이유. `repo-tab.spec.ts` V1·V2 가 그 자리다
 *   E5  **뒤집힌다** — 뷰 탭은 닫힌다 (FR-RTU-33). `repo-tab.spec.ts` X1·X2
 *   E5b **뒤집힌다** — 끌리고 쪼개진다 (FR-RTU-33). `repo-tab.spec.ts` X1·X3
 *   E6  개정 — 분할 **진입점**은 여전히 없다. 분할 자체는 드래그드롭만이다
 *   E7  살린다 — 순회와 나가는 길
 *   E8  개정 — 새로고침이 뷰 탭과 활성 탭을 보존한다
 */

// FR-RTU-72: 경로 없이는 열 수 없다 — 창의 신원이 루트다 (D-RTU-18).
const openRepo = (page: Page, repo: string) =>
  page.evaluate((r: string) => (window as any).app.openGitWindow(r), repo);

// 그 루트의 Repo 창 수. 재조정이 같은 루트를 둘로 만들지 않는다 (FR-RTU-63).
const repoWindowCount = (page: Page, repo: string) =>
  page.evaluate((r: string) => {
    const a = (window as any).app;
    return a.testing.edWindows().filter((w: any) => a.testing.edRootOf(w) === r).length;
  }, repo);

const activeWindow = (page: Page) => page.evaluate(() => (window as any).app.ws.activeWindow);

test.describe('묶음 D — Repo 창 골격', () => {
  test('E1 (V8 / FR-RTU-72): 같은 경로를 두 번 열어도 그 저장소의 창은 하나다', async ({ page }) => {
    await waitForInit(page);
    const repo = fx('basic');
    await openRepo(page, repo);
    await page.waitForSelector('#area .ed-win .ed-side', { timeout: 15000 });
    await openRepo(page, repo);

    /**
     * **id 로 비교하지 않는다** (D-RTU-18: Repo 창의 신원은 루트다).
     *
     * 목록에 없던 경로를 열면 로컬이 창을 만들고, 곧이어 온 `workspace_changed`
     * 의 재조정이 같은 루트의 창을 **새 id 로** 다시 세운다. 사용자에게 같은
     * 저장소의 창은 같은 창이므로, 재는 것은 "그 루트의 창이 하나인가" 다.
     */
    await expect.poll(() => repoWindowCount(page, repo), { timeout: 15000 }).toBe(1);
    await expect.poll(() => page.evaluate(() => {
      const a = (window as any).app;
      return a.testing.isEditorWin(a.testing.aw()) ? a.testing.edRootOf(a.testing.aw()) : null;
    }), { timeout: 15000 }).toBe(repo);
    // FR-EDT-45: Repo 창은 WINDOWS 목록에 없다 — 진입점은 Repo 탭의 행뿐이다.
    await expect(page.locator('#windows .si[data-window-type="editor"]')).toHaveCount(0);
  });

  test('E2 (V8): type 없는 창을 담은 워크스페이스도 정상 로드된다', async ({ page, request }) => {
    // 기존 workspace.json 은 창에 type 이 없다 (FR-GIT-25 하위호환).
    const tool = await (await request.post('/api/tools?cols=120&rows=40', { headers: JSON_HDR })).json();
    const legacy = {
      schemaVersion: 2,
      windows: [{
        id: 'gw-legacy', name: 'Legacy',
        layout: {
          type: 'pane', id: 'gw-legacy-r', activeTab: 'gw-legacy-t',
          tabs: [{ id: 'gw-legacy-t', name: 'Shell', type: 'terminal', toolId: tool.id }],
        },
      }],
    };
    const get = await request.get('/api/workspace');
    const put = await request.put('/api/workspace', {
      headers: { 'If-Match': get.headers()['etag'] || '0', 'Content-Type': 'application/json' },
      data: JSON.stringify(legacy),
    });
    expect(put.status(), 'type 없는 워크스페이스 주입 실패').toBeLessThan(300);

    await waitForInit(page);
    const shape = await page.evaluate(() => {
      const w = (window as any).app.ws.windows.find((x: any) => x.id === 'gw-legacy');
      return w ? { name: w.name, type: w.type, tabs: (w.layout?.tabs || []).length } : null;
    });
    expect(shape, 'type 없는 창이 로드되지 않았다').not.toBeNull();
    expect(shape!.name).toBe('Legacy');
    expect(shape!.tabs, '터미널 탭이 정리 과정에서 사라졌다').toBe(1);
    expect(shape!.type, 'type 이 없는 창에 값이 주입됐다').toBeUndefined();

    // 같은 워크스페이스에서 Repo 창을 열어도 기존 창은 남는다.
    const repo = fx('basic');
    await openRepo(page, repo);
    expect((await plainWindows(page)).length).toBe(1);
    expect(await repoWindowCount(page, repo)).toBe(1);
  });

  test('E6 개정 (FR-EDT-50 / FR-RTU-15): 분할 진입점이 없고 단축키도 늘리지 않는다',
    async ({ page }) => {
      await waitForInit(page);
      await openRepo(page, fx('basic'));
      await page.waitForSelector('#area .ed-win .ed-side', { timeout: 15000 });
      const before = await page.locator('#area .pn').count();

      // 진입점은 감춰진다 — 눌리지만 아무 일도 하지 않는 버튼은 고장으로 읽힌다.
      await expect(page.locator('#split-h:visible')).toHaveCount(0);
      await expect(page.locator('#split-v:visible')).toHaveCount(0);
      await page.evaluate(async () => {
        const a = (window as any).app;
        await a.executeAction('splitH');
        await a.executeAction('splitV');
      });
      // **예외 (`TEST-16`)**: 분할이 **생기지 않음**을 잰다.
      await page.waitForTimeout(1200);
      // 분할이 생기는 유일한 길은 드래그드롭이다 (FR-EDT-51) — 단축키는 아니다.
      await expect(page.locator('#area .pn')).toHaveCount(before);
    });

  test('E7 개정 (FR-SBT-31·34): Repo 창에서 순회는 창을 건드리지 않고, 나가는 길은 탭이다',
    async ({ page }) => {
      await waitForInit(page);
      const repo = fx('basic');
      await openRepo(page, repo);
      await page.waitForSelector('#area .ed-win .ed-side', { timeout: 15000 });
      const other = await page.evaluate(() => {
        const a = (window as any).app;
        return (a.testing.plainWindows()[0] || {}).id;
      });
      expect(other, '비교할 일반 창이 없다').toBeTruthy();
      // 활성 창은 **그 루트의** Repo 창이다 (D-RTU-18 — id 로 비교하지 않는다).
      await expect.poll(() => page.evaluate(() => {
        const a = (window as any).app;
        return a.testing.isEditorWin(a.testing.aw()) ? a.testing.edRootOf(a.testing.aw()) : null;
      }), { timeout: 15000 }).toBe(repo);
      // Repo 창이 활성이면 사이드바 탭도 Repo 다 (FR-SBT-14).
      expect(await page.evaluate(() => (window as any).app.testing.sbTab)).toBe('repo');

      // FR-SBT-34: 나가는 길은 Windows 탭이다 — 막다른 길이 아니다.
      await page.evaluate(() => (window as any).app.testing.sbJumpTo(1));
      expect(await activeWindow(page)).toBe(other);
      expect(await page.evaluate(() => (window as any).app.testing.sbTab)).toBe('windows');
    });

  test('E8 개정 (V21 / FR-RTU-34): 새로고침 뒤에도 열어 둔 뷰 탭과 활성 탭이 남는다',
    async ({ page }) => {
      await waitForInit(page);
      const repo = fx('basic');
      await openRepo(page, repo);
      await page.waitForSelector('#area .ed-win .ed-side', { timeout: 15000 });
      // Changes 사이드의 아이콘 줄이 본문 탭을 연다 (FR-RTU-21).
      await page.locator('.ed-side-tab[data-side="changes"]').click();
      await page.locator('.ed-side .ed-side-act[data-view="worktrees"]').click();
      await expect(page.locator('#area .pn-tab[data-git-view="worktrees"]'))
        .toHaveCount(1, { timeout: 10000 });
      await page.evaluate(() => (window as any).app.testing.save());

      await page.reload();
      await page.waitForSelector('#area .pn-tab[data-git-view]', { timeout: 15000 });
      // 열어 둔 것만 남는다 — 고정 일곱이 아니다 (FR-RTU-30·32).
      await expect(page.locator('#area .pn-tab[data-git-view]')).toHaveCount(1);
      await expect(page.locator('#area .pn-tab.active[data-git-view]'))
        .toHaveAttribute('data-git-view', 'worktrees');
      expect(await repoWindowCount(page, repo)).toBe(1);
      // 활성 탭의 본문이 그 탭의 것이어야 한다 — 이름만 살아남아서는 안 된다.
      await expect(page.locator('#area .pn-body .git-view.vis')).toHaveClass(/git-worktrees/);
    });
});

/**
 * UI 개정 — **Git 창의 경계** (FR-GIT-179~186).
 *
 * 창이 무엇을 할 수 있고 무엇을 못 하는가가 이 파일의 주제다.
 *
 * `TEST-7` 로 `git-ui-revision` 에서 옮겨 왔다 — 납품 묶음(“UI 개정”)이 아니라
 * **이 기능**이 주제인 자리다. 단정은 옮기면서 바꾸지 않았다.
 */
const GURFX = tmpPath('dm-gur-git-window-' + process.pid);
test.beforeAll(() => { gitFixture(GURFX) });
test.afterAll(() => { cleanGitFixture(GURFX) });
const gurFx = (n: string) => realPath(join(GURFX, n));
const gurCopy = makeCopyFx(GURFX);

async function gurOpenChanges(page: Page, repo: string) {
  await openGit(page, repo);
  await page.evaluate(() => (window as any).app.gitPanel.openView('changes'));
  await expect(page.locator('#area .ed-side .git-view.git-changes')).toBeVisible({ timeout: 10000 });
}

const gurFiles = (page: Page) => page.locator('#area .ed-side .git-file');

// 파일 목록이 채워질 때까지 기다린다 — status 조회는 비동기다.
async function gurWaitFiles(page: Page, min = 1) {
  await expect.poll(() => gurFiles(page).count(), { timeout: 20000 }).toBeGreaterThanOrEqual(min);
}

test.describe('UI 개정 — Git 창의 경계 (FR-GIT-179~186)', () => {
  test('V70 (FR-GIT-179·180): Git 창에는 분할·새 탭 진입점이 없고 단축키도 늘리지 않는다', async ({ page }) => {
    await waitForInit(page);
    await openGit(page, gurFx('basic'));

    // 상단 바의 분할 버튼과 탭 행의 `+` 는 **자리가 없다** — 눌리지만 아무 일도
    // 하지 않는 버튼은 고장으로 읽힌다.
    await expect(page.locator('#split-h:visible')).toHaveCount(0);
    await expect(page.locator('#split-v:visible')).toHaveCount(0);
    await expect(page.locator('#area .pn-tab-add')).toHaveCount(0);

    // 단축키 경로도 막힌다.
    const before = await page.evaluate(() => ({
      panes: document.querySelectorAll('#area .pn').length,
      tabs: document.querySelectorAll('#area .pn-tab').length,
    }));
    await page.evaluate(async () => {
      const a = (window as any).app;
      await a.executeAction('splitH');
      await a.executeAction('splitV');
      await a.executeAction('newTab');
    });
    // **예외 (`TEST-16`): 일어나지 않는 것을 잰다.** 분할·새 탭이 Git 창에서
    // 막히는지 보는 검사이므로 기다릴 신호가 없다 — 시간을 주고 그대로인지
    // 본다. 짧게 하면 "아직 안 일어났을 뿐" 과 구분되지 않는다.
    await page.waitForTimeout(1500);
    const after = await page.evaluate(() => ({
      panes: document.querySelectorAll('#area .pn').length,
      tabs: document.querySelectorAll('#area .pn-tab').length,
    }));
    expect(after).toEqual(before);
    // 본문의 뷰 탭은 여섯이다 — `Changes` 는 사이드로 갔다 (FR-RTU-32).
    expect(after.tabs).toBe(GIT_VIEW_TABS);
  });

  /**
   * **개정 (REPO_TAB_UNIFY_SRS FR-RTU-33 / V-RTU-31).**
   *
   *   이전 동작: 뷰 탭은 고정이라 끌 수도 닫을 수도 없었다 (FR-GIT-28)
   *   새  동작: 편집기 탭과 **같은 자격**이다 — 끌리고 닫히고 분할된다.
   *             창 **밖**으로만 못 나간다 (FR-RTU-17)
   *   이유:     고정의 근거는 Git 창의 탭이 일곱으로 정해져 있어 자리가 늘 같아야
   *             한다는 것이었고, 그 창이 사라졌다 (FR-RTU-70)
   */
  test('V71 (V-RTU-31 / FR-RTU-17·33): git 뷰 탭은 창 안에서 끌리고 창 밖으로는 못 나간다',
    async ({ page }) => {
      await waitForInit(page);
      await openGit(page, gurFx('basic'));

      const draggables = await page.evaluate(() =>
        [...document.querySelectorAll('#area .pn-tab[data-git-view]')].map(t => (t as HTMLElement).draggable));
      expect(draggables, 'git 뷰 탭이 끌리지 않는다').toEqual(
        new Array(GIT_VIEW_TABS).fill(true));

      // 창 안의 분할은 허용이다 — 드래그드롭이 분할이 생기는 유일한 길이다
      // (FR-EDT-51).
      const split = await page.evaluate(() => {
        const a = (window as any).app;
        const w = a.testing.aw();
        const pane = w.layout;
        const tabId = pane.tabs[1].id;
        a.testing.splitPaneWithTab(pane.id, tabId, pane.id, 'right');
        return { layoutType: a.testing.aw().layout.type, panes: document.querySelectorAll('#area .pn').length };
      });
      expect(split.layoutType, '분할이 생기지 않았다').toBe('split');
      expect(split.panes).toBe(2);

      // 창 **밖**으로는 못 나간다 (FR-RTU-17 / FR-EDT-53). 일반 창의 탭 수가
      // 그대로인 것이 그 증거다.
      const moved = await page.evaluate(() => {
        const a = (window as any).app;
        const plain = a.testing.plainWindows()[0];
        const before = ((a.testing.flattenPanes(plain.layout)[0] || {}).tabs || []).length;
        const pane = a.testing.flattenPanes(a.testing.aw().layout)[0];
        a.testing.moveTabToWindow(pane.id, pane.tabs[0].id, plain.id);
        return { before, after: ((a.testing.flattenPanes(plain.layout)[0] || {}).tabs || []).length };
      });
      expect(moved.after, 'git 뷰 탭이 다른 창으로 나갔다').toBe(moved.before);
    });

  test('V72 (FR-GIT-182): Git 창은 WINDOWS 목록에도 창 전환 순환에도 없다', async ({ page }) => {
    await waitForInit(page);
    await page.evaluate(() => (window as any).app.addWindow());
    await expect(page.locator('#windows .si')).toHaveCount(2, { timeout: 10000 });
    await openGit(page, gurFx('basic'));

    // 목록에는 일반 창만 있다.
    const listed = await page.evaluate(() =>
      [...document.querySelectorAll('#windows .si')].map((e) => (e as HTMLElement).dataset.windowType));
    expect(listed).not.toContain('git');
    expect(listed.length).toBe(2);

    // 일반 창으로 나간 뒤 순환을 돌아도 Git 창에 닿지 않는다.
    const activeType = () => page.evaluate(() => {
      const a = (window as any).app;
      return (a.ws.windows.find((w: any) => w.id === a.ws.activeWindow) || {}).type || 'terminal';
    });
    const activeId = () => page.evaluate(() => (window as any).app.ws.activeWindow);

    const plain = await page.evaluate(() => {
      const a = (window as any).app;
      const id = a.ws.windows.find((w: any) => w.type !== 'git').id;
      a.switchWindow(id);
      return id;
    });
    await expect.poll(activeId, { timeout: 10000 }).toBe(plain);

    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      const from = await activeId();
      await page.evaluate(() => (window as any).app.executeAction('windowNext'));
      // 순환이 실제로 한 칸 움직인 뒤에 읽는다 — 고정 대기로는 "아직 안 움직인"
      // 창을 읽을 수 있다.
      await expect.poll(activeId, { timeout: 10000 }).not.toBe(from);
      seen.push(await activeType());
    }
    expect(seen).not.toContain('git');
  });

  /**
   * **개정 (FR-SBT-34·35).** 상단 바의 `Close Git` 은 사라졌다 — 탭이 생기면서
   * Git 창을 **떠나는 길**이 상시 존재하게 됐고, 떠나기 위해 닫을 이유가 없어졌다.
   * 그래서 "창 파괴 → 재생성" 부분은 검증할 UI 경로가 없다 (§4.1.1).
   *
   * 남는 성질은 FR-GIT-184 하나다 — Git 창이 **열려 있어도** 다른 창으로 나갈 수
   * 있다. 나가는 길이 사이드바 탭이 되었으므로(FR-SBT-22) 트리거만 바뀐다.
   */
  test('V73 (FR-GIT-184·FR-SBT-22): Repo 창이 열려 있어도 다른 창으로 나갈 수 있다', async ({ page }) => {
    await waitForInit(page);
    const repo = gurFx('basic');
    await openGit(page, repo);
    // Git 창에 들어가면 사이드바가 따라온다 (FR-SBT-14).
    await expect(page.locator('.sb-tab[data-panel="repo"]')).toHaveClass(/active/);
    // 상단 바에는 더 이상 닫기 버튼이 없다 (FR-SBT-34).
    await expect(page.locator('#git-close')).toHaveCount(0);

    // 나가는 길: `Windows` 탭. 창 목록이 아니라 탭이 문이다 (FR-GIT-182 는 그대로).
    await page.click('.sb-tab[data-panel="windows"]');
    await expect.poll(() => page.evaluate(() => {
      const a = (window as any).app;
      return (a.ws.windows.find((w: any) => w.id === a.ws.activeWindow) || {}).type || 'terminal';
    })).toBe('terminal');

    // 떠나는 것과 닫는 것은 다르다 (FR-SBT-35) — 그 창은 그대로 남는다.
    // **창 타입은 `editor` 다** (FR-RTU-10 / D-RTU-1): 옛 `git` 창은 사라졌고
    // (FR-RTU-70) 저장소 하나가 창 하나다.
    expect(await page.evaluate((r) => !!(window as any).app.testing.edWindowFor(r), repo)).toBe(true);

    // 그리고 언제든 다시 들어간다 — 같은 루트의 창이 둘로 늘지 않는다 (FR-RTU-63).
    await page.click('.sb-tab[data-panel="repo"]');
    await expect.poll(() => page.evaluate(() => {
      const a = (window as any).app;
      return (a.ws.windows.find((w: any) => w.id === a.ws.activeWindow) || {}).type || 'terminal';
    })).toBe('editor');
    expect(await page.evaluate((r) =>
      (window as any).app.testing.edWindows().filter((w: any) => (window as any).app.testing.edRootOf(w) === r).length,
    repo)).toBe(1);
  });

  /**
   * FR-GIT-183a → **FR-SBT-23·24 로 계승.** 가는 곳은 여전히 **직전에 활성이었던
   * 일반 창**(`_lastPlainWindow`)이다. 창 목록에서 이웃한 창으로 가면 사용자는
   * 자기가 있던 자리로 돌아오지 못한다.
   *
   * 트리거만 `#git-close` 클릭 → `Windows` 탭 클릭으로 바뀐다. 창 3개 중 **가운데**
   * 에 서는 설정은 그대로 유효하다 — 이웃으로 가는 것과 구별되어야 하기 때문이다.
   * 이 스펙 하나가 I6("원래 있던 윈도우로 돌아간다")을 이름이 아니라 동작으로
   * 고정한다 (V-SBT-9).
   */
  test('V73b (FR-SBT-23·24, 옛 FR-GIT-183a): Windows 탭은 직전에 보던 일반 창으로 돌아간다', async ({ page }) => {
    await waitForInit(page);
    // 일반 창 셋을 만들고 **가운데**에 선다 — 이웃으로 가는 것과 구별되어야 한다.
    // EDITOR_TAB_SRS FR-EDT-13: root 에디터 창도 `type!=='git'` 을 통과하므로
    // 그 필터만으로는 안 된다 — `type!=='editor'` 도 함께 걸러야 일반 창만 남는다.
    await page.evaluate(async () => {
      const a = (window as any).app;
      await a.addWindow();
      await a.addWindow();
    });
    const ids = (await plainWindows(page)).map((w: any) => w.id);
    expect(ids.length).toBeGreaterThanOrEqual(3);
    const from = ids[1];
    await page.evaluate((id) => (window as any).app.switchWindow(id), from);
    expect(await page.evaluate(() => (window as any).app.ws.activeWindow)).toBe(from);

    const fxBasic = gurFx('basic');
    await openGit(page, fxBasic);
    await page.click('.sb-tab[data-panel="windows"]');

    // 이웃(ids[0]·ids[2])이 아니라 떠나온 그 창이다.
    await expect.poll(() => page.evaluate(() =>
      (window as any).app.ws.activeWindow)).toBe(from);
    // FR-SBT-35: 떠났을 뿐 그 Repo 창은 파괴되지 않는다 (FR-RTU-10).
    expect(await page.evaluate((r) => !!(window as any).app.testing.edWindowFor(r), fxBasic)).toBe(true);
  });

  test('V74 (FR-GIT-41·185): Open File 은 Git 창이 아닌 창에 열고 그 창을 활성화한다', async ({ page }) => {
    await waitForInit(page);
    await gurOpenChanges(page, gurCopy('basic', 'v74'));
    await gurWaitFiles(page);

    await gurFiles(page).first().click({ button: 'right' });
    await page.locator('.git-menu .git-menu-item[data-id="openFile"]').click();

    // 편집기 탭이 생기고, 그 탭이 있는 창이 활성이며, 그 창은 Git 창이 아니다.
    await expect.poll(() => page.evaluate(() => {
      const a = (window as any).app;
      const w = a.ws.windows.find((x: any) => x.id === a.ws.activeWindow);
      if (!w || w.type === 'git') return 'git-or-none';
      const has = (n: any): boolean =>
        n.type === 'pane' ? (n.tabs || []).some((t: any) => t.type === 'editor')
                          : (n.children || []).some(has);
      return has(w.layout) ? 'ok' : 'no-editor';
    }), { timeout: 20000 }).toBe('ok');

    // **개정 (FR-RTU-70).** 옛 Git 창이 사라졌으므로 "그 창의 고정 탭이 그대로다"
    // 를 잴 대상이 없다. 남는 계약은 FR-EDT-94 이며 위의 poll 이 그것을 못박았다.
  });

  test('V75 (FR-RTU-70·75, 옛 FR-GIT-186): 옛 Git 창은 사라지고 남의 탭만 일반 창이 받는다', async ({ page }) => {
    await waitForInit(page);
    const r = await page.evaluate(() => {
      // 개정 이전 모양: Git 창이 분할되어 있고 터미널·편집기 탭이 섞여 있다.
      const windows: any[] = [
        { id: 'w1', name: 'Window', layout: { type: 'pane', id: 'p1', tabs: [{ id: 't1', type: 'terminal', toolId: 'x' }], activeTab: 't1' } },
        {
          id: 'w2', name: 'Git', type: 'git',
          layout: {
            type: 'split', direction: 'horizontal', children: [
              { type: 'pane', id: 'p2', tabs: [
                { id: 'g1', type: 'git', gitView: 'changes' },
                { id: 'g2', type: 'git', gitView: 'diff' },
                { id: 'e1', type: 'editor', filePath: '/tmp/a.txt', name: 'a.txt' },
              ], activeTab: 'e1' },
              { type: 'pane', id: 'p3', tabs: [{ id: 't2', type: 'terminal', toolId: 'y' }], activeTab: 't2' },
            ],
          },
        },
      ];
      const moved = (window as any).migrateGitWindows(windows, () => {
        const w = { id: 'w3', name: 'Window', layout: { type: 'pane', id: 'p9', tabs: [], activeTab: null } };
        windows.push(w);
        return w;
      });
      const collect = (n: any): any[] =>
        n.type === 'pane' ? (n.tabs || []) : (n.children || []).flatMap(collect);
      return {
        moved,
        gitGone: !windows.some((w) => w && w.type === 'git'),
        plainTabIds: collect(windows[0].layout).map((t: any) => t.id),
        windowCount: windows.length,
      };
    });
    /**
     * **개정 (REPO_TAB_UNIFY_SRS FR-RTU-70·75 / D-RTU-14).**
     *
     *   이전 동작: Git 창은 남고 단일 칸 + 고정 탭 일곱으로 정리됐다
     *   새  동작: **창 자체가 사라진다.** 고정 뷰 탭은 버리고(재현 가능하며 옮길
     *             자리가 없다) 남의 탭(터미널·편집기)만 일반 창이 건져 낸다
     *   이유:     Git 창이라는 특수 창이 없어졌다 — 저장소 하나가 창 하나다
     */
    // 창이 사라졌으므로 목록에는 일반 창 하나만 남는다.
    expect(r.windowCount).toBe(1);
    expect(r.gitGone, 'Git 창이 남았다').toBe(true);
    // 옮긴 탭은 사라지지 않는다 — 일반 창이 받는다. 뷰 탭 둘은 버려진다.
    expect(r.plainTabIds).toEqual(['t1', 'e1', 't2']);
    // 반환값은 **바뀐 것의 수**다 — 옮긴 탭 둘 + 지운 창 하나.
    expect(r.moved).toBe(3);
  });
});

