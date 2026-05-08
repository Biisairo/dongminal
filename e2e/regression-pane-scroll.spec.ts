import { test, expect } from '@playwright/test';

// SRS: PANE_SCROLL_PRESERVE_SRS.md
//   FR-1/FR-2: _rLayout 을 거치는 모든 경로(세션 전환, 같은 region 의 탭 전환)
//   에서 xterm viewport(viewportY) + .xterm-viewport.scrollTop 가 직전 위치로
//   복원되어야 한다.

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

async function activePaneOfFocused(page) {
  return await page.evaluate(() => {
    const a = (window as any).app;
    const s = a.ws.sessions.find((x: any) => x.id === a.ws.activeSession);
    const find = (n: any, id: string): any => {
      if (!n) return null;
      if (n.type === 'region' && n.id === id) return n;
      if (n.children) for (const c of n.children) { const r = find(c, id); if (r) return r; }
      return null;
    };
    const rg = find(s.layout, a.focused);
    const tab = rg.tabs.find((t: any) => t.id === rg.activeTab);
    const pane = a.panes.get(tab.paneId);
    const vp = pane.el.querySelector('.xterm-viewport');
    return {
      viewportY: pane.term.buffer.active.viewportY,
      scrollTop: vp ? vp.scrollTop : -1,
      bufferLen: pane.term.buffer.active.length,
    };
  });
}

async function fillScrollback(page, lines = 200) {
  await page.evaluate((n) => {
    const a = (window as any).app;
    const s = a.ws.sessions.find((x: any) => x.id === a.ws.activeSession);
    const find = (m: any, id: string): any => {
      if (!m) return null;
      if (m.type === 'region' && m.id === id) return m;
      if (m.children) for (const c of m.children) { const r = find(c, id); if (r) return r; }
      return null;
    };
    const rg = find(s.layout, a.focused);
    const tab = rg.tabs.find((t: any) => t.id === rg.activeTab);
    const pane = a.panes.get(tab.paneId);
    let payload = '';
    for (let i = 1; i <= n; i++) payload += `LINE-${i}\r\n`;
    pane.term.write(payload);
    pane.term.scrollToBottom();
  }, lines);
  await page.waitForTimeout(80);
}

async function scrollUp(page, lines: number) {
  await page.evaluate((n) => {
    const a = (window as any).app;
    const s = a.ws.sessions.find((x: any) => x.id === a.ws.activeSession);
    const find = (m: any, id: string): any => {
      if (!m) return null;
      if (m.type === 'region' && m.id === id) return m;
      if (m.children) for (const c of m.children) { const r = find(c, id); if (r) return r; }
      return null;
    };
    const rg = find(s.layout, a.focused);
    const tab = rg.tabs.find((t: any) => t.id === rg.activeTab);
    const pane = a.panes.get(tab.paneId);
    pane.term.scrollLines(-n);
  }, lines);
  await page.waitForTimeout(50);
}

test.describe('Pane scroll preserve regression', () => {
  test('xterm scroll position survives session switch and return', async ({ page, request }) => {
    await waitForInit(page, request);

    const sidA = await page.evaluate(() => (window as any).app.ws.activeSession);
    await fillScrollback(page, 200);
    await scrollUp(page, 80);
    const before = await activePaneOfFocused(page);
    expect(before.viewportY).toBeGreaterThan(0);

    // 세션 B 추가하여 활성 전환된 다음 다시 A 로 복귀.
    await addSession(page);
    await page.evaluate((sid) => (window as any).app.switchSession(sid), sidA);
    await page.waitForTimeout(120);

    const after = await activePaneOfFocused(page);
    // doFit reflow 보정으로 viewportY 는 ±2, scrollTop 은 ±2*lineHeight 허용.
    expect(Math.abs(after.viewportY - before.viewportY)).toBeLessThanOrEqual(2);
    expect(after.scrollTop).toBeGreaterThan(0);
  });

  test('xterm scroll position survives same-region tab switch', async ({ page, request }) => {
    await waitForInit(page, request);

    // 같은 region 에 두 번째 터미널 탭 추가.
    const tabIds = await page.evaluate(async () => {
      const a = (window as any).app;
      await a.addTab(a.focused, 'terminal');
      const s = a.ws.sessions.find((x: any) => x.id === a.ws.activeSession);
      const find = (m: any, id: string): any => {
        if (!m) return null;
        if (m.type === 'region' && m.id === id) return m;
        if (m.children) for (const c of m.children) { const r = find(c, id); if (r) return r; }
        return null;
      };
      const rg = find(s.layout, a.focused);
      return rg.tabs.map((t: any) => t.id);
    });
    expect(tabIds.length).toBe(2);

    // 첫 탭으로 다시 전환하여 스크롤백 채우기.
    await page.evaluate((tid) => (window as any).app.switchTab((window as any).app.focused, tid), tabIds[0]);
    await page.waitForTimeout(50);
    await fillScrollback(page, 200);
    await scrollUp(page, 80);
    const before = await activePaneOfFocused(page);
    expect(before.viewportY).toBeGreaterThan(0);

    // 두 번째 탭으로 전환했다가 첫 탭으로 복귀.
    await page.evaluate((tid) => (window as any).app.switchTab((window as any).app.focused, tid), tabIds[1]);
    await page.waitForTimeout(80);
    await page.evaluate((tid) => (window as any).app.switchTab((window as any).app.focused, tid), tabIds[0]);
    await page.waitForTimeout(120);

    const after = await activePaneOfFocused(page);
    expect(Math.abs(after.viewportY - before.viewportY)).toBeLessThanOrEqual(2);
    expect(after.scrollTop).toBeGreaterThan(0);
  });
});
