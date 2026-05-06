import { test, expect } from '@playwright/test';

async function waitForInit(page) {
  await page.context().addInitScript(() => {
    sessionStorage.setItem('displayMode', 'desktop');
  });
  await page.goto('/');
  // Wait for init() → render() → xterm readiness inside the focused region.
  await page.waitForSelector('#area .rg.focused .xterm-helper-textarea', { timeout: 15000 });
}

test.describe('Basic connection & lifecycle', () => {
  test('server starts and initial session is rendered', async ({ page }) => {
    await waitForInit(page);

    // At least one region should exist after init (previous test state may linger).
    const rgCount = await page.locator('#area .rg').count();
    expect(rgCount).toBeGreaterThanOrEqual(1);
    // That region should be focused.
    await expect(page.locator('#area .rg.focused')).toHaveCount(1);
    // One tab inside the focused region.
    const tabs = page.locator('#area .rg.focused .rt');
    await expect(tabs).toHaveCount(1);
    await expect(page.locator('#area .rg.focused .rt.active')).toHaveCount(1);
  });

  test('status bar shows connection info', async ({ page }) => {
    await waitForInit(page);
    const statusBar = page.locator('#status-bar');
    await expect(statusBar).toBeVisible();
    // Status bar should contain some text after a short delay.
    await expect(statusBar).not.toHaveText('', { timeout: 5000 });
  });

  test('terminal input produces output', async ({ page }) => {
    await waitForInit(page);

    // Wait for xterm to render inside the focused region.
    await page.waitForSelector('#area .rg.focused .xterm-rows', { timeout: 15000 });
    await page.waitForSelector('#area .rg.focused .xterm-screen', { state: 'visible', timeout: 15000 });

    // Click the terminal canvas to focus it.
    await page.click('#area .rg.focused .xterm-screen');

    // Type a command.
    await page.keyboard.type('echo pw_test_42');
    await page.keyboard.press('Enter');

    // Wait for the echoed text to appear in xterm DOM.
    await expect(page.locator('#area .rg.focused .xterm-rows')).toContainText('pw_test_42', { timeout: 10000 });
  });

  test('page refresh reconnects existing pane', async ({ page }) => {
    await waitForInit(page);
    await page.waitForSelector('#area .rg.focused .xterm-rows', { timeout: 15000 });

    // Type something.
    await page.click('#area .rg.focused .xterm-screen');
    await page.keyboard.type('echo keep_alive');
    await page.keyboard.press('Enter');
    await expect(page.locator('#area .rg.focused .xterm-rows')).toContainText('keep_alive', { timeout: 10000 });

    // Refresh.
    await page.reload();
    await waitForInit(page);
    await page.waitForSelector('#area .rg.focused .xterm-rows', { timeout: 15000 });

    // Session should still exist.
    const rgCount = await page.locator('#area .rg').count();
    expect(rgCount).toBeGreaterThanOrEqual(1);
    await expect(page.locator('#area .rg.focused')).toHaveCount(1);
  });
});
