import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { Page } from '@playwright/test';

import { test, expect, waitForInit, waitSettled, GIT_VIEW_TABS } from './fixtures';

// 칸별 시선 — SLOT_VIEW_STATE_SRS §8
//
// M1 은 묶음 T(칸별 활성 탭)와 F(편집기 회수 결함)다. 칸은 클라이언트의 것이므로
// (FR-WSL-2) 검증은 DOM 과 sessionStorage 로 하고, 서버를 보는 것은 FR-SVS-14
// 하나뿐이다 — 포커스 칸의 탭이 워크스페이스에 반영되는지가 `dmctl` 의 활성
// 판정(SRS §2.4)을 지탱하기 때문이다.

const slotAdd = (page: Page) => page.evaluate(() => (window as any).app.slotAdd());
const renderNow = (page: Page) => page.evaluate(() => (window as any).app.render());
const focusSlot = (page: Page, i: number) =>
  page.evaluate((n) => (window as any).app.slotFocusTo(n), i);
const openInSlot = (page: Page, i: number, winId: string) =>
  page.evaluate(([n, id]) => (window as any).app.slotOpen(n, id), [i, winId] as const);
const activeWindowOf = (page: Page) => page.evaluate(() => (window as any).app.ws.activeWindow);
const slotsState = (page: Page) => page.evaluate(() => (window as any).app.slots);

/**
 * **개정 (REPO_TAB_UNIFY_SRS FR-RTU-70·72).** `openGitWindow()` 는 경로 없이는
 * 아무것도 열지 않는다 — 창의 신원이 루트이기 때문이다 (D-RTU-18). 그리고 뷰는
 * 고정 탭이 아니라 **필요할 때 여는 본문 탭**이므로(FR-RTU-30) 이 묶음이 재는
 * "칸마다 다른 탭" 을 위해 여섯을 미리 세운다.
 */
const TOP_FIXTURES = '/tmp/dm-git-fx-svs-top-' + process.pid;
test.beforeAll(() => {
  execFileSync('bash', ['e2e/git_fixture.sh', TOP_FIXTURES], { stdio: 'ignore' });
});
test.afterAll(() => {
  execFileSync('bash', ['e2e/git_fixture.sh', '--clean', TOP_FIXTURES], { stdio: 'ignore' });
});
const topFx = (name: string) => fs.realpathSync(path.join(TOP_FIXTURES, name));

const openGitWindow = async (page: Page) => {
  const repo = topFx('basic');
  await page.evaluate((r: string) => (window as any).app.openGitWindow(r), repo);
  await page.waitForSelector('#area .ed-win .ed-side', { timeout: 15000 });
  await page.evaluate(() => {
    const a = (window as any).app;
    a._edSetSide(a._aw(), 'changes');
    const p = a.gitPanel;
    for (const v of ['diff', 'history', 'branches', 'stash', 'console', 'worktrees']) p.openView(v);
  });
  await expect(page.locator('#area .pn-tab[data-git-view]')).toHaveCount(GIT_VIEW_TABS);
  const id = await page.evaluate((r: string) => (window as any).app._edWindowFor(r).id, repo);
  await page.evaluate(() => (window as any).app.render());
  return id;
};

// 칸 i 의 탭 바. 단일 슬롯 모드에서는 `.slot` 이 없으므로 `#area` 를 딛는다.
const paneOf = (page: Page, slot: number | null) =>
  slot === null
    ? page.locator('#area .pn')
    : page.locator(`#area .slot[data-slot="${slot}"] .pn`);

const activeTabLabel = (page: Page, slot: number | null) =>
  paneOf(page, slot).locator('.pn-tab.active .pn-tab-label').innerText();

const clickTab = async (page: Page, slot: number | null, name: string) => {
  await paneOf(page, slot).locator('.pn-tab', { hasText: name }).first().click();
};

// 터미널 탭은 기본 이름이 모두 같다 — 이름으로 비교하면 어떤 구현에서도 통과한다.
// 그래서 탭의 정체는 **id** 로 본다.
const activeTabId = (page: Page, slot: number | null) =>
  paneOf(page, slot).locator('.pn-tab.active').first().getAttribute('data-tab-id');

const clickTabId = async (page: Page, slot: number | null, tid: string) => {
  await paneOf(page, slot).locator(`.pn-tab[data-tab-id="${tid}"]`).first().click();
};

const tabIdsOf = (page: Page, winId: string) =>
  page.evaluate((id) => {
    const w = (window as any).app.ws.windows.find((s: any) => s.id === id);
    const walk = (n: any): any => (n.type === 'pane' ? n : walk(n.children[0]));
    return walk(w.layout).tabs.map((t: any) => ({ id: t.id, toolId: t.toolId }));
  }, winId);

// 그 칸이 실제로 그린 Git 뷰. 본문에 붙은 `.git-view` 의 클래스가 말한다.
const gitViewIn = (page: Page, slot: number) =>
  page.evaluate((n) => {
    const body = document.querySelector(`#area .slot[data-slot="${n}"] .pn-body`);
    const v = body && body.querySelector('.git-view');
    if (!v) return null;
    return [...v.classList].find((c) => c.startsWith('git-') && c !== 'git-view') || null;
  }, slot);

const addTabTo = (page: Page, paneId: string) =>
  page.evaluate(async (rid) => {
    await (window as any).app.addTab(rid);
    (window as any).app.render();
  }, paneId);

const firstPaneId = (page: Page, winId: string) =>
  page.evaluate((id) => {
    const w = (window as any).app.ws.windows.find((s: any) => s.id === id);
    const walk = (n: any) => (n.type === 'pane' ? n : walk(n.children[0]));
    return walk(w.layout).id;
  }, winId);

const stateActiveTab = async (request: any, winId: string) => {
  const r = await request.get('/api/state');
  expect(r.ok()).toBeTruthy();
  const st = await r.json();
  const w = (st.workspace?.windows || []).find((s: any) => s.id === winId);
  const walk = (n: any): any => (n?.type === 'pane' ? n : walk(n?.children?.[0]));
  return walk(w?.layout)?.activeTab || null;
};

test.describe('묶음 T — 칸별 활성 탭 (FR-SVS-1~14)', () => {
  test('TC-SVS-1: 두 칸이 같은 창의 서로 다른 탭을 본다 (FR-SVS-1·4·9)', async ({ page }) => {
    await waitForInit(page);
    const git = await openGitWindow(page);
    await slotAdd(page);
    await openInSlot(page, 0, git);
    await openInSlot(page, 1, git);

    /**
     * 두 칸이 **각자** 탭을 고른다.
     *
     * **개정 (FR-RTU-30·32).** 옛 Git 창은 고정 탭 일곱으로 열리고 첫 탭이
     * `Changes` 였다. 지금 본문의 뷰 탭은 필요할 때 열리고 `Changes` 는 사이드에
     * 있으므로(FR-RTU-32) "칸 0 은 Changes 를 그대로 본다" 라는 기준점이 없다 —
     * 양쪽을 명시적으로 고른다. 재는 것은 그대로다: 칸마다 활성 탭이 다르다.
     */
    await focusSlot(page, 0);
    await clickTab(page, 0, 'Diff');
    await focusSlot(page, 1);
    await clickTab(page, 1, 'History');

    expect(await activeTabLabel(page, 0)).toBe('Diff');
    expect(await activeTabLabel(page, 1)).toBe('History');

    // 양쪽 모두 자기 뷰를 실제로 그렸다 — 한쪽이 빈 것이 접수된 결함이었다.
    expect(await gitViewIn(page, 0)).toBe('git-diff');
    expect(await gitViewIn(page, 1)).toBe('git-history');
  });

  test('TC-SVS-2: 새로고침 후 각 칸이 보던 탭으로 돌아온다 (FR-SVS-6)', async ({ page }) => {
    await waitForInit(page);
    const git = await openGitWindow(page);
    await slotAdd(page);
    await openInSlot(page, 0, git);
    await openInSlot(page, 1, git);
    await focusSlot(page, 1);
    await clickTab(page, 1, 'Branches');
    await focusSlot(page, 0);
    await clickTab(page, 0, 'Stash');

    // FR-EQS-7: 칸별 시선도 워크스페이스 저장을 타고 남는다.
    await waitSettled(page);
    await page.reload();
    await page.waitForSelector('#area .slot[data-slot="1"]', { timeout: 15000 });

    expect(await activeTabLabel(page, 0)).toBe('Stash');
    expect(await activeTabLabel(page, 1)).toBe('Branches');
  });

  test('TC-SVS-3: 한 칸이 보던 탭을 닫으면 그 칸만 움직인다 (FR-SVS-5·10)', async ({ page }) => {
    await waitForInit(page);
    const win = await activeWindowOf(page);
    const rid = await firstPaneId(page, win);
    await addTabTo(page, rid);
    await addTabTo(page, rid);
    const tabs = await tabIdsOf(page, win);
    expect(tabs.length).toBe(3);

    await slotAdd(page);
    await openInSlot(page, 0, win);
    await openInSlot(page, 1, win);

    // 칸 0 은 첫 탭, 칸 1 은 마지막 탭을 본다.
    await focusSlot(page, 0);
    await clickTabId(page, 0, tabs[0].id);
    await focusSlot(page, 1);
    await clickTabId(page, 1, tabs[2].id);
    expect(await activeTabId(page, 0)).toBe(tabs[0].id);
    expect(await activeTabId(page, 1)).toBe(tabs[2].id);

    // 칸 1 이 보던 탭을 닫는다 → 칸 1 만 이웃으로 가고 칸 0 은 그대로다.
    await page.locator(`#area .slot[data-slot="1"] .pn-tab[data-tab-id="${tabs[2].id}"] .pn-tab-x`)
      .first().click();
    await page.waitForFunction(
      (n) => document.querySelectorAll('#area .slot[data-slot="1"] .pn-tab').length === n,
      2, { timeout: 10000 });

    expect(await activeTabId(page, 0)).toBe(tabs[0].id);
    expect(await activeTabId(page, 1)).toBe(tabs[1].id);
  });

  test('TC-SVS-4: 단일 슬롯 모드는 오버라이드를 두지 않는다 (FR-SVS-2·72)', async ({ page }) => {
    await waitForInit(page);
    const git = await openGitWindow(page);
    await clickTab(page, null, 'History');

    // 슬롯 상태 자체가 없다 — 단일 슬롯 모드의 표현은 `slots === null` 이다.
    expect(await slotsState(page)).toBeNull();
    expect(await activeTabLabel(page, null)).toBe('History');

    // 워크스페이스의 activeTab 이 그 탭이다 — 본 SRS 이전과 같은 동작이다.
    const shown = await page.evaluate((id) => {
      const w = (window as any).app.ws.windows.find((s: any) => s.id === id);
      const walk = (n: any): any => (n.type === 'pane' ? n : walk(n.children[0]));
      const pn = walk(w.layout);
      return pn.tabs.find((t: any) => t.id === pn.activeTab)?.name || null;
    }, git);
    expect(shown).toBe('History');
  });

  test('TC-SVS-5: 포커스 칸의 탭이 워크스페이스에 반영된다 (FR-SVS-14)', async ({ page, request }) => {
    await waitForInit(page);
    const git = await openGitWindow(page);
    await slotAdd(page);
    await openInSlot(page, 0, git);
    await openInSlot(page, 1, git);

    // 비포커스 칸(1)이 Console 로 가도 워크스페이스는 움직이지 않는다.
    // `Changes` 는 사이드에 있으므로(FR-RTU-32) 본문의 기준 탭은 `Diff` 다.
    await focusSlot(page, 0);
    await clickTab(page, 0, 'Diff');
    await focusSlot(page, 1);
    await clickTab(page, 1, 'Console');
    // 포커스는 칸 1 이므로 이제 워크스페이스가 Console 을 말해야 한다.
    await page.waitForTimeout(300);
    let at = await stateActiveTab(request, git);
    let name = await page.evaluate(([id, tid]) => {
      const w = (window as any).app.ws.windows.find((s: any) => s.id === id);
      const walk = (n: any): any => (n.type === 'pane' ? n : walk(n.children[0]));
      return walk(w.layout).tabs.find((t: any) => t.id === tid)?.name || null;
    }, [git, at] as const);
    expect(name).toBe('Console');

    // 포커스를 칸 0 으로 옮기면 워크스페이스는 칸 0 이 보는 것을 말한다.
    await focusSlot(page, 0);
    await page.waitForTimeout(300);
    at = await stateActiveTab(request, git);
    name = await page.evaluate(([id, tid]) => {
      const w = (window as any).app.ws.windows.find((s: any) => s.id === id);
      const walk = (n: any): any => (n.type === 'pane' ? n : walk(n.children[0]));
      return walk(w.layout).tabs.find((t: any) => t.id === tid)?.name || null;
    }, [git, at] as const);
    expect(name).toBe('Diff');
  });

  test('TC-SVS-13: 알람 판정은 어느 칸에서든 보이면 보인다 (FR-SVS-13)', async ({ page }) => {
    await waitForInit(page);
    const win = await activeWindowOf(page);
    const rid = await firstPaneId(page, win);
    await addTabTo(page, rid);
    await addTabTo(page, rid);
    const tabs = await tabIdsOf(page, win);
    expect(tabs.length).toBe(3);

    await slotAdd(page);
    await openInSlot(page, 0, win);
    await openInSlot(page, 1, win);
    // 칸 0 은 탭 A, 칸 1 은 탭 B. 탭 C 는 어느 칸에도 보이지 않는다.
    await focusSlot(page, 1);
    await clickTabId(page, 1, tabs[1].id);
    await focusSlot(page, 0);
    await clickTabId(page, 0, tabs[0].id);

    const seen = async (toolId: string) =>
      page.evaluate((t) => (window as any).app._isToolFocusedActive(t), toolId);

    expect(await seen(tabs[0].toolId)).toBe(true);   // 포커스 칸이 본다
    expect(await seen(tabs[1].toolId)).toBe(true);   // 다른 칸이 본다 — FR-SVS-13
    expect(await seen(tabs[2].toolId)).toBe(false);  // 아무 칸도 보지 않는다
  });

  test('TC-SVS-50: 원격 워크스페이스 변경이 와도 칸별 탭이 살아남는다 (FR-SVS-7)', async ({ browser }) => {
    // 구조 변경은 받아들이면서 **보는 자리는 로컬이 이긴다** — `activeWindow`·
    // `focusedPane` 과 같은 범주다 (app-cmd.js 의 보존 블록). SSE 는 실제로 다른
    // 클라이언트에서 와야 하므로 컨텍스트를 둘 띄운다 (sync.spec.ts 의 선례).
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    try {
      for (const c of [ctxA, ctxB]) {
        await c.addInitScript(() => sessionStorage.setItem('displayMode', 'desktop'));
      }
      const pageA = await ctxA.newPage();
      const pageB = await ctxB.newPage();
      for (const pg of [pageA, pageB]) {
        await pg.goto('/');
        await pg.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
      }

      // B 가 칸 둘에 같은 창을 두고 각자 다른 탭을 본다.
      const win = await activeWindowOf(pageB);
      const rid = await firstPaneId(pageB, win);
      await addTabTo(pageB, rid);
      const tabs = await tabIdsOf(pageB, win);
      await slotAdd(pageB);
      await openInSlot(pageB, 0, win);
      await openInSlot(pageB, 1, win);
      await focusSlot(pageB, 0);
      await clickTabId(pageB, 0, tabs[0].id);
      await focusSlot(pageB, 1);
      await clickTabId(pageB, 1, tabs[1].id);
      expect(await activeTabId(pageB, 0)).toBe(tabs[0].id);
      expect(await activeTabId(pageB, 1)).toBe(tabs[1].id);

      // A 가 창을 하나 더 만든다 → B 에 workspace_changed 가 온다.
      const beforeB = await pageB.locator('#windows .si').count();
      await pageA.click('#add-window');
      await expect(pageB.locator('#windows .si')).toHaveCount(beforeB + 1, { timeout: 15000 });

      // 구조는 따라왔지만 각 칸이 보던 탭은 그대로다.
      expect(await activeTabId(pageB, 0)).toBe(tabs[0].id);
      expect(await activeTabId(pageB, 1)).toBe(tabs[1].id);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  test('TC-SVS-54: 탭을 다른 분할 칸으로 옮기면 그 시선이 따라간다 (FR-SVS-11)', async ({ page }) => {
    await waitForInit(page);
    const win = await activeWindowOf(page);
    const rid0 = await firstPaneId(page, win);
    await addTabTo(page, rid0);
    const tabs = await tabIdsOf(page, win);

    // 분할로 pane 을 둘 만든다 — 탭 이동은 pane 사이의 일이다.
    await page.evaluate(() => (window as any).app.split('horizontal'));
    await page.waitForFunction(
      () => document.querySelectorAll('#area .pn').length >= 2, undefined, { timeout: 10000 });
    const panes = await page.evaluate((id) => {
      const w = (window as any).app.ws.windows.find((s: any) => s.id === id);
      const out: string[] = [];
      const walk = (n: any) => {
        if (!n) return;
        if (n.type === 'pane') { out.push(n.id); return }
        (n.children || []).forEach(walk);
      };
      walk(w.layout);
      return out;
    }, win);
    expect(panes.length).toBeGreaterThanOrEqual(2);
    const dst = panes.find((x: string) => x !== rid0);

    await slotAdd(page);
    await openInSlot(page, 0, win);
    await openInSlot(page, 1, win);

    // 도착 pane 에는 분할이 만든 탭이 이미 있다. **칸 1 이 그것을 보게** 두어야
    // 이 검사가 오버라이드를 실제로 잰다 — 그러지 않으면 폴백(`pn.activeTab`)만으로
    // 통과해 버린다.
    const dstTabs = await page.evaluate(([id, d]) => {
      const w = (window as any).app.ws.windows.find((s: any) => s.id === id);
      const find = (n: any): any => {
        if (!n) return null;
        if (n.type === 'pane') return n.id === d ? n : null;
        for (const c of (n.children || [])) { const r = find(c); if (r) return r }
        return null;
      };
      return find(w.layout).tabs.map((t: any) => t.id);
    }, [win, dst] as const);
    expect(dstTabs.length).toBe(1);
    await focusSlot(page, 1);
    await clickTabId(page, 1, dstTabs[0]);
    await focusSlot(page, 0);

    // 탭을 다른 pane 으로 옮긴다 (드롭 핸들러가 지나는 단일 통로).
    await page.evaluate(([src, tid, d]) =>
      (window as any).app._moveTabToPane(src, tid, d, null, false),
      [rid0, tabs[1].id, dst] as const);
    await renderNow(page);

    // 옮긴 칸의 시선이 그 탭을 **도착한 pane 에서** 가리킨다.
    const shown = await page.evaluate(([id, d]) => {
      const a = (window as any).app;
      const w = a.ws.windows.find((s: any) => s.id === id);
      const find = (n: any): any => {
        if (!n) return null;
        if (n.type === 'pane') return n.id === d ? n : null;
        for (const c of (n.children || [])) { const r = find(c); if (r) return r }
        return null;
      };
      const pn = find(w.layout);
      return pn ? [a.paneTab(pn, 0), a.paneTab(pn, 1)] : null;
    }, [win, dst] as const);
    // 옮긴 칸은 그 탭을, 다른 칸은 자기가 보던 탭을 그대로 본다.
    expect(shown[0]).toBe(tabs[1].id);
    expect(shown[1]).toBe(dstTabs[0]);
  });

  test('TC-SVS-55: pane·칸 이동은 시선을 건드리지 않는다 (FR-SVS-8)', async ({ page }) => {
    await waitForInit(page);
    const win = await activeWindowOf(page);
    const rid = await firstPaneId(page, win);
    await addTabTo(page, rid);
    const tabs = await tabIdsOf(page, win);

    await slotAdd(page);
    await openInSlot(page, 0, win);
    await openInSlot(page, 1, win);
    await focusSlot(page, 0);
    await clickTabId(page, 0, tabs[0].id);
    await focusSlot(page, 1);
    await clickTabId(page, 1, tabs[1].id);

    // 칸 사이를 오간다 — 포커스가 움직이는 것과 보는 탭이 바뀌는 것은 다른 사건이다.
    await page.evaluate(() => (window as any).app.paneNavigate('left'));
    await page.evaluate(() => (window as any).app.paneNavigate('right'));
    await renderNow(page);

    expect(await activeTabId(page, 0)).toBe(tabs[0].id);
    expect(await activeTabId(page, 1)).toBe(tabs[1].id);
  });

  test('TC-SVS-56: 알람이 부른 탭은 포커스 칸에 뜬다 (FR-SVS-12)', async ({ page }) => {
    await waitForInit(page);
    const win = await activeWindowOf(page);
    const rid = await firstPaneId(page, win);
    await addTabTo(page, rid);
    const tabs = await tabIdsOf(page, win);

    await slotAdd(page);
    await openInSlot(page, 0, win);
    await openInSlot(page, 1, win);
    // 두 칸 모두 첫 탭을 보게 두고 포커스는 칸 1 에 둔다.
    await focusSlot(page, 0);
    await clickTabId(page, 0, tabs[0].id);
    await focusSlot(page, 1);
    await clickTabId(page, 1, tabs[0].id);

    // 알람이 둘째 탭의 도구를 부른다 — 사용자는 포커스 칸에 있다.
    await page.evaluate((t) => (window as any).app._jumpToTool(t), tabs[1].toolId);
    await renderNow(page);

    expect(await activeTabId(page, 1)).toBe(tabs[1].id);
    // 다른 칸은 끌려가지 않는다.
    expect(await activeTabId(page, 0)).toBe(tabs[0].id);
  });

  test('TC-SVS-58: 형식이 어긋난 슬롯 키는 버려지고 단일 슬롯으로 떨어진다 (FR-SVS-71)', async ({ page }) => {
    // `tabs` 만 망가진 것이 아니라 배치 자체가 어긋난 값이다 — 그때는 키를 지우고
    // 단일 슬롯 모드로 간다 (FR-WSL-72 의 규약 그대로).
    await page.context().addInitScript(() => {
      sessionStorage.setItem('displayMode', 'desktop');
      sessionStorage.setItem('slots', JSON.stringify({ windows: ['x'], sizes: [1, 2], focused: 9 }));
    });
    await page.goto('/');
    await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });

    expect(await slotsState(page)).toBeNull();
    expect(await page.evaluate(() => sessionStorage.getItem('slots'))).toBeNull();
  });
});

test.describe('묶음 F — 함께 고치는 결함 (FR-SVS-60)', () => {
  // Editor 표면은 `/api/editors` 의 `home` 이 있어야 켜진다 (FR-EDT-120). 서버
  // 표면은 이 스펙의 대상이 아니므로 계약만 세운다 — editor-tab.spec.ts 와 같은
  // 방식이다. root Editor 창은 `_edReconcile` 이 그 home 으로 만든다 (FR-EDT-42).
  let HOME_DIR = '';
  let SOME_FILE = '';

  test.beforeAll(() => {
    HOME_DIR = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-svs-')));
    SOME_FILE = path.join(HOME_DIR, 'm1.txt');
    fs.writeFileSync(SOME_FILE, 'hello\n');
  });
  test.afterAll(() => {
    if (HOME_DIR) fs.rmSync(HOME_DIR, { recursive: true, force: true });
  });

  test('TC-SVS-6: 칸 2·3 의 편집기가 render 로 파괴되지 않는다', async ({ page }) => {
    await page.route('**/api/editors', async (route) => {
      await route.fulfill({ json: { home: HOME_DIR, list: [] } });
    });
    await waitForInit(page);

    // root Editor 창이 섰는지 확인한다 — 이것이 없으면 편집기 탭을 열 길이 없다.
    await page.waitForFunction(
      () => (window as any).app.ws.windows.some((w: any) => w.type === 'editor'),
      undefined, { timeout: 10000 });
    const edWin = await page.evaluate(
      () => (window as any).app.ws.windows.find((w: any) => w.type === 'editor').id);

    const opened = await page.evaluate((fp) => (window as any).app._edOpenFile(fp), SOME_FILE);
    expect(opened).not.toBeNull();
    await renderNow(page);

    // 칸 넷 모두 같은 Editor 창을 본다 → 편집기 인스턴스가 칸마다 선다.
    await slotAdd(page);
    await slotAdd(page);
    await slotAdd(page);
    for (let i = 0; i < 4; i++) await openInSlot(page, i, edWin);
    await renderNow(page);
    await page.waitForTimeout(300);

    const before = await page.evaluate(() => [...(window as any).app.fileEditors.keys()]);
    expect(before.filter((k: string) => k.endsWith('@2')).length).toBe(1);
    expect(before.filter((k: string) => k.endsWith('@3')).length).toBe(1);

    // 렌더를 여러 번 돌려도 살아 있는 편집기는 회수되지 않는다.
    await page.evaluate(() => { for (let i = 0; i < 3; i++) (window as any).app.render() });
    await page.waitForTimeout(300);

    const after = await page.evaluate(() => [...(window as any).app.fileEditors.keys()]);
    expect(after.sort()).toEqual(before.sort());
  });
});

test.describe('묶음 X — 탐색기의 관측과 시선 (FR-SVS-20~24)', () => {
  // 루트는 **서버에 실제로 등록**한다 (`/api/editors/add`) — editor-explorer.spec.ts
  // 와 같은 경로다. `/api/fs/*` 를 스텁하면 서버의 허용 루트 밖이라 403 이 오고,
  // 재는 것이 탐색기가 아니라 권한 검사가 된다.
  let BASE = '';
  let ROOT = '';

  test.beforeAll(() => {
    BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-svs-x-')));
    ROOT = path.join(BASE, 'proj');
    fs.mkdirSync(ROOT);
    for (const d of ['dirA', 'dirB']) {
      fs.mkdirSync(path.join(ROOT, d));
      fs.writeFileSync(path.join(ROOT, d, 'inside.txt'), 'x\n');
    }
  });
  test.afterAll(() => {
    if (BASE) fs.rmSync(BASE, { recursive: true, force: true });
  });

  async function twoSlotsOnEditor(page: Page, request: any) {
    const r = await request.post('/api/editors/add', { data: { path: ROOT } });
    expect(r.ok(), `editors/add 실패: ${await r.text()}`).toBeTruthy();
    await waitForInit(page);
    await page.waitForFunction(
      () => !!(window as any).app?._editors && (window as any).app._edWindows().length > 0,
      undefined, { timeout: 15000 });
    const edWin = await page.evaluate((root) => {
      const a = (window as any).app;
      const win = a._edWindows().find((x: any) => x.editor && x.editor.root === root);
      if (!win) throw new Error('Editor 창이 없다: ' + root);
      a.switchWindow(win.id);
      return win.id;
    }, ROOT);
    await slotAdd(page);
    await openInSlot(page, 0, edWin);
    await openInSlot(page, 1, edWin);
    await renderNow(page);
    await page.waitForFunction(() =>
      document.querySelectorAll('#area .slot .ed-explorer').length === 2
      && document.querySelectorAll('#area .slot[data-slot="0"] .ed-row').length > 0
      && document.querySelectorAll('#area .slot[data-slot="1"] .ed-row').length > 0,
      undefined, { timeout: 15000 });
    return edWin;
  }

  const rowIn = (page: Page, slot: number, p: string) =>
    page.locator(`#area .slot[data-slot="${slot}"] .ed-row[data-path="${p}"]`);

  // 이 묶음은 **X(관측과 시선)만** 재려 하므로 포커스를 명시적으로 옮긴 뒤 행을
  // 누른다. 비포커스 칸을 한 번 눌러도 듣는다는 것은 FR-SVS-61 의 요구이고
  // TC-SVS-40·41 이 따로 잰다 — 한 검사가 두 요구에 걸치면 무엇이 깨졌는지
  // 실패가 말해 주지 못한다.
  const clickRow = async (page: Page, slot: number, p: string) => {
    await focusSlot(page, slot);
    await rowIn(page, slot, p).click();
  };

  test('TC-SVS-10: 칸마다 다른 폴더를 펼친다 (FR-SVS-21)', async ({ page, request }) => {
    await twoSlotsOnEditor(page, request);
    const A = path.join(ROOT, 'dirA'), B = path.join(ROOT, 'dirB');

    // 두 칸 모두 탐색기를 갖는다 — 예전에는 뒤 칸이 앞 칸에서 떼어 갔다.
    expect(await page.locator('#area .slot[data-slot="0"] .ed-explorer').count()).toBe(1);
    expect(await page.locator('#area .slot[data-slot="1"] .ed-explorer').count()).toBe(1);

    await clickRow(page, 0, A);
    await expect(rowIn(page, 0, path.join(A, 'inside.txt'))).toHaveCount(1);
    await clickRow(page, 1, B);
    await expect(rowIn(page, 1, path.join(B, 'inside.txt'))).toHaveCount(1);

    // 펼침은 칸의 것이다 — 서로 새지 않는다 (FR-SVS-21).
    await expect(rowIn(page, 0, path.join(B, 'inside.txt'))).toHaveCount(0);
    await expect(rowIn(page, 1, path.join(A, 'inside.txt'))).toHaveCount(0);
  });

  test('TC-SVS-11: 관측은 루트마다 하나다 (FR-SVS-20)', async ({ page, request }) => {
    let statusReqs = 0;
    page.on('request', (r) => { if (r.url().includes('/api/git/status')) statusReqs++ });
    await twoSlotsOnEditor(page, request);
    await slotAdd(page);
    await slotAdd(page);
    const edWin = await page.evaluate((root) =>
      (window as any).app._edWindows().find((x: any) => x.editor && x.editor.root === root).id, ROOT);
    for (let i = 0; i < 4; i++) await openInSlot(page, i, edWin);
    await renderNow(page);
    await page.waitForFunction(
      () => document.querySelectorAll('#area .slot .ed-explorer').length === 4,
      undefined, { timeout: 15000 });

    // 시선은 넷, 관측은 하나다.
    expect(await page.evaluate(() => (window as any).app._edTrees.size)).toBe(4);
    expect(await page.evaluate(() => (window as any).app._edStores.size)).toBe(1);

    // 네 뷰가 동시에 git 색을 물어도 요청은 한 벌이다 — `gitBusy` 가 공유이기
    // 때문이며, 그것이 "폴링은 하나, 화면은 여럿" 의 실체다.
    const before = statusReqs;
    await page.evaluate(async () => {
      const ts = [...(window as any).app._edTrees.values()];
      await Promise.all(ts.map((t: any) => t.pollGit()));
    });
    expect(statusReqs - before).toBeLessThanOrEqual(1);
  });

  test('TC-SVS-41: 비포커스 칸의 폴더를 한 번 눌러 펼쳐진다 (FR-SVS-61)', async ({ page, request }) => {
    await twoSlotsOnEditor(page, request);
    const B = path.join(ROOT, 'dirB');
    // 포커스를 칸 0 에 두고 **칸 1** 의 폴더를 한 번만 누른다.
    await focusSlot(page, 0);
    await rowIn(page, 1, B).click();
    // 그 한 번으로 칸 1 이 포커스가 되고 폴더가 펼쳐진다.
    await expect(rowIn(page, 1, path.join(B, 'inside.txt'))).toHaveCount(1);
    expect(await page.evaluate(() => (window as any).app.slots.focused)).toBe(1);
  });

  test('TC-SVS-12: 칸을 없애면 그 시선만 거둬진다 (FR-SVS-23)', async ({ page, request }) => {
    await twoSlotsOnEditor(page, request);
    const A = path.join(ROOT, 'dirA');
    await clickRow(page, 0, A);
    await expect(rowIn(page, 0, path.join(A, 'inside.txt'))).toHaveCount(1);
    expect(await page.evaluate(() => (window as any).app._edTrees.size)).toBe(2);

    // 칸 1 을 없앤다 → 칸 0 의 펼침은 그대로고, 관측도 살아 있다.
    await page.evaluate(() => {
      (window as any).app.slotFocusTo(1);
      (window as any).app.slotRemove();
    });
    await renderNow(page);
    await page.waitForFunction(
      () => document.querySelectorAll('#area .ed-explorer').length === 1,
      undefined, { timeout: 15000 });

    await expect(page.locator(`#area .ed-row[data-path="${path.join(A, 'inside.txt')}"]`))
      .toHaveCount(1);
    expect(await page.evaluate(() => (window as any).app._edTrees.size)).toBe(1);
    expect(await page.evaluate(() => (window as any).app._edStores.size)).toBe(1);
  });
});

test.describe('묶음 F — 누른 한 번이 듣는다 (FR-SVS-61)', () => {
  test('TC-SVS-40: 비포커스 칸의 탭을 한 번 눌러 그 탭이 열린다', async ({ page }) => {
    await waitForInit(page);
    const git = await openGitWindow(page);
    await slotAdd(page);
    await openInSlot(page, 0, git);
    await openInSlot(page, 1, git);

    // 포커스를 칸 0 에 두고 **칸 1** 의 History 를 한 번만 누른다.
    // 기준 탭은 `Diff` 다 — `Changes` 는 사이드로 갔다 (FR-RTU-32).
    await focusSlot(page, 0);
    await clickTab(page, 0, 'Diff');
    await focusSlot(page, 1);
    await clickTab(page, 1, 'Diff');
    await focusSlot(page, 0);
    expect(await activeTabLabel(page, 1)).toBe('Diff');
    await clickTab(page, 1, 'History');

    // 그 한 번으로 칸 1 이 포커스가 되고 그 탭이 열린다 — 두 번 누를 필요가 없다.
    expect(await page.evaluate(() => (window as any).app.slots.focused)).toBe(1);
    expect(await activeTabLabel(page, 1)).toBe('History');
    // 칸 0 은 자기 탭을 그대로 본다.
    expect(await activeTabLabel(page, 0)).toBe('Diff');
  });
});

test.describe('묶음 O·V — Git 의 관측과 시선 (FR-SVS-30~47)', () => {
  // 저장소는 e2e/git_fixture.sh 가 만든다 — 다른 git 스펙과 같은 규약이다.
  const FIXTURES = '/tmp/dm-git-fx-svs-' + process.pid;

  test.beforeAll(() => {
    execFileSync('bash', ['e2e/git_fixture.sh', FIXTURES], { stdio: 'ignore' });
  });
  test.afterAll(() => {
    execFileSync('bash', ['e2e/git_fixture.sh', '--clean', FIXTURES], { stdio: 'ignore' });
  });

  const fx = (name: string) => fs.realpathSync(path.join(FIXTURES, name));

  // 상태를 바꾸는 검사는 픽스처를 복사해 쓴다 — 원본을 오염시키면 뒤 검사가 앞
  // 검사의 순서에 묶인다.
  function copyFx(name: string, tag: string) {
    const dst = path.join(FIXTURES, 'copy-' + tag);
    fs.rmSync(dst, { recursive: true, force: true });
    execFileSync('cp', ['-R', path.join(FIXTURES, name), dst]);
    return fs.realpathSync(dst);
  }

  async function twoSlotsOnGit(page: Page, repo: string) {
    await waitForInit(page);
    await page.evaluate((r: string) => (window as any).app.openGitWindow(r), repo);
  // REPO_TAB_UNIFY_SRS: 창의 모양이 바뀌었다 — `Changes` 는 **사이드**에 살고
  // 나머지 여섯 뷰는 **본문 탭**으로 필요할 때 열린다 (FR-RTU-30·32). 스펙들이
  // "탭을 클릭한다" 로 뷰를 고르므로 여기서 여섯을 미리 세운다.
  await page.waitForSelector('#area .ed-win .ed-side', { timeout: 15000 });
  await page.evaluate(() => {
    const a = (window as any).app;
    a._edSetSide(a._aw(), 'changes');
    const p = a.gitPanel;
    for (const v of ['diff', 'history', 'branches', 'stash', 'console', 'worktrees']) p.openView(v);
  });
    await expect(page.locator('#area .pn-tab[data-git-view]')).toHaveCount(GIT_VIEW_TABS);
    // FR-RTU-70: 옛 `_gitWindow()` 는 사라졌다 — 창의 신원은 루트다 (D-RTU-18).
    const git = await page.evaluate((r: string) => (window as any).app._edWindowFor(r).id, repo);
    await slotAdd(page);
    await openInSlot(page, 0, git);
    await openInSlot(page, 1, git);
    await renderNow(page);
    // 두 칸 모두 Changes 를 그리고 목록이 도착할 때까지 기다린다.
    await page.waitForFunction(() =>
      document.querySelectorAll('#area .slot .git-view.git-changes.vis').length === 2
      && document.querySelectorAll('#area .slot[data-slot="0"] .git-file').length > 0
      && document.querySelectorAll('#area .slot[data-slot="1"] .git-file').length > 0,
      undefined, { timeout: 15000 });
    return git;
  }

  const fileIn = (page: Page, slot: number, group: string, p: string) =>
    page.locator(`#area .slot[data-slot="${slot}"] .git-view.git-changes .git-file[data-group="${group}"][data-path="${p}"]`);

  /**
   * FR-RTU-60: 패널의 키는 **(루트, 칸)** 이다 — 칸 번호 하나가 아니다.
   *
   * 그래서 "칸 수만큼 패널" 도 그 루트로 좁혀 센다: 워크스페이스에는 다른 Repo
   * 창(`~`·메모장)의 패널도 함께 살 수 있다.
   */
  const panelOf = (page: Page, slot: number) =>
    page.evaluate((n) => {
      const a = (window as any).app;
      return a._gitPanel(a._gitRootOfActive(), n);
    }, slot);

  const panelsForActiveRoot = (page: Page) =>
    page.evaluate(() => {
      const a = (window as any).app;
      const root = a._gitRootOfActive();
      let n = 0;
      for (const k of a._gitPanels.keys()) if (a._gitPanelRoot(k) === root) n++;
      return n;
    });

  const previewOf = (page: Page, slot: number) =>
    page.evaluate((n) => {
      const a = (window as any).app;
      const p = a._gitPanel(a._gitRootOfActive(), n);
      return p.previewFile ? p.previewFile.path : null;
    }, slot);

  test('TC-SVS-20: 두 칸이 같은 뷰를 각자 그린다 (FR-SVS-42)', async ({ page }) => {
    await twoSlotsOnGit(page, fx('basic'));
    // 예전에는 `elFor` 가 view 별 단일 DOM 이라 뒤 칸이 앞 칸에서 떼어 갔다.
    expect(await page.locator('#area .slot[data-slot="0"] .git-view.git-changes').count()).toBe(1);
    expect(await page.locator('#area .slot[data-slot="1"] .git-view.git-changes').count()).toBe(1);
    // 시선은 둘, 관측은 하나다. **그 저장소의 패널만** 센다 (FR-RTU-60).
    expect(await panelsForActiveRoot(page)).toBe(2);
    expect(await page.evaluate(() => {
      const a = (window as any).app;
      const r = a._gitRootOfActive();
      return a._gitPanel(r, 0).obs === a._gitPanel(r, 1).obs;
    })).toBe(true);
  });

  test('TC-SVS-21: 칸마다 다른 파일을 고른다 (FR-SVS-43)', async ({ page }) => {
    await twoSlotsOnGit(page, fx('basic'));

    await focusSlot(page, 0);
    await fileIn(page, 0, 'changes', 'tracked.txt').click();
    await focusSlot(page, 1);
    await fileIn(page, 1, 'untracked', 'untracked.txt').click();

    // 미리보기 대상이 칸마다 다르다 — 예전에는 패널이 하나라 함께 움직였다.
    expect(await previewOf(page, 0)).toBe('tracked.txt');
    expect(await previewOf(page, 1)).toBe('untracked.txt');

    // 선택 표시도 각자다.
    await expect(fileIn(page, 0, 'changes', 'tracked.txt')).toHaveClass(/sel/);
    await expect(fileIn(page, 1, 'changes', 'tracked.txt')).not.toHaveClass(/sel/);
  });

  test('TC-SVS-22: status 요청이 칸 수만큼 늘지 않는다 (FR-SVS-31)', async ({ page }) => {
    let reqs = 0;
    page.on('request', (r) => { if (r.url().includes('/api/git/status')) reqs++ });
    await twoSlotsOnGit(page, fx('basic'));
    await slotAdd(page);
    await slotAdd(page);
    const git = await page.evaluate(() => (window as any).app.ws.activeWindow);
    for (let i = 0; i < 4; i++) await openInSlot(page, i, git);
    await renderNow(page);
    await page.waitForFunction(
      () => document.querySelectorAll('#area .slot .git-view.git-changes.vis').length === 4,
      undefined, { timeout: 15000 });

    expect(await panelsForActiveRoot(page)).toBe(4);

    // 네 패널이 동시에 관측을 물어도 요청 수는 **칸 수에 비례하지 않는다.**
    // single-flight 가 observer 에 있으므로, 겹친 부름은 진행 중인 요청에 합쳐지고
    // "끝나면 한 번 더" 한 번만 남는다 (FR-GIT-21) — 그 상한이 2다. 칸이 넷이어도
    // 넷이 되지 않는 것이 FR-SVS-31 이 요구하는 것이다.
    const before = reqs;
    await page.evaluate(async () => {
      const a = (window as any).app;
      const r = a._gitRootOfActive();
      const ps = [0, 1, 2, 3].map((i) => a._gitPanel(r, i));
      await Promise.all(ps.map((p: any) => p.collect()));
    });
    expect(reqs - before).toBeLessThanOrEqual(2);
  });

  test('TC-SVS-23: 한 칸의 쓰기가 모든 칸에 반영된다 (FR-SVS-44)', async ({ page }) => {
    const repo = copyFx('basic', 'stage');
    await twoSlotsOnGit(page, repo);

    // 칸 0 에서 unstaged 파일을 스테이징한다.
    await focusSlot(page, 0);
    await fileIn(page, 0, 'changes', 'tracked.txt').locator('.git-file-act[data-act="stage"]').click();

    // 결과는 관측이므로 **양쪽** 목록이 함께 움직인다.
    await expect(fileIn(page, 0, 'staged', 'tracked.txt')).toHaveCount(1, { timeout: 15000 });
    await expect(fileIn(page, 1, 'staged', 'tracked.txt')).toHaveCount(1, { timeout: 15000 });
  });

  test('TC-SVS-24: 소실은 두 칸에 함께 온다 (FR-SVS-33)', async ({ page }) => {
    const repo = copyFx('basic', 'gone');
    await twoSlotsOnGit(page, repo);

    fs.rmSync(repo, { recursive: true, force: true });
    /**
     * 폴링이 소실을 관측하면 두 칸 모두 안내로 간다.
     *
     * **세는 자리를 좁혔다** (FR-RTU-32). 소실 안내는 **뷰마다** 서므로, 사이드의
     * `Changes` 와 본문의 활성 뷰가 각각 하나씩 그린다 — 칸당 둘이다. 이 시험이
     * 재는 것은 "두 칸에 함께 오는가" 이니 칸마다 하나씩 세면 된다.
     */
    await page.waitForFunction(
      () => document.querySelectorAll(
        '#area .slot .ed-side .git-view.git-changes .git-missing').length === 2,
      undefined, { timeout: 30000 });
  });

  test('TC-SVS-25: 칸을 없애면 그 패널이 파괴된다 (FR-SVS-46)', async ({ page }) => {
    await twoSlotsOnGit(page, fx('basic'));
    expect(await panelsForActiveRoot(page)).toBe(2);

    await page.evaluate(() => {
      (window as any).app.slotFocusTo(1);
      (window as any).app.slotRemove();
    });
    await renderNow(page);
    await page.waitForFunction(
      () => document.querySelectorAll('#area .git-view.git-changes.vis').length === 1,
      undefined, { timeout: 15000 });

    expect(await panelsForActiveRoot(page)).toBe(1);
    // 남은 패널은 관측을 계속 본다.
    expect(await page.evaluate(() => {
      const a = (window as any).app;
      return !!a._gitPanel(a._gitRootOfActive(), 0).obs;
    })).toBe(true);
  });

  test('TC-SVS-51: 리포를 바꾸면 모든 칸의 시선이 되돌아간다 (FR-SVS-34)', async ({ page }) => {
    await twoSlotsOnGit(page, fx('basic'));

    // 두 칸이 각자 파일을 고른다.
    await focusSlot(page, 0);
    await fileIn(page, 0, 'changes', 'tracked.txt').click();
    await focusSlot(page, 1);
    await fileIn(page, 1, 'untracked', 'untracked.txt').click();
    expect(await previewOf(page, 0)).toBe('tracked.txt');
    expect(await previewOf(page, 1)).toBe('untracked.txt');

    // 활성 리포는 창의 것이므로 모든 칸이 같은 리포를 본다 — 바뀌면 이전 리포의
    // 선택이 새 리포의 헤더와 함께 보이는 순간이 **어느 칸에도** 있어서는 안 된다.
    /**
     * **개정 (REPO_TAB_UNIFY_SRS FR-RTU-72 / D-RTU-27).** 리포 전환은 이제 **창
     * 전환**이다 — `gitPanel.setRepo` 는 Repo 창의 패널에서 조기 반환한다.
     *
     * 그래서 재는 것이 바뀐다: 다른 저장소로 옮기면 두 칸 모두 **그 저장소의**
     * 패널을 보고, 이전 저장소의 선택이 새 저장소의 화면과 함께 보이는 순간이
     * 어느 칸에도 없다. 이전 저장소의 시선은 그 창에 그대로 남는다 (FR-RTU-61) —
     * 그것이 D-RTU-6 이 창마다 패널을 유지한 이유다.
     */
    const other = fx('detached');
    await page.evaluate((r) => (window as any).app.openGitWindow(r), other);
    await page.waitForFunction((r) => {
      const a = (window as any).app;
      return a._isEditorWin(a._aw()) && a._edRootOf(a._aw()) === r;
    }, other, { timeout: 15000 });
    await renderNow(page);

    // 새 저장소의 칸에는 고른 것이 없다.
    expect(await previewOf(page, 0)).toBeNull();
  });

  test('TC-SVS-53: 두 칸에서 겹친 쓰기가 한 번만 나간다 (FR-SVS-45)', async ({ page }) => {
    const repo = copyFx('basic', 'write');
    await twoSlotsOnGit(page, repo);

    let writes = 0;
    page.on('request', (r) => {
      if (r.url().includes('/api/git/uncommitted/reset')) writes++;
    });

    // 두 패널이 같은 쓰기를 동시에 부른다. `_writing` 이 관측이므로 뒤에 온 쪽은
    // 가드에 걸린다 — 칸마다 두면 같은 쓰기가 두 번 나간다.
    await page.evaluate(async () => {
      const a = (window as any).app;
      const r = a._gitRootOfActive();
      const p0 = a._gitPanel(r, 0);
      const p1 = a._gitPanel(r, 1);
      await Promise.all([p0.uncommittedReset(), p1.uncommittedReset()]);
    });
    expect(writes).toBe(1);
  });

  test('TC-SVS-57: 전역 진입점은 포커스 칸의 패널이다 (FR-SVS-47)', async ({ page }) => {
    await twoSlotsOnGit(page, fx('basic'));

    // 메뉴·확인창·다이얼로그는 화면에 하나만 서고 사용자가 방금 조작한 자리에
    // 속한다 — 그 자리가 포커스 칸이다 (D-8).
    for (const i of [0, 1, 0]) {
      await focusSlot(page, i);
      expect(await page.evaluate((n) => {
        const a = (window as any).app;
        return a.gitPanel === a._gitPanel(a._gitRootOfActive(), n);
      }, i)).toBe(true);
    }
  });
});

test.describe('묶음 E — 편집기 문서 (FR-SVS-50~55)', () => {
  // 루트는 서버에 실제로 등록한다 — 묶음 X 와 같은 이유다.
  let BASE = '';
  let ROOT = '';
  let FILE = '';

  test.beforeAll(() => {
    BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-svs-e-')));
    ROOT = path.join(BASE, 'proj');
    fs.mkdirSync(ROOT);
    FILE = path.join(ROOT, 'doc.txt');
    fs.writeFileSync(FILE, 'hello\n');
  });
  test.afterAll(() => {
    if (BASE) fs.rmSync(BASE, { recursive: true, force: true });
  });

  // 같은 파일 탭을 두 칸에서 보게 만든다. 편집기 인스턴스는 이미 칸마다 서므로
  // (FR-WSL-20) 이 검사가 재는 것은 **그 둘이 같은 문서를 보는지**다.
  async function sameFileInTwoSlots(page: Page, request: any) {
    const r = await request.post('/api/editors/add', { data: { path: ROOT } });
    expect(r.ok(), `editors/add 실패: ${await r.text()}`).toBeTruthy();
    await waitForInit(page);
    await page.waitForFunction(
      () => !!(window as any).app?._editors && (window as any).app._edWindows().length > 0,
      undefined, { timeout: 15000 });
    const edWin = await page.evaluate((root) => {
      const a = (window as any).app;
      const win = a._edWindows().find((x: any) => x.editor && x.editor.root === root);
      a.switchWindow(win.id);
      return win.id;
    }, ROOT);
    await page.evaluate((fp) => (window as any).app._edOpenFile(fp), FILE);
    await slotAdd(page);
    await openInSlot(page, 0, edWin);
    await openInSlot(page, 1, edWin);
    await renderNow(page);

    // 두 칸의 Monaco 가 모두 설 때까지 기다린다.
    await page.waitForFunction(() => {
      const es = [...(window as any).app.fileEditors.values()];
      return es.length === 2 && es.every((e: any) => !!e._editor);
    }, undefined, { timeout: 20000 });

    return page.evaluate(() => [...(window as any).app.fileEditors.keys()].sort());
  }

  const valueIn = (page: Page, key: string) =>
    page.evaluate((k) => (window as any).app.fileEditors.get(k)._editor.getValue(), key);

  test('TC-SVS-30: 한 칸의 타이핑이 다른 칸에 즉시 보인다 (FR-SVS-50·51)', async ({ page, request }) => {
    const keys = await sameFileInTwoSlots(page, request);
    expect(keys.length).toBe(2);

    // 문서는 하나다 — 두 에디터가 같은 모델을 든다.
    expect(await page.evaluate((ks) => {
      const a = (window as any).app;
      return a.fileEditors.get(ks[0])._editor.getModel()
        === a.fileEditors.get(ks[1])._editor.getModel();
    }, keys)).toBe(true);

    // 칸 0 의 에디터에 입력한다.
    await page.evaluate((k) => {
      const e = (window as any).app.fileEditors.get(k)._editor;
      e.focus();
      e.setPosition({ lineNumber: 1, column: 1 });
      e.trigger('test', 'type', { text: 'XY' });
    }, keys[0]);

    // 다른 칸이 그것을 그대로 본다.
    expect(await valueIn(page, keys[1])).toContain('XY');
    expect(await valueIn(page, keys[0])).toBe(await valueIn(page, keys[1]));
  });

  test('TC-SVS-31: 커서는 칸마다 남는다 (FR-SVS-52)', async ({ page, request }) => {
    const keys = await sameFileInTwoSlots(page, request);
    // 내용을 두 줄로 만든 뒤 각 칸의 커서를 다른 줄에 둔다.
    await page.evaluate((k) => {
      (window as any).app.fileEditors.get(k)._editor.getModel().setValue('one\ntwo\n');
    }, keys[0]);
    await page.evaluate((ks) => {
      const a = (window as any).app;
      a.fileEditors.get(ks[0])._editor.setPosition({ lineNumber: 1, column: 1 });
      a.fileEditors.get(ks[1])._editor.setPosition({ lineNumber: 2, column: 2 });
    }, keys);

    const pos = await page.evaluate((ks) => {
      const a = (window as any).app;
      return ks.map((k: string) => {
        const p = a.fileEditors.get(k)._editor.getPosition();
        return p.lineNumber + ':' + p.column;
      });
    }, keys);
    // 내용은 하나여도 보는 자리는 각자다.
    expect(pos[0]).toBe('1:1');
    expect(pos[1]).toBe('2:2');
  });

  test('TC-SVS-32: 저장은 문서 하나에 한 번이고 dirty 는 함께 사라진다 (FR-SVS-53·54)', async ({ page, request }) => {
    const keys = await sameFileInTwoSlots(page, request);

    // 칸 0 에서 편집한다 → dirty 는 문서의 것이므로 양쪽이 함께 참이다.
    await page.evaluate((k) => {
      const e = (window as any).app.fileEditors.get(k)._editor;
      e.getModel().setValue('saved by slot 0\n');
    }, keys[0]);
    await expect.poll(() => page.evaluate((ks) => {
      const a = (window as any).app;
      return ks.map((k: string) => a.fileEditors.get(k)._dirty);
    }, keys)).toEqual([true, true]);

    // 칸 0 에서 저장한다.
    await page.evaluate((k) => (window as any).app.fileEditors.get(k).save(), keys[0]);
    await expect.poll(() => page.evaluate((ks) => {
      const a = (window as any).app;
      return ks.map((k: string) => a.fileEditors.get(k)._dirty);
    }, keys)).toEqual([false, false]);

    // 디스크에 그 내용이 있고, 칸 1 에서 다시 저장해도 되돌아가지 않는다.
    expect(fs.readFileSync(FILE, 'utf8')).toBe('saved by slot 0\n');
    await page.evaluate((k) => (window as any).app.fileEditors.get(k).save(), keys[1]);
    expect(fs.readFileSync(FILE, 'utf8')).toBe('saved by slot 0\n');
  });

  test('TC-SVS-52: 문서는 마지막 칸이 떠날 때 거둬진다 (FR-SVS-55)', async ({ page, request }) => {
    const keys = await sameFileInTwoSlots(page, request);
    expect(await page.evaluate(() => (window as any).app._edDocs.size)).toBe(1);
    expect(await page.evaluate(() => {
      const d = [...(window as any).app._edDocs.values()][0];
      return d.views.size;
    })).toBe(2);

    // 칸 하나를 없앤다 → 다른 칸이 보고 있으므로 문서는 남는다. 편집 중이던 것이
    // 칸 정리로 사라지면 그것이 결함이다.
    await page.evaluate(() => {
      (window as any).app.slotFocusTo(1);
      (window as any).app.slotRemove();
    });
    await renderNow(page);
    await page.waitForFunction(() => {
      const d = [...(window as any).app._edDocs.values()][0];
      return d && d.views.size === 1;
    }, undefined, { timeout: 15000 });
    expect(await page.evaluate(() => (window as any).app._edDocs.size)).toBe(1);
    expect(await page.evaluate(() => {
      const d = [...(window as any).app._edDocs.values()][0];
      return !!d.model && !d.model.isDisposed();
    })).toBe(true);

    // 탭까지 닫으면 보는 칸이 하나도 없다 → 문서와 모델이 거둬진다.
    await page.evaluate(() => {
      const a = (window as any).app;
      const w = a.ws.windows.find((x: any) => x.type === 'editor' && x.layout);
      const walk = (n: any): any => (n.type === 'pane' ? n : walk(n.children[0]));
      const pn = walk(w.layout);
      return a.closeTab(pn.id, pn.tabs[0].id, w.id);
    });
    await renderNow(page);
    await page.waitForFunction(
      () => (window as any).app._edDocs.size === 0, undefined, { timeout: 15000 });
  });
});
