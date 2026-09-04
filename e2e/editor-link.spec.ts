import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { Page } from '@playwright/test';

import { test, expect, waitForInit } from './fixtures';

// EDITOR_TAB_SRS §3.4 — git 핀 ↔ Editor 행 연동 (FR-EDT-31~39, V-EDT-17·18·21·26).
//
// **이 파일은 `/api/editors` 를 스텁하지 않는다.** `editor-tab.spec.ts` 는 목록
// 종단을 `page.route` 로 세워 클라이언트 계약만 재는데, 그 때문에 연동의 절반이
// e2e 를 통과한 채로 비어 있었다 — 서버는 두 목록을 함께 바꿔 응답에 실어
// 보내는데 브라우저가 그 절반을 버려도 아무 테스트도 울지 않았다.
//
// 여기서는 실서버·실저장소로 **화면까지** 도달하는지 본다. 새로고침 없이
// 나타나야 한다 (FR-EDT-20·39·43).

function makeRepo(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  execFileSync('git', ['init', '-q', dir]);
  writeFileSync(join(dir, 'a.txt'), 'x');
  return dir;
}

// Editor 창의 루트 목록. 재조정의 결과이므로 화면의 진실이다 (FR-EDT-42).
const edRoots = (page: Page) =>
  page.evaluate(() => (window as any).app.ws.windows
    .filter((w: any) => w.type === 'editor')
    .map((w: any) => w.editor && w.editor.root));

// 사이드바 Editor 탭에 실제로 그려진 행.
const edRows = (page: Page) =>
  page.locator('#repo-entries .sbl-item').evaluateAll(
    (els) => els.map((e) => (e as HTMLElement).dataset.edRoot || ''));

const editorsList = (page: Page) =>
  page.evaluate(() => ((window as any).app._editors || {}).list || []);

test.describe('묶음 L — git 핀 ↔ Editor 행 연동 (실서버)', () => {
  test('L1 (V-EDT-17 / FR-EDT-31·39): 리포를 핀하면 새로고침 없이 Editor 행과 창이 생긴다', async ({ page, request }) => {
    await waitForInit(page);
    const repo = makeRepo('dm-ed-link-');

    const before = await edRoots(page);
    const r = await request.post('/api/git/repos/pin', { data: { path: repo } });
    expect(r.ok(), await r.text()).toBeTruthy();
    const root = (await r.json()).root as string;

    // 브라우저는 SSE `workspace_changed` 로 그 사실을 안다 — 새로고침하지 않는다.
    await expect.poll(() => editorsList(page), { timeout: 10000 }).toContain(root);
    await expect.poll(() => edRoots(page), { timeout: 10000 }).toContain(root);
    await expect.poll(() => edRows(page), { timeout: 10000 }).toContain(root);
    expect(before).not.toContain(root);
  });

  test('L2 (V-EDT-18 / FR-EDT-32): 핀을 지우면 Editor 행과 창이 함께 사라진다', async ({ page, request }) => {
    await waitForInit(page);
    const repo = makeRepo('dm-ed-link2-');
    const root = (await (await request.post('/api/git/repos/pin', { data: { path: repo } })).json()).root as string;
    await expect.poll(() => edRoots(page), { timeout: 10000 }).toContain(root);

    const r = await request.post('/api/git/repos/unpin', { data: { path: root } });
    expect(r.ok(), await r.text()).toBeTruthy();

    await expect.poll(() => editorsList(page), { timeout: 10000 }).not.toContain(root);
    await expect.poll(() => edRoots(page), { timeout: 10000 }).not.toContain(root);
    await expect.poll(() => edRows(page), { timeout: 10000 }).not.toContain(root);
  });

  test('L3 (V-EDT-19·21 / FR-EDT-33·34): Editor 를 더하면 핀이 함께 생기고, 지우면 함께 사라진다', async ({ page, request }) => {
    await waitForInit(page);
    const repo = makeRepo('dm-ed-link3-');

    const add = await request.post('/api/editors/add', { data: { path: repo } });
    expect(add.ok(), await add.text()).toBeTruthy();
    const list = (await add.json()).list as string[];
    const root = list[list.length - 1];

    const pins = await (await request.get('/api/git/repos')).json();
    expect(pins.pinned.map((p: any) => p.path)).toContain(root);
    await expect.poll(() => edRoots(page), { timeout: 10000 }).toContain(root);

    const rm = await request.post('/api/editors/remove', { data: { path: root } });
    expect(rm.ok(), await rm.text()).toBeTruthy();
    expect((await rm.json()).pinned).not.toContain(root);
    await expect.poll(() => edRoots(page), { timeout: 10000 }).not.toContain(root);
  });

  test('L4 (FR-EDT-97): 핀 직후의 Git Open File 이 root 가 아니라 리포의 Editor 로 간다', async ({ page, request }) => {
    await waitForInit(page);
    const repo = makeRepo('dm-ed-link4-');
    const root = (await (await request.post('/api/git/repos/pin', { data: { path: repo } })).json()).root as string;
    await expect.poll(() => edRoots(page), { timeout: 10000 }).toContain(root);

    // Git 창을 그 리포로 연 뒤 Open File 경로를 그대로 탄다.
    await page.evaluate(async (p) => {
      const a = (window as any).app;
      await a.openGitWindow(p);
      await a._gitOpenFile(p + '/a.txt');
    }, root);

    await expect.poll(() => page.evaluate((p) => {
      const a = (window as any).app;
      const f = a._findEditorTab(p + '/a.txt');
      return f ? (f.win.editor && f.win.editor.root) : '';
    }, root), { timeout: 10000 }).toBe(root);
  });

  test('L5 (FR-EDT-20 / FR-GIT-31): 창이 하나도 없는 워크스페이스에 브라우저가 붙어도 핀과 Editor 목록이 지워지지 않는다', async ({ page, request }) => {
    // 창을 비운다 — 새 서버·새 워크스페이스와 같은 상태다.
    const get = await request.get('/api/workspace');
    await request.put('/api/workspace', {
      headers: { 'If-Match': get.headers()['etag'] || '0', 'Content-Type': 'application/json' },
      data: '{"schemaVersion":2,"windows":[]}',
    });

    // 그 상태에서 핀을 건다. 연동으로 Editor 행도 함께 생긴다 (FR-EDT-31).
    const repo = makeRepo('dm-ed-link5-');
    const root = (await (await request.post('/api/git/repos/pin', { data: { path: repo } })).json()).root as string;

    // 이제 브라우저가 처음 붙는다. 창이 없으므로 `_mkWindow()` 와 재조정이
    // `_save()` 를 부른다 — 그 PUT 이 서버 소유 키를 덮어써서는 안 된다.
    await waitForInit(page);
    await expect.poll(() => edRoots(page), { timeout: 10000 }).toContain(root);

    const pins = await (await request.get('/api/git/repos')).json();
    expect(pins.pinned.map((p: any) => p.path)).toContain(root);

    const ws = await (await request.get('/api/workspace')).json();
    expect(ws.git?.pinned, 'git 키가 통째로 사라졌다').toContain(root);
    expect(ws.editors?.list).toContain(root);
  });

  // **떠나는 방식이 바뀌었다** (REPO_TAB_UNIFY_SRS FR-RTU-70).
  //   이전 동작: Git 창 하나가 리포를 갈아타므로, 보던 리포가 사라지면 그 창이
  //             갈 곳을 잃어 `_gitLeaveIfRemoved` 가 일반 창으로 옮겼다
  //   새  동작: 저장소마다 창이므로 **그 창 자체가 재조정으로 사라진다**
  //             (FR-EDT-42) — 활성 창이 유령이 되지 않게 `_edAfterChange` 가
  //             그 자리를 처리한다
  //   이유:     Git 창이 사라졌다. 갈아탈 대상이 없으므로 "떠난다" 는 개념도 없다
  test('L6: 보고 있던 리포의 핀을 지우면 그 창이 사라지고 다른 창으로 간다',
    async ({ page, request }) => {
      await waitForInit(page);
      const repo = makeRepo('dm-ed-link6-');
      const root = (await (await request.post('/api/git/repos/pin', { data: { path: repo } })).json()).root as string;
      await expect.poll(() => edRoots(page), { timeout: 10000 }).toContain(root);

      // 그 저장소의 Repo 창에 앉는다.
      await page.evaluate(async (p) => { await (window as any).app.openGitWindow(p) }, root);
      await expect.poll(() => page.evaluate(() => {
        const a = (window as any).app; const w = a._aw();
        return (w && w.editor && w.editor.root) || '';
      }), { timeout: 10000 }).toBe(root);

      // 핀을 지운다. 연동이 Editor 행도 함께 지우고(FR-EDT-32) 재조정이 창을 뺀다.
      await page.evaluate(async (p) => { await (window as any).app._gitUnpin(p) }, root);

      // 그 루트의 창이 없어졌고, 활성 창은 남아 있는 다른 창이다.
      await expect.poll(() => edRoots(page), { timeout: 10000 }).not.toContain(root);
      await expect.poll(() => page.evaluate(() => {
        const a = (window as any).app; const w = a._aw();
        return (w && w.editor && w.editor.root) || 'other';
      }), { timeout: 10000 }).not.toBe(root);
    });
});
