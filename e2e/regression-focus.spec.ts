import { test, expect } from './fixtures';

// SRS: MD_VIEWER_REGRESSION_FIX_SRS.md 의 포커스 불변식 부분.
//   FR-2: switchTab 후 창 전환→복귀 시 마지막 탭/분할 칸이 복원되어야 한다.
//   FR-3: 활성 분할 칸의 마지막 탭 close 후 전환→복귀 시 stale 분할 칸이 포커스되면 안 된다.
//   FR-4/5/6/7/10: split·keepFocus·창 삭제·closeTab 의 focusedPane 불변식.
//
// 이 SRS 의 MdViewer 관련 요구(FR-1 캐시 유지, FR-9 스크롤 보존)는 markdown
// 뷰어가 8dc0a3f 에서 제거되며 대상이 사라져 함께 삭제했다. 나머지는 뷰어와
// 무관한 focusedPane 불변식이라 그대로 유지한다.

async function resetWorkspace(request) {
  const get = await request.get('/api/workspace');
  const rev = get.headers()['etag'] || '0';
  await request.put('/api/workspace', {
    headers: { 'If-Match': rev, 'Content-Type': 'application/json' },
    data: '{"schemaVersion":2,"windows":[]}',
  });
}

async function waitForInit(page, request) {
  await resetWorkspace(request);
  await page.context().addInitScript(() => {
    sessionStorage.setItem('displayMode', 'desktop');
    try { localStorage.clear(); } catch {}
  });
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
}

async function addWindow(page) {
  const before = await page.locator('#windows .si').count();
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/tools') && r.request().method() === 'POST'),
    page.click('#add-window'),
  ]);
  await expect(page.locator('#windows .si')).toHaveCount(before + 1, { timeout: 10000 });
}

test.describe('focusedPane 불변식 회귀', () => {
  test('FR-2: switchTab persists s.focusedPane across session switch', async ({ page, request }) => {
    await waitForInit(page, request);

    // Split horizontally → 2 panes in session 1.
    await page.evaluate(() => (window as any).app.split('h'));
    await page.waitForTimeout(100);

    // Pick the second pane as focus target.
    const r2id = await page.evaluate(() => {
      const a = (window as any).app;
      const s = a.ws.windows.find((x: any) => x.id === a.ws.activeWindow);
      const regs: any[] = [];
      const walk = (n: any) => {
        if (!n) return;
        if (n.type === 'pane') regs.push(n);
        else if (n.children) n.children.forEach(walk);
      };
      walk(s.layout);
      // simulate switchTab on 2nd pane's active tab
      const target = regs[1];
      a.switchTab(target.id, target.activeTab);
      return target.id;
    });

    // Add a 2nd session and switch back.
    await addWindow(page);
    await page.evaluate((sid0) => {
      const a = (window as any).app;
      a.switchWindow(sid0);
    }, await page.evaluate(() => (window as any).app.ws.windows[0].id));

    // Focused pane should be r2id.
    const focusedNow = await page.evaluate(() => (window as any).app.focused);
    expect(focusedNow).toBe(r2id);
  });

  test('FR-3: closing active pane updates s.focusedPane in active session', async ({ page, request }) => {
    await waitForInit(page, request);

    // Split → 2 panes; close the second pane (focused after split).
    await page.evaluate(() => (window as any).app.split('h'));
    await page.waitForTimeout(100);

    const stateBefore = await page.evaluate(() => {
      const a = (window as any).app;
      const s = a.ws.windows.find((x: any) => x.id === a.ws.activeWindow);
      return { focused: a.focused, sFocused: s.focusedPane };
    });
    expect(stateBefore.focused).toBeTruthy();

    // Close all tabs in focused pane (forcing pane removal).
    await page.evaluate(async () => {
      const a = (window as any).app;
      const s = a.ws.windows.find((x: any) => x.id === a.ws.activeWindow);
      const find = (n: any, id: string): any => {
        if (!n) return null;
        if (n.type === 'pane' && n.id === id) return n;
        if (n.children) for (const c of n.children) { const r = find(c, id); if (r) return r; }
        return null;
      };
      const pn = find(s.layout, a.focused);
      for (const t of [...pn.tabs]) {
        await a.closeTab(pn.id, t.id);
      }
    });

    // Add 2nd session and return.
    await addWindow(page);
    const sid0 = await page.evaluate(() => (window as any).app.ws.windows[0].id);
    await page.evaluate((sid) => (window as any).app.switchWindow(sid), sid0);

    // s.focusedPane should not be the removed rid.
    const ok = await page.evaluate(() => {
      const a = (window as any).app;
      const s = a.ws.windows.find((x: any) => x.id === a.ws.activeWindow);
      const find = (n: any, id: string): any => {
        if (!n) return null;
        if (n.type === 'pane' && n.id === id) return n;
        if (n.children) for (const c of n.children) { const r = find(c, id); if (r) return r; }
        return null;
      };
      return !!find(s.layout, s.focusedPane);
    });
    expect(ok).toBe(true);
  });

  // FR-4: split 후 s.focusedPane 이 새 pane 과 일치해야 한다.
  test('FR-4: split updates s.focusedPane to the new pane', async ({ page, request }) => {
    await waitForInit(page, request);

    const result = await page.evaluate(async () => {
      const a = (window as any).app;
      const s = a.ws.windows.find((x: any) => x.id === a.ws.activeWindow);
      await a.split('h');
      return {
        focused: a.focused,
        focusedPane: s.focusedPane,
      };
    });

    // focused 와 s.focusedPane 이 반드시 일치해야 한다.
    expect(result.focused).toBeTruthy();
    expect(result.focusedPane).toBe(result.focused);
  });

  // FR-5: keepFocus=true 로 split 하면 원래 pane 으로 focusedPane 이 유지돼야 한다.
  test('FR-5: split with keepFocus keeps s.focusedPane on original pane', async ({ page, request }) => {
    await waitForInit(page, request);

    const result = await page.evaluate(async () => {
      const a = (window as any).app;
      const s = a.ws.windows.find((x: any) => x.id === a.ws.activeWindow);
      const beforeFocus = a.focused;
      await a.split('h', { keepFocus: true });
      return {
        beforeFocus,
        focused: a.focused,
        focusedPane: s.focusedPane,
      };
    });

    expect(result.focused).toBe(result.beforeFocus);
    expect(result.focusedPane).toBe(result.beforeFocus);
  });

  // FR-7: 활성 세션 삭제 시 이동한 세션의 저장된 focusedPane 을 보존한다.
  test('FR-7: delWindow preserves target session focusedPane', async ({ page, request }) => {
    await waitForInit(page, request);

    // 세션 A 에서 split + 두 번째 pane 으로 포커스 이동.
    const sidA = await page.evaluate(() => (window as any).app.ws.activeWindow);
    const r2idA = await page.evaluate(async () => {
      const a = (window as any).app;
      await a.split('h');
      return a.focused; // 새 pane (lastR)
    });

    // 세션 B 추가 (활성 세션이 B 로 전환됨).
    await addWindow(page);
    const sidB = await page.evaluate(() => (window as any).app.ws.activeWindow);
    expect(sidB).not.toBe(sidA);

    // 다시 A 로 전환 → 활성 A.
    await page.evaluate((sid) => (window as any).app.switchWindow(sid), sidA);
    expect(await page.evaluate(() => (window as any).app.focused)).toBe(r2idA);

    // 활성 세션 A 를 삭제 → B 가 활성이 됨. B 의 focusedPane 은 자기 layout 의 첫 pane 이어야 함.
    await page.evaluate(async (sid) => {
      const a = (window as any).app;
      // 삭제 시 busy 확인 모달이 뜨지 않도록 fake.
      a._isToolBusy = async () => false;
      await a.delWindow(sid);
    }, sidA);

    const after = await page.evaluate(() => {
      const a = (window as any).app;
      const s = a.ws.windows.find((x: any) => x.id === a.ws.activeWindow);
      const find = (n: any, id: string): any => {
        if (!n) return null;
        if (n.type === 'pane' && n.id === id) return n;
        if (n.children) for (const c of n.children) { const r = find(c, id); if (r) return r; }
        return null;
      };
      return {
        focused: a.focused,
        sFocused: s.focusedPane,
        focusedExists: !!find(s.layout, a.focused),
        syncMatches: a.focused === s.focusedPane,
      };
    });
    expect(after.focusedExists).toBe(true);
    expect(after.syncMatches).toBe(true);
  });

  // FR-6: split 후 세션 전환→복귀 시 새 pane 으로 포커스 복원.
  test('FR-6: split focus survives session switch and return', async ({ page, request }) => {
    await waitForInit(page, request);

    const session1Id = await page.evaluate(() => (window as any).app.ws.activeWindow);

    const focusedAfterSplit = await page.evaluate(async () => {
      const a = (window as any).app;
      await a.split('h');
      return a.focused;
    });

    // 2번째 세션 추가 후 복귀.
    await addWindow(page);
    await page.evaluate((sid) => (window as any).app.switchWindow(sid), session1Id);

    const focusedOnReturn = await page.evaluate(() => (window as any).app.focused);
    expect(focusedOnReturn).toBe(focusedAfterSplit);
  });

  // FR-10: 활성 탭을 닫으면 첫 탭이 아니라 인접 탭(다음, 없으면 이전)으로 이동.
  test('FR-10: closeTab activates neighbor tab, not first', async ({ page, request }) => {
    await waitForInit(page, request);

    // 동일 pane 에 탭 4개 만들기 (terminal 기본 1개 + 3개 추가).
    const ids = await page.evaluate(async () => {
      const a = (window as any).app;
      await a.addTab(a.focused, 'terminal');
      await a.addTab(a.focused, 'terminal');
      await a.addTab(a.focused, 'terminal');
      const s = a.ws.windows.find((x: any) => x.id === a.ws.activeWindow);
      const find = (n: any, id: string): any => {
        if (!n) return null;
        if (n.type === 'pane' && n.id === id) return n;
        if (n.children) for (const c of n.children) { const r = find(c, id); if (r) return r; }
        return null;
      };
      const pn = find(s.layout, a.focused);
      return pn.tabs.map((t: any) => t.id);
    });
    expect(ids.length).toBe(4);

    // 가운데 탭(index 1) 활성 후 닫기 → 다음 탭(원래 index 2) 으로 이동해야 함.
    await page.evaluate((tid) => {
      const a = (window as any).app;
      a.switchTab(a.focused, tid);
    }, ids[1]);

    const expectedNext = ids[2];
    await page.evaluate(async (tid) => {
      const a = (window as any).app;
      await a.closeTab(a.focused, tid);
    }, ids[1]);

    const activeAfterCloseMid = await page.evaluate(() => {
      const a = (window as any).app;
      const s = a.ws.windows.find((x: any) => x.id === a.ws.activeWindow);
      const find = (n: any, id: string): any => {
        if (!n) return null;
        if (n.type === 'pane' && n.id === id) return n;
        if (n.children) for (const c of n.children) { const r = find(c, id); if (r) return r; }
        return null;
      };
      return find(s.layout, a.focused).activeTab;
    });
    expect(activeAfterCloseMid).toBe(expectedNext);

    // 마지막 탭 활성 후 닫기 → 이전 탭으로 이동해야 함.
    // 현재 탭들: [ids[0], ids[2], ids[3]] (ids[1] 제거됨)
    await page.evaluate((tid) => {
      const a = (window as any).app;
      a.switchTab(a.focused, tid);
    }, ids[3]);

    await page.evaluate(async (tid) => {
      const a = (window as any).app;
      await a.closeTab(a.focused, tid);
    }, ids[3]);

    const activeAfterCloseLast = await page.evaluate(() => {
      const a = (window as any).app;
      const s = a.ws.windows.find((x: any) => x.id === a.ws.activeWindow);
      const find = (n: any, id: string): any => {
        if (!n) return null;
        if (n.type === 'pane' && n.id === id) return n;
        if (n.children) for (const c of n.children) { const r = find(c, id); if (r) return r; }
        return null;
      };
      return find(s.layout, a.focused).activeTab;
    });
    // 마지막 탭(ids[3]) 닫혔으니 이전 탭 ids[2] 가 활성이어야 함.
    expect(activeAfterCloseLast).toBe(ids[2]);
  });
});
