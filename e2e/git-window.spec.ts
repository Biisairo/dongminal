import { Page } from '@playwright/test';

import { test, expect } from './fixtures';

// GIT_M1_STEP3_CONTRACT §6 — 묶음 D 의 Git 창 골격. 검증 V8·V19·V20·V21.
//
// Git 창을 여는 UI 진입점은 4단계에 생긴다. 여기서는 계약 §6 대로 app 메서드를
// 직접 부른다.

const VIEWS = ['changes', 'diff', 'history', 'branches', 'stash', 'console'];
const NAMES = ['Changes', 'Diff', 'History', 'Branches', 'Stash', 'Console'];
// 준비 중 탭은 더 이상 없다 — console 도 FR-GIT-218 이 채웠다.
const PENDING: string[] = [];
const READY = ['changes', 'history', 'branches', 'stash', 'console'];
const PENDING_HINT = '이후 마일스톤에서 제공됩니다';

async function waitForInit(page: Page) {
  await page.context().addInitScript(() => {
    sessionStorage.setItem('displayMode', 'desktop');
  });
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
}

const openGit = (page: Page) => page.evaluate(() => (window as any).app.openGitWindow());

const gitWindowCount = (page: Page) =>
  page.evaluate(() => (window as any).app.ws.windows.filter((w: any) => w.type === 'git').length);

const activeWindow = (page: Page) => page.evaluate(() => (window as any).app.ws.activeWindow);

test.describe('묶음 D — Git 창 골격', () => {
  test('E1 (V8): openGitWindow 를 두 번 불러도 Git 창은 하나다', async ({ page }) => {
    await waitForInit(page);
    const first = await openGit(page);
    await expect(page.locator('#area .pn-tab[data-git-view]')).toHaveCount(6);

    const second = await openGit(page);
    expect(second, '두 번째 호출이 다른 창을 만들었다').toBe(first);
    expect(await gitWindowCount(page)).toBe(1);
    // FR-GIT-182 (GIT_UI_REVISION_SRS): Git 창은 WINDOWS 목록에 없다 — 진입점은
    // GIT 섹션의 리포 항목뿐이다.
    await expect(page.locator('#windows .si[data-window-type="git"]')).toHaveCount(0);
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

    // 같은 워크스페이스에서 Git 창을 열어도 기존 창은 남는다.
    await openGit(page);
    expect(await page.evaluate(() => (window as any).app.ws.windows.length)).toBe(2);
    expect(await gitWindowCount(page)).toBe(1);
  });

  test('E3 (V20): 고정 탭 6개가 순서대로 있다', async ({ page }) => {
    await waitForInit(page);
    await openGit(page);
    const tabs = page.locator('#area .pn-tab[data-git-view]');
    await expect(tabs).toHaveCount(6);
    const order = await tabs.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.gitView));
    expect(order).toEqual(VIEWS);
    await expect(tabs.locator('.pn-tab-label')).toHaveText(NAMES);
  });

  test('E4 (V20): 고정 탭 6개가 모두 채워져 있다', async ({ page }) => {
    await waitForInit(page);
    await openGit(page);
    for (const v of PENDING) {
      await page.locator(`#area .pn-tab[data-git-view="${v}"]`).click();
      const pending = page.locator('#area .pn-body .git-view.vis .git-pending');
      await expect(pending, `${v} 탭에 준비 중 안내가 없다`).toBeVisible();
      await expect(pending).toContainText(PENDING_HINT);
    }
    // 채워진 탭은 준비 중이 아니다. Console 은 FR-GIT-218 이 채웠다.
    for (const v of READY) {
      await page.locator(`#area .pn-tab[data-git-view="${v}"]`).click();
      await expect(page.locator('#area .pn-body .git-view.vis')).toHaveClass(new RegExp('git-' + v));
      await expect(page.locator('#area .pn-body .git-view.vis .git-pending')).toHaveCount(0);
    }
  });

  test('E5 (V20): git 탭은 닫히지 않는다', async ({ page }) => {
    await waitForInit(page);
    await openGit(page);
    await expect(page.locator('#area .pn-tab[data-git-view]')).toHaveCount(6);
    await expect(page.locator('#area .pn-tab[data-git-view] .pn-tab-x')).toHaveCount(0);

    // closeTab 을 직접 불러도 고정 탭은 남는다 (FR-GIT-28).
    await page.evaluate(() => {
      const app = (window as any).app;
      const w = app._gitWindow();
      return app.closeTab(w.layout.id, w.layout.tabs[0].id);
    });
    await expect(page.locator('#area .pn-tab[data-git-view]')).toHaveCount(6);
    expect(await gitWindowCount(page)).toBe(1);
  });

  test('E5b (V20 / FR-GIT-181): git 탭은 드래그로도 떼어내지지 않는다', async ({ page }) => {
    await waitForInit(page);
    await openGit(page);
    const tabs = page.locator('#area .pn-tab[data-git-view]');
    await expect(tabs).toHaveCount(6);
    // draggable=false 로 드래그 시작 자체를 막는다 (FR-GIT-28).
    expect(await tabs.evaluateAll((els) => els.every((e) => (e as HTMLElement).draggable))).toBe(false);

    // 드롭 경로를 직접 불러도 Git 창은 단일 칸 + 고정 탭 6개 그대로다.
    // (분할 자체가 막혔으므로 옮겨 갈 다른 칸이 애초에 없다 — FR-GIT-179.)
    const after = await page.evaluate(() => {
      const app = (window as any).app;
      const pane = app._gitWindow().layout;
      const gid = pane.tabs[0].id;
      app._moveTabToPane(pane.id, gid, pane.id, null, false);
      app._splitPaneWithTab(pane.id, gid, pane.id, 'right');
      return { type: app._gitWindow().layout.type, tabs: (app._gitWindow().layout.tabs || []).length };
    });
    expect(after).toEqual({ type: 'pane', tabs: 6 });
    await expect(page.locator('#area .pn-tab[data-git-view]')).toHaveCount(6);
    await expect(page.locator('#area .pn')).toHaveCount(1);
  });

  test('E6 (FR-GIT-179·180): Git 창은 분할되지 않고 분할 진입점도 없다', async ({ page }) => {
    // GIT_UI_REVISION_SRS 로 FR-GIT-27 이 폐기됐다 — Git 창은 닫힌 창이다.
    await waitForInit(page);
    await openGit(page);
    await expect(page.locator('#area .pn')).toHaveCount(1);

    await expect(page.locator('#split-h:visible')).toHaveCount(0);
    await page.evaluate(async () => {
      const a = (window as any).app;
      await a.executeAction('splitH');
      await a.executeAction('splitV');
    });
    await page.waitForTimeout(1200);
    await expect(page.locator('#area .pn')).toHaveCount(1);
    await expect(page.locator('#area .pn-tab[data-git-view]')).toHaveCount(6);
    expect(await gitWindowCount(page)).toBe(1);
  });

  test('E7 (FR-GIT-182·184): 창 전환 단축키는 Git 창을 지나가지 않는다', async ({ page }) => {
    // GIT_UI_REVISION_SRS 로 FR-GIT-30 이 폐기됐다.
    await waitForInit(page);
    const gid = await openGit(page);
    const other = await page.evaluate(
      (g) => (window as any).app.ws.windows.find((w: any) => w.id !== g)?.id, gid);
    expect(other, '비교할 다른 창이 없다').toBeTruthy();

    // Git 창에서 순환을 돌면 **나간다** — 단축키가 막다른 길이 되지 않는다.
    expect(await activeWindow(page)).toBe(gid);
    await page.evaluate(() => (window as any).app.executeAction('windowNext'));
    expect(await activeWindow(page)).toBe(other);
    // 일반 창이 하나뿐이므로 더 눌러도 그 자리다 — Git 창으로 돌아가지 않는다.
    await page.evaluate(() => (window as any).app.executeAction('windowNext'));
    expect(await activeWindow(page)).toBe(other);
    await page.evaluate(() => (window as any).app.executeAction('windowPrev'));
    expect(await activeWindow(page)).toBe(other);
  });

  test('E8 (V21): 새로고침 후 창·탭·활성 탭이 보존된다', async ({ page }) => {
    await waitForInit(page);
    await openGit(page);
    await page.locator('#area .pn-tab[data-git-view="console"]').click();
    await page.evaluate(() => (window as any).app._save());

    await page.reload();
    await page.waitForSelector('#area .pn-tab[data-git-view]', { timeout: 15000 });
    await expect(page.locator('#area .pn-tab[data-git-view]')).toHaveCount(6);
    expect(await gitWindowCount(page)).toBe(1);
    await expect(page.locator('#area .pn-tab.active[data-git-view]'))
      .toHaveAttribute('data-git-view', 'console');
    // 활성 탭의 본문이 그 탭의 것이어야 한다 — 이름만 살아남아서는 안 된다.
    await expect(page.locator('#area .pn-body .git-view.vis')).toHaveClass(/git-console/);
  });
});
