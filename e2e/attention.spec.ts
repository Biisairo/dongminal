import { test, expect } from '@playwright/test';

// PANE_ATTENTION_NOTIFY_SRS e2e: terminal-monitoring attention.
// Covers TC-PAN-15 (background tab highlight, distinct from focus),
// TC-PAN-18 (title/badge count), TC-PAN-21 (notification center list),
// TC-PAN-22 (center item click → jump + clear).

async function waitForInit(page) {
  await page.context().addInitScript(() => {
    sessionStorage.setItem('displayMode', 'desktop');
  });
  await page.goto('/');
  await page.waitForSelector('#area .rg.focused .xterm-helper-textarea', { timeout: 15000 });
}

test.describe('Pane attention', () => {
  test('background pane attention: highlight, center, jump-to-clear', async ({ page }) => {
    await waitForInit(page);

    // In the focused pane, run a foreground command that fires `dmctl notify`
    // (the real agent-facing primitive) after a delay. Foreground mirrors how a
    // real agent hook runs (the agent owns the pane's foreground), while we
    // switch away so the signalling pane is in the background — not the
    // focused-active tab, which would be suppressed.
    await page.waitForSelector('#area .rg.focused .xterm-screen', { state: 'visible', timeout: 15000 });
    // Absolute path: a stale dmctl earlier in PATH would not understand `notify`
    // (the real wrappers also call dmctl by absolute path for this reason).
    await page.keyboard.type('sleep 2 && "$DONGMINAL_HOME/bin/dmctl" notify done');
    await page.keyboard.press('Enter');

    // Add a new tab → it becomes the focused/active tab; the first tab's pane
    // is now in the background.
    const before = await page.locator('#area .rg.focused .rt').count();
    const [resp] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/panes') && r.status() === 200),
      page.locator('#area .rg.focused .rt-add').click(),
    ]);
    expect(resp.status()).toBe(200);
    await expect(page.locator('#area .rg.focused .rt')).toHaveCount(before + 1, { timeout: 10000 });

    // The background (first) tab gains the attention highlight; it must NOT be
    // the focus/active styling (distinct class).
    const firstTab = page.locator('#area .rg.focused .rt').first();
    await expect(firstTab).toHaveClass(/attn/, { timeout: 10000 });
    await expect(firstTab).not.toHaveClass(/active/);

    // Badge appears with count 1; title gets the count badge.
    const badge = page.locator('#attn-badge');
    await expect(badge).toBeVisible();
    await expect(badge.locator('.attn-count')).toHaveText('1');
    await expect.poll(() => page.title()).toContain('(1)');

    // The alarm must PERSIST until the user attends — it must not auto-clear
    // (regression guard: raw terminal input/echo must not dismiss it).
    await page.waitForTimeout(1000);
    await expect(firstTab).toHaveClass(/attn/);
    await expect(badge).toBeVisible();

    // Open the notification center: one item listed.
    await badge.click();
    await expect(page.locator('#attn-center.open')).toBeVisible();
    await expect(page.locator('#attn-center .attn-item')).toHaveCount(1);

    // Clicking the item jumps to that pane → attention clears everywhere.
    await page.locator('#attn-center .attn-item').first().click();
    await expect(page.locator('#area .rg.focused .rt').first()).not.toHaveClass(/attn/, { timeout: 10000 });
    await expect(badge).toBeHidden();
    await expect.poll(() => page.title()).not.toContain('(1)');
  });
});
