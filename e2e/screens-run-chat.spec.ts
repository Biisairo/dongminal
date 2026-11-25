import { Page } from '@playwright/test';

import { test, expect, waitForInit, stubTopic } from './fixtures';

// PERF 3.4.9 — Run·채팅 화면 묶음 (D-30·D-31, perf/M3_DESIGN.md §3.4).
//
// 부팅은 `b/run.js`·`b/chat.js` 를 싣지 않는다. 그 탭을 처음 그릴 때 렌더러가 자리표시를 두고 묶음을 싣는다.
// 부팅 때 복원된 탭의 묶음은 바로 싣는다(D-31).

const RUN_A = 'aaaaaaaa-3490-4111-8111-111111111111';
const NOW = () => Math.floor(Date.now() / 1000);

/** 페이지가 요청한 `b/<이름>.<확장자>` 를 모은다. 이동 전에 건다. */
function bundleRequests(page: Page) {
  const seen: string[] = [];
  page.on('request', (r) => {
    const m = /\/b\/([\w-]+\.(?:js|css))\?/.exec(r.url());
    if (m) seen.push(m[1]);
  });
  return seen;
}

async function mockRuns(page: Page) {
  const t = NOW();
  await page.route('**/api/runs', (route) => route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ runs: [{ id: RUN_A, short: 'a349', objective: '묶음 확인', state: 'open',
      isolation: 'per-member', createdAt: t - 100, members: [] }] }) }));
  await page.route('**/api/runs/*/graph', (route) => route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ runId: RUN_A, short: 'a349', objective: '묶음 확인', state: 'open', isolation: 'per-member',
      createdAt: t - 100, coordinatorToolId: 'tool-coord',
      members: [{ id: 'm1', role: '작가', agent: 'claude', toolId: 'tool-m1', state: 'working', createdAt: t - 90 }],
      edges: [], messages: [], timeline: [] }) }));
}

const addRunTab = (page: Page) => page.evaluate(async (rid) => {
  const app = (window as any).app;
  const w = app.ws.windows.find((x: any) => x.id === app.ws.activeWindow);
  const first = (n: any): any => !n ? null : n.type === 'pane' ? n : (n.children || []).map(first).find(Boolean);
  await app.layout.tabAdd.addTab(first(w.layout).id, 'run', { runId: rid });
  app.render();
}, RUN_A);

async function mockChat(page: Page) {
  const st = {
    me: { id: 'me', label: 'mac/User' }, helper: false,
    rooms: [{ id: 'r1', kind: 'group', name: 'ops', purpose: '', joined: true, members: 2, people: [] }],
    online: { nodes: [], participants: [] },
  };
  await stubTopic(page, 'chat', () => st);
  await page.route('**/api/chat**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(route.request().method() === 'GET' ? st : {}) }));
}

test('TC-LZ9-1: 부팅은 run·chat 묶음을 싣지 않고, Run 탭을 처음 그릴 때 b/run.js·b/run.css 가 실린다', async ({ page }) => {
  const seen = bundleRequests(page);
  await mockRuns(page);
  await waitForInit(page);
  expect(seen.filter((n) => /^(run|chat)\./.test(n))).toEqual([]);
  expect(await page.evaluate(() => [Screens.ready('run'), Screens.ready('chat')])).toEqual([false, false]);
  await addRunTab(page);
  await expect(page.locator('#area .run-view.vis .run-card').first()).toBeVisible();
  expect(seen.filter((n) => n.startsWith('run.')).sort()).toEqual(['run.css', 'run.js']);
  // 뷰 CSS 가 묶음에서 왔다 — `.run-view` 는 칸을 덮는다.
  expect(await page.locator('#area .run-view.vis').evaluate((e) => getComputedStyle(e).position)).toBe('absolute');
  expect(seen.filter((n) => n.startsWith('chat.'))).toEqual([]);
});

test('TC-LZ9-2: 채팅 방을 처음 열 때 b/chat.js 가 실리고 대화 화면이 그려진다', async ({ page }) => {
  const seen = bundleRequests(page);
  await mockChat(page);
  await waitForInit(page);
  await page.locator('#sb-tabs .sb-tab[data-panel="chat"]').click();
  await expect(page.locator('#sb-panel-chat .chat-room[data-room="r1"]')).toBeVisible();
  expect(seen.filter((n) => n.startsWith('chat.'))).toEqual([]);
  await page.locator('#sb-panel-chat .chat-room[data-room="r1"]').click();
  await expect(page.locator('#area .chat-view .chat-title')).toHaveText('#ops');
  expect(seen.filter((n) => n.startsWith('chat.'))).toEqual(['chat.js']);
});

test('TC-LZ9-3: 부팅 때 복원된 Run 탭은 그 묶음을 바로 싣고 그린다', async ({ page }) => {
  await mockRuns(page);
  await waitForInit(page);
  await addRunTab(page);
  await expect(page.locator('#area .run-view.vis .run-card').first()).toBeVisible();
  await page.evaluate(() => (window as any).app.wsSave.save());
  const seen = bundleRequests(page);
  // 다시 연다. 활성 탭이 Run 이라 터미널이 서지 않는다 — 준비 판정은 Run 뷰다.
  await waitForInit(page, { readyFor: { selector: '#area .run-view.vis .run-card' } });
  expect(seen).toContain('run.js');
});
