import { test, expect } from './fixtures';

async function waitForInit(page) {
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
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

    const beforeA = await pageA.locator('#windows .si').count();
    const beforeB = await pageB.locator('#windows .si').count();

    // Client A creates a new session.
    const [resp] = await Promise.all([
      pageA.waitForResponse((r) => r.url().includes('/api/tools') && r.request().method() === 'POST'),
      pageA.click('#add-window'),
    ]);
    expect(resp.status()).toBe(200);

    // Both clients should see the new session.
    await expect(pageA.locator('#windows .si')).toHaveCount(beforeA + 1, { timeout: 15000 });
    await expect(pageB.locator('#windows .si')).toHaveCount(beforeB + 1, { timeout: 15000 });

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

    const beforeA = await pageA.locator('#area .pn.focused .pn-tab').count();
    const beforeB = await pageB.locator('#area .pn.focused .pn-tab').count();

    // Client A adds a tab.
    const [resp] = await Promise.all([
      pageA.waitForResponse((r) => r.url().includes('/api/tools') && r.status() === 200),
      pageA.locator('#area .pn.focused .pn-tab-add').click(),
    ]);
    expect(resp.status()).toBe(200);

    // Both clients should see the new tab.
    await expect(pageA.locator('#area .pn.focused .pn-tab')).toHaveCount(beforeA + 1, { timeout: 15000 });
    await expect(pageB.locator('#area .pn.focused .pn-tab')).toHaveCount(beforeB + 1, { timeout: 15000 });

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

    const beforeA = await pageA.locator('#area .pn').count();
    const beforeB = await pageB.locator('#area .pn').count();

    // Client A splits horizontally.
    const [resp] = await Promise.all([
      pageA.waitForResponse((r) => r.url().includes('/api/tools') && r.status() === 200),
      pageA.click('#split-h'),
    ]);
    expect(resp.status()).toBe(200);

    // Both clients should see the new pane.
    await expect(pageA.locator('#area .pn')).toHaveCount(beforeA + 1, { timeout: 15000 });
    await expect(pageB.locator('#area .pn')).toHaveCount(beforeB + 1, { timeout: 15000 });

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
    let countA = await pageA.locator('#windows .si').count();
    if (countA < 2) {
      const [resp] = await Promise.all([
        pageA.waitForResponse((r) => r.url().includes('/api/tools') && r.request().method() === 'POST'),
        pageA.click('#add-window'),
      ]);
      expect(resp.status()).toBe(200);
      await expect(pageA.locator('#windows .si')).toHaveCount(countA + 1, { timeout: 10000 });
      countA = countA + 1;
    }

    // B 가 A 의 추가를 반영하기 전에 개수를 읽으면 아래 산술이 어긋난다.
    // (A 는 2개, B 는 아직 1개 → countBBefore-1 = 0 이 되어 영원히 불일치)
    await expect(pageB.locator('#windows .si')).toHaveCount(countA, { timeout: 15000 });
    const countBBefore = await pageB.locator('#windows .si').count();

    // Client A deletes the first session.
    await pageA.locator('#windows .si').first().locator('.si-x').click();

    // SSE 전파 대기는 아래 두 단정이 겸한다 (넉넉한 timeout).
    // 3abb475 가 waitForTimeout(1000) 을 단정으로 바꿀 때 기대값을 0 으로
    // 잘못 넣어(창 2개 중 1개를 지웠으니 0 이 될 수 없다) 그때부터 실패해 왔다.

    // Both clients should see the decreased count.
    await expect(pageA.locator('#windows .si')).toHaveCount(countA - 1, { timeout: 15000 });
    await expect(pageB.locator('#windows .si')).toHaveCount(countBBefore - 1, { timeout: 15000 });

    await ctxA.close();
    await ctxB.close();
  });
});
