import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { Page } from '@playwright/test';

import { test, expect } from './fixtures';

// EDITOR_TAB_SRS §4 — M2(탭·창 골격)의 검증 V-EDT-*.
//
// **서버 표면(M1)은 이 스펙의 대상이 아니다.** `/api/editors` 는 M1 이 소유하고
// 여기서는 그 계약을 `page.route` 로 세워 **클라이언트가 계약대로 움직이는지**만
// 잰다 — 목업 서버를 띄우지 않는다. 서버가 실제로 뜨면 라우트만 걷히고 같은
// 코드가 그대로 돈다 (FR-EDT-120 이 그 사이를 메운다).

const FIXTURES = '/tmp/dm-git-fx-edt-' + process.pid;
let HOME_DIR = '';
let PROJ_DIR = '';
let PROJ2_DIR = '';
let SOME_FILE = '';

test.beforeAll(() => {
  execFileSync('bash', ['e2e/git_fixture.sh', FIXTURES], { stdio: 'ignore' });
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-edt-'));
  HOME_DIR = fs.realpathSync(base);
  PROJ_DIR = path.join(HOME_DIR, 'proj');
  PROJ2_DIR = path.join(HOME_DIR, 'proj2');
  fs.mkdirSync(PROJ_DIR);
  fs.mkdirSync(PROJ2_DIR);
  SOME_FILE = path.join(PROJ_DIR, 'a.txt');
  fs.writeFileSync(SOME_FILE, 'hello\n');
});
test.afterAll(() => {
  execFileSync('bash', ['e2e/git_fixture.sh', '--clean', FIXTURES], { stdio: 'ignore' });
  if (HOME_DIR) fs.rmSync(HOME_DIR, { recursive: true, force: true });
});

const fx = (name: string) => fs.realpathSync(path.join(FIXTURES, name));

type EdState = { home: string; list: string[] };

/**
 * FR-EDT-110 의 네 종단을 클라이언트 계약대로 세운다.
 *
 * 목록의 권위는 서버다 (FR-EDT-20) — 그래서 add/remove/reorder 는 **새 목록을
 * 돌려주고** 클라이언트는 그것만 반영한다. 여기 규칙 셋이 그 계약이다:
 * 멱등(FR-EDT-25) · 문자열 일치 제거(FR-EDT-26) · 홈은 목록에 넣지 않음(FR-EDT-16).
 */
async function stubEditors(page: Page, st: EdState) {
  await page.route('**/api/editors', async (route) => {
    await route.fulfill({ json: { home: st.home, list: st.list.slice() } });
  });
  await page.route('**/api/editors/add', async (route) => {
    const b = route.request().postDataJSON() || {};
    const p = String(b.path || '');
    if (p && p !== st.home && !st.list.includes(p)) st.list.push(p);
    await route.fulfill({ json: { list: st.list.slice(), pinned: [] } });
  });
  await page.route('**/api/editors/remove', async (route) => {
    const b = route.request().postDataJSON() || {};
    st.list = st.list.filter((x) => x !== String(b.path || ''));
    await route.fulfill({ json: { list: st.list.slice(), pinned: [] } });
  });
  await page.route('**/api/editors/reorder', async (route) => {
    const b = route.request().postDataJSON() || {};
    const si = st.list.indexOf(String(b.src || ''));
    const ti = st.list.indexOf(String(b.target || ''));
    if (si >= 0 && ti >= 0) {
      const [m] = st.list.splice(si, 1);
      let at = st.list.indexOf(String(b.target || ''));
      if (at < 0) st.list.push(m);
      else st.list.splice(b.before ? at : at + 1, 0, m);
    }
    await route.fulfill({ json: { list: st.list.slice() } });
  });
}

async function initScripts(page: Page) {
  await page.context().addInitScript(() => {
    sessionStorage.setItem('displayMode', 'desktop');
    if (!sessionStorage.getItem('edTabCleared')) {
      try { localStorage.removeItem('sidebarTab') } catch {}
      sessionStorage.setItem('edTabCleared', '1');
    }
  });
}

async function waitReady(page: Page) {
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
}

// 워크스페이스 PUT 을 흘려보낸다. `_save()` 는 진행 중인 체인을 돌려주므로
// 이것을 await 하면 새로고침이 저장을 앞지르지 않는다.
async function flushSave(page: Page) {
  await page.evaluate(() => (window as any).app._save());
}

// 새로고침 뒤의 대기. 활성 창이 Editor 창이면 터미널 pane 이 화면에 없으므로
// `waitReady` 의 조건이 서지 않는다. `_editors` 는 init 의 **맨 앞**에서 채워지므로
// (FR-EDT-120 이 워크스페이스 처리보다 먼저 서야 한다) 그것만으로는 이르다 —
// 재조정이 끝난 근거인 Editor 창의 존재를 기다린다.
async function waitLoaded(page: Page) {
  await page.waitForFunction(
    () => !!(window as any).app?._editors && (window as any).app._edWindows().length > 0,
    undefined, { timeout: 15000 });
}

async function goto(page: Page, st?: EdState): Promise<EdState> {
  const state: EdState = st || { home: HOME_DIR, list: [PROJ_DIR] };
  await stubEditors(page, state);
  await initScripts(page);
  await page.goto('/');
  await waitReady(page);
  await waitLoaded(page);
  return state;
}

const tab = (page: Page, id: string) => page.locator(`.sb-tab[data-panel="${id}"]`);
// FR-EDT-14: root 행은 **패널 최하단의 별도 컨테이너**에 산다 — 목록의 끝이
// 아니다. 화면에 보이는 순서는 `#editor-entries` 다음 `#editor-root` 이므로
// 둘을 이어서 본다.
const rows = (page: Page) => page.locator('#editor-entries .sbl-item, #editor-root .sbl-item');
const rootRow = (page: Page) => page.locator('#editor-root .sbl-item');

async function openEditorTab(page: Page) {
  await tab(page, 'editor').click();
  await page.waitForFunction(
    () => !document.getElementById('sb-panel-editor')?.hasAttribute('hidden'),
    undefined, { timeout: 10000 });
}

const edWins = (page: Page) =>
  page.evaluate(() => (window as any).app.ws.windows
    .filter((w: any) => w.type === 'editor')
    .map((w: any) => ({ id: w.id, root: w.editor && w.editor.root, name: w.name, hasLayout: !!w.layout })));

// 활성 Editor 창의 pane 하나를 확보하고 그 안에 편집기 탭을 하나 만든다.
// FR-EDT-100 의 경로를 그대로 지난다 — 테스트가 자기 손으로 layout 을 짓지 않는다.
async function openFileInRoot(page: Page, filePath: string) {
  return page.evaluate((fp) => (window as any).app._edOpenFile(fp), filePath);
}

test.describe('묶음 T — 사이드바 Editor 탭 (FR-EDT-1~12)', () => {
  test('E1 (V-EDT-1): 탭이 Windows·Git·Editor 순으로 보인다', async ({ page }) => {
    await goto(page);
    const labels = await page.locator('#sb-tabs .sb-tab:not([hidden]) .sb-tab-label').allTextContents();
    expect(labels).toEqual(['Windows', 'Git', 'Editor']);
  });

  test('E2 (V-EDT-2): Ctrl+Shift+Digit3 이 Editor 탭으로 간다', async ({ page }) => {
    await goto(page);
    await page.keyboard.press('Control+Shift+Digit3');
    await expect.poll(() => page.evaluate(() => (window as any).app._sbTab)).toBe('editor');
    await expect(page.locator('#sb-panel-editor')).toBeVisible();
  });

  test('E3 (V-EDT-3): 직행 키가 배열에서 파생된다 — 손으로 넣은 sidebarTab3 이 없다', async ({ page }) => {
    await goto(page);
    const got = await page.evaluate(() => ({
      binding: (window as any).shortcuts.sidebarTab3,
      def: SHORTCUT_DEFAULTS.sidebarTab3,
      label: SHORTCUT_LABELS.sidebarTab3,
      derived: '사이드바 탭: ' + (SB_TAB_DEFS[2] as any).label,
      // executeAction 의 맵도 배열에서 나온다 — 세 번째 이름이 있어야 한다.
      action: typeof (window as any).app.executeAction === 'function',
    }));
    expect(got.binding).toBe('Ctrl+Shift+Digit3');
    expect(got.def).toBe('Ctrl+Shift+Digit3');
    expect(got.label).toBe(got.derived);
    expect(got.action).toBe(true);
  });

  test('E4 (V-EDT-4): 목록 렌더가 배열 순회다 — list 를 가진 넷째 서술자가 그려진다', async ({ page }) => {
    await goto(page);
    await page.evaluate(() => {
      const p = document.createElement('div');
      p.className = 'sb-panel'; p.id = 'sb-panel-demo2'; p.hidden = true;
      document.getElementById('sidebar')!.appendChild(p);
      const c = document.createElement('div'); c.id = 'demo2-list';
      p.appendChild(c);
      (SB_TAB_DEFS as any[]).push({
        id: 'demo2', label: 'Demo2', panelId: 'sb-panel-demo2',
        list: {
          containerId: 'demo2-list', itemClass: 'demo2-item',
          items: () => [{ k: 'a' }, { k: 'b' }],
          key: (e: any) => e.k,
          row: () => ({ name: 'x' }),
        },
      });
      (window as any).app.render();
    });
    await expect(page.locator('#demo2-list .sbl-item')).toHaveCount(2);
    // 남기면 뒤따르는 테스트의 탭 개수가 오염된다 — 같은 페이지 안에서만 산다.
    await page.evaluate(() => { (SB_TAB_DEFS as any[]).pop() });
  });

  test('E5 (V-EDT-5): 순회 키가 Editor 행을 돌고 root 행이 마지막에 포함된다', async ({ page }) => {
    const st = await goto(page, { home: HOME_DIR, list: [PROJ_DIR, PROJ2_DIR] });
    await openEditorTab(page);
    // 행은 일반 둘 + root 하나 = 셋이며 root 가 마지막이다 (FR-EDT-14).
    await expect(rows(page)).toHaveCount(3);
    const order = await page.evaluate(() =>
      [...document.querySelectorAll('#editor-entries .sbl-item, #editor-root .sbl-item')]
        .map((e) => (e as HTMLElement).dataset.edRoot));
    expect(order).toEqual([PROJ_DIR, PROJ2_DIR, HOME_DIR].map(String));
    expect(st.list).toEqual([PROJ_DIR, PROJ2_DIR]);

    // 목록 밖에서 순회를 시작하면 첫 항목으로 들어간다 (FR-BLP-15 ②).
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => (window as any).app.executeAction('windowNext'));
      seen.push(await page.evaluate(() => {
        const a = (window as any).app;
        const w = a._aw();
        return (w && w.editor && w.editor.root) || '';
      }));
    }
    expect(seen).toEqual([PROJ_DIR, PROJ2_DIR, HOME_DIR]);
  });

  test('E6 (V-EDT-6): 탭 선택 → Editor 창 전환, Editor 창 활성 → 탭이 따라온다', async ({ page }) => {
    await goto(page);
    await openEditorTab(page);
    // FR-EDT-7: 마지막으로 활성이었던 Editor 창이 없으면 root 에디터 창이다.
    await expect.poll(() => page.evaluate(() => {
      const w = (window as any).app._aw();
      return (w && w.editor && w.editor.root) || '';
    })).toBe(HOME_DIR);

    // FR-EDT-8: 역방향. 일반 창으로 나갔다가 Editor 창으로 돌아오면 탭이 따라온다.
    await page.evaluate(() => {
      const a = (window as any).app;
      a.switchWindow(a._plainWindows()[0].id);
    });
    await expect.poll(() => page.evaluate(() => (window as any).app._sbTab)).toBe('windows');
    await page.evaluate(() => {
      const a = (window as any).app;
      a.switchWindow(a._edWindows()[0].id);
    });
    await expect.poll(() => page.evaluate(() => (window as any).app._sbTab)).toBe('editor');
  });

  test('E7 (V-EDT-7): root 행은 최하단이고 × 가 없으며 드래그 출발·도착 모두 불가', async ({ page }) => {
    await goto(page, { home: HOME_DIR, list: [PROJ_DIR, PROJ2_DIR] });
    await openEditorTab(page);
    // 목록에는 일반 둘만, 고정 컨테이너에는 root 하나만 있다.
    await expect(page.locator('#editor-entries .sbl-item')).toHaveCount(2);
    const last = rootRow(page);
    await expect(last).toHaveCount(1);
    await expect(last).toHaveClass(/ed-root/);
    await expect(last).toHaveAttribute('data-ed-root', HOME_DIR);
    // FR-EDT-15: × 도, draggable 도 없다.
    await expect(last.locator('.sbl-x')).toHaveCount(0);
    expect(await last.evaluate((e: HTMLElement) => e.draggable)).toBe(false);
    // 도착지도 아니다 — dragover 로 대상이 잡히지 않으므로 순서가 그대로다.
    const before = await page.evaluate(() => (window as any).app._editors.list.slice());
    await page.evaluate((home) => {
      const a = (window as any).app;
      const list = document.getElementById('editor-entries')!;
      const src = list.querySelector('.sbl-item') as HTMLElement;
      const dst = document.querySelector(
        `#editor-root .sbl-item[data-ed-root="${CSS.escape(home)}"]`) as HTMLElement;
      const dt = new DataTransfer();
      src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt, clientY: 5 }));
      dst.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt, clientY: 5 }));
      src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    }, HOME_DIR);
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => (window as any).app._editors.list.slice())).toEqual(before);
  });

  test('E8 (V-EDT-8): 홈 경로를 일반 행으로 추가하면 목록이 변하지 않고 오류도 아니다', async ({ page }) => {
    await goto(page);
    await openEditorTab(page);
    const n0 = await rows(page).count();
    // FR-EDT-16: 성공으로 처리하되 목록이 바뀌지 않는다. 클라이언트는 응답만
    // 반영하므로 낙관적으로 행을 더해서도 안 된다.
    const ok = await page.evaluate((home) =>
      (window as any).app._edMutate('/add', { path: home }), HOME_DIR);
    expect(ok).toBe(true);
    await expect(rows(page)).toHaveCount(n0);
    expect(await page.evaluate(() => (window as any).app._editors.list.slice())).toEqual([PROJ_DIR]);
  });

  test('E9 (V-EDT-9): 워크스페이스를 비워도 root 행과 root 창이 있다', async ({ page }) => {
    // fixtures 가 매 테스트 전에 워크스페이스를 비운다 — 그 상태가 곧 전제다.
    await goto(page, { home: HOME_DIR, list: [] });
    await openEditorTab(page);
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toHaveClass(/ed-root/);
    const wins = await edWins(page);
    expect(wins).toHaveLength(1);
    expect(wins[0].root).toBe(HOME_DIR);
    // FR-EDT-44: root 에디터 창의 이름은 `~` 다.
    expect(wins[0].name).toBe('~');
  });

  test('E10 (V-EDT-89 / FR-EDT-120): /api/editors 가 실패하면 Editor 탭이 숨겨진다', async ({ page }) => {
    await page.route('**/api/editors', (route) => route.fulfill({ status: 404, body: 'nope' }));
    await initScripts(page);
    await page.goto('/');
    await waitReady(page);
    await expect(tab(page, 'editor')).toBeHidden();
    expect(await page.evaluate(() => (window as any).app._edOff)).toBe(true);
    // 표면이 없으면 창도 없다 — 추측한 홈으로 만든 창이 남지 않는다.
    expect(await edWins(page)).toHaveLength(0);
  });
});

test.describe('묶음 E — 목록의 반영 (FR-EDT-19~21)', () => {
  test('E11 (V-EDT-16 / FR-EDT-21): 409 뒤 클라이언트가 서버의 editors 를 채택한다', async ({ page }) => {
    await goto(page);
    // 409 를 한 번 내고, 그때의 GET 이 서버의 `editors` 를 준다. 클라이언트는
    // 하위 키를 소유하지 않으므로 병합 없이 통째로 채택해야 한다.
    await page.route('**/api/workspace', async (route) => {
      const req = route.request();
      if (req.method() === 'PUT') {
        const first = await page.evaluate(() => {
          const w = window as any;
          if (w.__put409) return false;
          w.__put409 = true; return true;
        });
        if (first) return route.fulfill({ status: 409, body: '{}' });
        return route.continue();
      }
      if (req.method() === 'GET') {
        const res = await route.fetch();
        const body = await res.json();
        body.editors = { list: [PROJ2_DIR] };
        return route.fulfill({ response: res, json: body });
      }
      return route.continue();
    });
    await page.evaluate(() => (window as any).app._save());
    await expect.poll(() => page.evaluate(() => (window as any).app._editors.list.slice()),
      { timeout: 10000 }).toEqual([PROJ2_DIR]);
    // 목록이 바뀌었으면 창도 따라온다 (FR-EDT-42).
    await expect.poll(async () => (await edWins(page)).map((w) => w.root).sort())
      .toEqual([HOME_DIR, PROJ2_DIR].sort());
  });
});

test.describe('묶음 W — Editor 창 (FR-EDT-40~56)', () => {
  test('E12 (V-EDT-27): Editor 창이 Windows 목록과 창 순회에 나오지 않는다', async ({ page }) => {
    await goto(page);
    const inList = await page.evaluate(() =>
      [...document.querySelectorAll('#windows .sbl-item')].map((e) => (e as HTMLElement).dataset.windowType));
    expect(inList).not.toContain('editor');
    expect(await page.evaluate(() =>
      (window as any).app._plainWindows().some((w: any) => w.type === 'editor'))).toBe(false);

    // Windows 탭에서의 순회는 일반 창만 돈다.
    await page.evaluate(() => (window as any).app._sbSetTab('windows'));
    const before = await page.evaluate(() => (window as any).app.ws.activeWindow);
    await page.evaluate(() => (window as any).app.executeAction('windowNext'));
    await page.waitForTimeout(200);
    // 일반 창이 하나뿐이면 순회는 아무 일도 하지 않는다 (FR-BLP-15 ③).
    expect(await page.evaluate(() => (window as any).app.ws.activeWindow)).toBe(before);
  });

  test('E13 (V-EDT-28 / FR-EDT-49): layout 이 없는 Editor 창이 로드·SSE 동기화를 넘어 살아남는다', async ({ page }) => {
    await goto(page);
    expect((await edWins(page)).every((w) => !w.hasLayout)).toBe(true);

    // ① SSE 동기화 경로 (`_applyRemoteWorkspace`) — `workspace_changed` 가 도는 자리.
    await page.evaluate(async () => {
      const a = (window as any).app;
      const r = await fetch('/api/state');
      const st = await r.json();
      a._applyRemoteWorkspace(st.workspace, st.tools || []);
    });
    let wins = await edWins(page);
    expect(wins.map((w) => w.root).sort()).toEqual([HOME_DIR, PROJ_DIR].sort());

    // ② 로드 경로.
    await flushSave(page);
    await page.reload();
    await waitReady(page);
    await waitLoaded(page);
    wins = await edWins(page);
    expect(wins.map((w) => w.root).sort()).toEqual([HOME_DIR, PROJ_DIR].sort());
    expect(wins.every((w) => !w.hasLayout)).toBe(true);
  });

  test('E14 (V-EDT-29): git pin 이 부른 workspace_changed 로도 빈 Editor 창이 사라지지 않는다', async ({ page }) => {
    await goto(page);
    const repo = fx('basic');
    const before = (await edWins(page)).map((w) => w.root);
    expect(before.length).toBeGreaterThan(0);
    await page.evaluate(async (p) => { await (window as any).app._gitPin(p) }, repo);
    // 핀 하나가 `workspace_changed` 를 쏘고(§2.4) 그것이 동기화 경로를 돈다.
    await page.waitForTimeout(1200);

    // **개수가 아니라 생존을 잰다.** 핀은 연동으로 같은 경로의 Editor 행을
    // 만들므로(FR-EDT-31) 창이 하나 **느는 것이 옳다** — 이 항목이 재는 것은
    // 그것과 무관하게 **이미 있던 빈 창들이 필터에 지워지지 않는가**다
    // (FR-EDT-49 / D-13). 개수로 재면 연동이 깨진 상태가 통과한다.
    const after = (await edWins(page)).map((w) => w.root);
    for (const root of before) expect(after).toContain(root);

    await page.evaluate(async (p) => { await (window as any).app._gitUnpin(p) }, repo);
  });

  test('E15 (V-EDT-30 / FR-EDT-42(4)): 같은 루트의 창이 둘이면 재조정이 하나로 줄인다 (결정론)', async ({ page }) => {
    await goto(page);
    const kept = await page.evaluate(() => {
      const a = (window as any).app;
      const root = a._edHome();
      const orig = a._edWindowFor(root);
      // 다른 브라우저가 같은 루트의 창을 먼저 쓴 상황을 그대로 만든다.
      const dupA = { id: '0000-aaa', name: '~', type: 'editor', editor: { root }, layout: null };
      const dupB = { id: 'zzzz-zzz', name: '~', type: 'editor', editor: { root }, layout: null };
      a.ws.windows.push(dupB, dupA);
      a._edReconcile();
      const left = a.ws.windows.filter((w: any) => w.type === 'editor' && w.editor.root === root);
      return { n: left.length, id: left[0] && left[0].id, origId: orig.id };
    });
    expect(kept.n).toBe(1);
    // id 사전순으로 앞선 하나만 남는다 — 어느 브라우저가 먼저 쓰든 값이 같다.
    expect(kept.id).toBe('0000-aaa');
  });

  test('E16 (V-EDT-31): 행 제거 → 창 소멸, 행 추가 → 창 생성', async ({ page }) => {
    await goto(page);
    expect((await edWins(page)).map((w) => w.root).sort()).toEqual([HOME_DIR, PROJ_DIR].sort());

    await page.evaluate((p) => (window as any).app._edRemove(p), PROJ_DIR);
    await expect.poll(async () => (await edWins(page)).map((w) => w.root)).toEqual([HOME_DIR]);

    await page.evaluate((p) => (window as any).app._edMutate('/add', { path: p }), PROJ2_DIR);
    await expect.poll(async () => (await edWins(page)).map((w) => w.root).sort())
      .toEqual([HOME_DIR, PROJ2_DIR].sort());
    // FR-EDT-44: 창 이름은 경로의 마지막 조각이다.
    expect((await edWins(page)).find((w) => w.root === PROJ2_DIR)!.name).toBe('proj2');
  });

  test('E17 (V-EDT-32 / FR-EDT-50): Editor 창에서 분할 단축키가 무동작이고 분할 버튼이 감춰진다', async ({ page }) => {
    await goto(page);
    await openFileInRoot(page, SOME_FILE);
    await expect.poll(() => page.evaluate(() => {
      const w = (window as any).app._aw();
      return !!(w && w.type === 'editor' && w.layout);
    })).toBe(true);

    await expect(page.locator('#split-h')).toHaveClass(/git-hidden/);
    await expect(page.locator('#split-v')).toHaveClass(/git-hidden/);

    const paneCount = () => page.evaluate(() => {
      const a = (window as any).app;
      return a._flattenPanes(a._aw().layout).length;
    });
    expect(await paneCount()).toBe(1);
    await page.evaluate(async () => {
      const a = (window as any).app;
      await a.executeAction('splitH');
      await a.executeAction('splitV');
    });
    await page.waitForTimeout(200);
    expect(await paneCount()).toBe(1);
  });

  test('E18 (V-EDT-33·34 / FR-EDT-51·52): 드롭 분할이 되고, 탭이 0이 된 pane 은 사라진다', async ({ page }) => {
    await goto(page);
    await openFileInRoot(page, SOME_FILE);
    const second = path.join(PROJ_DIR, 'b.txt');
    fs.writeFileSync(second, 'b\n');
    await openFileInRoot(page, second);
    await expect.poll(() => page.evaluate(() => {
      const a = (window as any).app;
      return a._flattenPanes(a._aw().layout)[0].tabs.length;
    })).toBe(2);

    // FR-EDT-51: 분할이 생기는 유일한 길이다. 새 pane 은 끌어온 탭을 담은 채로 태어난다.
    const after = await page.evaluate(() => {
      const a = (window as any).app;
      const pane = a._flattenPanes(a._aw().layout)[0];
      const tid = pane.tabs[1].id;
      a._splitPaneWithTab(pane.id, tid, pane.id, 'right');
      const panes = a._flattenPanes(a._aw().layout);
      return { n: panes.length, tabs: panes.map((p: any) => p.tabs.length) };
    });
    expect(after.n).toBe(2);
    expect(after.tabs).toEqual([1, 1]);

    // FR-EDT-52: 탭이 0이 되면 그 pane 은 붕괴한다 — 빈 pane 이 남지 않는다.
    await page.evaluate(async () => {
      const a = (window as any).app;
      const p = a._flattenPanes(a._aw().layout)[1];
      await a.closeTab(p.id, p.tabs[0].id);
    });
    await expect.poll(() => page.evaluate(() => {
      const a = (window as any).app;
      return a._flattenPanes(a._aw().layout).length;
    })).toBe(1);
  });

  test('E19 (V-EDT-35·36 / FR-EDT-53): 탭은 자기 Editor 창 안에서만 움직인다', async ({ page }) => {
    await goto(page);
    await openFileInRoot(page, SOME_FILE);
    const second = path.join(PROJ_DIR, 'c.txt');
    fs.writeFileSync(second, 'c\n');
    await openFileInRoot(page, second);

    // V-EDT-36: 같은 창 안의 pane 간 이동은 **된다** — 게이트가 탭 타입 자리에
    // 들어가지 않았다는 증거다 (§2.2).
    const moved = await page.evaluate(() => {
      const a = (window as any).app;
      let panes = a._flattenPanes(a._aw().layout);
      a._splitPaneWithTab(panes[0].id, panes[0].tabs[1].id, panes[0].id, 'right');
      panes = a._flattenPanes(a._aw().layout);
      const tid = panes[1].tabs[0].id;
      a._moveTabToPane(panes[1].id, tid, panes[0].id, null, false);
      const now = a._flattenPanes(a._aw().layout);
      return { n: now.length, tabs: now[0].tabs.length };
    });
    expect(moved).toEqual({ n: 1, tabs: 2 });

    // V-EDT-35: 다른 Editor 창으로도, 일반 창으로도 나가지 못한다.
    const stayed = await page.evaluate(() => {
      const a = (window as any).app;
      const src = a._aw();
      const pane = a._flattenPanes(src.layout)[0];
      const tid = pane.tabs[0].id;
      const otherEd = a._edWindows().find((w: any) => w.id !== src.id);
      const plain = a._plainWindows()[0];
      a._moveTabToWindow(pane.id, tid, otherEd.id);
      a._moveTabToWindow(pane.id, tid, plain.id);
      return {
        here: a._flattenPanes(a.ws.windows.find((w: any) => w.id === src.id).layout)[0].tabs.length,
        active: a.ws.activeWindow === src.id,
      };
    });
    expect(stayed.here).toBe(2);
    expect(stayed.active).toBe(true);
  });

  test('E20 (V-EDT-37 / FR-EDT-54): Editor 창에 터미널 탭을 만들 수 없다', async ({ page }) => {
    await goto(page);
    await openFileInRoot(page, SOME_FILE);
    const got = await page.evaluate(async () => {
      const a = (window as any).app;
      const w = a._aw();
      const pane = a._flattenPanes(w.layout)[0];
      const before = a.tools.size;
      await a.addTab(pane.id, 'terminal');
      await a.addTab(pane.id, 'run', { runId: 'x' });
      return { tabs: a._flattenPanes(a._aw().layout)[0].tabs.length, tools: a.tools.size - before };
    });
    expect(got.tabs).toBe(1);
    expect(got.tools).toBe(0);
    // FR-EDT-54: `+` 자리도 만들지 않는다 — 눌리지만 아무 일도 하지 않는 버튼은 고장이다.
    await expect(page.locator('#area .pn .pn-tab-add')).toHaveCount(0);
  });

  test('E21 (V-EDT-38 / FR-EDT-55·100): 갓 만든 Editor 창에 pane 이 없고, 파일을 열면 하나 생긴다', async ({ page }) => {
    await goto(page);
    expect((await edWins(page)).every((w) => !w.hasLayout)).toBe(true);
    // 우측은 빈 pane 이 아니라 pane 이 **없는** 것이다 — 안내문이 그 자리에 선다.
    await openEditorTab(page);
    await expect(page.locator('#area .ed-win .ed-area .ed-empty')).toHaveCount(1);
    await expect(page.locator('#area .ed-win .pn')).toHaveCount(0);

    await openFileInRoot(page, SOME_FILE);
    await expect(page.locator('#area .ed-win .ed-area .pn')).toHaveCount(1);
    await expect(page.locator('#area .ed-win .ed-empty')).toHaveCount(0);
    // FR-EDT-95: pane 은 파일을 자기 루트 아래에 포함하는 창 중 **가장 깊은
    // 것**에 생긴다. `SOME_FILE` 은 `PROJ_DIR/a.txt` 이므로 root 에디터가
    // 아니라 `PROJ_DIR` 창이다.
    const w = (await edWins(page)).find((x) => x.root === PROJ_DIR)!;
    expect(w.hasLayout).toBe(true);
    expect((await edWins(page)).find((x) => x.root === HOME_DIR)!.hasLayout).toBe(false);

    // FR-EDT-101: 같은 파일을 다시 열면 중복 탭이 생기지 않는다.
    await openFileInRoot(page, SOME_FILE);
    await expect.poll(() => page.evaluate(() => {
      const a = (window as any).app;
      return a._flattenPanes(a._aw().layout)[0].tabs.length;
    })).toBe(1);
  });

  test('E22 (V-EDT-39 / FR-EDT-47): 탐색기 폭이 window.editor.explorerWidth 로 저장되고 복원된다', async ({ page }) => {
    await goto(page);
    await openEditorTab(page);
    await expect(page.locator('#area .ed-win .ed-explorer')).toHaveCount(1);
    await page.evaluate(() => {
      const a = (window as any).app;
      a._edSetExplorerWidth(a._aw(), 310);
      a.render();
    });
    expect(await page.evaluate(() => {
      const w = (window as any).app._aw();
      return w.editor.explorerWidth;
    })).toBe(310);
    await expect(page.locator('#area .ed-win .ed-explorer')).toHaveCSS('width', '310px');

    await flushSave(page);
    await page.reload();
    await waitLoaded(page);
    expect(await page.evaluate((home) => {
      const w = (window as any).app._edWindowFor(home);
      return w.editor.explorerWidth;
    }, HOME_DIR)).toBe(310);
  });
});

test.describe('묶음 R·M — 일반 창 금지와 마이그레이션 (FR-EDT-94·103~107)', () => {
  test('E23 (V-EDT-72 / FR-EDT-94): 일반 창에서 편집기 탭이 열리지 않는다', async ({ page }) => {
    await goto(page);
    const got = await page.evaluate(async (fp) => {
      const a = (window as any).app;
      const plain = a._plainWindows()[0];
      a.switchWindow(plain.id);
      const pane = a._flattenPanes(plain.layout)[0];
      await a.addTab(pane.id, 'editor', { filePath: fp });
      const has = (n: any): boolean => !n ? false
        : n.type === 'pane' ? (n.tabs || []).some((t: any) => t.type === 'editor')
          : (n.children || []).some(has);
      return {
        plainHas: a._plainWindows().some((w: any) => has(w.layout)),
      };
    }, SOME_FILE);
    expect(got.plainHas).toBe(false);

    // 대신 **연결된** Editor 로 간다 (FR-EDT-95·96). `SOME_FILE` 을 루트 아래에
    // 포함하는 창이 둘(`HOME_DIR`·`PROJ_DIR`)이므로 깊은 쪽이 이긴다. root
    // 에디터는 그런 창이 하나도 없을 때의 폴백이다 — R3 이 그쪽을 잰다.
    await page.evaluate((fp) => (window as any).app._execRemote('openEditorTab', { filePath: fp }), SOME_FILE);
    await expect.poll(() => page.evaluate((fp) => {
      const a = (window as any).app;
      const f = a._findEditorTab(fp);
      return f ? (f.win.type + ':' + (f.win.editor && f.win.editor.root)) : '';
    }, SOME_FILE)).toBe('editor:' + PROJ_DIR);
  });

  test('E24 (V-EDT-80 / FR-EDT-103·105): 구 워크스페이스의 일반 창 편집기 탭이 로드 시 사라지고 pane 이 붕괴한다', async ({ page, request }) => {
    const get = await request.get('/api/workspace');
    const rev = get.headers()['etag'] || '0';
    const legacyWin = 'legacy-win-1';
    await request.put('/api/workspace', {
      headers: { 'If-Match': rev, 'Content-Type': 'application/json' },
      data: JSON.stringify({
        schemaVersion: 2,
        activeWindow: legacyWin,
        windows: [{
          id: legacyWin, name: 'Legacy',
          layout: {
            type: 'pane', id: 'legacy-pane-1', activeTab: 'legacy-tab-1',
            tabs: [{ id: 'legacy-tab-1', type: 'editor', name: 'a.txt', filePath: SOME_FILE }],
          },
        }],
      }),
    });
    await goto(page);
    const got = await page.evaluate((wid) => {
      const a = (window as any).app;
      const has = (n: any): boolean => !n ? false
        : n.type === 'pane' ? (n.tabs || []).some((t: any) => t.type === 'editor')
          : (n.children || []).some(has);
      return {
        legacyGone: !a.ws.windows.some((w: any) => w.id === wid),
        plainHasEditor: a._plainWindows().some((w: any) => has(w.layout)),
        plainCount: a._plainWindows().length,
      };
    }, legacyWin);
    // 탭이 0이 된 pane 이 붕괴하고, layout 이 빈 일반 창은 사라진다.
    expect(got.legacyGone).toBe(true);
    expect(got.plainHasEditor).toBe(false);
    // 일반 창이 하나도 남지 않으면 새로 만든다 — 사용자를 Editor 창에 가두지 않는다.
    expect(got.plainCount).toBeGreaterThan(0);
  });

  test('E25 (V-EDT-81 / FR-EDT-104): clean() 은 여전히 Editor 창의 편집기 탭을 보존한다', async ({ page }) => {
    await goto(page);
    // 순수 함수 계약 — `clean` 은 창 타입을 모르며 편집기 탭을 버리지 않는다 (§2.9).
    expect(await page.evaluate(() => {
      const n = clean({ type: 'pane', id: 'p', activeTab: 't',
        tabs: [{ id: 't', type: 'editor', name: 'a', filePath: '/x' }] }, new Set());
      return n && n.tabs.length;
    })).toBe(1);

    // 그리고 실제로도 살아남는다 — Editor 창의 탭이 로드를 넘는다.
    await openFileInRoot(page, SOME_FILE);
    await expect.poll(() => page.evaluate(() => {
      const a = (window as any).app;
      return !!(a._aw().layout);
    })).toBe(true);
    await flushSave(page);
    await page.reload();
    await waitLoaded(page);
    expect(await page.evaluate((fp) => {
      const a = (window as any).app;
      const f = a._findEditorTab(fp);
      return f ? f.win.type : '';
    }, SOME_FILE)).toBe('editor');
  });
});

// FR-EDT-54 의 두 번째 구멍 — 백그라운드 도구의 복귀.
//
// `_restoreTool` 은 `addTab` 을 거치지 않고 pane 에 터미널 탭을 **직접 넣는다**.
// FR-EDT-54 의 게이트는 `addTab` 안에만 있으므로 복귀 대상 pane 을 고르는 자리에
// 같은 조건이 없으면 Editor 창에 터미널 탭이 생기고, 일반 창만 걷는
// `_migrateEditorTabs` 가 그것을 영원히 지나친다.
test.describe('묶음 W — 백그라운드 복귀 (FR-EDT-54)', () => {
  test('E26 (FR-EDT-54): Editor 창이 활성이어도 복귀는 일반 창으로 간다', async ({ page, request }) => {
    await goto(page);
    // 일반 창의 pane 에 터미널 탭을 하나 더 만든다 — detach 로 탭이 0이 되면
    // 그 창이 사라지고 `_mkWindow` 가 활성 창을 도로 일반 창으로 돌린다.
    const toolId = await page.evaluate(async () => {
      const a = (window as any).app;
      const plain = a._plainWindows()[0];
      a.switchWindow(plain.id);
      const pane = a._flattenPanes(plain.layout)[0];
      await a.addTab(pane.id, 'terminal');
      const p = a._flattenPanes(a._aw().layout).find((x: any) => x.id === pane.id);
      return p.tabs[p.tabs.length - 1].toolId as string;
    });
    expect(toolId).toBeTruthy();

    const d = await request.post('/api/commands', { data: { action: 'detachTab', args: { toolId } } });
    expect(d.status()).toBe(200);
    await expect.poll(async () => {
      const bg = await (await request.get('/api/tools/background')).json();
      return (bg.background || []).some((b: any) => b.toolId === toolId);
    }, { timeout: 10000 }).toBe(true);

    // 재현의 전제 — Editor 창이 활성이고 포커스된 pane 이 그 창의 것이다.
    await openFileInRoot(page, SOME_FILE);
    expect(await page.evaluate(() => {
      const a = (window as any).app;
      const w = a._aw();
      return a._isEditorWin(w) && !!a._flattenPanes(w.layout).some((p: any) => p.id === a.focused);
    })).toBe(true);

    await page.evaluate((tid) => (window as any).app._restoreTool(tid), toolId);
    await expect.poll(async () => {
      const bg = await (await request.get('/api/tools/background')).json();
      return (bg.background || []).some((b: any) => b.toolId === toolId);
    }, { timeout: 10000 }).toBe(false);

    const got = await page.evaluate((tid) => {
      const a = (window as any).app;
      const walk = (n: any, out: any[]) => {
        if (!n) return out;
        for (const t of n.tabs || []) out.push(t);
        for (const c of n.children || []) walk(c, out);
        return out;
      };
      const tabsOf = (w: any) => walk(w.layout, []);
      return {
        edTypes: a._edWindows().flatMap((w: any) => tabsOf(w).map((t: any) => t.type)),
        plainHasTool: a._plainWindows().some((w: any) => tabsOf(w).some((t: any) => t.toolId === tid)),
      };
    }, toolId);
    // Editor 창에는 편집기 탭만 있다.
    expect(got.edTypes.every((t: string) => t === 'editor')).toBe(true);
    // 그리고 도구는 조용히 사라지지 않고 일반 창으로 돌아왔다 (FR-BGR-5·7).
    expect(got.plainHasTool).toBe(true);
  });
});

declare const SB_TAB_DEFS: unknown[];
declare const SHORTCUT_DEFAULTS: Record<string, string>;
declare const SHORTCUT_LABELS: Record<string, string>;
declare function clean(n: unknown, ok: Set<string>): { tabs: unknown[] } | null;
