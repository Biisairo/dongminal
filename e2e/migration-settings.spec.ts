import { test, expect, waitForInit } from './fixtures';

/**
 * ISSUE_TREE_OPS_SRS 묶음 M — 맥락 기준 migration 설정 넷 (TC-ITM-1 화면 쪽).
 *
 * Settings ▸ Terminal 에 일반 훅과 issue-tree 의 켬·기준이 따로 서고, 저장된 값을 서버가
 * 훅 판정에 쓴다(`GET /api/tools/migration-advice` 의 ctxPct).
 */

const settings = async (request) => (await request.get('/api/settings')).json();

test.afterEach(async ({ request }) => {
  const cur = await settings(request);
  delete cur.migrationHook; delete cur.migrationHookCtxPct; delete cur.issueTreeMigration; delete cur.issueTreeCtxPct;
  await request.put('/api/settings', { data: cur });
});

test('TC-ITM-1: 맥락 migration 설정 넷이 따로 저장되고 서버 판정이 그 값을 쓴다', async ({ page, request }) => {
  await waitForInit(page);
  await page.click('#settings-btn');
  await page.click('.mtab[data-tab="terminal"]');
  const hook = page.locator('#ds-mighook');
  const hookPct = page.locator('#ds-mighookpct');
  const tree = page.locator('#ds-treemig');
  const treePct = page.locator('#ds-treemigpct');
  await expect(hook).not.toBeChecked();
  await expect(tree).toBeChecked();
  await expect(hookPct).toHaveValue('50');
  await expect(treePct).toHaveValue('50');

  await hookPct.fill('65');
  await hookPct.blur();
  await expect.poll(() => settings(request).then((s: any) => s.migrationHookCtxPct), { timeout: 10000 }).toBe(65);
  // 한쪽을 바꿔도 다른 쪽은 그대로다 (FR-ITM-2).
  await expect(treePct).toHaveValue('50');
  const adv = await (await request.get('/api/tools/migration-advice?id=none')).json();
  expect(adv.ctxPct).toBe(65);

  await tree.uncheck();
  await expect.poll(() => settings(request).then((s: any) => s.issueTreeMigration), { timeout: 10000 }).toBe(false);
  await expect(hook).not.toBeChecked();
  await page.click('#modal-close');
});
