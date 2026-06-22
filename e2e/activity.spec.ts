import { test, expect } from '@playwright/test';

// AGENT_ACTIVITY_PANEL_SRS e2e: agent activity panel.
// Covers TC-AAP-11 (card with location/state/detail), TC-AAP-12 (toggle),
// TC-AAP-13 (click → jump), TC-AAP-14 (in-place update), TC-AAP-17 (attention
// alarm composited onto the card), TC-AAP-19 (new agent appends at bottom,
// status update keeps position), TC-AAP-20 (drag reorder persisted).

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

  test('new agent appends at bottom, status update keeps position (TC-AAP-19)', async ({ page }) => {
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
    // pid1 reported first → top; pid2 reported second → appended at the bottom.
    expect(await setActivity(page, pid1, 'done', '', 'one')).toBe(200);
    expect(await setActivity(page, pid2, 'done', '', 'two')).toBe(200);
    await expect(page.locator('#agents-panel .ag-card')).toHaveCount(2, { timeout: 10000 });
    await expect(page.locator('#agents-panel .ag-card').first()).toHaveAttribute('data-pid', pid1!);
    await expect(page.locator('#agents-panel .ag-card').last()).toHaveAttribute('data-pid', pid2!);

    // Re-updating pid1 (status change) must NOT move it — order stays pid1, pid2.
    expect(await setActivity(page, pid1, 'working', 'Bash', 'again')).toBe(200);
    await expect(page.locator('#agents-panel .ag-card').first()).toHaveAttribute('data-pid', pid1!);
    await expect(page.locator('#agents-panel .ag-card').last()).toHaveAttribute('data-pid', pid2!);
  });

  test('drag reorders cards and persists to workspace (TC-AAP-20)', async ({ page }) => {
    await waitForInit(page);
    const pid1 = await page.locator('#area .rg.focused .rt.active').getAttribute('data-pid');

    const before = await page.locator('#area .rg.focused .rt').count();
    await page.locator('#area .rg.focused .rt-add').click();
    await expect(page.locator('#area .rg.focused .rt')).toHaveCount(before + 1, { timeout: 10000 });
    const pid2 = await page.locator('#area .rg.focused .rt.active').getAttribute('data-pid');

    await page.locator('#agents-toggle').click();
    await expect(page.locator('#agents-panel.open')).toBeVisible();

    expect(await setActivity(page, pid1, 'done', '', 'one')).toBe(200);
    expect(await setActivity(page, pid2, 'done', '', 'two')).toBe(200);
    await expect(page.locator('#agents-panel .ag-card')).toHaveCount(2, { timeout: 10000 });
    // Initial order: pid1, pid2.
    await expect(page.locator('#agents-panel .ag-card').first()).toHaveAttribute('data-pid', pid1!);

    // Drag pid2's card above pid1's card (native HTML5 DnD via synthetic events
    // sharing one DataTransfer — same path the sidebar session DnD uses). Full
    // browser sequence: drop commits immediately (no snap-back flicker), dragend
    // is a guarded fallback (must NOT double-move thanks to _drag.done).
    await page.evaluate(
      ({ src, dst }) => {
        const dt = new DataTransfer();
        const s = document.querySelector(`#agents-panel .ag-card[data-pid="${src}"]`)!;
        const d = document.querySelector(`#agents-panel .ag-card[data-pid="${dst}"]`)!;
        const rect = d.getBoundingClientRect();
        const y = rect.top + 2; // upper half → insert before
        s.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
        d.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt, clientY: y }));
        d.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt, clientY: y }));
        s.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
      },
      { src: pid2, dst: pid1 },
    );

    // New order: pid2, pid1.
    await expect(page.locator('#agents-panel .ag-card').first()).toHaveAttribute('data-pid', pid2!, {
      timeout: 10000,
    });
    await expect(page.locator('#agents-panel .ag-card').last()).toHaveAttribute('data-pid', pid1!);

    // Persisted into ws.agentsOrder and survives a polling re-sync.
    const order = await page.evaluate(() => (window as any).app.ws.agentsOrder);
    expect(order.indexOf(pid2)).toBeLessThan(order.indexOf(pid1));
    await page.evaluate(() => (window as any).app._activityRestore());
    await expect(page.locator('#agents-panel .ag-card').first()).toHaveAttribute('data-pid', pid2!, {
      timeout: 10000,
    });

    // Dropping OUTSIDE the panel must also commit immediately (document-level
    // accept). Drag pid2 back below pid1 but release on document.body.
    await page.evaluate(
      ({ src, dst }) => {
        const dt = new DataTransfer();
        const s = document.querySelector(`#agents-panel .ag-card[data-pid="${src}"]`)!;
        const d = document.querySelector(`#agents-panel .ag-card[data-pid="${dst}"]`)!;
        const rect = d.getBoundingClientRect();
        const y = rect.bottom - 2; // lower half → insert after
        s.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
        d.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt, clientY: y }));
        // Release far outside the panel — handled by the document-level drop.
        document.body.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt, clientY: 5 }));
        s.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
      },
      { src: pid2, dst: pid1 },
    );
    await expect(page.locator('#agents-panel .ag-card').first()).toHaveAttribute('data-pid', pid1!, {
      timeout: 10000,
    });
    await expect(page.locator('#agents-panel .ag-card').last()).toHaveAttribute('data-pid', pid2!);
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
