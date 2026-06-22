import { test, expect } from '@playwright/test';

// AGENT_ACTIVITY_PANEL_SRS e2e: agent activity panel.
// Covers TC-AAP-11 (card with location/state/detail), TC-AAP-12 (toggle),
// TC-AAP-13 (click → jump), TC-AAP-14 (in-place update), TC-AAP-17 (attention
// alarm composited onto the card).

async function waitForInit(page) {
  await page.context().addInitScript(() => {
    sessionStorage.setItem('displayMode', 'desktop');
  });
  await page.goto('/');
  await page.waitForSelector('#area .rg.focused .xterm-helper-textarea', { timeout: 15000 });
}

async function setActivity(page, paneId, state, tool, detail) {
  return page.evaluate(
    async (a) => {
      const r = await fetch('/api/panes/activity/set', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(a),
      });
      return r.status;
    },
    { paneId, state, tool, detail },
  );
}

test.describe('Agent activity panel', () => {
  test('card render, in-place update, toggle, jump', async ({ page }) => {
    await waitForInit(page);

    const pid = await page.locator('#area .rg.focused .rt.active').getAttribute('data-pid');
    expect(pid).toBeTruthy();

    // Open the panel (toggle button next to Split V).
    await page.locator('#agents-toggle').click();
    await expect(page.locator('#agents-panel.open')).toBeVisible();

    // Report a working activity → a card appears with the command detail.
    expect(await setActivity(page, pid, 'working', 'Bash', 'npm test')).toBe(200);
    const card = page.locator('#agents-panel .ag-card').first();
    await expect(card).toHaveCount(1, { timeout: 10000 });
    await expect(card.locator('.ag-detail')).toHaveText('npm test');
    await expect(card.locator('.ag-state')).toContainText('Bash');

    // A new signal overwrites the same card in place (TC-AAP-14).
    expect(await setActivity(page, pid, 'done', '', '')).toBe(200);
    await expect(page.locator('#agents-panel .ag-card')).toHaveCount(1);
    await expect(card.locator('.ag-state')).toContainText('done');

    // Clicking the card jumps to that pane (here the only pane → stays focused,
    // and the card click must not throw / panel still consistent).
    await card.click();
    await expect(page.locator('#area .rg.focused .rt.active')).toHaveAttribute('data-pid', pid!);
  });

  test('SessionEnd (ended) removes the card (FR-AAP-16)', async ({ page }) => {
    await waitForInit(page);
    const pid = await page.locator('#area .rg.focused .rt.active').getAttribute('data-pid');
    await page.locator('#agents-toggle').click();
    await expect(page.locator('#agents-panel.open')).toBeVisible();

    // done card present, then an `ended` signal removes it.
    expect(await setActivity(page, pid, 'done', '', 'x')).toBe(200);
    await expect(page.locator('#agents-panel .ag-card')).toHaveCount(1, { timeout: 10000 });
    expect(await setActivity(page, pid, 'ended', '', '')).toBe(200);
    await expect(page.locator('#agents-panel .ag-card')).toHaveCount(0, { timeout: 10000 });
  });

  test('most-recently-updated agent is on top (FR-AAP-13)', async ({ page }) => {
    await waitForInit(page);
    const pid1 = await page.locator('#area .rg.focused .rt.active').getAttribute('data-pid');

    // Second tab → a second pane.
    const before = await page.locator('#area .rg.focused .rt').count();
    await page.locator('#area .rg.focused .rt-add').click();
    await expect(page.locator('#area .rg.focused .rt')).toHaveCount(before + 1, { timeout: 10000 });
    const pid2 = await page.locator('#area .rg.focused .rt.active').getAttribute('data-pid');
    expect(pid1).toBeTruthy();
    expect(pid2).toBeTruthy();

    await page.locator('#agents-toggle').click();
    await expect(page.locator('#agents-panel.open')).toBeVisible();

    // done state isn't pruned by the busy check, so ordering is stable.
    expect(await setActivity(page, pid1, 'done', '', 'one')).toBe(200);
    expect(await setActivity(page, pid2, 'done', '', 'two')).toBe(200);
    await expect(page.locator('#agents-panel .ag-card')).toHaveCount(2, { timeout: 10000 });
    // pid2 updated last → top.
    await expect(page.locator('#agents-panel .ag-card').first()).toHaveAttribute('data-pid', pid2!);

    // Re-updating pid1 moves it to the top.
    expect(await setActivity(page, pid1, 'done', '', 'again')).toBe(200);
    await expect(page.locator('#agents-panel .ag-card').first()).toHaveAttribute('data-pid', pid1!);
  });

  test('attention alarm is composited onto the activity card (TC-AAP-17)', async ({ page }) => {
    await waitForInit(page);

    // Make a second tab so the first pane is in the background (foreground+active
    // panes suppress the attention highlight).
    const pid = await page.locator('#area .rg.focused .rt.active').getAttribute('data-pid');
    expect(pid).toBeTruthy();
    // done (not pruned by the busy check) so the card stays put through polling.
    expect(await setActivity(page, pid, 'done', '', 'finished')).toBe(200);

    await page.locator('#agents-toggle').click();
    await expect(page.locator('#agents-panel.open')).toBeVisible();
    const card = page.locator(`#agents-panel .ag-card[data-pid="${pid}"]`);
    await expect(card).toHaveCount(1, { timeout: 10000 });

    // Move focus to a new tab so the first pane is background, then raise an
    // attention alarm on it via the server endpoint. Wait for the new tab to
    // actually become active first (else the pane is still focused-active and
    // the alarm is suppressed).
    const before = await page.locator('#area .rg.focused .rt').count();
    await page.locator('#area .rg.focused .rt-add').click();
    await expect(page.locator('#area .rg.focused .rt')).toHaveCount(before + 1, { timeout: 10000 });
    await page.evaluate(async (p) => {
      await fetch('/api/panes/attention/set', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paneId: p, reason: 'done' }),
      });
    }, pid);

    await expect(card).toHaveClass(/attn/, { timeout: 10000 });
  });
});
