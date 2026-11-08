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
    request.post('/api/runs/members', { headers: JSON_HDR, data: { runId, role, agent: 'claude', id, assign: { issue: 'o/r#' + role.split('›').pop()!.replace(/^.*#/, '') } } });
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
  await expect(tree.locator('.run-tree-svg')).toBeVisible();
  await expect(tree.locator('.run-tree-node')).toHaveCount(2);
  // 가지 Run 의 노드도 루트 아래에 선으로 이어진다 (FR-ITC-10).
  await expect(tree.locator('.run-tree-edge')).toHaveCount(1);
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

/**
 * ISSUE_TREE_OPS_SRS 묶음 C — 트리 Run 은 대시보드의 중심이 이슈 트리다 (TC-ITC-3).
 * 부모는 배정에서 오고, 끝난 노드는 흐린 흔적으로 남고, 카드는 트리 순서다.
 */
test('TC-ITC-3: 트리 Run 대시보드의 중심에 배정 트리를 그리고 끝난 노드를 남긴다', async ({ page, request }) => {
  await waitForInit(page);
  const ref = `e2e/ops#${Date.now() % 100000}`;
  const a = await newTab(request);
  const b = await newTab(request);
  const c = await newTab(request);
  for (const t of [a, b, c]) await serverKnowsTab(request, t.uuid);
  const run = await (await request.post('/api/runs', { headers: JSON_HDR,
    data: { objective: 'ops', projection: 'dedicated-window', tree: ref } })).json();
  const add = async (role: string, id: string, assign: Record<string, unknown>) => {
    const r = await request.post('/api/runs/members', { headers: JSON_HDR, data: { runId: run.id, role, agent: 'claude', id, assign } });
    expect(r.ok(), await r.text()).toBeTruthy();
    return r.json();
  };
  const root = await add('op#1', a.uuid, { issue: 'o/r#1', title: '루트 이슈' });
  const ended = await add('op#1›2', b.uuid, { issue: 'o/r#2', title: '끝난 하위', parent: root.id });
  await add('op#1›3', c.uuid, { issue: 'o/r#3', title: '지금 하위', parent: root.id });
  const rep = await request.post('/api/runs/report', { headers: JSON_HDR,
    data: { runId: run.id, memberId: ended.id, toolId: b.toolId, outcome: 'succeeded', summary: 'a. b. c.' } });
  expect(rep.ok(), await rep.text()).toBeTruthy();

  if (!(await page.locator('#agents-panel.open').count())) await page.keyboard.press('Control+Shift+KeyO');
  const row = page.locator(`#agents-panel .runs-row[data-runid="${run.id}"]`);
  await expect(row).toBeVisible({ timeout: 10000 });
  await row.click();
  const view = page.locator('#area .run-view.vis');
  await expect(view).toHaveClass(/tree-run/);
  await expect(view.locator('.run-graph-wrap')).toBeHidden();
  const nodes = view.locator('.run-tree.vis .run-tree-node');
  await expect(nodes).toHaveCount(3);
  await expect(nodes.nth(0).locator('.run-tree-issue')).toHaveText('#1');
  await expect(nodes.nth(0).locator('.run-tree-title')).toHaveText('루트 이슈');
  const done = nodes.nth(1);
  await expect(done).toHaveClass(/ended/);
  await expect(done.locator('.run-tree-title')).toHaveText('끝난 하위');
  await expect(nodes.nth(2)).toHaveClass(/leaf/);
  await expect(nodes.nth(0)).toHaveAttribute('data-depth', '0');
  await expect(nodes.nth(2)).toHaveAttribute('data-depth', '1');
  // 루트에서 자식 둘로 선이 내려간다 (FR-ITC-10).
  await expect(view.locator('.run-tree-edge')).toHaveCount(2);
  // 카드도 트리 순서다 (FR-ITC-8).
  await expect(view.locator('.run-card').first()).toContainText('op#1');

  await request.post('/api/runs/close', { headers: JSON_HDR, data: { runId: run.id, force: true } });
});
