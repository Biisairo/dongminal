import { Page } from '@playwright/test';

import { test, expect } from './fixtures';

// GIT_M1_STEP3_CONTRACT §6 — 묶음 D 의 Git 창 골격. 검증 V8·V19·V20·V21.
//
// Git 창을 여는 UI 진입점은 4단계에 생긴다. 여기서는 계약 §6 대로 app 메서드를
// 직접 부른다.

const VIEWS = ['changes', 'diff', 'history', 'branches', 'stash', 'console'];
const NAMES = ['Changes', 'Diff', 'History', 'Branches', 'Stash', 'Console'];
const PENDING = ['history', 'branches', 'stash', 'console'];
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
    await expect(page.locator('#windows .si[data-window-type="git"]')).toHaveCount(1);
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

  test('E4 (V20): 미구현 4개 탭은 준비 중 안내를 보인다', async ({ page }) => {
    await waitForInit(page);
    await openGit(page);
    for (const v of PENDING) {
      await page.locator(`#area .pn-tab[data-git-view="${v}"]`).click();
      const pending = page.locator('#area .pn-body .git-view.vis .git-pending');
      await expect(pending, `${v} 탭에 준비 중 안내가 없다`).toBeVisible();
      await expect(pending).toContainText(PENDING_HINT);
    }
    // changes 는 준비 중이 아니다 — 5단계가 채운다.
    await page.locator('#area .pn-tab[data-git-view="changes"]').click();
    await expect(page.locator('#area .pn-body .git-view.vis')).toHaveClass(/git-changes/);
    await expect(page.locator('#area .pn-body .git-view.vis .git-pending')).toHaveCount(0);
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

  test('E5b (V20): git 탭은 드래그로도 떼어내지지 않는다', async ({ page }) => {
    await waitForInit(page);
    await openGit(page);
    const tabs = page.locator('#area .pn-tab[data-git-view]');
    await expect(tabs).toHaveCount(6);
    // draggable=false 로 드래그 시작 자체를 막는다 (FR-GIT-28).
    expect(await tabs.evaluateAll((els) => els.every((e) => (e as HTMLElement).draggable))).toBe(false);

    await page.click('#split-h');
    await expect(page.locator('#area .pn')).toHaveCount(2);

    // 드롭 경로를 직접 불러도 git 탭은 원래 pane 에 남는다.
    const perPane = await page.evaluate(() => {
      const app = (window as any).app;
      const panes = () => app._gitWindow().layout.children;
      const src = panes().find((c: any) => (c.tabs || []).some((t: any) => t.type === 'git'));
      const dst = panes().find((c: any) => c.id !== src.id);
      const gid = src.tabs[0].id;
      app._moveTabToPane(src.id, gid, dst.id, null, false);
      app._splitPaneWithTab(src.id, gid, dst.id, 'right');
      return panes().map((c: any) => (c.tabs || []).filter((t: any) => t.type === 'git').length);
    });
    expect(perPane, 'git 탭이 다른 pane 으로 흩어졌다').toEqual([6, 0]);
    await expect(page.locator('#area .pn-tab[data-git-view]')).toHaveCount(6);
    await expect(page.locator('#area .pn')).toHaveCount(2);
  });

  test('E6 (V19): Git 창에서 분할하면 터미널 pane 이 생기고 Git 탭은 남는다', async ({ page }) => {
    await waitForInit(page);
    await openGit(page);
    await expect(page.locator('#area .pn')).toHaveCount(1);

    await page.click('#split-h');
    await expect(page.locator('#area .pn')).toHaveCount(2);
    await expect(page.locator('#area .pn-tab[data-git-view]')).toHaveCount(6);
    await page.waitForSelector('#area .pn .xterm-helper-textarea', { timeout: 15000 });
    expect(await gitWindowCount(page)).toBe(1);
  });

  test('E7 (V19): 창 전환 단축키로 Git 창을 지나갈 수 있다', async ({ page }) => {
    await waitForInit(page);
    const gid = await openGit(page);
    const other = await page.evaluate(
      (g) => (window as any).app.ws.windows.find((w: any) => w.id !== g)?.id, gid);
    expect(other, '비교할 다른 창이 없다').toBeTruthy();

    expect(await activeWindow(page)).toBe(gid);
    await page.evaluate(() => (window as any).app.executeAction('windowNext'));
    expect(await activeWindow(page)).toBe(other);
    await page.evaluate(() => (window as any).app.executeAction('windowNext'));
    expect(await activeWindow(page)).toBe(gid);
    await expect(page.locator('#area .pn-tab[data-git-view]')).toHaveCount(6);
  });

  test('E8 (V21): 새로고침 후 창·탭·활성 탭이 보존된다', async ({ page }) => {
    await waitForInit(page);
    await openGit(page);
    await page.locator('#area .pn-tab[data-git-view="branches"]').click();
    await page.evaluate(() => (window as any).app._save());

    await page.reload();
    await page.waitForSelector('#area .pn-tab[data-git-view]', { timeout: 15000 });
    await expect(page.locator('#area .pn-tab[data-git-view]')).toHaveCount(6);
    expect(await gitWindowCount(page)).toBe(1);
    await expect(page.locator('#area .pn-tab.active[data-git-view]'))
      .toHaveAttribute('data-git-view', 'branches');
    await expect(page.locator('#area .pn-body .git-view.vis .git-pending')).toBeVisible();
  });
});
