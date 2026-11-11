import { test, expect, waitForInit } from './fixtures';

/**
 * UX_BATCH12_SRS TC-AFC-2 (FR-AFC-1·2) — 다른 탭에 있다가 탭 바에서 알람 탭을 고르면 알람이 꺼진다.
 * 이미 포커스된 탭에 선 알람은 포커스만으로는 꺼지지 않는다.
 */
const JSON_HDR = { 'Content-Type': 'application/json' };
const has = (page, id: string) => page.evaluate((x) => (window as any).app.testing.attn.has(x), id);

test('TC-AFC-2: 탭 바에서 알람 탭을 고르면 꺼지고, 포커스 탭에 선 알람은 남는다', async ({ page, request }) => {
  await waitForInit(page);
  const tabs = page.locator('#area .pn.focused .pn-tab');
  const before = await tabs.count();
  await page.locator('#area .pn.focused .pn-tab-add').click();
  await expect(tabs).toHaveCount(before + 1, { timeout: 10000 });
  const second = (await page.locator('#area .pn.focused .pn-tab.active').getAttribute('data-toolid'))!;
  const first = (await tabs.first().getAttribute('data-toolid'))!;
  expect(first).not.toBe(second);

  // 포커스 탭(second)에 선 알람은 남는다 (FR-AFC-2).
  expect((await request.post('/api/tools/attention/set', { headers: JSON_HDR, data: { toolId: second, reason: 'signaled' } })).ok()).toBeTruthy();
  await expect.poll(() => has(page, second)).toBe(true);
  await page.evaluate(() => (window as any).app.render());
  expect(await has(page, second)).toBe(true);
  await request.post('/api/tools/attention/clear-all', { headers: JSON_HDR });
  await expect.poll(() => has(page, second)).toBe(false);

  // 다른 탭(first)의 알람은 탭 바에서 그 탭을 고르면 꺼진다 (FR-AFC-1).
  expect((await request.post('/api/tools/attention/set', { headers: JSON_HDR, data: { toolId: first, reason: 'signaled' } })).ok()).toBeTruthy();
  await expect.poll(() => has(page, first)).toBe(true);
  await page.locator(`#area .pn.focused .pn-tab[data-toolid="${first}"] .pn-tab-label`).click();
  await expect.poll(() => has(page, first)).toBe(false);

  await request.post('/api/tools/attention/clear-all', { headers: JSON_HDR });
});
