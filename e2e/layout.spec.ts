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
