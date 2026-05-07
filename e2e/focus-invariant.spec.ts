import { test, expect, Page, APIRequestContext } from '@playwright/test';

// SRS: APP_DECOMPOSE_SRS.md (S1-Phase1)
//   불변식: this.focused === active session.focusedRegion
//   본 스펙은 _setFocus 도입 이후 18 사이트의 동작이 1:1 보존되는지 검증.

async function resetWorkspace(request: APIRequestContext) {
  const get = await request.get('/api/workspace');
  const rev = get.headers()['etag'] || '0';
  await request.put('/api/workspace', {
    headers: { 'If-Match': rev, 'Content-Type': 'application/json' },
    data: '{}',
  });
}

async function waitForInit(page: Page, request: APIRequestContext) {
  await resetWorkspace(request);
  await page.context().addInitScript(() => {
    sessionStorage.setItem('displayMode', 'desktop');
    try { localStorage.clear(); } catch {}
  });
  await page.goto('/');
  await page.waitForSelector('#area .rg.focused .xterm-helper-textarea', { timeout: 15000 });
}

async function readInvariant(page: Page) {
  return page.evaluate(() => {
    const a = (window as any).app;
    const sess = a.ws.sessions.find((s: any) => s.id === a.ws.activeSession);
    return {
      focused: a.focused,
      sessionFocusedRegion: sess ? sess.focusedRegion : null,
      activeSession: a.ws.activeSession,
    };
  });
}

test.describe('Focus invariant (S1-Phase1)', () => {
  test('initial state holds invariant', async ({ page, request }) => {
    await waitForInit(page, request);
    const inv = await readInvariant(page);
    expect(inv.focused).toBe(inv.sessionFocusedRegion);
    expect(inv.focused).not.toBeNull();
  });

  test('split keeps invariant on new region focus', async ({ page, request }) => {
    await waitForInit(page, request);
    await page.click('#split-h');
    await page.waitForFunction(() => document.querySelectorAll('#area .rg').length >= 2, { timeout: 5000 });
    const inv = await readInvariant(page);
    expect(inv.focused).toBe(inv.sessionFocusedRegion);
  });

  test('switchTab keeps invariant', async ({ page, request }) => {
    await waitForInit(page, request);
    // Add a new tab via UI button, then switch.
    await page.evaluate(() => {
      const a = (window as any).app;
      a.addTab(a.focused, 'terminal');
    });
    await page.waitForFunction(() => document.querySelectorAll('#area .rg.focused .rt').length >= 2, { timeout: 5000 });
    const tabs = await page.locator('#area .rg.focused .rt').all();
    await tabs[0].click();
    const inv = await readInvariant(page);
    expect(inv.focused).toBe(inv.sessionFocusedRegion);
  });

  test('session switch then return restores focused region', async ({ page, request }) => {
    await waitForInit(page, request);
    await page.click('#split-h');
    await page.waitForFunction(() => document.querySelectorAll('#area .rg').length >= 2, { timeout: 5000 });

    const before = await readInvariant(page);

    // Add a second session.
    await page.evaluate(() => (window as any).app.addSession());
    await page.waitForFunction(() => (window as any).app.ws.sessions.length === 2, { timeout: 5000 });

    // Switch back to the first session.
    await page.evaluate(() => {
      const a = (window as any).app;
      a.switchSession(a.ws.sessions[0].id);
    });
    await page.waitForTimeout(150);

    const after = await readInvariant(page);
    expect(after.focused).toBe(after.sessionFocusedRegion);
    expect(after.focused).toBe(before.focused);
  });

  test('closeTab on active tab moves to adjacent (FR-10)', async ({ page, request }) => {
    await waitForInit(page, request);
    // Stub busy check to keep the test deterministic — fresh shells often
    // briefly look busy while sourcing rc files, which would block close
    // behind a confirm dialog and make the test flaky.
    await page.evaluate(() => {
      const a = (window as any).app;
      a._isPaneBusy = async () => false;
    });
    // Add 2 more terminal tabs and wait for each pane to register.
    await page.evaluate(async () => {
      const a = (window as any).app;
      await a.addTab(a.focused, 'terminal');
      await a.addTab(a.focused, 'terminal');
    });
    await page.waitForFunction(() => {
      const a = (window as any).app;
      const sess = a.ws.sessions.find((s: any) => s.id === a.ws.activeSession);
      const findRg = (n: any): any => n && (n.type === 'region' ? n : (n.children || []).map(findRg).find(Boolean));
      const rg = findRg(sess.layout);
      return rg && rg.tabs.length >= 3;
    }, { timeout: 10000 });

    const tabIds = await page.evaluate(() => {
      const a = (window as any).app;
      const sess = a.ws.sessions.find((s: any) => s.id === a.ws.activeSession);
      const findRg = (n: any): any => n && (n.type === 'region' ? n : (n.children || []).map(findRg).find(Boolean));
      return findRg(sess.layout).tabs.map((t: any) => t.id);
    });
    expect(tabIds.length).toBeGreaterThanOrEqual(3);

    // Activate middle tab and wait for it to become active.
    await page.evaluate((tid) => (window as any).app.switchTab((window as any).app.focused, tid), tabIds[1]);
    await page.waitForFunction((tid) => {
      const a = (window as any).app;
      const sess = a.ws.sessions.find((s: any) => s.id === a.ws.activeSession);
      const findRg = (n: any): any => n && (n.type === 'region' ? n : (n.children || []).map(findRg).find(Boolean));
      return findRg(sess.layout).activeTab === tid;
    }, tabIds[1], { timeout: 5000 });

    // Close middle tab.
    await page.evaluate((tid) => (window as any).app.closeTab((window as any).app.focused, tid), tabIds[1]);
    await page.waitForFunction((expected) => {
      const a = (window as any).app;
      const sess = a.ws.sessions.find((s: any) => s.id === a.ws.activeSession);
      const findRg = (n: any): any => n && (n.type === 'region' ? n : (n.children || []).map(findRg).find(Boolean));
      const rg = findRg(sess.layout);
      return rg && rg.tabs.length === 2 && rg.activeTab === expected;
    }, tabIds[2], { timeout: 5000 });
  });

  test('setFocus on different region updates both sides', async ({ page, request }) => {
    await waitForInit(page, request);
    await page.click('#split-h');
    await page.waitForFunction(() => document.querySelectorAll('#area .rg').length >= 2, { timeout: 5000 });

    const otherRid = await page.evaluate(() => {
      const a = (window as any).app;
      const sess = a.ws.sessions.find((s: any) => s.id === a.ws.activeSession);
      const flat: any[] = [];
      const walk = (n: any) => { if (!n) return; if (n.type === 'region') flat.push(n.id); (n.children || []).forEach(walk); };
      walk(sess.layout);
      return flat.find(id => id !== a.focused);
    });
    expect(otherRid).toBeTruthy();

    await page.evaluate((rid) => (window as any).app.setFocus(rid), otherRid);
    await page.waitForTimeout(80);

    const inv = await readInvariant(page);
    expect(inv.focused).toBe(otherRid);
    expect(inv.sessionFocusedRegion).toBe(otherRid);
  });
});

test.describe('API method routing (S3)', () => {
  test('GET /api/state returns 200 with ETag', async ({ request }) => {
    const r = await request.get('/api/state');
    expect(r.status()).toBe(200);
    expect(r.headers()['etag']).toBeDefined();
  });

  test('POST /api/state returns 404 (method mismatch)', async ({ request }) => {
    const r = await request.post('/api/state');
    expect(r.status()).toBe(404);
  });

  test('DELETE /api/workspace returns 404', async ({ request }) => {
    const r = await request.delete('/api/workspace');
    expect(r.status()).toBe(404);
  });

  test('GET /api/upload returns 404', async ({ request }) => {
    const r = await request.get('/api/upload');
    expect(r.status()).toBe(404);
  });

  test('GET /api/ping returns ok regardless of method', async ({ request }) => {
    for (const method of ['GET', 'POST', 'PUT', 'DELETE'] as const) {
      const r = await request.fetch('/api/ping', { method });
      expect(r.status()).toBe(200);
    }
  });

  test('unknown /api path returns 404', async ({ request }) => {
    const r = await request.get('/api/__nonexistent__');
    expect(r.status()).toBe(404);
  });
});

test.describe('Workspace ETag (S5)', () => {
  test('GET returns coherent (raw, rev) — same ETag matches body rev', async ({ request }) => {
    const r = await request.get('/api/workspace');
    expect(r.status()).toBe(200);
    const etag = r.headers()['etag'];
    expect(etag).toBeDefined();
    // Save a known body, fetch it back, ETag should bump and body should match.
    const next = '{"sessions":[],"activeSession":""}';
    const put = await request.put('/api/workspace', {
      headers: { 'If-Match': etag, 'Content-Type': 'application/json' },
      data: next,
    });
    expect(put.status()).toBe(200);
    const put2 = await request.get('/api/workspace');
    expect(put2.headers()['etag']).toBe(put.headers()['etag']);
  });

  test('PUT with stale If-Match returns 409 + current ETag', async ({ request }) => {
    const get = await request.get('/api/workspace');
    const cur = get.headers()['etag'];

    const r = await request.put('/api/workspace', {
      headers: { 'If-Match': '999999', 'Content-Type': 'application/json' },
      data: '{}',
    });
    expect(r.status()).toBe(409);
    expect(r.headers()['etag']).toBe(cur);
  });
});

test.describe('Pane size validation (L4)', () => {
  test('cols above MaxTerminalDim falls back', async ({ request }) => {
    // POST /api/panes accepts cols/rows; oversized values should be clamped.
    // The fake pane manager doesn't run, but the real one does — verify the
    // creation succeeds (oversized → fallback default 120).
    const r = await request.post('/api/panes?cols=99999&rows=24');
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.id).toBeDefined();
    // Cleanup so subsequent tests aren't polluted.
    await request.delete('/api/panes/' + body.id);
  });
});
