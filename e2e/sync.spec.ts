import { test, expect } from '@playwright/test';

async function waitForInit(page) {
  await page.goto('/');
  await page.waitForSelector('#area .rg.focused .xterm-helper-textarea', { timeout: 15000 });
}

test.describe('Multi-client synchronization via SSE', () => {
  test('client A creates session and client B syncs', async ({ browser }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    await ctxA.addInitScript(() => sessionStorage.setItem('displayMode', 'desktop'));
    await ctxB.addInitScript(() => sessionStorage.setItem('displayMode', 'desktop'));
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    await waitForInit(pageA);
    await waitForInit(pageB);

    const beforeA = await pageA.locator('#sessions .si').count();
    const beforeB = await pageB.locator('#sessions .si').count();

    // Client A creates a new session.
    const [resp] = await Promise.all([
      pageA.waitForResponse((r) => r.url().includes('/api/panes') && r.request().method() === 'POST'),
      pageA.click('#add-session'),
    ]);
    expect(resp.status()).toBe(200);

    // Both clients should see the new session.
    await expect(pageA.locator('#sessions .si')).toHaveCount(beforeA + 1, { timeout: 15000 });
    await expect(pageB.locator('#sessions .si')).toHaveCount(beforeB + 1, { timeout: 15000 });

    await ctxA.close();
    await ctxB.close();
  });

  test('client A adds tab and client B syncs', async ({ browser }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    await ctxA.addInitScript(() => sessionStorage.setItem('displayMode', 'desktop'));
    await ctxB.addInitScript(() => sessionStorage.setItem('displayMode', 'desktop'));
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    await waitForInit(pageA);
    await waitForInit(pageB);

    const beforeA = await pageA.locator('#area .rg.focused .rt').count();
    const beforeB = await pageB.locator('#area .rg.focused .rt').count();

    // Client A adds a tab.
    const [resp] = await Promise.all([
      pageA.waitForResponse((r) => r.url().includes('/api/panes') && r.status() === 200),
      pageA.locator('#area .rg.focused .rt-add').click(),
    ]);
    expect(resp.status()).toBe(200);

    // Both clients should see the new tab.
    await expect(pageA.locator('#area .rg.focused .rt')).toHaveCount(beforeA + 1, { timeout: 15000 });
    await expect(pageB.locator('#area .rg.focused .rt')).toHaveCount(beforeB + 1, { timeout: 15000 });

    await ctxA.close();
    await ctxB.close();
  });

  test('client A splits and client B syncs layout', async ({ browser }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    await ctxA.addInitScript(() => sessionStorage.setItem('displayMode', 'desktop'));
    await ctxB.addInitScript(() => sessionStorage.setItem('displayMode', 'desktop'));
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    await waitForInit(pageA);
    await waitForInit(pageB);

    const beforeA = await pageA.locator('#area .rg').count();
    const beforeB = await pageB.locator('#area .rg').count();

    // Client A splits horizontally.
    const [resp] = await Promise.all([
      pageA.waitForResponse((r) => r.url().includes('/api/panes') && r.status() === 200),
      pageA.click('#split-h'),
    ]);
    expect(resp.status()).toBe(200);

    // Both clients should see the new region.
    await expect(pageA.locator('#area .rg')).toHaveCount(beforeA + 1, { timeout: 15000 });
    await expect(pageB.locator('#area .rg')).toHaveCount(beforeB + 1, { timeout: 15000 });

    await ctxA.close();
    await ctxB.close();
  });

  test('client A deletes session and client B syncs', async ({ browser }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    await ctxA.addInitScript(() => sessionStorage.setItem('displayMode', 'desktop'));
    await ctxB.addInitScript(() => sessionStorage.setItem('displayMode', 'desktop'));
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    await waitForInit(pageA);
    await waitForInit(pageB);

    // Ensure at least 2 sessions on A.
    let countA = await pageA.locator('#sessions .si').count();
    if (countA < 2) {
      const [resp] = await Promise.all([
        pageA.waitForResponse((r) => r.url().includes('/api/panes') && r.request().method() === 'POST'),
        pageA.click('#add-session'),
      ]);
      expect(resp.status()).toBe(200);
      await expect(pageA.locator('#sessions .si')).toHaveCount(countA + 1, { timeout: 10000 });
      countA = countA + 1;
    }

    const countBBefore = await pageB.locator('#sessions .si').count();

    // Client A deletes the first session.
    await pageA.locator('#sessions .si').first().locator('.si-x').click();

    // Wait a moment for SSE to propagate.
    await pageB.waitForTimeout(1000);

    // Both clients should see the decreased count.
    await expect(pageA.locator('#sessions .si')).toHaveCount(countA - 1, { timeout: 15000 });
    await expect(pageB.locator('#sessions .si')).toHaveCount(countBBefore - 1, { timeout: 15000 });

    await ctxA.close();
    await ctxB.close();
  });
});
