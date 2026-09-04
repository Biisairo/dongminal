import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { APIRequestContext, Page } from '@playwright/test';

import { test, expect } from './fixtures';

// EDITOR_TAB_SRS §4 — M5(파일 조작) · M6(파일 열기 라우팅)의 검증
// V-EDT-57~62·68~71 (조작) · V-EDT-73~79 (라우팅).
//
// **서버를 목업하지 않는다.** 조작 종단 셋(FR-EDT-109)은 M1 이 이미 서 있고
// 루트 가드·409·재귀 삭제는 Go 테스트가 잰다 (V-EDT-62~67 은 handlers_fs_test.go).
// 여기서 재는 것은 그 위의 **클라이언트 규약**이다 — 만드는 자리(81), 선택(82),
// 확인창의 사실(83·84), 자기 하위 금지(85), 영향받은 폴더만 재조회(88), 탭의
// 추종과 닫힘(90·91), 실패의 되돌림(92), 그리고 대상 창을 고르는 규칙(95~101).
//
// **파괴적 조작을 재는 스펙이다.** 픽스처는 전부 `mkdtemp` 아래에 만들고 테스트마다
// 자기 루트를 새로 짓는다 — 저장소 자신도 홈도 대상으로 삼지 않는다.

let BASE = '';
let REPO = '';

const j = (...p: string[]) => path.join(...p);
const w = (p: string, s: string) => fs.writeFileSync(p, s);
const git = (d: string, ...a: string[]) => execFileSync('git', ['-C', d, ...a], { stdio: 'ignore' });

/**
 * 테스트 하나가 쓰는 루트. 조작이 파괴적이므로 **공유하지 않는다.**
 *
 *   <root>/src/a.txt · b.txt · deep/c.txt   — 폴더 4항목 (확인창의 수)
 *   <root>/docs/d.txt
 *   <root>/top.txt
 */
function mkRoot(tag: string) {
  const d = j(BASE, tag);
  fs.mkdirSync(j(d, 'src', 'deep'), { recursive: true });
  fs.mkdirSync(j(d, 'docs'));
  w(j(d, 'src', 'a.txt'), 'A\n');
  w(j(d, 'src', 'b.txt'), 'B\n');
  w(j(d, 'src', 'deep', 'c.txt'), 'C\n');
  w(j(d, 'docs', 'd.txt'), 'D\n');
  w(j(d, 'top.txt'), 'T\n');
  return fs.realpathSync(d);
}

function mkRepo(tag: string) {
  const d = j(BASE, tag);
  fs.mkdirSync(j(d, 'sub'), { recursive: true });
  w(j(d, 'sub', 'x.txt'), 'one\n');
  git(d, 'init', '-q', '-b', 'main', '.');
  git(d, 'config', 'user.name', 'Fixture');
  git(d, 'config', 'user.email', 'fixture@example.invalid');
  git(d, 'config', 'commit.gpgsign', 'false');
  git(d, 'add', '-A');
  git(d, 'commit', '-qm', 'base');
  fs.appendFileSync(j(d, 'sub', 'x.txt'), 'two\n');
  return fs.realpathSync(d);
}

test.beforeAll(() => {
  BASE = fs.realpathSync(fs.mkdtempSync(j(os.tmpdir(), 'dm-edop-')));
  REPO = mkRepo('repo');
});
test.afterAll(() => {
  if (BASE) fs.rmSync(BASE, { recursive: true, force: true });
});

// ── 진입 ────────────────────────────────────────────

// 목록의 권위는 서버다 (FR-EDT-20) — 행을 만들면 재조정이 창을 만든다. 조작 종단은
// 이 목록으로 root 를 대조하므로(FR-EDT-113) 여기를 지나지 않으면 전부 거부된다.
async function addEditor(request: APIRequestContext, p: string) {
  const r = await request.post('/api/editors/add', { data: { path: p } });
  expect(r.ok(), `editors/add 실패: ${await r.text()}`).toBeTruthy();
}

async function goto(page: Page) {
  await page.context().addInitScript(() => { sessionStorage.setItem('displayMode', 'desktop') });
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
  await page.waitForFunction(
    () => !!(window as any).app?._editors && (window as any).app._edWindows().length > 0,
    undefined, { timeout: 15000 });
}

async function openEditor(page: Page, root: string) {
  await page.evaluate((r) => {
    const a = (window as any).app;
    const win = a._edWindows().find((x: any) => x.editor && x.editor.root === r);
    if (!win) throw new Error('Editor 창이 없다: ' + r);
    a.switchWindow(win.id);
  }, root);
  await page.waitForSelector('.ed-win .ed-explorer .ed-tree', { timeout: 10000 });
}

async function enter(page: Page, request: APIRequestContext, root: string) {
  await addEditor(request, root);
  await goto(page);
  await openEditor(page, root);
  await expect(page.locator('.ed-tree .ed-row').first()).toBeVisible({ timeout: 10000 });
}

const row = (page: Page, p: string) => page.locator(`.ed-tree .ed-row[data-path="${p}"]`);
const input = (page: Page) => page.locator('.ed-tree .ed-input');
const opErr = (page: Page) => page.locator('.ed-tree .ed-op-err');
const confirmMsg = (page: Page) => page.locator('.ed-confirm .confirm-msg');

async function ctx(page: Page, p: string, id: string) {
  await row(page, p).click({ button: 'right' });
  await expect(page.locator('.git-menu')).toBeVisible();
  await page.locator(`.git-menu .git-menu-item[data-id="${id}"]`).click();
}

// 열려 있는 편집기 탭 전부 — 어느 창의 어느 pane 인지까지. 탭의 추종(FR-EDT-90)과
// 닫힘(FR-EDT-91), 그리고 라우팅(FR-EDT-95~101)이 모두 이 값으로 판정된다.
function tabs(page: Page) {
  return page.evaluate(() => {
    const out: { win: string; root: string; pane: string; id: string; name: string; file: string }[] = [];
    for (const s of (window as any).app.ws.windows) {
      const walk = (n: any) => {
        if (!n) return;
        if (n.type === 'pane') {
          for (const t of n.tabs || []) {
            if (t && t.type === 'editor') {
              out.push({
                win: s.id, root: (s.editor && s.editor.root) || '', pane: n.id,
                id: t.id, name: t.name, file: t.filePath,
              });
            }
          }
        }
        for (const c of n.children || []) walk(c);
      };
      walk(s.layout);
    }
    return out;
  });
}

// 요청 수로만 확인할 수 있는 요구가 하나 있다 (FR-EDT-88).
function counter(page: Page, pred: (url: string) => boolean) {
  const box = { n: 0 };
  page.on('request', ((req: { url(): string }) => { if (pred(req.url())) box.n++ }) as never);
  return box;
}
const isList = (u: string) => u.includes('/api/fs/list');

test.describe('묶음 F — 파일 조작 (FR-EDT-79~93)', () => {
  test('O1 (V-EDT-57 / FR-EDT-81): 새 파일·새 폴더가 선택된 폴더 아래에 생긴다', async ({ page, request }) => {
    const R = mkRoot('o1');
    await enter(page, request, R);

    // ① 선택이 없으면 루트다.
    await page.locator('.ed-head-new-file').click();
    await input(page).fill('r.txt');
    await input(page).press('Enter');
    await expect(row(page, j(R, 'r.txt'))).toBeVisible({ timeout: 10000 });
    expect(fs.existsSync(j(R, 'r.txt'))).toBe(true);

    // ② 선택이 폴더면 그 아래다.
    await row(page, j(R, 'src')).click();
    await expect(row(page, j(R, 'src', 'a.txt'))).toBeVisible();
    await page.locator('.ed-head-new-file').click();
    await input(page).fill('n.txt');
    await input(page).press('Enter');
    await expect(row(page, j(R, 'src', 'n.txt'))).toBeVisible({ timeout: 10000 });

    // ③ 선택이 파일이면 그 부모다 — 방금 만든 파일이 선택되어 있다.
    await page.locator('.ed-head-new-dir').click();
    await input(page).fill('nd');
    await input(page).press('Enter');
    await expect(row(page, j(R, 'src', 'nd'))).toBeVisible({ timeout: 10000 });
    expect(fs.statSync(j(R, 'src', 'nd')).isDirectory()).toBe(true);
    expect(fs.statSync(j(R, 'src', 'n.txt')).isFile()).toBe(true);
  });

  test('O2 (V-EDT-58 / FR-EDT-82): 이름 변경은 확장자 앞까지 선택한다', async ({ page, request }) => {
    const R = mkRoot('o2');
    await enter(page, request, R);
    await row(page, j(R, 'src')).click();
    await expect(row(page, j(R, 'src', 'a.txt'))).toBeVisible();

    await ctx(page, j(R, 'src', 'a.txt'), 'rename');
    await expect(input(page)).toBeVisible();
    expect(await input(page).inputValue()).toBe('a.txt');
    // `a.txt` 의 확장자 앞까지 = [0,1).
    expect(await page.evaluate(() => {
      const el = document.querySelector('.ed-input') as HTMLInputElement;
      return [el.selectionStart, el.selectionEnd, document.activeElement === el];
    })).toEqual([0, 1, true]);

    // 선택된 자리에 그대로 타이핑하면 확장자는 남는다 — 그것이 이 규칙의 목적이다.
    await page.keyboard.type('z');
    await page.keyboard.press('Enter');
    await expect(row(page, j(R, 'src', 'z.txt'))).toBeVisible({ timeout: 10000 });
    expect(fs.existsSync(j(R, 'src', 'a.txt'))).toBe(false);
    expect(fs.readFileSync(j(R, 'src', 'z.txt'), 'utf8')).toBe('A\n');
  });

  test('O3 (V-EDT-59 / FR-EDT-83): 폴더 삭제 확인창이 재귀와 항목 수를 밝힌다', async ({ page, request }) => {
    const R = mkRoot('o3');
    await enter(page, request, R);

    await ctx(page, j(R, 'src'), 'delete');
    await expect(confirmMsg(page)).toBeVisible();
    // src 아래는 a.txt · b.txt · deep · deep/c.txt 의 넷이다.
    await expect(confirmMsg(page)).toContainText('재귀');
    await expect(confirmMsg(page)).toContainText('4개');
    await expect(confirmMsg(page)).toContainText('영구 삭제');

    // 기본 선택지는 안전한 쪽이다 — 취소하면 아무것도 사라지지 않는다.
    await page.locator('.ed-confirm .confirm-cancel').click();
    await expect(confirmMsg(page)).toHaveCount(0);
    expect(fs.existsSync(j(R, 'src', 'deep', 'c.txt'))).toBe(true);
  });

  test('O4 (V-EDT-60 / FR-EDT-84): dirty 탭의 파일 삭제는 그 사실을 밝힌다', async ({ page, request }) => {
    const R = mkRoot('o4');
    await enter(page, request, R);
    await row(page, j(R, 'src')).click();
    await row(page, j(R, 'src', 'a.txt')).click();
    await expect.poll(async () => (await tabs(page)).length).toBe(1);

    // Monaco 는 CDN 에서 온다 — e2e 에서 편집을 흉내 낼 수 없으므로 `_edDirtyUnder`
    // 가 읽는 계약(`FileEditor._dirty`) 자체를 세운다.
    await page.evaluate(() => {
      for (const e of (window as any).app.fileEditors.values()) e._dirty = true;
    });
    await openEditor(page, R);
    await ctx(page, j(R, 'src', 'a.txt'), 'delete');
    await expect(confirmMsg(page)).toContainText('저장되지 않은 탭 1개');
    await expect(confirmMsg(page)).toContainText('a.txt');
    await page.locator('.ed-confirm .confirm-cancel').click();
    expect(fs.existsSync(j(R, 'src', 'a.txt'))).toBe(true);
  });

  test('O5 (V-EDT-61 / FR-EDT-85): 폴더를 자기 하위로 옮길 수 없다', async ({ page, request }) => {
    const R = mkRoot('o5');
    await enter(page, request, R);
    await row(page, j(R, 'src')).click();
    await expect(row(page, j(R, 'src', 'deep'))).toBeVisible();

    await row(page, j(R, 'src')).dragTo(row(page, j(R, 'src', 'deep')));
    await expect(opErr(page)).toContainText('자기 하위');
    expect(fs.existsSync(j(R, 'src', 'deep', 'src'))).toBe(false);
    expect(fs.existsSync(j(R, 'src', 'a.txt'))).toBe(true);
  });

  test('O6 (V-EDT-62 / FR-EDT-86): 같은 이름이 있으면 거부하고 덮어쓰지 않는다', async ({ page, request }) => {
    const R = mkRoot('o6');
    w(j(R, 'docs', 'a.txt'), 'DOCS-A\n');
    await enter(page, request, R);
    await row(page, j(R, 'src')).click();
    await row(page, j(R, 'docs')).click();
    await expect(row(page, j(R, 'docs', 'a.txt'))).toBeVisible();

    // ① 이동 — 대상에 같은 이름이 있다.
    await row(page, j(R, 'docs', 'a.txt')).dragTo(row(page, j(R, 'src')));
    await expect(opErr(page)).toContainText('이미 있습니다');
    expect(fs.readFileSync(j(R, 'src', 'a.txt'), 'utf8')).toBe('A\n');
    expect(fs.readFileSync(j(R, 'docs', 'a.txt'), 'utf8')).toBe('DOCS-A\n');

    // ② 생성 — 같은 자리에 같은 이름.
    await row(page, j(R, 'src')).click();
    await page.locator('.ed-head-new-file').click();
    await input(page).fill('b.txt');
    await input(page).press('Enter');
    await expect(opErr(page)).toContainText('이미 있습니다');
    expect(fs.readFileSync(j(R, 'src', 'b.txt'), 'utf8')).toBe('B\n');
  });

  test('O7 (V-EDT-68 / FR-EDT-88): 조작 뒤 영향받은 폴더만 다시 읽는다', async ({ page, request }) => {
    const R = mkRoot('o7');
    await enter(page, request, R);
    await row(page, j(R, 'src')).click();
    await expect(row(page, j(R, 'src', 'a.txt'))).toBeVisible();
    await row(page, j(R, 'docs')).click();
    await expect(row(page, j(R, 'docs', 'd.txt'))).toBeVisible();

    // ① 생성 — 만든 폴더 하나뿐이다.
    const c1 = counter(page, isList);
    await row(page, j(R, 'src')).click();
    await page.locator('.ed-head-new-file').click();
    await input(page).fill('n.txt');
    await input(page).press('Enter');
    await expect(row(page, j(R, 'src', 'n.txt'))).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(500);
    expect(c1.n).toBe(1);

    // ② 이동 — 출발·도착 둘이다. 트리 전체를 새로 만들지 않는다.
    const c2 = counter(page, isList);
    await row(page, j(R, 'src', 'b.txt')).dragTo(row(page, j(R, 'docs')));
    await expect(row(page, j(R, 'docs', 'b.txt'))).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(500);
    expect(c2.n).toBe(2);
  });

  test('O8 (V-EDT-69 / FR-EDT-90): 이름 변경·이동을 열린 탭이 따라간다', async ({ page, request }) => {
    const R = mkRoot('o8');
    await enter(page, request, R);
    // **더블클릭으로 연다** (REPO_TAB_UNIFY_SRS FR-RTU-40·42).
    //   이전 동작: 한 번 클릭이 탭을 하나씩 만들었다
    //   새  동작: 한 번 클릭은 **미리보기 탭 하나를 재사용**한다 — 목록을 훑어도
    //             탭이 쌓이지 않게 하려는 것이다 (D-RTU-9)
    //   이유:     이 시험은 탭 둘이 **동시에** 열려 있어야 성립한다. 고정하는
    //             계기가 더블클릭이므로 그것을 쓴다
    await row(page, j(R, 'src')).click();
    await row(page, j(R, 'src', 'a.txt')).dblclick();
    await openEditor(page, R);
    await row(page, j(R, 'src', 'deep')).click();
    await row(page, j(R, 'src', 'deep', 'c.txt')).dblclick();
    await openEditor(page, R);
    await expect.poll(async () => (await tabs(page)).length).toBe(2);

    // ① 폴더의 이름 변경 — 그 아래 모든 탭이 따라간다. 탭은 닫히지 않는다.
    await ctx(page, j(R, 'src'), 'rename');
    await input(page).fill('src2');
    await input(page).press('Enter');
    await expect(row(page, j(R, 'src2'))).toBeVisible({ timeout: 10000 });
    await expect.poll(async () => (await tabs(page)).map((t) => t.file).sort()).toEqual([
      j(R, 'src2', 'a.txt'), j(R, 'src2', 'deep', 'c.txt'),
    ]);

    // ② 파일의 이동 — 이름도 경로도 따라간다. 펼침은 이름 변경을 넘어 살아 있다
    //    (접두사가 갈아탄다) — 다시 펼치지 않는 것이 그 증거다.
    await expect(row(page, j(R, 'src2', 'a.txt'))).toBeVisible();
    // 도착지를 펼쳐 둔다 — 접힌 폴더로 옮기면 옮겨진 행 자체가 화면에 없다.
    await row(page, j(R, 'docs')).click();
    await expect(row(page, j(R, 'docs', 'd.txt'))).toBeVisible();
    await row(page, j(R, 'src2', 'a.txt')).dragTo(row(page, j(R, 'docs')));
    await expect(row(page, j(R, 'docs', 'a.txt'))).toBeVisible({ timeout: 10000 });
    const t = await tabs(page);
    expect(t).toHaveLength(2);
    expect(t.map((x) => x.file).sort()).toEqual([
      j(R, 'docs', 'a.txt'), j(R, 'src2', 'deep', 'c.txt'),
    ]);
    expect(t.find((x) => x.file.endsWith('docs/a.txt'))!.name).toBe('a.txt');
  });

  test('O9 (V-EDT-70 / FR-EDT-91): 삭제되면 그 탭이 닫힌다 — 폴더면 하위 전부', async ({ page, request }) => {
    const R = mkRoot('o9');
    await enter(page, request, R);
    // FR-RTU-40·42: 한 번 클릭은 미리보기 탭 하나를 재사용한다 — 셋을 동시에
    // 열어 두려면 고정해야 한다 (O8 과 같은 근거).
    await row(page, j(R, 'src')).click();
    await row(page, j(R, 'src', 'a.txt')).dblclick();
    await openEditor(page, R);
    await row(page, j(R, 'src', 'deep')).click();
    await row(page, j(R, 'src', 'deep', 'c.txt')).dblclick();
    await openEditor(page, R);
    await row(page, j(R, 'top.txt')).dblclick();
    await openEditor(page, R);
    await expect.poll(async () => (await tabs(page)).length).toBe(3);

    // FR-EDT-91: dirty 여도 확인창을 **다시** 띄우지 않는다 (FR-EDT-84 에서 이미 밝혔다).
    await page.evaluate(() => {
      for (const e of (window as any).app.fileEditors.values()) e._dirty = true;
    });
    await ctx(page, j(R, 'src'), 'delete');
    await expect(confirmMsg(page)).toBeVisible();
    await page.locator('.ed-confirm .confirm-ok').click();

    // 폴더 아래의 둘만 닫힌다. 확인창은 다시 뜨지 않는다.
    await expect.poll(async () => (await tabs(page)).map((t) => t.file)).toEqual([j(R, 'top.txt')]);
    expect(fs.existsSync(j(R, 'src'))).toBe(false);
    await expect(page.locator('.confirm-overlay')).toHaveCount(0);
  });

  test('O10 (V-EDT-71 / FR-EDT-92): 실패는 사유를 보이고 낙관적 반영을 되돌린다', async ({ page, request }) => {
    const R = mkRoot('o10');
    await enter(page, request, R);
    await row(page, j(R, 'src')).click();
    await expect(row(page, j(R, 'src', 'a.txt'))).toBeVisible();

    // 디스크로 만들 수 없는 실패다 — 실행 사용자에 따라 결과가 갈리는 권한 대신
    // 서버의 계약(FR-EDT-117)을 세운다. 재는 것은 **클라이언트의 되돌림**이다.
    await page.route('**/api/fs/create', async (route) => {
      await route.fulfill({ status: 500, json: { code: 'io_failed', message: '디스크' } });
    });
    await page.locator('.ed-head-new-file').click();
    await input(page).fill('x.txt');
    await input(page).press('Enter');

    await expect(opErr(page)).toContainText('파일시스템 조작에 실패했습니다');
    // 낙관적으로 그렸던 행이 사라진다 — 남으면 사용자는 만들어졌다고 읽는다.
    await expect(row(page, j(R, 'src', 'x.txt'))).toHaveCount(0);
    expect(fs.existsSync(j(R, 'src', 'x.txt'))).toBe(false);
    // 형제 행은 그대로다.
    await expect(row(page, j(R, 'src', 'a.txt'))).toBeVisible();
  });
});

test.describe('묶음 R — 파일 열기 라우팅 (FR-EDT-95~101)', () => {
  test('R1 (V-EDT-73 / FR-EDT-95): 중첩된 Editor 둘이면 깊은 쪽이 이긴다', async ({ page, request }) => {
    const OUT = mkRoot('r1');
    const IN = fs.realpathSync(j(OUT, 'src'));
    await addEditor(request, OUT);
    await addEditor(request, IN);
    await goto(page);

    await page.evaluate((p) => (window as any).app._edOpenFile(p), j(IN, 'a.txt'));
    await expect.poll(async () => (await tabs(page)).map((t) => t.root)).toEqual([IN]);
  });

  test('R2 (V-EDT-74 / FR-EDT-96): edit <path> 가 연결된 Editor 로 간다', async ({ page, request }) => {
    const R = mkRoot('r2');
    await addEditor(request, R);
    await goto(page);

    // `edit` 이 브라우저에서 도달하는 자리는 `_execRemote('openEditorTab')` 하나다.
    await page.evaluate((p) => (window as any).app._execRemote('openEditorTab', { filePath: p }),
      j(R, 'top.txt'));
    await expect.poll(async () => (await tabs(page)).map((t) => t.root)).toEqual([R]);
    // FR-EDT-102: 연 창으로 전환된다.
    expect(await page.evaluate(() => (window as any).app._aw().editor.root)).toBe(R);
  });

  test('R3 (V-EDT-75 / FR-EDT-96·99): 루트 밖 경로의 edit 은 root 에디터로 간다', async ({ page, request }) => {
    const R = mkRoot('r3');
    const OUT = j(BASE, 'r3-outside.txt');
    w(OUT, 'X\n');
    await addEditor(request, R);
    await goto(page);
    const home = await page.evaluate(() => (window as any).app._edHome());

    await page.evaluate((p) => (window as any).app._execRemote('openEditorTab', { filePath: p }), OUT);
    // FR-EDT-99: 그 창의 탐색기가 이 파일을 가리키지 못하는 것이 정상이다.
    await expect.poll(async () => (await tabs(page)).map((t) => t.root)).toEqual([home]);
    expect(home).not.toBe(R);
  });

  test('R4 (V-EDT-76 / FR-EDT-97): Git Open File 은 파일이 아니라 리포로 고른다', async ({ page, request }) => {
    // 리포와 **리포 안의 더 깊은 루트**를 함께 세운다. 파일 경로로 골랐다면
    // 깊은 쪽(FR-EDT-95)이 이겼을 자리다.
    const SUB = fs.realpathSync(j(REPO, 'sub'));
    await addEditor(request, REPO);
    await addEditor(request, SUB);
    await goto(page);
    await page.evaluate((r) => (window as any).app.openGitWindow(r), REPO);
    await page.waitForFunction(() => (window as any).app.gitPanel.repo, undefined, { timeout: 10000 });

    await page.evaluate((p) => (window as any).app._gitOpenFile(p), j(SUB, 'x.txt'));
    await expect.poll(async () => (await tabs(page)).map((t) => t.root)).toEqual([REPO]);
  });

  test('R5 (V-EDT-77 / FR-EDT-98·99): Open File (HEAD) 의 임시 파일도 리포의 Editor 로 간다', async ({ page, request }) => {
    const SUB = fs.realpathSync(j(REPO, 'sub'));
    await addEditor(request, REPO);
    await addEditor(request, SUB);
    await goto(page);
    await page.evaluate((r) => (window as any).app.openGitWindow(r), REPO);
    await page.waitForFunction(() => (window as any).app.gitPanel.repo, undefined, { timeout: 10000 });

    // 진짜 종단을 지난다 — 임시 경로를 테스트가 지어내면 "저장소 밖" 이라는 전제가
    // 픽스처의 것이 된다.
    await page.evaluate(() => (window as any).app.gitPanel.openFileAtHead({ path: 'sub/x.txt' }));
    await expect.poll(async () => (await tabs(page)).map((t) => t.root)).toEqual([REPO]);
    const t = (await tabs(page))[0];
    expect(t.file.startsWith(REPO)).toBe(false);
    expect(t.name).toContain('HEAD');
  });

  test('R6 (V-EDT-78 / FR-EDT-100): 비활성 대상 창에서도 그 창의 focusedPane 에 붙는다', async ({ page, request }) => {
    const R = mkRoot('r6');
    await addEditor(request, R);
    await goto(page);

    // pane 둘을 만든다. 분할이 생기는 길은 드롭 하나뿐이므로(D-8) 그 경로를 쓴다.
    await page.evaluate((p) => (window as any).app._edOpenFile(p), j(R, 'top.txt'));
    await page.evaluate((p) => (window as any).app._edOpenFile(p), j(R, 'docs', 'd.txt'));
    const two = await page.evaluate(() => {
      const a = (window as any).app;
      const t = a._findEditorTab(a._aw().layout.tabs[1].filePath);
      a._splitPaneWithTab(t.pane.id, t.tab.id, t.pane.id, 'right');
      return { focused: a._aw().focusedPane, panes: a._aw().layout.children.map((c: any) => c.id) };
    });
    expect(two.panes).toHaveLength(2);
    expect(two.focused).toBe(two.panes[1]);

    // 다른 창으로 떠난다 — 이제 대상 창은 **비활성**이다.
    await page.evaluate(() => {
      const a = (window as any).app;
      a.switchWindow(a._plainWindows()[0].id);
    });
    await page.evaluate((p) => (window as any).app._edOpenFile(p), j(R, 'src', 'a.txt'));
    const t = await tabs(page);
    expect(t.find((x) => x.file === j(R, 'src', 'a.txt'))!.pane).toBe(two.focused);
  });

  test('R7 (V-EDT-79 / FR-EDT-101): 이미 열린 파일을 다시 열면 그 탭으로 간다', async ({ page, request }) => {
    const R = mkRoot('r7');
    await addEditor(request, R);
    await goto(page);
    const f = j(R, 'top.txt');

    await page.evaluate((p) => (window as any).app._edOpenFile(p), f);
    await expect.poll(async () => (await tabs(page)).length).toBe(1);
    const first = (await tabs(page))[0];
    await page.evaluate(() => {
      const a = (window as any).app;
      a.switchWindow(a._plainWindows()[0].id);
    });
    // 두 번째는 `edit` 의 경로로 연다 — 중복 방지는 진입점마다 따로 있지 않다.
    await page.evaluate((p) => (window as any).app._execRemote('openEditorTab', { filePath: p }), f);
    const t = await tabs(page);
    expect(t).toHaveLength(1);
    expect(t[0].id).toBe(first.id);
    expect(await page.evaluate(() => (window as any).app.ws.activeWindow)).toBe(first.win);
  });
});
