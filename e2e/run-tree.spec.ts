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

/**
 * ISSUE_TREE_OPS_SRS TC-ITC-6 (FR-ITC-11~17): 트리는 Run 화면 50% 높이의 영역 안에서 맞춤으로
 * 시작하고, ⌘/Ctrl+휠로 줌, 끌기로 패닝하며, 미니맵·게이지로 위치와 배율을 바꾼다.
 */
test('TC-ITC-6: 트리 보기 영역의 맞춤·줌·패닝·미니맵·게이지', async ({ page, request }) => {
  await waitForInit(page);
  const ref = `e2e/cam#${Date.now() % 100000}`;
  const tabs = [await newTab(request), await newTab(request), await newTab(request)];
  for (const t of tabs) await serverKnowsTab(request, t.uuid);
  const run = await (await request.post('/api/runs', { headers: JSON_HDR,
    data: { objective: 'cam', projection: 'dedicated-window', tree: ref } })).json();
  const add = async (role: string, id: string, assign: Record<string, unknown>) => {
    const r = await request.post('/api/runs/members', { headers: JSON_HDR, data: { runId: run.id, role, agent: 'claude', id, assign } });
    expect(r.ok(), await r.text()).toBeTruthy();
    return r.json();
  };
  const root = await add('cm#1', tabs[0].uuid, { issue: 'o/r#1', title: '루트' });
  await add('cm#1›2', tabs[1].uuid, { issue: 'o/r#2', title: '하위 둘', parent: root.id });
  const third = await add('cm#1›3', tabs[2].uuid, { issue: 'o/r#3', title: '하위 셋', parent: root.id });

  if (!(await page.locator('#agents-panel.open').count())) await page.keyboard.press('Control+Shift+KeyO');
  const row = page.locator(`#agents-panel .runs-row[data-runid="${run.id}"]`);
  await expect(row).toBeVisible({ timeout: 10000 });
  await row.click();
  const view = page.locator('#area .run-view.vis');
  const wrap = view.locator('.run-tree-wrap');
  const svg = wrap.locator('.run-tree-svg');
  const pct = wrap.locator('.run-tree-pct');
  const zoom = wrap.locator('.run-tree-zoom');
  const nodes = svg.locator('.run-tree-node');
  await expect(nodes).toHaveCount(3);

  // FR-ITC-11: 영역 높이는 Run 화면 높이의 50% 다.
  const vb = (await view.boundingBox())!;
  const wb = (await wrap.boundingBox())!;
  expect(Math.abs(wb.height - vb.height * 0.5), `영역 ${wb.height} / 화면 ${vb.height}`).toBeLessThanOrEqual(2);

  // FR-ITC-12: 처음에는 노드 전부가 영역 안에 보인다.
  for (let i = 0; i < 3; i++) {
    const nb = (await nodes.nth(i).boundingBox())!;
    expect(nb.x >= wb.x - 1 && nb.x + nb.width <= wb.x + wb.width + 1, `노드 ${i} 가로`).toBe(true);
    expect(nb.y >= wb.y - 1 && nb.y + nb.height <= wb.y + wb.height + 1, `노드 ${i} 세로`).toBe(true);
  }
  await expect(wrap.locator('.run-tree-mini')).toBeVisible();
  await expect(wrap.locator('.run-tree-mini-view')).toHaveCount(1);
  const fitPct = await pct.textContent();
  expect(fitPct).toMatch(/^\d+%$/);
  const viewBox = () => svg.getAttribute('viewBox');

  // FR-ITC-13: 수식키 없는 휠은 줌하지 않는다. Ctrl+휠은 줌한다.
  await page.mouse.move(wb.x + wb.width / 2, wb.y + wb.height / 2);
  await page.mouse.wheel(0, -200);
  await expect(pct).toHaveText(fitPct!);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -200);
  await page.keyboard.up('Control');
  await expect.poll(async () => parseInt((await pct.textContent()) || '0', 10)).toBeGreaterThan(parseInt(fitPct!, 10));

  // FR-ITC-14: 노드 위에서 시작해 끌면 패닝이고, 탭으로 가지 않는다.
  const activeBefore = await page.evaluate(() => (window as any).app.ws.activeWindow);
  const before = await viewBox();
  const nb = (await nodes.nth(0).boundingBox())!;
  await page.mouse.move(nb.x + nb.width / 2, nb.y + nb.height / 2);
  await page.mouse.down();
  await page.mouse.move(nb.x + nb.width / 2 + 60, nb.y + nb.height / 2 + 20, { steps: 6 });
  await page.mouse.up();
  await expect.poll(viewBox).not.toBe(before);
  expect(await page.evaluate(() => (window as any).app.ws.activeWindow), '끌기가 노드 클릭이 됐다').toBe(activeBefore);

  // FR-ITC-17: 데이터 갱신으로 다시 그려도 보는 범위가 남는다.
  const moved = await viewBox();
  // 보고(`/api/runs/report`)는 run_changed 를 내지 않는다 — 배정 변경으로 다시 그리게 한다.
  const asg = await request.post('/api/runs/assign', { headers: JSON_HDR,
    data: { memberId: third.id, title: '바뀐 셋', toolId: tabs[0].toolId } });
  expect(asg.ok(), await asg.text()).toBeTruthy();
  await expect(nodes.nth(2).locator('.run-tree-title')).toHaveText('바뀐 셋', { timeout: 10000 });
  expect(await viewBox()).toBe(moved);

  // FR-ITC-16: 게이지 슬라이더와 맞춤 버튼.
  await zoom.fill('200');
  await expect(pct).toHaveText('200%');
  await wrap.locator('.run-tree-fit').click();
  await expect(pct).toHaveText(fitPct!);

  // FR-ITC-15: 미니맵을 누르면 그 점이 가운데로 온다.
  await zoom.fill('300');
  const atFull = await viewBox();
  const mb = (await wrap.locator('.run-tree-mini').boundingBox())!;
  await page.mouse.click(mb.x + 3, mb.y + 3);
  await expect.poll(viewBox).not.toBe(atFull);

  await request.post('/api/runs/close', { headers: JSON_HDR, data: { runId: run.id, force: true } });
});
