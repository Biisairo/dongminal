import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { APIRequestContext, Locator, Page } from '@playwright/test';

import { test, expect } from './fixtures';

// FILE_TRANSFER_SRS §5 — V-FTR-8·12·14~21.
//
// Go 테스트가 재는 것(헤더·상한·루트 가드·409)은 여기서 다시 재지 않는다
// (handlers_transfer_test.go). 여기서 재는 것은 **클라이언트 규약**이다 — 어디에
// 놓을 수 있는가(20·21), 무엇이 활성인가(13), 실패가 어디에 붙는가(19).
//
// 파괴적 조작을 재므로 픽스처는 전부 mkdtemp 아래이고 테스트마다 새 루트를 짓는다.

let BASE = '';

const j = (...p: string[]) => path.join(...p);
const w = (p: string, s: string) => fs.writeFileSync(p, s);

/**
 * <root>/a/b/c/deep.txt   — 폴더의 폴더의 폴더 (요구 ④)
 * <root>/docs/d.txt
 * <root>/top.txt
 */
function mkRoot(tag: string) {
  const d = j(BASE, tag);
  fs.mkdirSync(j(d, 'a', 'b', 'c'), { recursive: true });
  fs.mkdirSync(j(d, 'docs'));
  w(j(d, 'a', 'b', 'c', 'deep.txt'), 'DEEP\n');
  w(j(d, 'docs', 'd.txt'), 'D\n');
  w(j(d, 'top.txt'), 'T\n');
  return fs.realpathSync(d);
}

test.beforeAll(() => { BASE = fs.realpathSync(fs.mkdtempSync(j(os.tmpdir(), 'dm-ftr-'))) });
test.afterAll(() => { if (BASE) fs.rmSync(BASE, { recursive: true, force: true }) });

async function addEditor(request: APIRequestContext, p: string) {
  const r = await request.post('/api/editors/add', { data: { path: p } });
  expect(r.ok(), `editors/add 실패: ${await r.text()}`).toBeTruthy();
}

async function enter(page: Page, request: APIRequestContext, root: string) {
  await addEditor(request, root);
  await page.context().addInitScript(() => { sessionStorage.setItem('displayMode', 'desktop') });
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
  await page.waitForFunction(
    () => !!(window as any).app?._editors && (window as any).app._edWindows().length > 0,
    undefined, { timeout: 15000 });
  await page.evaluate((r) => {
    const a = (window as any).app;
    const win = a._edWindows().find((x: any) => x.editor && x.editor.root === r);
    if (!win) throw new Error('Editor 창이 없다: ' + r);
    a.switchWindow(win.id);
  }, root);
  await page.waitForSelector('.ed-win .ed-explorer .ed-tree', { timeout: 10000 });
  await expect(page.locator('.ed-tree .ed-row').first()).toBeVisible({ timeout: 10000 });
}

const row = (page: Page, p: string) => page.locator(`.ed-tree .ed-row[data-path="${p}"]`);
const opErr = (page: Page) => page.locator('.ed-tree .ed-op-err');
const head = (page: Page) => page.locator('.ed-explorer .ed-head');
const tree = (page: Page) => page.locator('.ed-explorer .ed-tree');

async function ctxMenu(page: Page, p: string) {
  await row(page, p).click({ button: 'right' });
  await expect(page.locator('.git-menu')).toBeVisible();
}

async function ctx(page: Page, p: string, id: string) {
  await ctxMenu(page, p);
  await page.locator(`.git-menu .git-menu-item[data-id="${id}"]`).click();
}

// 트리를 펼친다 — 폴더 행 클릭이 toggle 이다.
async function open(page: Page, ...paths: string[]) {
  for (const p of paths) {
    await row(page, p).click();
    await page.waitForTimeout(150);
  }
}

// ── OS 드롭 ─────────────────────────────────────────
//
// 바깥에서 온 파일은 Playwright 의 dragTo 로 만들 수 없다 — 그것은 트리 **내부**의
// 드래그다. DataTransfer 를 직접 만들어 이벤트로 넣는다.

async function fileDT(page: Page, files: { name: string; body: string }[]) {
  return page.evaluateHandle((fs) => {
    const dt = new DataTransfer();
    for (const f of fs) dt.items.add(new File([f.body], f.name, { type: 'text/plain' }));
    return dt;
  }, files);
}

async function dropFiles(page: Page, target: Locator, files: { name: string; body: string }[]) {
  const dt = await fileDT(page, files);
  await target.dispatchEvent('dragover', { dataTransfer: dt });
  await target.dispatchEvent('drop', { dataTransfer: dt });
}

test.describe('묶음 F — 루트 이동과 자동 펼침 (FR-FTR-20~24)', () => {
  test('FT1 (V-FTR-17): 폴더의 폴더의 폴더에 있는 파일을 헤더에 놓으면 루트로 온다', async ({ page, request }) => {
    const R = mkRoot('ft1');
    await enter(page, request, R);
    await open(page, j(R, 'a'), j(R, 'a', 'b'), j(R, 'a', 'b', 'c'));
    await expect(row(page, j(R, 'a', 'b', 'c', 'deep.txt'))).toBeVisible();

    await row(page, j(R, 'a', 'b', 'c', 'deep.txt')).dragTo(head(page));

    await expect(row(page, j(R, 'deep.txt'))).toBeVisible({ timeout: 10000 });
    expect(fs.existsSync(j(R, 'deep.txt'))).toBe(true);
    expect(fs.existsSync(j(R, 'a', 'b', 'c', 'deep.txt'))).toBe(false);
  });

  test('FT2 (V-FTR-18): 트리의 빈 여백에 놓아도 루트로 온다 — 폴더도 같다', async ({ page, request }) => {
    const R = mkRoot('ft2');
    await enter(page, request, R);
    await open(page, j(R, 'a'));
    await expect(row(page, j(R, 'a', 'b'))).toBeVisible();

    // 빈 여백은 트리의 맨 아래다 — 행이 없는 자리를 집는다.
    const box = await tree(page).boundingBox();
    await row(page, j(R, 'a', 'b')).dragTo(tree(page), {
      targetPosition: { x: 10, y: (box?.height ?? 200) - 4 },
    });

    await expect(row(page, j(R, 'b'))).toBeVisible({ timeout: 10000 });
    expect(fs.statSync(j(R, 'b')).isDirectory()).toBe(true);
    expect(fs.existsSync(j(R, 'a', 'b'))).toBe(false);
    // 옮겨진 폴더의 하위는 따라온다.
    expect(fs.existsSync(j(R, 'b', 'c', 'deep.txt'))).toBe(true);
  });

  test('FT3 (V-FTR-19): 이미 루트에 있는 것을 루트에 놓으면 서버에 묻지 않는다', async ({ page, request }) => {
    const R = mkRoot('ft3');
    await enter(page, request, R);
    let renames = 0;
    page.on('request', (req) => { if (req.url().includes('/api/fs/rename')) renames++ });

    await row(page, j(R, 'top.txt')).dragTo(head(page));
    await page.waitForTimeout(600);

    expect(renames).toBe(0);
    expect(fs.existsSync(j(R, 'top.txt'))).toBe(true);
    await expect(opErr(page)).toHaveCount(0);
  });

  test('FT4 (V-FTR-20): 루트에 같은 이름이 있으면 거부하고 사유를 보인다', async ({ page, request }) => {
    const R = mkRoot('ft4');
    w(j(R, 'd.txt'), 'ROOT-D\n');
    await enter(page, request, R);
    await open(page, j(R, 'docs'));
    await expect(row(page, j(R, 'docs', 'd.txt'))).toBeVisible();

    await row(page, j(R, 'docs', 'd.txt')).dragTo(head(page));

    await expect(opErr(page)).toContainText('이미 있습니다', { timeout: 10000 });
    expect(fs.readFileSync(j(R, 'd.txt'), 'utf8')).toBe('ROOT-D\n');
    expect(fs.readFileSync(j(R, 'docs', 'd.txt'), 'utf8')).toBe('D\n');
  });

  test('FT5 (V-FTR-21): 접힌 폴더 위에 머무르면 펼쳐지고, 그 손자까지 이어서 넣을 수 있다', async ({ page, request }) => {
    const R = mkRoot('ft5');
    await enter(page, request, R);
    // a 는 접혀 있다 — 지금은 b 도 c 도 화면에 없다.
    await expect(row(page, j(R, 'a', 'b'))).toHaveCount(0);

    const dt = await page.evaluateHandle(() => new DataTransfer());
    await row(page, j(R, 'top.txt')).dispatchEvent('dragstart', { dataTransfer: dt });

    // ① a 위에 머무른다 → 펼쳐진다.
    await row(page, j(R, 'a')).dispatchEvent('dragover', { dataTransfer: dt });
    await expect(row(page, j(R, 'a', 'b'))).toBeVisible({ timeout: 10000 });

    // ② 이어서 b 위에 머무른다 → 손자가 나온다. 드래그를 놓지 않았다.
    await row(page, j(R, 'a', 'b')).dispatchEvent('dragover', { dataTransfer: dt });
    await expect(row(page, j(R, 'a', 'b', 'c'))).toBeVisible({ timeout: 10000 });

    // ③ 그 자리에 놓는다.
    await row(page, j(R, 'a', 'b', 'c')).dispatchEvent('dragover', { dataTransfer: dt });
    await row(page, j(R, 'a', 'b', 'c')).dispatchEvent('drop', { dataTransfer: dt });

    // FR-FTR-20b: 접힌 폴더로 옮겨도 그 폴더가 펼쳐져 옮긴 것이 보인다.
    await expect(row(page, j(R, 'a', 'b', 'c', 'top.txt'))).toBeVisible({ timeout: 10000 });
    expect(fs.existsSync(j(R, 'a', 'b', 'c', 'top.txt'))).toBe(true);
    expect(fs.existsSync(j(R, 'top.txt'))).toBe(false);
  });
});

test.describe('묶음 D·E — 탐색기의 전송 (FR-FTR-13~19)', () => {
  test('FT6 (V-FTR-14): OS 드롭으로 폴더에 올린다 — 헤더에 놓으면 루트다', async ({ page, request }) => {
    const R = mkRoot('ft6');
    await enter(page, request, R);
    await open(page, j(R, 'docs'));

    await dropFiles(page, row(page, j(R, 'docs')), [{ name: 'dropped.txt', body: 'DROPPED' }]);
    await expect(row(page, j(R, 'docs', 'dropped.txt'))).toBeVisible({ timeout: 10000 });
    expect(fs.readFileSync(j(R, 'docs', 'dropped.txt'), 'utf8')).toBe('DROPPED');

    await dropFiles(page, head(page), [{ name: 'at-root.txt', body: 'ROOT' }]);
    await expect(row(page, j(R, 'at-root.txt'))).toBeVisible({ timeout: 10000 });
  });

  test('FT7 (V-FTR-15): 메뉴 업로드는 폴더면 그 안, 파일이면 그 형제 자리다', async ({ page, request }) => {
    const R = mkRoot('ft7');
    const src = j(BASE, 'picked.txt');
    w(src, 'PICKED');
    await enter(page, request, R);
    await open(page, j(R, 'docs'));

    const chooser = page.waitForEvent('filechooser');
    await ctx(page, j(R, 'docs', 'd.txt'), 'upload');
    await (await chooser).setFiles([src]);

    await expect(row(page, j(R, 'docs', 'picked.txt'))).toBeVisible({ timeout: 10000 });
    expect(fs.readFileSync(j(R, 'docs', 'picked.txt'), 'utf8')).toBe('PICKED');
  });

  test('FT8 (V-FTR-16): 둘 중 둘째가 충돌하면 첫째는 남고 사유가 그 자리에 붙는다', async ({ page, request }) => {
    const R = mkRoot('ft8');
    w(j(R, 'docs', 'dup.txt'), 'ORIGINAL\n');
    await enter(page, request, R);
    await open(page, j(R, 'docs'));

    await dropFiles(page, row(page, j(R, 'docs')), [
      { name: 'first.txt', body: 'FIRST' },
      { name: 'dup.txt', body: 'SECOND' },
    ]);

    await expect(opErr(page)).toContainText('이미 있습니다', { timeout: 10000 });
    await expect(opErr(page)).toContainText('dup.txt');
    expect(fs.readFileSync(j(R, 'docs', 'first.txt'), 'utf8')).toBe('FIRST');
    expect(fs.readFileSync(j(R, 'docs', 'dup.txt'), 'utf8')).toBe('ORIGINAL\n');
  });

  test('FT9 (V-FTR-12): 다운로드는 파일에서만 활성이고 실제로 내려받는다', async ({ page, request }) => {
    const R = mkRoot('ft9');
    await enter(page, request, R);

    // ① 폴더에서는 비활성이고 사유가 보인다.
    await ctxMenu(page, j(R, 'docs'));
    const item = page.locator('.git-menu .git-menu-item[data-id="download"]');
    await expect(item).toHaveClass(/disabled/);
    await expect(item).toHaveAttribute('title', /파일만/);
    await page.keyboard.press('Escape');

    // ② 파일에서는 내려받는다.
    const dl = page.waitForEvent('download');
    await ctx(page, j(R, 'top.txt'), 'download');
    const got = await dl;
    expect(got.suggestedFilename()).toBe('top.txt');
  });
});

test.describe('묶음 C — 터미널 (FR-FTR-8·10·11)', () => {
  test('FT11 (V-FTR-9): 업로드가 끝나도 셸에 엔터를 보내지 않는다', async ({ page, request }) => {
    const R = mkRoot('ft11');
    await enter(page, request, R);

    const sent = await page.evaluate(async () => {
      const app = (window as any).app;
      const tool = [...app.tools.values()][0];
      const out: number[][] = [];
      const orig = tool._send.bind(tool);
      tool._send = (m: Uint8Array) => { out.push([...m]); return orig(m) };
      await new Promise<void>((res) => {
        const dt = new DataTransfer();
        dt.items.add(new File(['UP'], 'from-term.txt', { type: 'text/plain' }));
        tool._uploadFiles(dt.files);
        setTimeout(res, 1500);
      });
      tool._send = orig;
      return out;
    });

    // 0x0d 는 엔터다 — 그 순간 돌고 있는 것이 셸이 아니면 그 프로그램이 받는다.
    expect(sent.some((m) => m.length === 2 && m[1] === 0x0d)).toBe(false);
  });

  test('FT12 (V-FTR-10): 도구의 cwd 를 모르면 업로드하지 않고 사유를 쓴다', async ({ page, request }) => {
    const R = mkRoot('ft12');
    await enter(page, request, R);
    // 서버의 cwd 로 폴백한 응답 — 사용자가 보고 있는 폴더가 아니다 (D-4).
    await page.route('**/api/cwd*', (route) =>
      route.fulfill({ json: { cwd: '/tmp', source: 'server' } }));

    let uploads = 0;
    page.on('request', (r) => { if (r.url().includes('/api/upload')) uploads++ });

    const said = await page.evaluate(async () => {
      const app = (window as any).app;
      const tool = [...app.tools.values()][0];
      const lines: string[] = [];
      const orig = tool._say.bind(tool);
      tool._say = (s: string) => { lines.push(s); return orig(s) };
      await new Promise<void>((res) => {
        const dt = new DataTransfer();
        dt.items.add(new File(['UP'], 'nope.txt', { type: 'text/plain' }));
        tool._uploadFiles(dt.files);
        setTimeout(res, 1500);
      });
      tool._say = orig;
      return lines.join('');
    });

    expect(uploads).toBe(0);
    expect(said).toContain('업로드하지 않았습니다');
  });

  test('FT10 (V-FTR-8): OSC 가 청크 경계에서 갈려도 다운로드가 일어난다', async ({ page, request }) => {
    const R = mkRoot('ft10');
    await enter(page, request, R);

    const dl = page.waitForEvent('download');
    const leftover = await page.evaluate(() => {
      const app = (window as any).app;
      const tool = [...app.tools.values()][0];
      const enc = new TextEncoder();
      // `\x1b]777;Download;/etc/host` 와 `s\x07` — BEL 이 다음 청크에 있다.
      tool._handleOutput(enc.encode('\x1b]777;Download;/etc/host'));
      tool._doFlush();
      const mid = tool._outputBuf;
      tool._handleOutput(enc.encode('s\x07'));
      tool._doFlush();
      // 앞 조각을 보류했는가, 그리고 화면에 잔재가 남지 않았는가.
      return { mid, after: tool._outputBuf };
    });
    expect(leftover.mid).toContain('777;Download');
    expect(leftover.after).toBe('');
    const got = await dl;
    expect(got.suggestedFilename()).toBe('hosts');
  });
});
