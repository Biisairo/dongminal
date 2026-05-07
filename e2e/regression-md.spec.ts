import { test, expect } from '@playwright/test';

// SRS: MD_VIEWER_REGRESSION_FIX_SRS.md
//   FR-1: 비활성 세션의 MdViewer 인스턴스는 활성 세션 렌더 후에도 유지되어야 한다.
//   FR-2: switchTab 후 세션 전환→복귀 시 마지막 탭/region 이 복원되어야 한다.
//   FR-3: 활성 region 의 마지막 탭 close 후 세션 전환→복귀 시 stale region 이 포커스되면 안 된다.

async function resetWorkspace(request) {
  const get = await request.get('/api/workspace');
  const rev = get.headers()['etag'] || '0';
  await request.put('/api/workspace', {
    headers: { 'If-Match': rev, 'Content-Type': 'application/json' },
    data: '{}',
  });
}

async function waitForInit(page, request) {
  await resetWorkspace(request);
  await page.context().addInitScript(() => {
    sessionStorage.setItem('displayMode', 'desktop');
    try { localStorage.clear(); } catch {}
  });
  await page.goto('/');
  await page.waitForSelector('#area .rg.focused .xterm-helper-textarea', { timeout: 15000 });
}

async function addSession(page) {
  const before = await page.locator('#sessions .si').count();
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/panes') && r.request().method() === 'POST'),
    page.click('#add-session'),
  ]);
  await expect(page.locator('#sessions .si')).toHaveCount(before + 1, { timeout: 10000 });
}

async function openMdTabInActive(page, filePath: string) {
  await page.evaluate((fp) => {
    const a = (window as any).app;
    if (!a) throw new Error('app not exposed');
    a.addTab(a.focused, 'markdown', { name: fp.split('/').pop(), filePath: fp });
  }, filePath);
}

test.describe('MD viewer regression', () => {
  test('FR-1: MdViewer in inactive session survives render of active session', async ({ page, request }) => {
    await waitForInit(page, request);

    // Session 1: open md tab.
    await openMdTabInActive(page, '/tmp/__regression_a.md');
    await page.waitForTimeout(50);
    const tabAId = await page.evaluate(() => {
      const a = (window as any).app;
      const s = a.ws.sessions.find((x: any) => x.id === a.ws.activeSession);
      return s.layout.tabs.find((t: any) => t.type === 'markdown').id;
    });

    // Add a 2nd session (active switches).
    await addSession(page);

    // Open md tab in session 2 to trigger render.
    await openMdTabInActive(page, '/tmp/__regression_b.md');

    // Session 1's md viewer should still be cached.
    const cachedA = await page.evaluate((tid) => {
      const a = (window as any).app;
      return a.mdViewers.has(tid);
    }, tabAId);
    expect(cachedA).toBe(true);
  });

  test('FR-2: switchTab persists s.focusedRegion across session switch', async ({ page, request }) => {
    await waitForInit(page, request);

    // Split horizontally → 2 regions in session 1.
    await page.evaluate(() => (window as any).app.split('h'));
    await page.waitForTimeout(100);

    // Pick the second region as focus target.
    const r2id = await page.evaluate(() => {
      const a = (window as any).app;
      const s = a.ws.sessions.find((x: any) => x.id === a.ws.activeSession);
      const regs: any[] = [];
      const walk = (n: any) => {
        if (!n) return;
        if (n.type === 'region') regs.push(n);
        else if (n.children) n.children.forEach(walk);
      };
      walk(s.layout);
      // simulate switchTab on 2nd region's active tab
      const target = regs[1];
      a.switchTab(target.id, target.activeTab);
      return target.id;
    });

    // Add a 2nd session and switch back.
    await addSession(page);
    await page.evaluate((sid0) => {
      const a = (window as any).app;
      a.switchSession(sid0);
    }, await page.evaluate(() => (window as any).app.ws.sessions[0].id));

    // Focused region should be r2id.
    const focusedNow = await page.evaluate(() => (window as any).app.focused);
    expect(focusedNow).toBe(r2id);
  });

  test('FR-3: closing active region updates s.focusedRegion in active session', async ({ page, request }) => {
    await waitForInit(page, request);

    // Split → 2 regions; close the second region (focused after split).
    await page.evaluate(() => (window as any).app.split('h'));
    await page.waitForTimeout(100);

    const stateBefore = await page.evaluate(() => {
      const a = (window as any).app;
      const s = a.ws.sessions.find((x: any) => x.id === a.ws.activeSession);
      return { focused: a.focused, sFocused: s.focusedRegion };
    });
    expect(stateBefore.focused).toBeTruthy();

    // Close all tabs in focused region (forcing region removal).
    await page.evaluate(async () => {
      const a = (window as any).app;
      const s = a.ws.sessions.find((x: any) => x.id === a.ws.activeSession);
      const find = (n: any, id: string): any => {
        if (!n) return null;
        if (n.type === 'region' && n.id === id) return n;
        if (n.children) for (const c of n.children) { const r = find(c, id); if (r) return r; }
        return null;
      };
      const rg = find(s.layout, a.focused);
      // Mark as not busy for fast close
      for (const t of [...rg.tabs]) {
        a.mdViewers.delete(t.id);
        await a.closeTab(rg.id, t.id);
      }
    });

    // Add 2nd session and return.
    await addSession(page);
    const sid0 = await page.evaluate(() => (window as any).app.ws.sessions[0].id);
    await page.evaluate((sid) => (window as any).app.switchSession(sid), sid0);

    // s.focusedRegion should not be the removed rid.
    const ok = await page.evaluate(() => {
      const a = (window as any).app;
      const s = a.ws.sessions.find((x: any) => x.id === a.ws.activeSession);
      const find = (n: any, id: string): any => {
        if (!n) return null;
        if (n.type === 'region' && n.id === id) return n;
        if (n.children) for (const c of n.children) { const r = find(c, id); if (r) return r; }
        return null;
      };
      return !!find(s.layout, s.focusedRegion);
    });
    expect(ok).toBe(true);
  });

  // FR-4: split 후 s.focusedRegion 이 새 region 과 일치해야 한다.
  test('FR-4: split updates s.focusedRegion to the new region', async ({ page, request }) => {
    await waitForInit(page, request);

    const result = await page.evaluate(async () => {
      const a = (window as any).app;
      const s = a.ws.sessions.find((x: any) => x.id === a.ws.activeSession);
      await a.split('h');
      return {
        focused: a.focused,
        focusedRegion: s.focusedRegion,
      };
    });

    // focused 와 s.focusedRegion 이 반드시 일치해야 한다.
    expect(result.focused).toBeTruthy();
    expect(result.focusedRegion).toBe(result.focused);
  });

  // FR-5: keepFocus=true 로 split 하면 원래 region 으로 focusedRegion 이 유지돼야 한다.
  test('FR-5: split with keepFocus keeps s.focusedRegion on original region', async ({ page, request }) => {
    await waitForInit(page, request);

    const result = await page.evaluate(async () => {
      const a = (window as any).app;
      const s = a.ws.sessions.find((x: any) => x.id === a.ws.activeSession);
      const beforeFocus = a.focused;
      await a.split('h', { keepFocus: true });
      return {
        beforeFocus,
        focused: a.focused,
        focusedRegion: s.focusedRegion,
      };
    });

    expect(result.focused).toBe(result.beforeFocus);
    expect(result.focusedRegion).toBe(result.beforeFocus);
  });

  // FR-9: render() 후에도 MdViewer 의 scrollTop 이 보존되어야 한다.
  test('FR-9: MdViewer scroll position survives render', async ({ page, request }) => {
    await waitForInit(page, request);

    await openMdTabInActive(page, '/tmp/__regression_scroll.md');
    await page.evaluate(() => {
      const a = (window as any).app;
      const v = [...a.mdViewers.values()][0];
      v.el.innerHTML = '<div style="height:5000px">long</div>';
      v.el.classList.add('vis');
      v.el.scrollTop = 1500;
    });

    // split('h', { keepFocus: true }) 로 render() 트리거.
    await page.evaluate(() => (window as any).app.split('h', { keepFocus: true }));
    await page.waitForTimeout(80);

    const scrollTop = await page.evaluate(() => {
      const a = (window as any).app;
      const v = [...a.mdViewers.values()][0];
      return v.el.scrollTop;
    });
    expect(scrollTop).toBeGreaterThan(0);
  });

  // FR-7: 활성 세션 삭제 시 이동한 세션의 저장된 focusedRegion 을 보존한다.
  test('FR-7: delSession preserves target session focusedRegion', async ({ page, request }) => {
    await waitForInit(page, request);

    // 세션 A 에서 split + 두 번째 region 으로 포커스 이동.
    const sidA = await page.evaluate(() => (window as any).app.ws.activeSession);
    const r2idA = await page.evaluate(async () => {
      const a = (window as any).app;
      await a.split('h');
      return a.focused; // 새 region (lastR)
    });

    // 세션 B 추가 (활성 세션이 B 로 전환됨).
    await addSession(page);
    const sidB = await page.evaluate(() => (window as any).app.ws.activeSession);
    expect(sidB).not.toBe(sidA);

    // 다시 A 로 전환 → 활성 A.
    await page.evaluate((sid) => (window as any).app.switchSession(sid), sidA);
    expect(await page.evaluate(() => (window as any).app.focused)).toBe(r2idA);

    // 활성 세션 A 를 삭제 → B 가 활성이 됨. B 의 focusedRegion 은 자기 layout 의 첫 region 이어야 함.
    await page.evaluate(async (sid) => {
      const a = (window as any).app;
      // 삭제 시 busy 확인 모달이 뜨지 않도록 fake.
      a._isPaneBusy = async () => false;
      await a.delSession(sid);
    }, sidA);

    const after = await page.evaluate(() => {
      const a = (window as any).app;
      const s = a.ws.sessions.find((x: any) => x.id === a.ws.activeSession);
      const find = (n: any, id: string): any => {
        if (!n) return null;
        if (n.type === 'region' && n.id === id) return n;
        if (n.children) for (const c of n.children) { const r = find(c, id); if (r) return r; }
        return null;
      };
      return {
        focused: a.focused,
        sFocused: s.focusedRegion,
        focusedExists: !!find(s.layout, a.focused),
        syncMatches: a.focused === s.focusedRegion,
      };
    });
    expect(after.focusedExists).toBe(true);
    expect(after.syncMatches).toBe(true);
  });

  // FR-6: split 후 세션 전환→복귀 시 새 region 으로 포커스 복원.
  test('FR-6: split focus survives session switch and return', async ({ page, request }) => {
    await waitForInit(page, request);

    const session1Id = await page.evaluate(() => (window as any).app.ws.activeSession);

    const focusedAfterSplit = await page.evaluate(async () => {
      const a = (window as any).app;
      await a.split('h');
      return a.focused;
    });

    // 2번째 세션 추가 후 복귀.
    await addSession(page);
    await page.evaluate((sid) => (window as any).app.switchSession(sid), session1Id);

    const focusedOnReturn = await page.evaluate(() => (window as any).app.focused);
    expect(focusedOnReturn).toBe(focusedAfterSplit);
  });

  // FR-10: 활성 탭을 닫으면 첫 탭이 아니라 인접 탭(다음, 없으면 이전)으로 이동.
  test('FR-10: closeTab activates neighbor tab, not first', async ({ page, request }) => {
    await waitForInit(page, request);

    // 동일 region 에 탭 4개 만들기 (terminal 기본 1개 + 3개 추가).
    const ids = await page.evaluate(async () => {
      const a = (window as any).app;
      await a.addTab(a.focused, 'terminal');
      await a.addTab(a.focused, 'terminal');
      await a.addTab(a.focused, 'terminal');
      const s = a.ws.sessions.find((x: any) => x.id === a.ws.activeSession);
      const find = (n: any, id: string): any => {
        if (!n) return null;
        if (n.type === 'region' && n.id === id) return n;
        if (n.children) for (const c of n.children) { const r = find(c, id); if (r) return r; }
        return null;
      };
      const rg = find(s.layout, a.focused);
      return rg.tabs.map((t: any) => t.id);
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
      const s = a.ws.sessions.find((x: any) => x.id === a.ws.activeSession);
      const find = (n: any, id: string): any => {
        if (!n) return null;
        if (n.type === 'region' && n.id === id) return n;
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
      const s = a.ws.sessions.find((x: any) => x.id === a.ws.activeSession);
      const find = (n: any, id: string): any => {
        if (!n) return null;
        if (n.type === 'region' && n.id === id) return n;
        if (n.children) for (const c of n.children) { const r = find(c, id); if (r) return r; }
        return null;
      };
      return find(s.layout, a.focused).activeTab;
    });
    // 마지막 탭(ids[3]) 닫혔으니 이전 탭 ids[2] 가 활성이어야 함.
    expect(activeAfterCloseLast).toBe(ids[2]);
  });
});
