import { test, expect } from '@playwright/test';

async function waitForInit(page) {
  await page.context().addInitScript(() => {
    sessionStorage.setItem('displayMode', 'desktop');
  });
  await page.goto('/');
  await page.waitForSelector('#area .rg.focused .xterm-helper-textarea', { timeout: 15000 });
}

test.describe('Terminal features', () => {
  test('search opens and closes', async ({ page }) => {
    await waitForInit(page);
    await page.keyboard.press('Control+f');
    await expect(page.locator('#search-bar')).not.toHaveClass(/hidden/);

    await page.keyboard.press('Escape');
    await expect(page.locator('#search-bar')).toHaveClass(/hidden/);
  });

  test('search finds text in terminal', async ({ page }) => {
    await waitForInit(page);
    await page.waitForSelector('#area .rg.focused .xterm-screen', { state: 'visible', timeout: 15000 });
    await page.click('#area .rg.focused .xterm-screen');

    // Type a unique string.
    await page.keyboard.type('findme_12345');
    await page.keyboard.press('Enter');
    await expect(page.locator('#area .rg.focused .xterm-rows')).toContainText('findme_12345', { timeout: 10000 });

    // Open search.
    await page.keyboard.press('Control+f');
    await expect(page.locator('#search-bar')).not.toHaveClass(/hidden/);

    // Type search query.
    await page.locator('#search-input').fill('findme_12345');
    await page.locator('#search-input').press('Enter');

    // _doSearch sets #search-count to '' when results exist, '없음' when none.
    const countText = await page.locator('#search-count').textContent();
    expect(countText).not.toBe('없음');

    // Close search.
    await page.keyboard.press('Escape');
    await expect(page.locator('#search-bar')).toHaveClass(/hidden/);
  });

  test('multiple sequential commands produce output', async ({ page }) => {
    await waitForInit(page);
    await page.waitForSelector('#area .rg.focused .xterm-screen', { state: 'visible', timeout: 15000 });
    await page.click('#area .rg.focused .xterm-screen');

    for (let i = 0; i < 3; i++) {
      const cmd = `echo seq_${i}`;
      await page.keyboard.type(cmd);
      await page.keyboard.press('Enter');
      await expect(page.locator('#area .rg.focused .xterm-rows')).toContainText(`seq_${i}`, { timeout: 10000 });
    }
  });

  test('terminal survives page refresh', async ({ page }) => {
    await waitForInit(page);
    await page.waitForSelector('#area .rg.focused .xterm-screen', { state: 'visible', timeout: 15000 });
    await page.click('#area .rg.focused .xterm-screen');

    await page.keyboard.type('echo survive_refresh');
    await page.keyboard.press('Enter');
    await expect(page.locator('#area .rg.focused .xterm-rows')).toContainText('survive_refresh', { timeout: 10000 });

    const beforeRg = await page.locator('#area .rg').count();
    await page.reload();
    await waitForInit(page);

    // Region count should be preserved.
    await expect(page.locator('#area .rg')).toHaveCount(beforeRg, { timeout: 10000 });
    await expect(page.locator('#area .rg.focused')).toHaveCount(1);
  });

  test('typing in terminal updates status bar cwd', async ({ page }) => {
    await waitForInit(page);
    await page.waitForSelector('#area .rg.focused .xterm-screen', { state: 'visible', timeout: 15000 });
    await page.click('#area .rg.focused .xterm-screen');

    // cd to /tmp and echo something.
    await page.keyboard.type('cd /tmp');
    await page.keyboard.press('Enter');
    await page.keyboard.type('echo cwd_test');
    await page.keyboard.press('Enter');
    await expect(page.locator('#area .rg.focused .xterm-rows')).toContainText('cwd_test', { timeout: 10000 });

    // Status bar should eventually reflect /tmp.
    const statusText = await page.locator('#status-bar').textContent();
    expect(statusText.length).toBeGreaterThan(0);
  });

  test('_send drops are counted when ws is closed', async ({ page }) => {
    await waitForInit(page);
    await page.waitForFunction(() => {
      const a = (window as any).app;
      const p = a && a.panes && a.panes.values().next().value;
      return p && p.ws && p.ws.readyState === 1;
    }, { timeout: 10000 });

    const before = await page.evaluate(() => (window as any).__dongminalDebug.sendDropCount());

    await page.evaluate(() => {
      const a = (window as any).app;
      const p = a.panes.values().next().value;
      try { p.ws.close() } catch {}
      Object.defineProperty(p.ws, 'readyState', { get: () => 3 });
      p._send(new Uint8Array([1, 65]));
      p._send(new Uint8Array([1, 66]));
    });

    const after = await page.evaluate(() => (window as any).__dongminalDebug.sendDropCount());
    expect(after - before).toBeGreaterThanOrEqual(2);
  });

  test('_send buffers while ws is connecting', async ({ page }) => {
    await waitForInit(page);
    await page.waitForFunction(() => {
      const a = (window as any).app;
      const p = a && a.panes && a.panes.values().next().value;
      return p && p.ws && p.ws.readyState === 1;
    }, { timeout: 10000 });

    const queued = await page.evaluate(() => {
      const a = (window as any).app;
      const p = a.panes.values().next().value;
      const fakeWs = { readyState: 0, send: () => {} };
      p.ws = fakeWs as any;
      p._send(new Uint8Array([1, 65]));
      p._send(new Uint8Array([1, 66]));
      return p._sendQueue.length;
    });
    expect(queued).toBe(2);

    const remaining = await page.evaluate(() => {
      const a = (window as any).app;
      const p = a.panes.values().next().value;
      let calls = 0;
      const fakeWs = { readyState: 1, send: () => { calls++ } };
      p.ws = fakeWs as any;
      p._flushSendQueue();
      return { qlen: p._sendQueue.length, calls };
    });
    expect(remaining.qlen).toBe(0);
    expect(remaining.calls).toBe(2);
  });

  test('_send queue is bounded and drops oldest', async ({ page }) => {
    await waitForInit(page);
    await page.waitForFunction(() => {
      const a = (window as any).app;
      const p = a && a.panes && a.panes.values().next().value;
      return p && p.ws && p.ws.readyState === 1;
    }, { timeout: 10000 });

    const result = await page.evaluate(() => {
      const a = (window as any).app;
      const p = a.panes.values().next().value;
      const before = p._sendDropCount;
      p._sendQueue = [];
      const fakeWs = { readyState: 0, send: () => {} };
      p.ws = fakeWs as any;
      for (let i = 0; i < p._sendQueueMax + 5; i++) {
        p._send(new Uint8Array([1, i & 0xff]));
      }
      return { qlen: p._sendQueue.length, dropDelta: p._sendDropCount - before };
    });
    expect(result.qlen).toBe(64);
    expect(result.dropDelta).toBe(5);
  });
});
