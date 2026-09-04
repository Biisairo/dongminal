import { execFileSync } from 'child_process';
import { realpathSync } from 'fs';
import { join } from 'path';

import { Page } from '@playwright/test';

import { test, expect, plainWindows, waitForInit } from './fixtures';

const FIXTURES = '/tmp/dm-git-fx-gitwin-' + process.pid;
test.beforeAll(() => {
  execFileSync('bash', ['e2e/git_fixture.sh', FIXTURES], { stdio: 'ignore' });
});
test.afterAll(() => {
  execFileSync('bash', ['e2e/git_fixture.sh', '--clean', FIXTURES], { stdio: 'ignore' });
});
const fx = (name: string) => realpathSync(join(FIXTURES, name));

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
    return a._edWindows().filter((w: any) => a._edRootOf(w) === r).length;
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
      return a._isEditorWin(a._aw()) ? a._edRootOf(a._aw()) : null;
    }), { timeout: 15000 }).toBe(repo);
    // FR-EDT-45: Repo 창은 WINDOWS 목록에 없다 — 진입점은 Repo 탭의 행뿐이다.
    await expect(page.locator('#windows .si[data-window-type="editor"]')).toHaveCount(0);
  });

  test('E2 (V8): type 없는 창을 담은 워크스페이스도 정상 로드된다', async ({ page, request }) => {
    // 기존 workspace.json 은 창에 type 이 없다 (FR-GIT-25 하위호환).
    const tool = await (await request.post('/api/tools?cols=120&rows=40')).json();
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
        return (a._plainWindows()[0] || {}).id;
      });
      expect(other, '비교할 일반 창이 없다').toBeTruthy();
      // 활성 창은 **그 루트의** Repo 창이다 (D-RTU-18 — id 로 비교하지 않는다).
      await expect.poll(() => page.evaluate(() => {
        const a = (window as any).app;
        return a._isEditorWin(a._aw()) ? a._edRootOf(a._aw()) : null;
      }), { timeout: 15000 }).toBe(repo);
      // Repo 창이 활성이면 사이드바 탭도 Repo 다 (FR-SBT-14).
      expect(await page.evaluate(() => (window as any).app._sbTab)).toBe('repo');

      // FR-SBT-34: 나가는 길은 Windows 탭이다 — 막다른 길이 아니다.
      await page.evaluate(() => (window as any).app._sbJumpTo(1));
      expect(await activeWindow(page)).toBe(other);
      expect(await page.evaluate(() => (window as any).app._sbTab)).toBe('windows');
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
      await page.evaluate(() => (window as any).app._save());

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
