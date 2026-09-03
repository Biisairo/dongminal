import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { APIRequestContext, Page } from '@playwright/test';

import { test, expect } from './fixtures';

// NOTES_LIVE_EXPLORER_SRS §5.2 — 묶음 N(메모장)·묶음 L(탐색기의 살아있는 반영)의
// 클라이언트 검증 V-13~V-25.
//
// **서버를 목업하지 않는다.** 메모 루트도 스탬프도 서버가 정하는 값이고, 이
// SRS 가 고치려는 결함이 바로 "화면이 디스크의 사실을 따라가지 않는다" 이므로,
// 진짜 디스크에 만들고 진짜 응답 위에서 잰다. 계약만 재는 둘(종단 없음·요청
// 수)은 그 값을 디스크로 만들 수 없으므로 그때만 `page.route` 를 쓴다.

let BASE = '';
let PLAIN = '';

const j = (...p: string[]) => path.join(...p);

test.beforeAll(() => {
  BASE = fs.realpathSync(fs.mkdtempSync(j(os.tmpdir(), 'dm-nle-')));
  PLAIN = j(BASE, 'plain');
  fs.mkdirSync(PLAIN);
  fs.mkdirSync(j(PLAIN, 'sub'));
  fs.writeFileSync(j(PLAIN, 'sub', 'inner.txt'), 'x\n');
  fs.writeFileSync(j(PLAIN, 'a.txt'), 'x\n');
  PLAIN = fs.realpathSync(PLAIN);
});
test.afterAll(() => {
  if (BASE) fs.rmSync(BASE, { recursive: true, force: true });
});

// ── 진입 ────────────────────────────────────────────

async function addEditor(request: APIRequestContext, p: string) {
  const r = await request.post('/api/editors/add', { data: { path: p } });
  expect(r.ok(), `editors/add 실패: ${await r.text()}`).toBeTruthy();
}

async function goto(page: Page) {
  await page.context().addInitScript(() => {
    sessionStorage.setItem('displayMode', 'desktop');
    try { localStorage.removeItem('sidebarTab') } catch {}
  });
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
  await page.waitForFunction(
    () => !!(window as any).app?._editors && (window as any).app._edWindows().length > 0,
    undefined, { timeout: 15000 });
}

async function openEditorTab(page: Page) {
  await page.locator('.sb-tab[data-panel="editor"]').click();
  await page.waitForFunction(
    () => !document.getElementById('sb-panel-editor')?.hasAttribute('hidden'),
    undefined, { timeout: 10000 });
}

async function openEditorWin(page: Page, root: string) {
  await page.evaluate((r) => {
    const a = (window as any).app;
    const win = a._edWindows().find((x: any) => x.editor && x.editor.root === r);
    if (!win) throw new Error('Editor 창이 없다: ' + r);
    a.switchWindow(win.id);
  }, root);
  await page.waitForSelector('.ed-win .ed-explorer .ed-tree', { timeout: 10000 });
}

const notesRoot = (page: Page) =>
  page.evaluate(() => (window as any).app._edNotes() as string);

const fixedRows = (page: Page) => page.locator('#editor-root .sbl-item');
const treeRows = (page: Page) => page.locator('.ed-tree .ed-row');
// 폴링 주기(EDITOR_GIT_POLL_MS)의 두 배 남짓. 한 주기를 놓쳐도 다음 회차가
// 잡으므로 대기가 주기에 아슬아슬하게 걸리지 않는다.
const POLL_WAIT = 9000;

function counter(page: Page, pred: (url: string) => boolean) {
  const box = { n: 0 };
  page.on('request', ((req: { url(): string }) => { if (pred(req.url())) box.n++ }) as never);
  return box;
}

// ── 묶음 N — 메모장 ─────────────────────────────────

test.describe('묶음 N — 메모장 (FR-NOT-1~12)', () => {
  test('V-13: 고정 행이 둘이고 메모장이 ~ 위에 있다', async ({ page }) => {
    await goto(page);
    await openEditorTab(page);
    await expect(fixedRows(page)).toHaveCount(2);
    const labels = await fixedRows(page).locator('.sbl-name').allTextContents();
    expect(labels).toEqual(['메모장', '~']);
  });

  test('V-14: 메모장 행에 × 가 없고 드래그의 출발점이 아니다', async ({ page }) => {
    await goto(page);
    await openEditorTab(page);
    const memo = fixedRows(page).first();
    await expect(memo.locator('.sbl-x')).toHaveCount(0);
    // FR-NOT-10: 고정 행은 재배치 리스너를 아예 받지 않는다 (FR-EDT-15 와 같다).
    expect(await memo.evaluate((e) => (e as HTMLElement).draggable)).toBe(false);
  });

  test('V-15: 메모장 행을 누르면 메모장 창이 활성이 된다', async ({ page }) => {
    await goto(page);
    await openEditorTab(page);
    const notes = await notesRoot(page);
    expect(notes).not.toBe('');

    await fixedRows(page).first().click();
    await page.waitForSelector('.ed-win .ed-explorer', { timeout: 10000 });
    const got = await page.evaluate(() => {
      const a = (window as any).app;
      const w = a._aw();
      return { root: a._edRootOf(w), name: w.name };
    });
    expect(got.root).toBe(notes);
    // FR-NOT-9: 행과 창이 같은 이름을 쓴다.
    expect(got.name).toBe('메모장');
    await expect(page.locator('.ed-win .ed-head-name')).toHaveText('메모장');
  });

  test('V-16: 메모장 창에서 만든 파일이 메모 루트 아래에 생긴다', async ({ page }) => {
    await goto(page);
    const notes = await notesRoot(page);
    await openEditorWin(page, notes);

    await page.evaluate(() => (window as any).app._edActiveTree().startCreate(false));
    const input = page.locator('.ed-tree .ed-input');
    await expect(input).toBeVisible({ timeout: 10000 });
    await input.fill('memo-v16.md');
    await input.press('Enter');

    const made = j(notes, 'memo-v16.md');
    await expect.poll(() => fs.existsSync(made), { timeout: 10000 }).toBe(true);
    await expect(page.locator(`.ed-tree .ed-row[data-path="${made}"]`)).toBeVisible();
    fs.rmSync(made, { force: true });
  });

  test('V-17: 메모 루트가 일반 행 목록에 없다', async ({ page }) => {
    await goto(page);
    await openEditorTab(page);
    const notes = await notesRoot(page);
    const paths = await page.evaluate(() =>
      [...document.querySelectorAll('#editor-entries .sbl-item')]
        .map((e) => (e as HTMLElement).dataset.edRoot));
    expect(paths).not.toContain(notes);
  });

  test('V-18b: 워크스페이스 동기화를 거쳐도 메모장 행과 창이 남는다', async ({ page }) => {
    // FR-NOT-13 의 회귀. `_applyRemoteWorkspace` 는 `editors.list` 만 새로 알고
    // 나머지는 아는 값을 되쓴다 — 거기서 `notes` 가 지워지면 `_edRoots()` 에서
    // 메모 루트가 빠지고 **재조정이 메모장 창을 삭제한다.** 실제로 그렇게 깨졌고
    // 전체 e2e 의 창 수가 그것을 잡았다.
    await goto(page);
    await openEditorTab(page);
    const notes = await notesRoot(page);
    const before = await page.evaluate(() => (window as any).app.ws.windows.length);

    await page.evaluate(() => (window as any).app._onWorkspaceChanged());
    await page.waitForFunction(
      () => !(window as any).app._wsApplyInflight, undefined, { timeout: 10000 });

    expect(await notesRoot(page), '동기화가 메모 루트를 지웠다').toBe(notes);
    expect(await page.evaluate(() => (window as any).app.ws.windows.length),
      '동기화가 창을 지웠다').toBe(before);
    expect(await page.evaluate((r) =>
      (window as any).app._edWindows().some((w: any) => w.editor && w.editor.root === r), notes),
      '메모장 창이 사라졌다').toBe(true);
    await expect(fixedRows(page)).toHaveCount(2);
  });

  test('V-18: notes 가 없으면 ~ 만 남고 Editor 탭은 그대로다', async ({ page }) => {
    // FR-NOT-11 은 서버가 답하지 **못하는** 경우이므로 디스크로 만들 수 없다.
    await page.route('**/api/editors', async (route) => {
      const r = await route.fetch();
      const j = await r.json();
      delete j.notes;
      await route.fulfill({ json: j });
    });
    await goto(page);
    await openEditorTab(page);
    await expect(fixedRows(page)).toHaveCount(1);
    await expect(fixedRows(page).locator('.sbl-name')).toHaveText('~');
    await expect(page.locator('.sb-tab[data-panel="editor"]')).toBeVisible();
  });
});

// ── 묶음 L — 탐색기의 살아있는 반영 ─────────────────

test.describe('묶음 L — 탐색기의 살아있는 반영 (FR-FSL-1~14)', () => {
  test('V-19: 탐색기 밖에서 만든 파일이 한 주기 안에 나타난다', async ({ page, request }) => {
    await addEditor(request, PLAIN);
    await goto(page);
    await openEditorWin(page, PLAIN);
    await expect(treeRows(page).first()).toBeVisible({ timeout: 10000 });

    const made = j(PLAIN, 'v19-outside.txt');
    fs.writeFileSync(made, 'x\n');
    try {
      await expect(page.locator(`.ed-tree .ed-row[data-path="${made}"]`))
        .toBeVisible({ timeout: POLL_WAIT });
    } finally {
      fs.rmSync(made, { force: true });
    }
  });

  test('V-20: 탐색기 밖에서 지운 파일이 한 주기 안에 사라진다', async ({ page, request }) => {
    const doomed = j(PLAIN, 'v20-doomed.txt');
    fs.writeFileSync(doomed, 'x\n');
    await addEditor(request, PLAIN);
    await goto(page);
    await openEditorWin(page, PLAIN);
    await expect(page.locator(`.ed-tree .ed-row[data-path="${doomed}"]`))
      .toBeVisible({ timeout: 10000 });

    fs.rmSync(doomed);
    await expect(page.locator(`.ed-tree .ed-row[data-path="${doomed}"]`))
      .toHaveCount(0, { timeout: POLL_WAIT });
  });

  test('V-19: 펼친 하위 겹의 변경도 따라간다', async ({ page, request }) => {
    await addEditor(request, PLAIN);
    await goto(page);
    await openEditorWin(page, PLAIN);
    const sub = j(PLAIN, 'sub');
    await page.locator(`.ed-tree .ed-row[data-path="${sub}"]`).click();
    await expect(page.locator(`.ed-tree .ed-row[data-path="${j(sub, 'inner.txt')}"]`))
      .toBeVisible({ timeout: 10000 });

    const made = j(sub, 'v19-deep.txt');
    fs.writeFileSync(made, 'x\n');
    try {
      await expect(page.locator(`.ed-tree .ed-row[data-path="${made}"]`))
        .toBeVisible({ timeout: POLL_WAIT });
    } finally {
      fs.rmSync(made, { force: true });
    }
  });

  test('V-21: 아무것도 바뀌지 않으면 목록 요청이 나가지 않는다', async ({ page, request }) => {
    await addEditor(request, PLAIN);
    await goto(page);
    await openEditorWin(page, PLAIN);
    await expect(treeRows(page).first()).toBeVisible({ timeout: 10000 });

    // 첫 조회가 끝난 **뒤**부터 센다. 이 구간에 디스크는 그대로다.
    const list = counter(page, (u) => u.includes('/api/fs/list'));
    const stamp = counter(page, (u) => u.includes('/api/fs/stamp'));
    await page.waitForTimeout(POLL_WAIT);
    expect(stamp.n, '스탬프는 주기마다 물어야 한다').toBeGreaterThan(0);
    expect(list.n, `변경이 없으면 목록을 다시 읽지 않는다 (list=${list.n})`).toBe(0);
  });

  test('V-22: 접힌 폴더는 dirs 에 실리지 않는다', async ({ page, request }) => {
    await addEditor(request, PLAIN);
    await goto(page);
    await openEditorWin(page, PLAIN);
    const sub = j(PLAIN, 'sub');
    // 한 번 펼쳤다 접는다 — 캐시(`_kids`)는 남지만 화면에는 없다.
    await page.locator(`.ed-tree .ed-row[data-path="${sub}"]`).click();
    await expect(page.locator(`.ed-tree .ed-row[data-path="${j(sub, 'inner.txt')}"]`))
      .toBeVisible({ timeout: 10000 });
    await page.locator(`.ed-tree .ed-row[data-path="${sub}"]`).click();
    await expect(page.locator(`.ed-tree .ed-row[data-path="${j(sub, 'inner.txt')}"]`))
      .toHaveCount(0);

    const dirs = await page.evaluate(() =>
      (window as any).app._edActiveTree()._stampDirs() as string[]);
    expect(dirs).toContain(PLAIN);
    expect(dirs).not.toContain(sub);
  });

  test('V-23: git 저장소가 아닌 메모 루트에서도 목록이 따라간다', async ({ page }) => {
    await goto(page);
    const notes = await notesRoot(page);
    await openEditorWin(page, notes);
    // FR-FSL-13 의 전제 — 이 루트에는 git 색이 없다.
    await expect.poll(
      () => page.evaluate(() => (window as any).app._edActiveTree()._gitOff),
      { timeout: POLL_WAIT }).toBe(true);

    const made = j(notes, 'v23-outside.md');
    fs.writeFileSync(made, 'x\n');
    try {
      await expect(page.locator(`.ed-tree .ed-row[data-path="${made}"]`))
        .toBeVisible({ timeout: POLL_WAIT });
    } finally {
      fs.rmSync(made, { force: true });
    }
  });

  test('V-24: stamp 가 404 면 그 뒤로 묻지 않는다', async ({ page, request }) => {
    // 종단이 없는 옛 서버다. 디스크로 만들 수 없으므로 라우트로 세운다.
    await page.route('**/api/fs/stamp', async (route) => {
      await route.fulfill({ status: 404, json: { code: 'not_found' } });
    });
    await addEditor(request, PLAIN);
    await goto(page);
    await openEditorWin(page, PLAIN);
    await expect(treeRows(page).first()).toBeVisible({ timeout: 10000 });

    await expect.poll(
      () => page.evaluate(() => (window as any).app._edActiveTree()._stampOff),
      { timeout: POLL_WAIT }).toBe(true);

    const stamp = counter(page, (u) => u.includes('/api/fs/stamp'));
    await page.waitForTimeout(POLL_WAIT);
    expect(stamp.n, '4xx 뒤에는 다시 묻지 않는다').toBe(0);
  });

  test('V-25: 같은 루트를 보는 칸이 둘이어도 주기당 stamp 는 한 벌이다', async ({ page, request }) => {
    await addEditor(request, PLAIN);
    await goto(page);
    await openEditorWin(page, PLAIN);
    await expect(treeRows(page).first()).toBeVisible({ timeout: 10000 });

    // FR-SVS-20: 관측은 루트마다 하나다. 칸을 둘로 늘려도 그 사실이 유지된다.
    await page.evaluate(() => (window as any).app.slotAdd());
    await page.waitForFunction(
      () => document.querySelectorAll('.ed-win .ed-explorer').length >= 2,
      undefined, { timeout: 10000 });

    const stamp = counter(page, (u) => u.includes('/api/fs/stamp'));
    await page.waitForTimeout(POLL_WAIT);
    const cycles = Math.floor(POLL_WAIT / 3000);
    expect(stamp.n, `칸 둘이어도 주기당 한 벌 (n=${stamp.n}, 주기≈${cycles})`)
      .toBeLessThanOrEqual(cycles + 1);
    await page.evaluate(() => (window as any).app.slotRemove());
  });
});

// ── 묶음 K — 캐럿 ───────────────────────────────────

test.describe('묶음 K — 캐럿 (FR-CUR-1·2)', () => {
  test('V-26·27: 캐럿 애니메이션이 꺼져 있고 깜빡임은 그대로다', async ({ page }) => {
    await goto(page);
    const notes = await notesRoot(page);
    const memo = j(notes, 'v26.txt');
    fs.writeFileSync(memo, 'hello\n');
    try {
      await page.evaluate((p) => (window as any).app._edOpenFile(p), memo);
      await page.waitForSelector('.file-editor .monaco-editor', { timeout: 20000 });
      const opts = await page.evaluate(() => {
        const a = (window as any).app;
        const view = [...a.fileEditors.values()].find((v: any) => v._editor);
        const ed = (view as any)._editor;
        const m = (window as any).monaco.editor.EditorOption;
        return {
          smoothCaret: ed.getOption(m.cursorSmoothCaretAnimation),
          blinking: ed.getOption(m.cursorBlinking),
        };
      });
      expect(opts.smoothCaret).toBe('off');
      // cursorBlinking 은 열거값으로 읽힌다 — 'blink' 는 1 이다.
      expect(opts.blinking).toBe(1);
    } finally {
      fs.rmSync(memo, { force: true });
    }
  });
});
