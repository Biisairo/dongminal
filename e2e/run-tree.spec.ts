import { test, expect, waitForInit, JSON_HDR } from './fixtures';

/**
 * ISSUE_AGENT_TREE_SRS 묶음 D — 트리 대시보드 (TC-ITD-3).
 *
 * 실제 서버에 트리 표지가 있는 Run 둘(루트·가지)을 열고 실제 탭을 멤버로 등록한다.
 * 재는 것은 대시보드가 **다른 Run 의 노드까지** 한 트리로 그리는가, 잎이 구분되는가,
 * 노드를 누르면 그 에이전트의 탭으로 가는가다.
 */

const cmd = (request, action: string, args: Record<string, unknown> = {}) =>
  request.post('/api/commands', { headers: JSON_HDR, data: { action, args } });

async function newTab(request): Promise<{ uuid: string; toolId: string }> {
  const r = await cmd(request, 'newWindow', { keepFocus: true });
  const j = await r.json();
  expect(j.newTabs?.[0], JSON.stringify(j)).toBeTruthy();
  return j.newTabs[0];
}

async function serverKnowsTab(request, uuid: string) {
  await expect.poll(async () => {
    const st = await (await request.get('/api/state')).json();
    const f = (n) => (n?.type === 'pane' ? n.tabs || [] : (n?.children || []).flatMap(f));
    return (st?.workspace?.windows || []).flatMap((w) => f(w.layout)).some((t) => t.id === uuid);
  }, { timeout: 20000 }).toBe(true);
}

test('TC-ITD-3: 트리 Run 대시보드가 가지 Run 의 노드까지 트리로 그리고, 노드를 누르면 그 탭으로 간다', async ({ page, request }) => {
  await waitForInit(page);
  const ref = `e2e/tree#${Date.now() % 100000}`;
  const a = await newTab(request);
  const b = await newTab(request);
  await serverKnowsTab(request, a.uuid);
  await serverKnowsTab(request, b.uuid);

  const root = await (await request.post('/api/runs', { headers: JSON_HDR,
    data: { objective: 'tree', projection: 'dedicated-window', tree: ref } })).json();
  const branch = await (await request.post('/api/runs', { headers: JSON_HDR,
    data: { objective: 'branch', projection: 'dedicated-window', tree: ref, treeBranch: true } })).json();
  expect(root.id && branch.id, JSON.stringify([root, branch])).toBeTruthy();
  const add = (runId: string, role: string, id: string) =>
    request.post('/api/runs/members', { headers: JSON_HDR, data: { runId, role, agent: 'claude', id } });
  expect((await add(root.id, 'tt#1', a.uuid)).ok()).toBeTruthy();
  expect((await add(branch.id, 'tt#1›2›3', b.uuid)).ok()).toBeTruthy();

  // 같은 이슈를 두 번 등록하면 거절된다 (FR-ITU-4 — e2e 로도 한 번 본다).
  const dup = await add(branch.id, 'tt#1', b.uuid);
  expect(dup.status()).toBe(409);

  // 루트 Run 의 대시보드를 연다.
  if (!(await page.locator('#agents-panel.open').count())) await page.keyboard.press('Control+Shift+KeyO');
  const row = page.locator(`#agents-panel .runs-row[data-runid="${root.id}"]`);
  await expect(row).toBeVisible({ timeout: 10000 });
  await row.click();
  const tree = page.locator('#area .run-view.vis .run-tree.vis');
  await expect(tree).toBeVisible();
  await expect(tree.locator('.run-tree-node')).toHaveCount(2);
  const leaf = tree.locator('.run-tree-node.leaf');
  await expect(leaf).toHaveCount(1);
  await expect(leaf.locator('.run-tree-role')).toHaveText('tt#1›2›3');

  await leaf.click();
  await expect.poll(() => page.evaluate((tid) => {
    const app = (window as any).app;
    const loc = app.testing.findToolLocation(tid);
    return !!loc && app.ws.activeWindow === loc.win.id;
  }, b.toolId), { timeout: 10000 }).toBe(true);

  await request.post('/api/runs/close', { headers: JSON_HDR, data: { runId: branch.id, force: true } });
  await request.post('/api/runs/close', { headers: JSON_HDR, data: { runId: root.id, force: true } });
});
