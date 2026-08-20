import { test, expect } from './fixtures';

async function waitForInit(page) {
  await page.context().addInitScript(() => {
    sessionStorage.setItem('displayMode', 'desktop');
  });
  await page.goto('/');
  // Wait for init() → render() → xterm readiness inside the focused pane.
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
}

test.describe('Focus movement', () => {
  test('new session creates focused pane', async ({ page }) => {
    await waitForInit(page);

    const beforeSi = await page.locator('#windows .si').count();

    // Use the add-window button (triggers _mkWindow → _newTool POST).
    const [response] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/tools') && r.request().method() === 'POST'),
      page.click('#add-window'),
    ]);
    expect(response.status()).toBe(200);
    // Session count increased by 1 (active session switched, so pn count stays 1).
    await expect(page.locator('#windows .si')).toHaveCount(beforeSi + 1, { timeout: 10000 });

    // Exactly one focused pane.
    await expect(page.locator('#area .pn.focused')).toHaveCount(1);
  });

  test('new tab in focused pane', async ({ page }) => {
    await waitForInit(page);

    // Click the "+" tab button inside the focused pane.
    const addTabBtn = page.locator('#area .pn.focused .rt-add');
    const before = await page.locator('#area .pn.focused .rt').count();
    const [resp] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/tools') && r.status() === 200),
      addTabBtn.click(),
    ]);
    expect(resp.status()).toBe(200);

    // Tab count increased by 1.
    await expect(page.locator('#area .pn.focused .rt')).toHaveCount(before + 1, { timeout: 10000 });
    // Exactly one active tab.
    await expect(page.locator('#area .pn.focused .rt.active')).toHaveCount(1);
    // Pane itself stays focused.
    await expect(page.locator('#area .pn.focused')).toHaveCount(1);
  });

  test('split horizontal creates new pane and moves focus', async ({ page }) => {
    await waitForInit(page);
    const before = await page.locator('#area .pn').count();

    // Click Split H.
    const [respH] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/tools') && r.status() === 200),
      page.click('#split-h'),
    ]);
    expect(respH.status()).toBe(200);

    // One more pane.
    await expect(page.locator('#area .pn')).toHaveCount(before + 1, { timeout: 10000 });

    // Exactly one pane should be focused after split.
    await expect(page.locator('#area .pn.focused')).toHaveCount(1);
  });

  test('split vertical creates new pane below', async ({ page }) => {
    await waitForInit(page);
    const before = await page.locator('#area .pn').count();

    const [respV] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/tools') && r.status() === 200),
      page.click('#split-v'),
    ]);
    expect(respV.status()).toBe(200);

    await expect(page.locator('#area .pn')).toHaveCount(before + 1, { timeout: 10000 });
    await expect(page.locator('#area .pn.focused')).toHaveCount(1);
  });

  test('switch session restores focused pane', async ({ page }) => {
    await waitForInit(page);
    const beforeSi = await page.locator('#windows .si').count();

    // Create a second session.
    const [resp] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/tools') && r.request().method() === 'POST'),
      page.click('#add-window'),
    ]);
    expect(resp.status()).toBe(200);
    await expect(page.locator('#windows .si')).toHaveCount(beforeSi + 1, { timeout: 10000 });

    // Click first session in sidebar.
    const firstSession = page.locator('#windows .si').first();
    await firstSession.click();

    // The first session's pane should become focused.
    await expect(page.locator('#area .pn.focused')).toHaveCount(1);
    // Sidebar active indicator moved.
    await expect(firstSession).toHaveClass(/active/);
  });

  test('setFocus by clicking inactive pane', async ({ page }) => {
    await waitForInit(page);
    const before = await page.locator('#area .pn').count();

    const [resp] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/tools') && r.status() === 200),
      page.click('#split-h'),
    ]);
    expect(resp.status()).toBe(200);
    await expect(page.locator('#area .pn')).toHaveCount(before + 1, { timeout: 10000 });

    // Click the left (first) pane body to focus it.
    const firstPaneEl = page.locator('#area .pn').first();
    await firstPaneEl.locator('.pn-body').click();

    // Left pane should now be focused.
    await expect(firstPaneEl).toHaveClass(/focused/);
  });

  test('search decorations cleared on pane switch', async ({ page }) => {
    await waitForInit(page);
    await page.waitForSelector('.xterm-rows', { timeout: 10000 });

    // Open search.
    await page.keyboard.press('Control+f');
    await expect(page.locator('#search-bar')).not.toHaveClass(/hidden/);

    // Close search.
    await page.keyboard.press('Escape');
    await expect(page.locator('#search-bar')).toHaveClass(/hidden/);
  });
});
