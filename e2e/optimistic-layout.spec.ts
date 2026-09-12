import { join } from 'path';

import { Page } from '@playwright/test';

import { test, expect, waitForInit, GIT_VIEW_TABS, openGit, gitFixture, cleanGitFixture } from './fixtures';
import { tmpPath, realPath } from './osenv';

/**
 * OPTIMISTIC_LAYOUT_SRS §5 — V-OPL-1·2.
 *
 * **아직 저장되지 않은 로컬 레이아웃은 원격 채택에 지지 않는다.**
 *
 * `11-git-polling.md §5` 가 flaky 아홉 중 다섯(H14·D1·BR11·X4·V10-13)을 이
 * 자리로 매핑했다 — `openView` 는 탭을 로컬 배열에만 넣고 `save()` 는 디바운스로
 * 뒤따르므로, 그 사이에 오는 `workspace_changed` 한 번이 탭을 전부 지웠다.
 *
 * **경주를 기다려 재지 않는다.** 저장을 라우트로 막아 "아직 나가지 못한 변경"
 * 상태를 인공으로 세우고, 밖에서 워크스페이스를 바꿔 채택을 부른다. 그러면
 * 결정적이다 — 이 저장소가 `TERMINAL_RESUME_SRS` 에서 배운 것과 같은 방식이다
 * (증상의 확률이 아니라 그 상위 성질을 잰다).
 */

const FIXTURES = tmpPath('dm-git-fx-optlayout-' + process.pid);

test.beforeAll(() => {
  gitFixture(FIXTURES);
});
test.afterAll(() => {
  cleanGitFixture(FIXTURES);
});

const fx = (name: string) => realPath(join(FIXTURES, name));

const viewTabs = (page: Page) => page.locator('#area .pn-tab[data-git-view]');

/** 이 화면의 `PUT /api/workspace` 를 막는다. 로컬 변경이 서버에 닿지 않는다. */
async function blockSave(page: Page) {
  await page.route('**/api/workspace', async (route) => {
    if (route.request().method() === 'PUT') return route.abort();
    return route.fallback();
  });
}

/**
 * 밖에서 워크스페이스를 한 번 바꾼다 — **창은 건드리지 않는다.**
 *
 * 창을 건드리면 무엇이 탭을 지켰는지 갈리지 않는다. 바꾸는 것은 `sidebarWidth`
 * 하나이고, 그래도 서버 rev 가 오르므로 SSE `workspace_changed` 가 방송된다.
 * 그때 오는 원격 스냅샷에는 이 화면이 방금 만든 탭이 **없다** — 그것이 요점이다.
 */
async function bumpWorkspace(request: any, width: number) {
  const got = await request.get('/api/workspace');
  expect(got.ok()).toBeTruthy();
  const etag = got.headers()['etag'];
  const body = await got.json();
  body.sidebarWidth = width;
  const put = await request.put('/api/workspace', {
    headers: { 'If-Match': etag, 'Content-Type': 'application/json' },
    data: body,
  });
  expect(put.ok()).toBeTruthy();
}

/** 이 화면이 그 rev 를 채택할 때까지 기다린다. */
async function waitAdopted(page: Page, width: number) {
  await page.waitForFunction(
    (w: number) => (window as any).app?.ws?.sidebarWidth === w,
    width, { timeout: 20000 });
}

test('V-OPL-1: 저장 전에 채택이 와도 방금 연 git 뷰 탭이 남는다', async ({ page, request }) => {
  await waitForInit(page);
  await blockSave(page);
  await openGit(page, fx('basic'));
  await expect(viewTabs(page)).toHaveCount(GIT_VIEW_TABS);

  await bumpWorkspace(request, 231);
  await waitAdopted(page, 231);

  // 채택이 닿은 **뒤에도** 일곱이다. 이전 동작에서는 여기서 0 이었다.
  await expect(viewTabs(page)).toHaveCount(GIT_VIEW_TABS);
  // 그리고 그 탭들은 화면에 실제로 서 있다 — 배열에만 남은 것이 아니다.
  await expect(page.locator('#area .pn-body .git-view.vis')).toHaveCount(1);
});

test('V-OPL-2: 되얹은 탭은 저장으로 나가 새로고침 뒤에도 있다', async ({ page, request }) => {
  await waitForInit(page);
  await blockSave(page);
  await openGit(page, fx('basic'));
  await expect(viewTabs(page)).toHaveCount(GIT_VIEW_TABS);

  await bumpWorkspace(request, 232);
  await waitAdopted(page, 232);
  await expect(viewTabs(page)).toHaveCount(GIT_VIEW_TABS);

  // 저장 길을 다시 연다. FR-OPL-9 가 병합에 저장을 딸려 보냈으므로, 대기 중인
  // 저장 하나가 나간다.
  await page.unroute('**/api/workspace');
  await expect(async () => {
    await page.evaluate(() => (window as any).app.testing.save());
    const got = await request.get('/api/workspace');
    const body = await got.json();
    const tabs = (body.windows || []).flatMap((w: any) => {
      const panes = (function walk(n: any): any[] {
        if (!n) return [];
        if (n.type === 'pane') return [n];
        return (n.children || []).flatMap(walk);
      })(w.layout);
      return panes.flatMap((p: any) => p.tabs || []);
    });
    expect(tabs.filter((t: any) => t && t.type === 'git').length).toBe(GIT_VIEW_TABS);
  }).toPass({ timeout: 20000 });

  // 새로고침 뒤의 활성 창은 Repo 창이다 — 기본 준비 판정(포커스 칸의 xterm)이
  // 서지 않으므로 자기 기준을 준다.
  await waitForInit(page, { readyFor: { selector: '#area .ed-win .ed-side' } });
  await expect(viewTabs(page)).toHaveCount(GIT_VIEW_TABS);
});

test('V-OPL-3e: 다른 화면이 닫은 탭은 되살아나지 않는다', async ({ page, request }) => {
  await waitForInit(page);
  await openGit(page, fx('basic'));
  await expect(viewTabs(page)).toHaveCount(GIT_VIEW_TABS);

  // 저장이 서버에 닿을 때까지 기다린다 — 여기서부터 그 탭들은 "원격이 아는 것"
  // 이고, 그래야 지움과 미도착이 갈린다 (D-OPL-1).
  await expect(async () => {
    const got = await request.get('/api/workspace');
    const body = await got.json();
    const n = JSON.stringify(body.windows || []).split('"type":"git"').length - 1;
    expect(n).toBe(GIT_VIEW_TABS);
  }).toPass({ timeout: 20000 });

  // 밖에서 그 탭들을 **닫는다**.
  const got = await request.get('/api/workspace');
  const etag = got.headers()['etag'];
  const body = await got.json();
  const strip = (n: any): any => {
    if (!n) return n;
    if (n.type === 'pane') { n.tabs = (n.tabs || []).filter((t: any) => t.type !== 'git'); return n }
    if (n.children) n.children = n.children.map(strip);
    return n;
  };
  for (const w of body.windows || []) w.layout = strip(w.layout);
  body.sidebarWidth = 233;
  const put = await request.put('/api/workspace', {
    headers: { 'If-Match': etag, 'Content-Type': 'application/json' },
    data: body,
  });
  expect(put.ok()).toBeTruthy();
  await waitAdopted(page, 233);

  // 되살아나지 않는다. 합집합이었다면 여기서 일곱이다.
  await expect(viewTabs(page)).toHaveCount(0);
});
