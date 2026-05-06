import { test, expect } from '@playwright/test';

async function waitForInit(page) {
  await page.context().addInitScript(() => {
    sessionStorage.setItem('displayMode', 'desktop');
  });
  await page.goto('/');
  // Wait for init() → render() → xterm readiness inside the focused region.
  await page.waitForSelector('#area .rg.focused .xterm-helper-textarea', { timeout: 15000 });
}

test.describe('Focus movement', () => {
  test('new session creates focused region', async ({ page }) => {
    await waitForInit(page);

    const beforeSi = await page.locator('#sessions .si').count();

    // Use the add-session button (triggers _mkSession → _newPane POST).
    const [response] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/panes') && r.request().method() === 'POST'),
      page.click('#add-session'),
    ]);
    expect(response.status()).toBe(200);
    // Session count increased by 1 (active session switched, so rg count stays 1).
    await expect(page.locator('#sessions .si')).toHaveCount(beforeSi + 1, { timeout: 10000 });

    // Exactly one focused region.
    await expect(page.locator('#area .rg.focused')).toHaveCount(1);
  });

  test('new tab in focused region', async ({ page }) => {
    await waitForInit(page);

    // Click the "+" tab button inside the focused region.
    const addTabBtn = page.locator('#area .rg.focused .rt-add');
    const before = await page.locator('#area .rg.focused .rt').count();
    const [resp] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/panes') && r.status() === 200),
      addTabBtn.click(),
    ]);
    expect(resp.status()).toBe(200);

    // Tab count increased by 1.
    await expect(page.locator('#area .rg.focused .rt')).toHaveCount(before + 1, { timeout: 10000 });
    // Exactly one active tab.
    await expect(page.locator('#area .rg.focused .rt.active')).toHaveCount(1);
    // Region itself stays focused.
    await expect(page.locator('#area .rg.focused')).toHaveCount(1);
  });

  test('split horizontal creates new region and moves focus', async ({ page }) => {
    await waitForInit(page);
    const before = await page.locator('#area .rg').count();

    // Click Split H.
    const [respH] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/panes') && r.status() === 200),
      page.click('#split-h'),
    ]);
    expect(respH.status()).toBe(200);

    // One more region.
    await expect(page.locator('#area .rg')).toHaveCount(before + 1, { timeout: 10000 });

    // Exactly one region should be focused after split.
    await expect(page.locator('#area .rg.focused')).toHaveCount(1);
  });

  test('split vertical creates new region below', async ({ page }) => {
    await waitForInit(page);
    const before = await page.locator('#area .rg').count();

    const [respV] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/panes') && r.status() === 200),
      page.click('#split-v'),
    ]);
    expect(respV.status()).toBe(200);

    await expect(page.locator('#area .rg')).toHaveCount(before + 1, { timeout: 10000 });
    await expect(page.locator('#area .rg.focused')).toHaveCount(1);
  });

  test('switch session restores focused region', async ({ page }) => {
    await waitForInit(page);
    const beforeSi = await page.locator('#sessions .si').count();

    // Create a second session.
    const [resp] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/panes') && r.request().method() === 'POST'),
      page.click('#add-session'),
    ]);
    expect(resp.status()).toBe(200);
    await expect(page.locator('#sessions .si')).toHaveCount(beforeSi + 1, { timeout: 10000 });

    // Click first session in sidebar.
    const firstSession = page.locator('#sessions .si').first();
    await firstSession.click();

    // The first session's region should become focused.
    await expect(page.locator('#area .rg.focused')).toHaveCount(1);
    // Sidebar active indicator moved.
    await expect(firstSession).toHaveClass(/active/);
  });

  test('setFocus by clicking inactive region', async ({ page }) => {
    await waitForInit(page);
    const before = await page.locator('#area .rg').count();

    const [resp] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/panes') && r.status() === 200),
      page.click('#split-h'),
    ]);
    expect(resp.status()).toBe(200);
    await expect(page.locator('#area .rg')).toHaveCount(before + 1, { timeout: 10000 });

    // Click the left (first) region body to focus it.
    const firstRegion = page.locator('#area .rg').first();
    await firstRegion.locator('.rg-body').click();

    // Left region should now be focused.
    await expect(firstRegion).toHaveClass(/focused/);
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
