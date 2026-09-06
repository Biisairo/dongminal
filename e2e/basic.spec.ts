import { test, expect, waitForInit, waitShellReady } from './fixtures';

test.describe('Basic connection & lifecycle', () => {
  test('server starts and initial session is rendered', async ({ page }) => {
    await waitForInit(page);

    // At least one pane should exist after init (previous test state may linger).
    const rgCount = await page.locator('#area .pn').count();
    expect(rgCount).toBeGreaterThanOrEqual(1);
    // That pane should be focused.
    await expect(page.locator('#area .pn.focused')).toHaveCount(1);
    // One tab inside the focused pane.
    const tabs = page.locator('#area .pn.focused .pn-tab');
    await expect(tabs).toHaveCount(1);
    await expect(page.locator('#area .pn.focused .pn-tab.active')).toHaveCount(1);
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

    // 셸이 입력을 받을 수 있을 때까지 기다린다 — xterm 이 선 것과 셸이 뜬 것은
    // 다르고, Windows 에서는 그 사이에 넣은 입력이 사라진다 (FR-CEM-13).
    await waitShellReady(page);

    // Click the terminal canvas to focus it.
    await page.click('#area .pn.focused .xterm-screen');

    // Type a command.
    await page.keyboard.type('echo pw_test_42');
    await page.keyboard.press('Enter');

    // Wait for the echoed text to appear in xterm DOM.
    await expect(page.locator('#area .pn.focused .xterm-rows')).toContainText('pw_test_42', { timeout: 10000 });
  });

  test('page refresh reconnects existing pane', async ({ page }) => {
    await waitForInit(page);
    await waitShellReady(page);

    // Type something.
    await page.click('#area .pn.focused .xterm-screen');
    await page.keyboard.type('echo keep_alive');
    await page.keyboard.press('Enter');
    await expect(page.locator('#area .pn.focused .xterm-rows')).toContainText('keep_alive', { timeout: 10000 });

    // Refresh.
    await page.reload();
    await waitForInit(page);
    await page.waitForSelector('#area .pn.focused .xterm-rows', { timeout: 15000 });

    // Session should still exist.
    const rgCount = await page.locator('#area .pn').count();
    expect(rgCount).toBeGreaterThanOrEqual(1);
    await expect(page.locator('#area .pn.focused')).toHaveCount(1);
  });
});
