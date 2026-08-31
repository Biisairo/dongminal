import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { APIRequestContext, Locator, Page } from '@playwright/test';

import { test, expect } from './fixtures';

// EXPLORER_TRANSFER_IGNORE_SRS §5 — V-ETR-6~8·21~27·29~31·33~38.
//
// Go 테스트가 재는 것(종단의 헤더·상한·가드·409·source)은 여기서 다시 재지
// 않는다. 여기서 재는 것은 **클라이언트 규약**이다 — 무엇이 흐려지는가,
// 무엇을 묻지 않는가, 실패했을 때 무엇을 고를 수 있는가, 그리고 복사가 어디로
// 떨어지는가.
//
// 파괴적 조작을 재므로 픽스처는 전부 mkdtemp 아래이고 테스트마다 새 루트를 짓는다.

let BASE = '';

const j = (...p: string[]) => path.join(...p);
const w = (p: string, s: string) => fs.writeFileSync(p, s);

test.beforeAll(() => { BASE = fs.realpathSync(fs.mkdtempSync(j(os.tmpdir(), 'dm-etr-'))) });
test.afterAll(() => { if (BASE) fs.rmSync(BASE, { recursive: true, force: true }) });

function git(dir: string, ...args: string[]) {
  execFileSync('git', args, {
    cwd: dir,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    stdio: 'pipe',
  });
}

/**
 * 무시 규칙이 있는 저장소.
 *
 *   .gitignore   node_modules/ · *.log · tracked.log
 *   node_modules/pkg/a.js   ← 무시된 폴더 안
 *   src/main.js             ← 무시 아님
 *   app.log                 ← 무시
 *   tracked.log             ← 패턴에 맞지만 **추적 중**이라 무시가 아니다 (D-3)
 */
function mkIgnoreRoot(tag: string) {
  const d = j(BASE, tag);
  fs.mkdirSync(j(d, 'node_modules', 'pkg'), { recursive: true });
  fs.mkdirSync(j(d, 'src'), { recursive: true });
  w(j(d, '.gitignore'), 'node_modules/\n*.log\ntracked.log\n');
  w(j(d, 'node_modules', 'pkg', 'a.js'), 'x\n');
  w(j(d, 'src', 'main.js'), 'x\n');
  w(j(d, 'app.log'), 'x\n');
  w(j(d, 'tracked.log'), 'x\n');
  git(d, 'init', '-b', 'main');
  git(d, 'config', 'user.email', 't@example.com');
  git(d, 'config', 'user.name', 'tester');
  git(d, 'add', '-f', 'tracked.log');
  git(d, 'add', '.gitignore', 'src');
  git(d, 'commit', '-m', 'init');
  return fs.realpathSync(d);
}

/** 저장소가 아닌 평범한 트리. 전송 검사에 쓴다. */
function mkPlainRoot(tag: string) {
  const d = j(BASE, tag);
  fs.mkdirSync(j(d, 'box'), { recursive: true });
  w(j(d, 'box', 'a.txt'), 'A\n');
  w(j(d, 'top.txt'), 'T\n');
  return fs.realpathSync(d);
}

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

async function ctxMenu(page: Page, p: string) {
  await row(page, p).click({ button: 'right' });
  await expect(page.locator('.git-menu')).toBeVisible();
}

async function ctx(page: Page, p: string, id: string) {
  await ctxMenu(page, p);
  await page.locator(`.git-menu .git-menu-item[data-id="${id}"]`).click();
}

async function open(page: Page, ...paths: string[]) {
  for (const p of paths) {
    await row(page, p).click();
    await page.waitForTimeout(150);
  }
}

// ── 묶음 A — 무시된 항목의 흐림 ───────────────────────

test.describe('묶음 A — 무시 표시 (FR-ETR-1~8)', () => {
  test('ET1 (V-ETR-6): 무시된 파일·폴더만 흐려진다 — 추적 중인 것은 아니다', async ({ page, request }) => {
    const R = mkIgnoreRoot('et1');
    await enter(page, request, R);

    // 판정은 목록을 읽은 **뒤에** 온다 (FR-ETR-5) — 클래스가 붙기를 기다린다.
    await expect(row(page, j(R, 'node_modules'))).toHaveClass(/ed-ignored/, { timeout: 10000 });
    await expect(row(page, j(R, 'app.log'))).toHaveClass(/ed-ignored/);

    // D-3: 패턴에 맞아도 추적 중이면 무시가 아니다. `--no-index` 를 주면 이 검사가
    // 깨진다 — VS Code 와 같은 판정이어야 한다는 요구가 여기 걸려 있다.
    await expect(row(page, j(R, 'tracked.log'))).not.toHaveClass(/ed-ignored/);
    await expect(row(page, j(R, 'src'))).not.toHaveClass(/ed-ignored/);
    await expect(row(page, j(R, '.gitignore'))).not.toHaveClass(/ed-ignored/);
  });

  test('ET2 (V-ETR-7): 무시된 폴더를 펼쳐도 그 겹을 서버에 묻지 않는다', async ({ page, request }) => {
    const R = mkIgnoreRoot('et2');
    await enter(page, request, R);
    await expect(row(page, j(R, 'node_modules'))).toHaveClass(/ed-ignored/, { timeout: 10000 });

    // FR-ETR-6: 부모가 무시면 자식도 무시다 — 물을 이유가 없다 (D-2).
    const asked: string[] = [];
    page.on('request', r => { if (r.url().includes('/api/fs/ignored')) asked.push(r.url()) });

    await open(page, j(R, 'node_modules'));
    await expect(row(page, j(R, 'node_modules', 'pkg'))).toBeVisible({ timeout: 10000 });

    expect(asked, `무시된 폴더의 하위를 물었다: ${asked.join(', ')}`).toHaveLength(0);
    // 그럼에도 하위는 흐려져야 한다 — 묻지 않는 것과 표시하지 않는 것은 다르다.
    await expect(row(page, j(R, 'node_modules', 'pkg'))).toHaveClass(/ed-ignored/);
  });

  test('ET3 (V-ETR-8): 무시는 표시일 뿐 — 조작을 막지 않는다', async ({ page, request }) => {
    const R = mkIgnoreRoot('et3');
    await enter(page, request, R);
    await expect(row(page, j(R, 'app.log'))).toHaveClass(/ed-ignored/, { timeout: 10000 });

    await ctx(page, j(R, 'app.log'), 'rename');
    const inp = page.locator('.ed-tree .ed-input');
    await expect(inp).toBeVisible();
    await inp.fill('renamed.log');
    await inp.press('Enter');

    await expect(row(page, j(R, 'renamed.log'))).toBeVisible({ timeout: 10000 });
    expect(fs.existsSync(j(R, 'renamed.log'))).toBe(true);
  });

  test('ET4 (FR-ETR-4): 저장소가 아닌 루트에서는 판정을 굳히고 다시 묻지 않는다', async ({ page, request }) => {
    const R = mkPlainRoot('et4');
    await enter(page, request, R);
    await expect(row(page, j(R, 'box'))).toBeVisible({ timeout: 10000 });

    // 첫 요청은 404(not_repo)를 받고 `_ignOff` 를 세운다. 그 뒤로는 겹을 펼쳐도
    // 요청이 없어야 한다 — 굳히지 않으면 펼칠 때마다 영영 묻는다.
    await page.waitForTimeout(500);
    const asked: string[] = [];
    page.on('request', r => { if (r.url().includes('/api/fs/ignored')) asked.push(r.url()) });

    await open(page, j(R, 'box'));
    await expect(row(page, j(R, 'box', 'a.txt'))).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(500);

    expect(asked, `굳히지 않고 다시 물었다: ${asked.join(', ')}`).toHaveLength(0);
    // 아무것도 흐려지지 않는다.
    await expect(row(page, j(R, 'box'))).not.toHaveClass(/ed-ignored/);
  });
});

// ── 묶음 B — 폴더 다운로드 ────────────────────────────

test.describe('묶음 B — 폴더 다운로드 (FR-ETR-9·16)', () => {
  test('ET5 (V-ETR-23): 폴더 행의 다운로드가 활성이고 zip 종단으로 간다', async ({ page, request }) => {
    const R = mkPlainRoot('et5');
    await enter(page, request, R);

    await ctxMenu(page, j(R, 'box'));
    const item = page.locator('.git-menu .git-menu-item[data-id="download"]');
    // FR-ETR-16: 폴더에서 **활성**이다. 전에는 "파일만 내려받을 수 있습니다" 였다.
    await expect(item).not.toHaveClass(/disabled/);

    const dl = page.waitForEvent('download', { timeout: 15000 });
    await item.click();
    const got = await dl;
    expect(got.suggestedFilename()).toBe('box.zip');
    expect(got.url()).toContain('/api/fs/download-dir');
  });

  test('ET6 (V-ETR-23): 파일은 여전히 파일 종단으로 간다', async ({ page, request }) => {
    const R = mkPlainRoot('et6');
    await enter(page, request, R);

    const dl = page.waitForEvent('download', { timeout: 15000 });
    await ctx(page, j(R, 'top.txt'), 'download');
    const got = await dl;
    expect(got.suggestedFilename()).toBe('top.txt');
    expect(got.url()).toContain('/api/fs/download?');
  });
});

// ── 묶음 C·D — 폴더 업로드와 실패의 선택 ──────────────

/**
 * 폴더 드롭을 만든다. `dataTransfer.files` 만으로는 폴더를 표현할 수 없으므로
 * `items[].webkitGetAsEntry()` 를 흉내 낸다 — 실제 브라우저가 주는 것과 같은
 * 모양이다 (FileSystemDirectoryEntry / FileSystemFileEntry).
 */
async function dropTree(page: Page, target: Locator, tree: Record<string, string>) {
  const dt = await page.evaluateHandle((files) => {
    type Node = { name: string; body?: string; kids?: Node[] };
    const rootKids: Node[] = [];
    for (const [rel, body] of Object.entries(files)) {
      const parts = rel.split('/');
      let level = rootKids;
      for (let i = 0; i < parts.length; i++) {
        const name = parts[i];
        const leaf = i === parts.length - 1;
        let node = level.find(n => n.name === name);
        if (!node) { node = leaf ? { name, body } : { name, kids: [] }; level.push(node) }
        if (!leaf) level = node.kids!;
      }
    }
    const mkEntry = (n: Node): any => {
      if (n.kids) {
        return {
          isFile: false, isDirectory: true, name: n.name,
          createReader() {
            let done = false;
            return {
              // readEntries 는 한 번에 전부 주지 않는다 — 빈 배열이 올 때까지
              // 되풀이해야 한다. 실제 Chrome 의 동작을 그대로 흉내 낸다.
              readEntries(cb: (e: any[]) => void) {
                if (done) { cb([]); return }
                done = true;
                cb(n.kids!.map(mkEntry));
              },
            };
          },
        };
      }
      return {
        isFile: true, isDirectory: false, name: n.name,
        file(cb: (f: File) => void) { cb(new File([n.body ?? ''], n.name, { type: 'text/plain' })) },
      };
    };
    const dt = new DataTransfer();
    // types 에 'Files' 가 있어야 바깥에서 온 드롭으로 읽힌다 (FR-FTR-17).
    dt.items.add(new File([''], '__probe__'), );
    const entries = rootKids.map(mkEntry);
    Object.defineProperty(dt, 'items', {
      value: entries.map(en => ({ kind: 'file', webkitGetAsEntry: () => en })),
    });
    return dt;
  }, tree);
  await target.dispatchEvent('dragover', { dataTransfer: dt });
  await target.dispatchEvent('drop', { dataTransfer: dt });
}

test.describe('묶음 C — 폴더 업로드 (FR-ETR-21·25)', () => {
  test('ET7 (V-ETR-21): 폴더를 드롭하면 하위 구조가 그대로 올라간다', async ({ page, request }) => {
    const R = mkPlainRoot('et7');
    await enter(page, request, R);

    await dropTree(page, page.locator('.ed-explorer .ed-head'), {
      'pkg/one.txt': 'ONE\n',
      'pkg/sub/two.txt': 'TWO\n',
      'pkg/sub/deep/three.txt': 'THREE\n',
    });

    await expect(row(page, j(R, 'pkg'))).toBeVisible({ timeout: 15000 });
    expect(fs.readFileSync(j(R, 'pkg', 'one.txt'), 'utf8')).toBe('ONE\n');
    expect(fs.readFileSync(j(R, 'pkg', 'sub', 'two.txt'), 'utf8')).toBe('TWO\n');
    expect(fs.readFileSync(j(R, 'pkg', 'sub', 'deep', 'three.txt'), 'utf8')).toBe('THREE\n');
  });

  test('ET8b (FR-ETR-22): 항목이 상한을 넘으면 하나도 올리지 않는다', async ({ page, request }) => {
    const R = mkPlainRoot('et8b');
    await enter(page, request, R);

    // 홈 폴더를 잘못 놓았을 때 브라우저가 멎지 않아야 한다. 파일시스템에는 아무
    // 것도 만들지 않는다 — 재는 것은 **수집이 멈추는가** 이지 전송이 아니다.
    const tree: Record<string, string> = {};
    for (let i = 0; i <= 10000; i++) tree[`huge/f${i}.txt`] = '';

    const posted: string[] = [];
    page.on('request', r => { if (r.url().includes('/api/fs/upload')) posted.push(r.url()) });

    await dropTree(page, page.locator('.ed-explorer .ed-head'), tree);

    await expect(opErr(page)).toContainText('넘어 올리지 않았습니다', { timeout: 30000 });
    expect(posted, '상한을 넘었는데 올리기 시작했다').toHaveLength(0);
    expect(fs.existsSync(j(R, 'huge'))).toBe(false);
  });

  test('ET8 (FR-ETR-21): 폴더 행에 놓으면 그 폴더 아래로 간다', async ({ page, request }) => {
    const R = mkPlainRoot('et8');
    await enter(page, request, R);

    await dropTree(page, row(page, j(R, 'box')), { 'pkg/one.txt': 'ONE\n' });

    await expect(row(page, j(R, 'box', 'pkg'))).toBeVisible({ timeout: 15000 });
    expect(fs.readFileSync(j(R, 'box', 'pkg', 'one.txt'), 'utf8')).toBe('ONE\n');
  });
});

test.describe('묶음 D — 실패했을 때의 선택 (FR-ETR-26~30)', () => {
  // 충돌을 만든다: 올리려는 이름이 이미 있으면 서버가 409 로 거절한다
  // (FR-FTR-16 은 그대로다).
  const mkConflict = (R: string) => {
    fs.mkdirSync(j(R, 'pkg'), { recursive: true });
    w(j(R, 'pkg', 'one.txt'), 'OLD\n');
  };

  test('ET9 (V-ETR-24·25): 실패하면 묻고, 건너뛰면 다음이 이어진다', async ({ page, request }) => {
    const R = mkPlainRoot('et9');
    mkConflict(R);
    await enter(page, request, R);

    await dropTree(page, page.locator('.ed-explorer .ed-head'), {
      'pkg/one.txt': 'NEW\n',   // 충돌한다
      'pkg/two.txt': 'TWO\n',   // 그 뒤에 올 것
    });

    // FR-ETR-27·28: 다이얼로그가 뜨고, 어느 항목이 왜 실패했는지 보인다.
    const dlg = page.locator('#ed-upload-fail-dlg');
    await expect(dlg).toBeVisible({ timeout: 15000 });
    await expect(dlg).toContainText('pkg/one.txt');
    await expect(dlg).toContainText('같은 이름이 이미 있습니다');

    await dlg.locator('[data-opt="skip"]').click();

    // FR-ETR-26: 건너뛴 뒤 다음 항목이 이어진다.
    await expect(row(page, j(R, 'pkg'))).toBeVisible({ timeout: 15000 });
    await expect(opErr(page)).toBeVisible({ timeout: 10000 });
    expect(fs.readFileSync(j(R, 'pkg', 'one.txt'), 'utf8')).toBe('OLD\n');  // 덮어쓰지 않았다
    expect(fs.readFileSync(j(R, 'pkg', 'two.txt'), 'utf8')).toBe('TWO\n');  // 이어졌다
  });

  test('ET10 (V-ETR-27): 중단을 고르면 남은 항목을 올리지 않는다', async ({ page, request }) => {
    const R = mkPlainRoot('et10');
    mkConflict(R);
    await enter(page, request, R);

    await dropTree(page, page.locator('.ed-explorer .ed-head'), {
      'pkg/one.txt': 'NEW\n',
      'pkg/two.txt': 'TWO\n',
    });

    const dlg = page.locator('#ed-upload-fail-dlg');
    await expect(dlg).toBeVisible({ timeout: 15000 });
    await dlg.locator('[data-opt="abort"]').click();

    await expect(opErr(page)).toBeVisible({ timeout: 15000 });
    expect(fs.readFileSync(j(R, 'pkg', 'one.txt'), 'utf8')).toBe('OLD\n');
    expect(fs.existsSync(j(R, 'pkg', 'two.txt')), '중단했는데 다음 항목이 올라갔다').toBe(false);
  });

  test('ET11 (V-ETR-26): 이후 모두 건너뛰기는 다시 묻지 않는다', async ({ page, request }) => {
    const R = mkPlainRoot('et11');
    fs.mkdirSync(j(R, 'pkg'), { recursive: true });
    w(j(R, 'pkg', 'one.txt'), 'OLD1\n');
    w(j(R, 'pkg', 'two.txt'), 'OLD2\n');
    await enter(page, request, R);

    await dropTree(page, page.locator('.ed-explorer .ed-head'), {
      'pkg/one.txt': 'NEW1\n',   // 충돌
      'pkg/two.txt': 'NEW2\n',   // 또 충돌 — 여기서 다시 물으면 안 된다
      'pkg/three.txt': 'THREE\n',
    });

    const dlg = page.locator('#ed-upload-fail-dlg');
    await expect(dlg).toBeVisible({ timeout: 15000 });
    await dlg.locator('[data-opt="skipAll"]').click();
    // 두 번째 충돌에 다이얼로그가 다시 서면 이 대기가 실패한다.
    await expect(dlg).toBeHidden({ timeout: 15000 });

    // `pkg` 행은 픽스처가 이미 만들어 두었으므로 그것을 기다리는 것은 아무것도
    // 기다리지 않는 것이다. 전송이 **끝났다**는 신호는 건너뛴 수가 붙는 것이다
    // (FR-ETR-30).
    await expect(opErr(page)).toContainText('건너뛰었습니다', { timeout: 15000 });
    expect(fs.readFileSync(j(R, 'pkg', 'one.txt'), 'utf8')).toBe('OLD1\n');
    expect(fs.readFileSync(j(R, 'pkg', 'two.txt'), 'utf8')).toBe('OLD2\n');
    expect(fs.readFileSync(j(R, 'pkg', 'three.txt'), 'utf8')).toBe('THREE\n');
  });
});

// ── 묶음 F — 터미널의 복사 ────────────────────────────

test.describe('묶음 F — OSC 52 (FR-ETR-37~43)', () => {
  /** 터미널에 OSC 52 를 흘려 넣는다 — 셸이 보낸 것과 같은 길이다. */
  async function feedOsc52(page: Page, payload: string) {
    await page.evaluate((p) => {
      const a = (window as any).app;
      const pane = a._focusedTerminal();
      if (!pane || !pane.term) throw new Error('터미널이 없다');
      pane.term.write('\x1b]52;c;' + p + '\x07');
    }, payload);
  }

  const b64 = (s: string) =>
    Buffer.from(s, 'utf8').toString('base64');

  test('ET12 (V-ETR-33·37): OSC 52 가 클립보드로 가고 화면에 잔재가 없다', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/');
    await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });

    await feedOsc52(page, b64('hello-osc52'));
    await page.waitForTimeout(300);

    const got = await page.evaluate(() => navigator.clipboard.readText());
    expect(got).toBe('hello-osc52');
    // FR-ETR-42: 핸들러가 true 를 돌려주지 않으면 잔재가 찍힌다.
    await expect(page.locator('#area .pn.focused .xterm-screen')).not.toContainText('52;c;');
  });

  test('ET13 (V-ETR-34): 한글이 깨지지 않는다 — 바이트로 풀고 UTF-8 로 읽는다', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/');
    await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });

    await feedOsc52(page, b64('한글 복사 내용'));
    await page.waitForTimeout(300);

    // `atob` 의 결과를 그대로 쓰면 여기서 깨진다.
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('한글 복사 내용');
  });

  test('ET14 (V-ETR-35): 클립보드가 막히면 복사창이 뜨고 내용이 선택돼 있다', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });

    // secure context 가 아닌 환경(원격 HTTP)을 흉내 낸다 — 두 단이 모두 막힌
    // 자리가 곧 이 창이 서는 자리다 (D-12).
    await page.evaluate(() => {
      try { Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true }) } catch {}
      (document as any).execCommand = () => false;
    });

    await feedOsc52(page, b64('fallback-text'));

    const box = page.locator('#term-copy');
    await expect(box).toBeVisible({ timeout: 10000 });
    const ta = box.locator('.tc-copy-text');
    await expect(ta).toHaveValue('fallback-text');
    // FR-ETR-41: 미리 선택돼 있어야 Cmd/Ctrl+C 로 끝낼 수 있다.
    const sel = await ta.evaluate((el: HTMLTextAreaElement) => el.selectionEnd - el.selectionStart);
    expect(sel).toBe('fallback-text'.length);

    // FR-ETR-41: Esc 로 닫힌다.
    await ta.press('Escape');
    await expect(box).toBeHidden();
  });

  // FR-ETR-44: 한 도구의 출력은 붙어 있는 모든 브라우저로 간다. 게이트가 없으면
  // OSC 52 하나에 창마다 복사창이 서고, 사용자는 자기가 보던 창이 아닌 곳에서
  // 그것을 만난다.
  test('ET14b (V-ETR-39): 보고 있지 않은 브라우저에는 복사창이 서지 않는다', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
    await page.evaluate(() => {
      try { Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true }) } catch {}
      (document as any).execCommand = () => false;
    });

    // 이 브라우저가 OS 포커스를 잃은 상태 — 사용자는 지금 다른 창을 보고 있다.
    await page.evaluate(() => { (document as any).hasFocus = () => false });
    await feedOsc52(page, b64('other-window-text'));
    await page.waitForTimeout(500);
    await expect(page.locator('#term-copy')).toHaveCount(0);

    // 포커스가 이 창에 있는 도구여도, **다른 도구**의 복사는 여기서 서지 않는다.
    await page.evaluate(() => { (document as any).hasFocus = () => true });
    await page.evaluate(() =>
      (window as any).TermClipboard.write('not-mine', 'tool-that-is-not-active'));
    await page.waitForTimeout(500);
    await expect(page.locator('#term-copy')).toHaveCount(0);

    // 보고 있는 도구의 복사는 종전대로 선다 — 게이트가 막는 것은 엉뚱한 창뿐이다.
    await feedOsc52(page, b64('mine-text'));
    await expect(page.locator('#term-copy')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#term-copy .tc-copy-text')).toHaveValue('mine-text');
    await page.locator('#term-copy .tc-copy-text').press('Escape');
  });

  test('ET15 (V-ETR-36): 읽기 요청(`?`)에는 아무것도 보내지 않는다', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });

    // D-13: 원격의 셸에 사용자 클립보드를 넘기는 통로를 열지 않는다. 창도 뜨지
    // 않아야 한다 — 뜨면 그 자체가 "무언가 응답했다" 는 신호가 된다.
    await feedOsc52(page, '?');
    await page.waitForTimeout(300);
    await expect(page.locator('#term-copy')).toBeHidden();
  });

  test('ET16 (V-ETR-38): 상한을 넘는 내용은 무시되고 화면도 그대로다', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });

    await page.evaluate(() => {
      try { Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true }) } catch {}
      (document as any).execCommand = () => false;
    });
    // 1MiB 를 넘는 payload. 클립보드가 막혀 있으므로, 상한이 없다면 복사창이 뜬다.
    await feedOsc52(page, 'A'.repeat((1 << 20) + 8));
    await page.waitForTimeout(500);

    await expect(page.locator('#term-copy')).toBeHidden();
    await expect(page.locator('#area .pn.focused .xterm-screen')).not.toContainText('52;c;');
  });
});
