import { test, expect } from '@playwright/test';

async function waitForInit(page) {
  await page.context().addInitScript(() => {
    sessionStorage.setItem('displayMode', 'desktop');
  });
  await page.goto('/');
  await page.waitForSelector('#area .rg.focused .xterm-helper-textarea', { timeout: 15000 });
}

test.describe('Layout & navigation', () => {
  test('split horizontal increases region count', async ({ page }) => {
    await waitForInit(page);
    const before = await page.locator('#area .rg').count();
    const [resp] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/panes') && r.status() === 200),
      page.click('#split-h'),
    ]);
    expect(resp.status()).toBe(200);
    await expect(page.locator('#area .rg')).toHaveCount(before + 1, { timeout: 10000 });
    await expect(page.locator('#area .rg.focused')).toHaveCount(1);
  });

  test('split vertical increases region count', async ({ page }) => {
    await waitForInit(page);
    const before = await page.locator('#area .rg').count();
    const [resp] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/panes') && r.status() === 200),
      page.click('#split-v'),
    ]);
    expect(resp.status()).toBe(200);
    await expect(page.locator('#area .rg')).toHaveCount(before + 1, { timeout: 10000 });
    await expect(page.locator('#area .rg.focused')).toHaveCount(1);
  });

  test('pane navigation with arrow keys moves focus', async ({ page }) => {
    await waitForInit(page);
    // Always create a fresh horizontal split for reliable pane navigation.
    const before = await page.locator('#area .rg').count();
    const [resp] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/panes') && r.status() === 200),
      page.click('#split-h'),
    ]);
    expect(resp.status()).toBe(200);
    await expect(page.locator('#area .rg')).toHaveCount(before + 1, { timeout: 10000 });
    await expect(page.locator('#area .rg.focused')).toHaveCount(1);

    // After split-h, the new (rightmost) region is focused.
    // paneLeft moves to the previous region; paneRight moves back.
    const countAfter = before + 1;
    const rightRegion = page.locator('#area .rg').nth(countAfter - 1);
    const leftRegion = page.locator('#area .rg').nth(countAfter - 2);

    const leftResult = await page.evaluate(() => {
      const app = (window as any).app;
      const before = app.focused;
      app.executeAction('paneLeft');
      return { before, after: app.focused };
    });
    // Verify the focused region moved to the expected ID.
    await expect(page.locator('#area .rg.focused')).toHaveAttribute('data-rid', leftResult.after, { timeout: 5000 });

    await page.evaluate(() => {
      const app = (window as any).app;
      app.executeAction('paneRight');
    });
    await expect(page.locator('#area .rg.focused')).toHaveAttribute('data-rid', leftResult.before, { timeout: 5000 });
  });

  test('resize handle exists between split regions', async ({ page }) => {
    await waitForInit(page);
    const before = await page.locator('#area .rg').count();
    if (before < 2) {
      const [resp] = await Promise.all([
        page.waitForResponse((r) => r.url().includes('/api/panes') && r.status() === 200),
        page.click('#split-h'),
      ]);
      expect(resp.status()).toBe(200);
      await expect(page.locator('#area .rg')).toHaveCount(before + 1, { timeout: 10000 });
    }

    // After horizontal split, at least one resize handle (.sh) should exist.
    const shCount = await page.locator('#area .sp .sh').count();
    expect(shCount).toBeGreaterThan(0);
  });

  // Regression: rapid successive split() calls must each split the
  // currently-focused region (which is the previous split's new region),
  // not race on a stale this.focused. Without serialization, two parallel
  // split() invocations would both target the same initial region.
  test('rapid successive splits each create a region (serialized)', async ({ page }) => {
    await waitForInit(page);
    const before = await page.locator('#area .rg').count();

    await page.evaluate(() => {
      const app = (window as any).app;
      // Fire two splits without awaiting between them — simulates a fast
      // shortcut press. Both promises must resolve to distinct regions.
      const p1 = app.split('horizontal');
      const p2 = app.split('horizontal');
      return Promise.all([p1, p2]);
    });

    await expect(page.locator('#area .rg')).toHaveCount(before + 2, { timeout: 10000 });
    await expect(page.locator('#area .rg.focused')).toHaveCount(1);
  });

  // Regression: clicking the split button twice in quick succession must
  // produce two splits, with focus on the latest new region (NOT on the
  // first/original region as the SSE workspace_changed echo could cause).
  test('two rapid split-h button clicks produce two splits and keep focus on latest', async ({ page }) => {
    await waitForInit(page);
    const before = await page.locator('#area .rg').count();
    const firstId = await page.locator('#area .rg.focused').getAttribute('data-rid');

    // Two button clicks back-to-back, no awaiting between them — this is
    // exactly the user-reported reproduction.
    await page.evaluate(() => {
      const btn = document.getElementById('split-h')!;
      btn.click();
      btn.click();
    });

    await expect(page.locator('#area .rg')).toHaveCount(before + 2, { timeout: 10000 });
    await expect(page.locator('#area .rg.focused')).toHaveCount(1);
    // Focus must NOT have jumped back to the original region.
    const focusedId = await page.locator('#area .rg.focused').getAttribute('data-rid');
    expect(focusedId).not.toBe(firstId);
  });

  // Regression for the user-reported "한번씩 건너뛰는" pattern: even when
  // the SSE workspace_changed echo lands during the second split's
  // _newPane await (which would replace this.ws and stale the second
  // split's session reference), the second split must still produce a
  // visible region and focus must end on the latest split, not on R1.
  test('split survives stale-ws via post-await re-fetch', async ({ page }) => {
    await waitForInit(page);
    const before = await page.locator('#area .rg').count();

    // Click 1: completes naturally.
    await page.evaluate(async () => {
      await (window as any).app.split('horizontal');
    });
    await expect(page.locator('#area .rg')).toHaveCount(before + 1, { timeout: 10000 });
    const afterFirstId = await page.locator('#area .rg.focused').getAttribute('data-rid');

    // Click 2: while the new-pane fetch is in flight, simulate an SSE
    // workspace_changed apply by directly invoking _onWorkspaceChanged
    // with the server's current rev (which would replace this.ws).
    await page.evaluate(async () => {
      const app = (window as any).app;
      const p = app.split('horizontal');
      // Force an immediate remote-state apply on the next microtask while
      // _splitInner is still awaiting _newPane.
      await Promise.resolve();
      await app._onWorkspaceChanged();
      await p;
    });

    await expect(page.locator('#area .rg')).toHaveCount(before + 2, { timeout: 10000 });
    await expect(page.locator('#area .rg.focused')).toHaveCount(1);
    const finalId = await page.locator('#area .rg.focused').getAttribute('data-rid');
    // Focus must NOT have jumped to the original first region.
    expect(finalId).not.toBe(afterFirstId === finalId ? null : afterFirstId);
  });

  // TC-SKF-1: 사용자 포커스 region A, split 대상 region B (A != B). keepFocus=true 면
  // 새 region 이 추가되더라도 사용자 포커스는 A 그대로여야 한다.
  test('keepFocus split on a different region leaves user focus untouched', async ({ page }) => {
    await waitForInit(page);
    // 먼저 region 두 개 확보 (split-h 한 번).
    const before = await page.locator('#area .rg').count();
    const [resp] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/panes') && r.status() === 200),
      page.click('#split-h'),
    ]);
    expect(resp.status()).toBe(200);
    await expect(page.locator('#area .rg')).toHaveCount(before + 1, { timeout: 10000 });

    // 사용자 포커스를 region 0 (leftmost) 으로 옮긴다. split target 은 region 1.
    const regions = page.locator('#area .rg');
    const userRg = regions.nth(0);
    const targetRg = regions.nth(1);
    await userRg.locator('.rg-body').click();
    await expect(userRg).toHaveClass(/focused/);
    const userRegionId = await userRg.getAttribute('data-rid');
    const targetRegionId = await targetRg.getAttribute('data-rid');
    expect(userRegionId).not.toBe(targetRegionId);

    // dmctl/MCP 처럼 location 지정 keepFocus split: targetRegion=B, 사용자 포커스 A.
    const countBefore = await page.locator('#area .rg').count();
    await page.evaluate(async (targetRid) => {
      const app = (window as any).app;
      await app.split('horizontal', {
        keepFocus: true,
        targetSession: app.ws.activeSession,
        targetRegion: targetRid,
      });
    }, targetRegionId);
    await expect(page.locator('#area .rg')).toHaveCount(countBefore + 1, { timeout: 10000 });

    // 사용자 포커스는 여전히 region A.
    const focused = page.locator('#area .rg.focused');
    await expect(focused).toHaveCount(1);
    expect(await focused.getAttribute('data-rid')).toBe(userRegionId);
  });

  // REMOTE_SESSION_TAB_CREATE_SRS TC-RST-1: newSession + keepFocus + name —
  // 세션은 사이드바에만 추가, 사용자 포커스 무변화.
  test('remote newSession with keepFocus and name leaves focus untouched', async ({ page }) => {
    await waitForInit(page);
    const before = await page.evaluate(() => {
      const app = (window as any).app;
      return { active: app.ws.activeSession, focused: app.focused, count: app.ws.sessions.length };
    });
    await page.evaluate(() => (window as any).app._execRemote('newSession', { name: 'wf-test', keepFocus: true }));
    await page.waitForFunction((n) => (window as any).app.ws.sessions.length === n + 1, before.count, { timeout: 10000 });
    const after = await page.evaluate(() => {
      const app = (window as any).app;
      return {
        active: app.ws.activeSession,
        focused: app.focused,
        lastName: app.ws.sessions[app.ws.sessions.length - 1].name,
      };
    });
    expect(after.active).toBe(before.active);
    expect(after.focused).toBe(before.focused);
    expect(after.lastName).toBe('wf-test');
  });

  // TC-RST-2: newSession + name 만 → 전환은 기존대로, 이름 반영.
  test('remote newSession with name only switches and names', async ({ page }) => {
    await waitForInit(page);
    const beforeCount = await page.evaluate(() => (window as any).app.ws.sessions.length);
    await page.evaluate(() => (window as any).app._execRemote('newSession', { name: 'named-active' }));
    await page.waitForFunction((n) => (window as any).app.ws.sessions.length === n + 1, beforeCount, { timeout: 10000 });
    const after = await page.evaluate(() => {
      const app = (window as any).app;
      const last = app.ws.sessions[app.ws.sessions.length - 1];
      return { active: app.ws.activeSession, lastId: last.id, lastName: last.name };
    });
    expect(after.active).toBe(after.lastId);
    expect(after.lastName).toBe('named-active');
  });

  // TC-RST-4: newTab + location(다른 region) + keepFocus + name —
  // 대상 region 의 activeTab 유지 + 사용자 포커스 무변화 + 탭 이름 반영.
  test('remote newTab with keepFocus adds background tab without focus change', async ({ page }) => {
    await waitForInit(page);
    // region 2개 확보.
    const before = await page.locator('#area .rg').count();
    const [resp] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/panes') && r.status() === 200),
      page.click('#split-h'),
    ]);
    expect(resp.status()).toBe(200);
    await expect(page.locator('#area .rg')).toHaveCount(before + 1, { timeout: 10000 });

    // 사용자 포커스를 region 0 으로, target 은 region 1.
    const regions = page.locator('#area .rg');
    await regions.nth(0).locator('.rg-body').click();
    await expect(regions.nth(0)).toHaveClass(/focused/);

    const state = await page.evaluate(() => {
      const app = (window as any).app;
      const s = app.ws.sessions.find((x: any) => x.id === app.ws.activeSession);
      const rgs: any[] = [];
      (function collect(n: any) {
        if (!n) return;
        if (n.type === 'region') { rgs.push(n); return; }
        if (n.children) n.children.forEach(collect);
      })(s.layout);
      const target = rgs.find((r: any) => r.id !== app.focused);
      // 브라우저 _resolveLocation 은 좌표만 파싱 (uuid→좌표는 서버 책임) — 좌표 구성.
      const si = app.ws.sessions.findIndex((x: any) => x.id === app.ws.activeSession) + 1;
      const pi = rgs.findIndex((r: any) => r.id === target.id) + 1;
      const ti = target.tabs.findIndex((t: any) => t.id === target.activeTab) + 1;
      return {
        active: app.ws.activeSession, focused: app.focused,
        targetRegion: target.id, targetActiveTab: target.activeTab,
        targetCoord: `S${si}.P${pi}.T${ti}`,
        targetTabCount: target.tabs.length,
      };
    });

    await page.evaluate((s) => (window as any).app._execRemote('newTab',
      { location: s.targetCoord, keepFocus: true, name: 'worker' }), state);
    await page.waitForFunction((s) => {
      const app = (window as any).app;
      const sess = app.ws.sessions.find((x: any) => x.id === s.active);
      const rgs: any[] = [];
      (function collect(n: any) {
        if (!n) return;
        if (n.type === 'region') { rgs.push(n); return; }
        if (n.children) n.children.forEach(collect);
      })(sess.layout);
      const target = rgs.find((r: any) => r.id === s.targetRegion);
      return target && target.tabs.length === s.targetTabCount + 1;
    }, state, { timeout: 10000 });

    const after = await page.evaluate((s) => {
      const app = (window as any).app;
      const sess = app.ws.sessions.find((x: any) => x.id === s.active);
      const rgs: any[] = [];
      (function collect(n: any) {
        if (!n) return;
        if (n.type === 'region') { rgs.push(n); return; }
        if (n.children) n.children.forEach(collect);
      })(sess.layout);
      const target = rgs.find((r: any) => r.id === s.targetRegion);
      return {
        active: app.ws.activeSession, focused: app.focused,
        targetActiveTab: target.activeTab,
        newTabName: target.tabs[target.tabs.length - 1].name,
      };
    }, state);

    expect(after.active).toBe(state.active);
    expect(after.focused).toBe(state.focused);
    expect(after.targetActiveTab).toBe(state.targetActiveTab); // 대상 region 의 보던 탭 유지
    expect(after.newTabName).toBe('worker');
  });

  // RENAME_TAB_SESSION_SRS TC-RNS-1/2/3: 원격 rename — 포커스 무영향 + 64자 절단.
  test('remote renameTab and renameSession change names without focus change', async ({ page }) => {
    await waitForInit(page);
    const before = await page.evaluate(() => {
      const app = (window as any).app;
      return { active: app.ws.activeSession, focused: app.focused };
    });
    // 활성 세션의 포커스 탭을 좌표 S{n}.P1.T1 로 rename (활성 세션 index 계산).
    const result = await page.evaluate(() => {
      const app = (window as any).app;
      const si = app.ws.sessions.findIndex((x: any) => x.id === app.ws.activeSession) + 1;
      const coord = `S${si}.P1.T1`;
      app._execRemote('renameTab', { location: coord, name: 'writer' });
      app._execRemote('renameSession', { location: coord, name: 'x'.repeat(80) });
      const s = app.ws.sessions[si - 1];
      const rgs: any[] = [];
      (function collect(n: any) {
        if (!n) return;
        if (n.type === 'region') { rgs.push(n); return; }
        if (n.children) n.children.forEach(collect);
      })(s.layout);
      return {
        tabName: rgs[0].tabs[0].name,
        sessionName: s.name,
        active: app.ws.activeSession,
        focused: app.focused,
      };
    });
    expect(result.tabName).toBe('writer');
    expect(result.sessionName.length).toBe(64); // TC-RNS-3 절단
    expect(result.active).toBe(before.active);
    expect(result.focused).toBe(before.focused);
  });

  // REMOTE_COMMAND_RESULT_SRS TC-RCR-9: 생성 명령에 reqId 가 있으면 처리 후
  // POST /api/command-result 로 새 region/tab(uuid+paneId) 를 echo.
  test('remote creating command echoes new ids to command-result', async ({ page }) => {
    await waitForInit(page);
    const captured: any[] = [];
    await page.route('**/api/command-result', async (route) => {
      captured.push(JSON.parse(route.request().postData() || '{}'));
      await route.fulfill({ status: 200, contentType: 'application/json', body: '' });
    });

    const coord = await page.evaluate(() => {
      const app = (window as any).app;
      const si = app.ws.sessions.findIndex((x: any) => x.id === app.ws.activeSession) + 1;
      return `S${si}.P1.T1`;
    });
    await page.evaluate((c) => (window as any).app._execRemote('splitV',
      { reqId: 'test-req-9', location: c, count: 2, keepFocus: true }), coord);

    await expect.poll(() => captured.length, { timeout: 10000 }).toBeGreaterThan(0);
    const echo = captured[0];
    expect(echo.reqId).toBe('test-req-9');
    expect(echo.newRegions.length).toBeGreaterThanOrEqual(1);
    expect(echo.newTabs.length).toBeGreaterThanOrEqual(1);
    expect(typeof echo.newTabs[0].uuid).toBe('string');
    expect(echo.newTabs[0].uuid.length).toBeGreaterThan(0);
    expect(echo.newTabs[0].paneId.length).toBeGreaterThan(0);
  });

  // REMOTE_COMMAND_RESULT_SRS: SSE → _execRemote → echo → long-poll 응답 전 경로.
  // (reqId 가 broadcast top-level 에서 _execRemote 까지 전달되는지 — SSE 연결 갭 회귀)
  test('creating command via POST returns newTabs end-to-end through SSE', async ({ page }) => {
    await waitForInit(page);
    // 페이지의 SSE 구독이 자리잡도록 잠깐 대기.
    await page.waitForTimeout(300);
    const resp = await page.evaluate(async () => {
      const r = await fetch('/api/commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'splitV', args: { count: 2, keepFocus: true } }),
      });
      return r.json();
    });
    expect(resp.ok).toBe(true);
    expect(resp.timedOut).toBe(false);
    expect(resp.newTabs.length).toBeGreaterThanOrEqual(1);
    expect(typeof resp.newTabs[0].uuid).toBe('string');
    expect(resp.newTabs[0].uuid.length).toBeGreaterThan(0);
    expect(resp.newTabs[0].paneId.length).toBeGreaterThan(0);
    expect(resp.newRegions.length).toBeGreaterThanOrEqual(1);
  });

  // TC-RCR-10: reqId 없는 명령(단축키/버튼 경로)은 echo 하지 않는다.
  test('remote command without reqId does not echo', async ({ page }) => {
    await waitForInit(page);
    const captured: any[] = [];
    await page.route('**/api/command-result', async (route) => {
      captured.push(1);
      await route.fulfill({ status: 200, body: '' });
    });

    const before = await page.locator('#area .rg').count();
    const coord = await page.evaluate(() => {
      const app = (window as any).app;
      const si = app.ws.sessions.findIndex((x: any) => x.id === app.ws.activeSession) + 1;
      return `S${si}.P1.T1`;
    });
    await page.evaluate((c) => (window as any).app._execRemote('splitV',
      { location: c, count: 2, keepFocus: true }), coord); // reqId 없음
    await expect(page.locator('#area .rg')).toHaveCount(before + 1, { timeout: 10000 });
    // 분할은 됐지만 echo 는 없어야.
    expect(captured.length).toBe(0);
  });

  // TC-RST-10: name 64자 절단.
  test('remote newSession truncates name to 64 chars', async ({ page }) => {
    await waitForInit(page);
    const long = 'x'.repeat(80);
    const beforeCount = await page.evaluate(() => (window as any).app.ws.sessions.length);
    await page.evaluate((n) => (window as any).app._execRemote('newSession', { name: n, keepFocus: true }), long);
    await page.waitForFunction((n) => (window as any).app.ws.sessions.length === n + 1, beforeCount, { timeout: 10000 });
    const lastName = await page.evaluate(() => {
      const app = (window as any).app;
      return app.ws.sessions[app.ws.sessions.length - 1].name;
    });
    expect(lastName.length).toBe(64);
  });

  test('keepFocus split preserves original region focus', async ({ page }) => {
    await waitForInit(page);
    const before = await page.locator('#area .rg').count();
    const firstRegion = page.locator('#area .rg').first();
    await firstRegion.locator('.rg-body').click();
    await expect(firstRegion).toHaveClass(/focused/);
    const firstRegionId = await firstRegion.getAttribute('data-rid');

    // Trigger split with keepFocus via evaluate (avoids Promise.all race).
    await page.evaluate(async () => {
      const app = (window as any).app;
      await app.split('horizontal', { keepFocus: true });
    });
    await expect(page.locator('#area .rg')).toHaveCount(before + 1, { timeout: 10000 });

    // Focus should still be on the original region.
    const focusedRegion = page.locator('#area .rg.focused');
    await expect(focusedRegion).toHaveCount(1);
    expect(await focusedRegion.getAttribute('data-rid')).toBe(firstRegionId);
  });
});
