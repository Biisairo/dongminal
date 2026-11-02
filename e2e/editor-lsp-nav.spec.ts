/**
 * 코드 탐색 — CODEMIRROR_MIGRATION_SRS FR-CMR-90~95 · §4.3 · §11.6 T (EDITOR_LSP_SRS V-LSP-13~21·60).
 *
 * **기능 검사는 실제 gopls 로 한다** (M8 결정 7). 짜 둔 응답에 맞춘 검사는 실제 서버와 어긋나도
 * 통과한다. 통로(`/api/lsp/ws`)는 `routeWebSocket` 으로 실제 서버에 잇고 프레임만 기록한다
 * (`lspTap`). 가짜 소켓은 실패 주입(상한 거절·끊김)에만 쓴다.
 *
 * gopls 는 패키지를 다 읽기 전의 요청에 빈 답을 줄 수 있다 — 검사는 그 파일의 첫
 * `textDocument/publishDiagnostics` 를 기다린 뒤 시작한다 (`ready`).
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { APIRequestContext, Page, WebSocketRoute } from '@playwright/test';

import { test, expect, rmTree, switchToEditorRoot, openExplorerSide, openGit } from './fixtures';
import { ED_SEL } from './editor';
import { TMP, realPath, cssPath } from './osenv';

/**
 * **고정 대기의 예외 (`TEST-16`).** 이 파일의 `waitForTimeout` 은 전부 **일어나지
 * 않는 것**을 잰다 — 요청이 나가지 않는다 · 옛 키가 듣지 않는다 · 말풍선이 뜨지 않는다 ·
 * 제안이 뜨지 않는다. 기다릴 신호가 없으므로 시간을 주고 그래도 그대로인지 보는 것이 검사 자체다.
 */

const j = (...p: string[]) => path.join(...p);

/**
 * ROOT 아래의 자리. **템플릿에 `/` 를 박지 않는다** — Windows 에서는 구분자가
 * 섞인 문자열(`C:\…\root/aa`)이 되고, 그것은 서버가 주는 값과도 화면의
 * `data-path` 와도 다르다 (CI_E2E_MATRIX_SRS FR-CEM-11).
 */
const P = (rel: string) => j(ROOT, ...rel.split('/'));
let BASE = '';
let ROOT = '';

const MAIN_GO = 'package main\n\nimport "example.com/lspnav/pkg/deep"\n\nfunc main() {\n\tdeep.Helper()\n}\n';
const BAD_GO = 'package bad\n\nfunc f() {\n\tnope()\n}\n';

test.beforeAll(async ({ request }) => {
  BASE = realPath(fs.mkdtempSync(j(TMP, 'dm-lspnav-')));
  ROOT = j(BASE, 'root');
  // 정의가 **다른 파일, 그리고 깊은 겹**에 있다 — 조상 펼치기까지 걸린다.
  fs.mkdirSync(j(ROOT, 'pkg', 'deep'), { recursive: true });
  fs.mkdirSync(j(ROOT, 'bad'), { recursive: true });
  fs.writeFileSync(j(ROOT, 'go.mod'), 'module example.com/lspnav\n\ngo 1.21\n');
  fs.writeFileSync(j(ROOT, 'main.go'), MAIN_GO);
  fs.writeFileSync(j(ROOT, 'pkg', 'deep', 'helper.go'),
    'package deep\n\n// Helper 는 여기 있다.\nfunc Helper() int {\n\treturn 1\n}\n');
  fs.writeFileSync(j(ROOT, 'bad', 'bad.go'), BAD_GO);
  fs.writeFileSync(j(ROOT, 'notes.txt'), 'plain text\n');
  ROOT = realPath(ROOT);

  // §4.3: gopls 가 없으면 건너뛰지 않고 실패한다. CI 는 e2e.yml 이 판을 고정해 설치한다.
  const r = await request.post('/api/lsp/status', { data: {} });
  expect(r.ok(), `상태 조회 실패: ${r.status()}`).toBeTruthy();
  const gopls = ((await r.json()).servers || []).find((s: any) => s.id === 'gopls');
  expect(gopls && gopls.found, `gopls 가 없다 — go install golang.org/x/tools/gopls@v0.20.0: ${JSON.stringify(gopls)}`).toBe(true);
});
test.afterAll(() => {
  rmTree(BASE);
});

type Frame = { dir: 'up' | 'down'; method?: string; uri?: string };
type Tap = { frames: Frame[]; sockets: { page: WebSocketRoute; server: WebSocketRoute }[] };

const LSP_WS = /\/api\/lsp\/ws/;

/** 통로를 실제 서버에 잇고 두 방향 프레임의 method 를 남긴다. */
async function lspTap(page: Page): Promise<Tap> {
  const tap: Tap = { frames: [], sockets: [] };
  const rec = (dir: Frame['dir'], m: string | Buffer) => {
    const o = JSON.parse(String(m));
    const p = o.params || {};
    tap.frames.push({ dir, method: o.method, uri: p.uri || (p.textDocument && p.textDocument.uri) });
  };
  await page.routeWebSocket(LSP_WS, (ws) => {
    const server = ws.connectToServer();
    tap.sockets.push({ page: ws, server });
    ws.onMessage((m) => { rec('up', m); server.send(m) });
    server.onMessage((m) => { rec('down', m); ws.send(m) });
  });
  return tap;
}

const uriIs = (uri: string | undefined, rel: string) =>
  !!uri && decodeURIComponent(uri).replace(/\\/g, '/').endsWith('/' + rel);

/** gopls 가 그 파일을 다 읽었다 — 첫 진단 알림이 왔다. `from` 뒤의 프레임만 본다. */
async function ready(tap: Tap, rel: string, from = 0) {
  await expect.poll(() => tap.frames.slice(from).some((f) =>
    f.dir === 'down' && f.method === 'textDocument/publishDiagnostics' && uriIs(f.uri, rel)),
  { timeout: 60000, message: `${rel} 의 진단 알림이 오지 않았다` }).toBe(true);
}

const sent = (tap: Tap, method: string) => tap.frames.filter((f) => f.dir === 'up' && f.method === method).length;

async function enter(page: Page, request: APIRequestContext, root = ROOT) {
  const r = await request.post('/api/editors/add', { data: { path: root } });
  expect(r.ok(), `editors/add 실패: ${await r.text()}`).toBeTruthy();
  await page.context().addInitScript(() => { sessionStorage.setItem('displayMode', 'desktop') });
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
  await page.waitForFunction(
    () => !!(window as any).app?.testing.editors && (window as any).app.testing.edWindows().length > 0,
    undefined, { timeout: 15000 });
  await switchToEditorRoot(page, root);
  await openExplorerSide(page);
  await expect(page.locator('.ed-tree .ed-row').first()).toBeVisible({ timeout: 10000 });
}

async function openFile(page: Page, rel: string) {
  await page.evaluate((p) => (window as any).app.testing.edOpenFile(p), P(rel));
  await waitEditorAt(page, P(rel));
}

/** 경로만 보지 않고 그 파일의 편집기가 **실제로 설** 때까지 기다린다. 절대경로를 구분자만 맞춰 견준다. */
async function waitEditorAt(page: Page, abs: string) {
  await page.waitForFunction((p) => {
    const v = (window as any).app.testing.edActiveEditor();
    if (!v || !edT.has(v) || v.el.offsetParent === null) return false;
    const key = (x: any) => String(x == null ? '' : x).replace(/\\/g, '/');
    return key(v.filePath) === key(p);
  }, abs, { timeout: 20000 });
}

/**
 * 상태를 stub 한다 (FR-LSP-44 의 표는 **서버가 준다**). 설치 제안 검사만 쓴다 — 제안은
 * 서버가 **없는** 상태를 재야 하고, 그 상태를 러너마다 세울 수는 없다.
 */
const stubStatus = (page: Page, servers: any[]) => page.route('**/api/lsp/status',
  (r: any) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ servers }),
  }));

const GOPLS_MISSING = {
  id: 'gopls', langs: ['go'], exts: ['.go'],
  found: false, installer: 'go', canInstall: true,
};

// 커서를 그 자리에 둔다 — 요청이 싣는 좌표가 이것이다.
async function putCursor(page: Page, line: number, col: number) {
  await page.evaluate(([l, c]) => {
    const ed = edT.of((window as any).app.testing.edActiveEditor());
    edT.setCursor(ed, l, c);
    edT.focus(ed);
  }, [line, col] as const);
}

const activePath = (page: Page) => page.evaluate(
  () => String((window as any).app.testing.edActiveEditor()?.filePath || ''));
const cursor = (page: Page) => page.evaluate(() => edT.cursor(edT.of((window as any).app.testing.edActiveEditor())));
const note = (page: Page) => page.locator('.file-editor:visible .fe-note.vis');
const diags = (page: Page) => page.evaluate(() => {
  const h = edT.of((window as any).app.testing.edActiveEditor());
  return h ? edT.diagnostics(h) : [];
});
const docOf = (page: Page, abs: string) => page.evaluate((p) => {
  const key = (x: any) => String(x == null ? '' : x).replace(/\\/g, '/');
  for (const [k, d] of (window as any).app.testing.edDocs) if (key(k) === key(p)) return true;
  return false;
}, abs);
// 그 파일을 보는 칸의 진단 — 활성 칸이 아니어도 읽는다.
const docDiags = (page: Page, abs: string) => page.evaluate((p) => {
  const key = (x: any) => String(x == null ? '' : x).replace(/\\/g, '/');
  for (const [k, d] of (window as any).app.testing.edDocs) if (key(k) === key(p)) return edT.docDiagnostics(d);
  return null;
}, abs);
// 그 파일 문서 전체를 되돌릴 수 있는 편집으로 바꾼다 — 칸을 거치므로 `didChange` 가 나간다.
const editDoc = (page: Page, abs: string, text: string) => page.evaluate(([p, s]) => {
  const key = (x: any) => String(x == null ? '' : x).replace(/\\/g, '/');
  for (const [k, d] of (window as any).app.testing.edDocs) if (key(k) === key(p)) edT.docEdit(d, s);
}, [abs, text] as const);

/** 메인 → 정의(helper.go 4행 6열). `deep.Helper` 의 `H` 는 6행 7열이다. */
async function atHelperCall(page: Page, request: APIRequestContext) {
  const tap = await lspTap(page);
  await enter(page, request);
  await openFile(page, 'main.go');
  await ready(tap, 'main.go');
  await putCursor(page, 6, 8);
  return tap;
}

test.describe('코드 탐색 — 정의 (FR-CMR-93)', () => {
  // V-LSP-13 · FR-LSP-26 / FR-EKB-6
  test('정의가 다른 파일이면 탭으로 열리고 그 줄로 가며 탐색기에서 보인다', async ({ page, request }) => {
    const tap = await atHelperCall(page, request);
    // 깊은 겹은 아직 접혀 있다 — 이것이 출발점이다.
    await expect(page.locator(`.ed-tree .ed-row[data-path="${cssPath(P('pkg/deep/helper.go'))}"]`)).toHaveCount(0);

    await page.keyboard.press('F12');
    await waitEditorAt(page, P('pkg/deep/helper.go'));
    await expect.poll(() => cursor(page), { timeout: 10000 }).toEqual({ line: 4, col: 6 });
    expect(sent(tap, 'textDocument/definition'), '정의 요청이 통로로 가지 않았다').toBeGreaterThan(0);
    for (const p of [P('pkg'), P('pkg/deep'), P('pkg/deep/helper.go')]) {
      await expect(page.locator(`.ed-tree .ed-row[data-path="${cssPath(p)}"]`)).toBeVisible({ timeout: 10000 });
    }
  });

  // V-LSP-60b (FR-LSP-60) — **제스처 그대로.** 수정 키는 앱이 읽는 플랫폼을 따른다.
  test('그 자리를 Mod+클릭하면 정의로 옮긴다', async ({ page, request }) => {
    await atHelperCall(page, request);
    const at = await page.evaluate(() => {
      const p = edT.coords(edT.of((window as any).app.testing.edActiveEditor()), 6, 9);
      return { x: p.left + 2, y: p.top + p.height / 2 };
    });
    const mac = await page.evaluate(() => (0, eval)('IS_MAC'));
    const mod = mac ? 'Meta' : 'Control';
    await page.keyboard.down(mod);
    await page.mouse.click(at.x, at.y);
    await page.keyboard.up(mod);

    await waitEditorAt(page, P('pkg/deep/helper.go'));
    await expect.poll(() => cursor(page), { timeout: 10000 }).toEqual({ line: 4, col: 6 });
  });

  // V-LSP-21 · FR-LSP-40: 설정에서 바꾼 키로 동작한다 — 조합이 코드에 박혀 있지 않다.
  test('설정에서 바꾼 키로 정의 이동이 된다', async ({ page, request }) => {
    const tap = await atHelperCall(page, request);
    await page.evaluate(() => { (window as any).shortcuts.edGotoDef = 'Ctrl+Shift+KeyY' });

    // 옛 기본값은 더 이상 듣지 않는다.
    await page.keyboard.press('F12');
    await page.waitForTimeout(500);
    expect(await activePath(page)).toBe(P('main.go'));
    expect(sent(tap, 'textDocument/definition')).toBe(0);

    await page.keyboard.press('Control+Shift+KeyY');
    await waitEditorAt(page, P('pkg/deep/helper.go'));
  });

  // V-LSP-63 (FR-LSP-65): LSP 가 없는 파일에서는 언어 서버에 묻지 않는다.
  test('LSP 가 없는 파일에서는 정의 요청이 나가지 않는다', async ({ page, request }) => {
    const tap = await lspTap(page);
    await enter(page, request);
    await openFile(page, 'notes.txt');
    await putCursor(page, 1, 2);
    await page.keyboard.press('F12');
    await page.waitForTimeout(500);
    expect(sent(tap, 'textDocument/definition')).toBe(0);
    expect(await activePath(page)).toBe(P('notes.txt'));
  });

  // V-LSP-19 · FR-LSP-40b — 편집기가 없는 탭이면 이 키는 우리 것이 아니다.
  test('편집기가 없는 탭에서는 F12 를 삼키지 않는다', async ({ page, request }) => {
    const tap = await atHelperCall(page, request);
    await page.evaluate(() => {
      const a = (window as any).app;
      const term = a.ws.windows.find((w: any) => !a.testing.isEditorWin(w));
      if (!term) throw new Error('터미널 창이 없다');
      a.switchWindow(term.id);
    });
    await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 10000 });
    await page.keyboard.press('F12');
    await page.waitForTimeout(500);
    expect(sent(tap, 'textDocument/definition'), 'Editor 창이 아닌데 언어 서버에 물었다').toBe(0);
  });
});

test.describe('코드 탐색 — 참조 (FR-CMR-93)', () => {
  // FR-CMR-93 · §3.16: 라이브러리 참조 패널. 열린 파일의 참조가 보인다.
  test('참조는 패널에 뜨고 다른 파일의 항목을 고르면 그 줄로 열린다', async ({ page, request }) => {
    const tap = await lspTap(page);
    await enter(page, request);
    await openFile(page, 'main.go');
    await ready(tap, 'main.go');
    await openFile(page, 'pkg/deep/helper.go');
    await ready(tap, 'pkg/deep/helper.go');
    await putCursor(page, 4, 7);

    await page.keyboard.press('Shift+F12');
    const panel = page.locator(`.file-editor:visible ${ED_SEL.refPanel}`);
    await expect(panel).toBeVisible({ timeout: 15000 });
    const items = panel.locator(ED_SEL.refItem);
    await expect(items).toHaveCount(2);
    expect(sent(tap, 'textDocument/references')).toBeGreaterThan(0);

    await items.filter({ hasText: 'deep.Helper()' }).click();
    await waitEditorAt(page, P('main.go'));
    await expect.poll(() => cursor(page), { timeout: 10000 }).toEqual({ line: 6, col: 7 });
  });
});

test.describe('코드 탐색 — 호버 (FR-CMR-92·94)', () => {
  // V-LSP-16 · FR-LSP-29
  test('심볼에 호버하면 타입이 보인다', async ({ page, request }) => {
    await atHelperCall(page, request);
    await page.evaluate(() => edT.showHover(edT.of((window as any).app.testing.edActiveEditor())));
    await expect(page.locator(`${ED_SEL.surface} ${ED_SEL.hover}`).first())
      .toContainText(/func (deep\.)?Helper\(\) int/, { timeout: 15000 });
  });

  // FR-LSP-31: 호버가 비면 말풍선이 뜨지 않고 알림도 없다.
  test('빈 자리에 호버하면 아무것도 뜨지 않는다', async ({ page, request }) => {
    const tap = await atHelperCall(page, request);
    await putCursor(page, 2, 1);
    const before = sent(tap, 'textDocument/hover');
    await page.evaluate(() => edT.showHover(edT.of((window as any).app.testing.edActiveEditor())));
    await expect.poll(() => sent(tap, 'textDocument/hover'), { timeout: 10000 }).toBeGreaterThan(before);
    await page.waitForTimeout(800);
    await expect(page.locator(`${ED_SEL.surface} ${ED_SEL.hover}`)).toHaveCount(0);
    await expect(note(page)).toHaveCount(0);
  });
});

test.describe('코드 탐색 — 진단 (FR-CMR-92)', () => {
  async function atBad(page: Page, request: APIRequestContext) {
    const tap = await lspTap(page);
    await enter(page, request);
    await openFile(page, 'bad/bad.go');
    await ready(tap, 'bad/bad.go');
    return tap;
  }

  // V-LSP-17 · FR-LSP-32·33·34
  test('진단이 밑줄로 서고, 갱신이 앞 진단을 덮고, 고치면 걷힌다', async ({ page, request }) => {
    await atBad(page, request);
    await expect.poll(() => diags(page), { timeout: 30000 }).toHaveLength(1);
    const [d] = await diags(page);
    expect(d.line).toBe(4);
    expect(d.sev).toBe('error');
    expect(d.msg).toContain('nope');
    await expect(page.locator(`.file-editor:visible ${ED_SEL.lintError}`).first()).toBeVisible();

    await editDoc(page, P('bad/bad.go'), BAD_GO.replace('nope()', 'other()'));
    await expect.poll(async () => (await diags(page)).map((x: any) => x.msg).join('|'), { timeout: 30000 })
      .toMatch(/^[^|]*other[^|]*$/);

    await editDoc(page, P('bad/bad.go'), 'package bad\n\nfunc other() {}\n\nfunc f() {\n\tother()\n}\n');
    await expect.poll(() => diags(page), { timeout: 30000 }).toHaveLength(0);
  });

  test('다른 파일의 진단은 이 파일에 얹히지 않는다', async ({ page, request }) => {
    const tap = await atBad(page, request);
    await openFile(page, 'main.go');
    await ready(tap, 'main.go');
    expect(await docOf(page, P('bad/bad.go'))).toBe(true);
    await page.waitForTimeout(400);
    expect(await diags(page)).toHaveLength(0);
  });

  // FR-LSP-36 · FR-CMR-92: 끄면 걷히고, 켜면 보관한 진단이 다시 선다.
  test('설정에서 끄면 밑줄이 걷히고 다시 켜면 다시 선다', async ({ page, request }) => {
    await atBad(page, request);
    await expect.poll(() => diags(page), { timeout: 30000 }).toHaveLength(1);

    const toggle = async (on: boolean) => {
      await page.click('#settings-btn');
      await page.click('button.mtab[data-tab="code"]');
      await expect(page.locator('#panel-code')).toBeVisible();
      if (on) await page.check('#lsp-diag');
      else await page.uncheck('#lsp-diag');
      await page.click('#modal-close');
    };
    await toggle(false);
    await expect.poll(() => diags(page), { timeout: 10000 }).toHaveLength(0);
    await toggle(true);
    await expect.poll(() => diags(page), { timeout: 10000 }).toHaveLength(1);
  });
});

test.describe('코드 탐색 — 열리지 않은 파일의 변경 (FR-CMR-110~112)', () => {
  // 열지 않은 파일을 저장 API 로 만든다 → 통로가 Created 를 끼워 넣고, gopls 가 다시 검사한다.
  // 끼워 넣지 않으면 gopls 는 디스크의 새 파일을 모른 채 낡은 진단을 둔다 (§3.16).
  test('열지 않은 파일을 저장하면 열린 파일의 진단이 그것을 반영한다', async ({ page, request }) => {
    const tap = await lspTap(page);
    await enter(page, request);
    await openFile(page, 'bad/bad.go');
    await ready(tap, 'bad/bad.go');
    // 오류만 센다 — 고친 뒤 gopls 는 `f` 가 쓰이지 않는다는 정보 진단을 낼 수 있다.
    const errors = async () => (await diags(page)).filter((d: any) => d.sev === 'error').length;
    await expect.poll(errors, { timeout: 30000 }).toBe(1);
    const late = P('bad/nope.go');
    try {
      const r = await request.post('/api/file/write', { data: { path: late, content: 'package bad\n\nfunc nope() {}\n' } });
      expect(r.ok(), await r.text()).toBeTruthy();
      await expect.poll(errors, { timeout: 30000 }).toBe(0);
    } finally {
      fs.rmSync(late, { force: true });
    }
  });

  // 브랜치를 바꾸면(터미널의 git) 그 사이에 생기고 사라진 파일이 알려진다 — 열린 파일의 진단이 따라 바뀐다.
  test('브랜치를 바꾸면 열린 파일의 진단이 그 브랜치를 따른다', async ({ page, request }) => {
    const repo = j(BASE, 'gitrepo');
    const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd: repo });
    fs.mkdirSync(j(repo, 'other'), { recursive: true });
    fs.writeFileSync(j(repo, 'go.mod'), 'module example.com/gitrepo\n\ngo 1.21\n');
    fs.writeFileSync(j(repo, 'main.go'), 'package main\n\nfunc main() {\n\tfeat()\n}\n');
    git('init', '-q', '-b', 'main');
    git('add', '.');
    git('commit', '-qm', 'main');
    git('checkout', '-qb', 'feat');
    fs.writeFileSync(j(repo, 'feat.go'), 'package main\n\nfunc feat() {}\n');
    git('add', '.');
    git('commit', '-qm', 'feat');
    git('checkout', '-q', 'main');
    const root = realPath(repo);
    const main = j(root, 'main.go');

    const tap = await lspTap(page);
    await enter(page, request, root);
    await page.evaluate((p) => (window as any).app.testing.edOpenFile(p), main);
    await waitEditorAt(page, main);
    await ready(tap, 'main.go');
    await expect.poll(async () => (await docDiags(page, main))?.length, { timeout: 30000 }).toBe(1);
    // git 감시는 git 상태를 본 저장소만 돈다 — Git 창을 연다.
    await openGit(page, root);

    git('checkout', '-q', 'feat');
    await expect.poll(async () => (await docDiags(page, main))?.length, { timeout: 60000 }).toBe(0);
    git('checkout', '-q', 'main');
    await expect.poll(async () => (await docDiags(page, main))?.length, { timeout: 60000 }).toBe(1);
  });
});

test.describe('코드 탐색 — 통로 실패 (FR-CMR-91·102)', () => {
  // 가짜 소켓 — 서버에 잇지 않고 상한 거절로 닫는다.
  test('상한에 걸리면 알림 줄과 상태 패널에 그 사실이 보인다', async ({ page, request }) => {
    let opened = 0;
    await page.routeWebSocket(LSP_WS, (ws) => {
      opened++;
      ws.close({ code: 4001, reason: 'limit' });
    });
    await enter(page, request);
    await openFile(page, 'main.go');
    await expect.poll(() => opened, { timeout: 15000 }).toBeGreaterThan(0);
    await putCursor(page, 6, 8);
    await page.keyboard.press('F12');
    await expect(note(page)).toBeVisible({ timeout: 10000 });
    await expect(note(page)).toContainText('상한');
    expect(await activePath(page)).toBe(P('main.go'));

    await page.click('#settings-btn');
    await page.click('button.mtab[data-tab="code"]');
    await expect(page.locator('#lsp-list .lsp-msg', { hasText: '상한' })).toBeVisible({ timeout: 10000 });
  });

  // 실제 서버에 이은 첫 소켓을 서버가 끝낸 것처럼 닫는다 → 다음 F12 가 새 소켓으로 다시 연다.
  test('끊긴 뒤 다음 정의 요청이 다시 연결하고 정의로 간다', async ({ page, request }) => {
    const tap = await atHelperCall(page, request);
    expect(tap.sockets).toHaveLength(1);
    const first = tap.sockets[0];
    first.server.close();
    first.page.close({ code: 4003, reason: 'ended' });
    await page.waitForTimeout(300);

    await page.keyboard.press('F12');
    await expect.poll(() => tap.sockets.length, { timeout: 15000 }).toBe(2);
    await waitEditorAt(page, P('pkg/deep/helper.go'));
    await expect.poll(() => cursor(page), { timeout: 10000 }).toEqual({ line: 4, col: 6 });
  });
});

test.describe('코드 탐색 — 설치 제안 (M5)', () => {
  const offer = (page: Page) => page.locator('.file-editor:visible .fe-offer');

  // V-LSP-20 · FR-LSP-44: 서버가 없는 파일을 열면 제안한다 — 무엇을 설치하면
  // 무엇이 되는지와 함께.
  test('서버가 없는 파일을 열면 제안이 뜬다', async ({ page, request }) => {
    await enter(page, request);
    await stubStatus(page, [GOPLS_MISSING]);
    await openFile(page, 'main.go');

    await expect(offer(page)).toBeVisible({ timeout: 10000 });
    await expect(offer(page)).toContainText('gopls');
    await expect(offer(page).locator('.fe-offer-go')).toBeVisible();
  });

  // FR-LSP-44: 서버가 **있으면** 제안하지 않는다 — 있는데 뜨면 그것이 곧 방해다.
  test('서버가 있으면 제안이 뜨지 않는다', async ({ page, request }) => {
    await enter(page, request);
    await stubStatus(page, [{ ...GOPLS_MISSING, found: true, exe: '/usr/bin/gopls', origin: 'path' }]);
    await openFile(page, 'main.go');
    await page.waitForTimeout(700);
    await expect(offer(page)).toHaveCount(0);
  });

  // FR-LSP-44: 그 언어의 파일이 아니면 제안하지 않는다.
  test('지원 언어가 아닌 파일에는 제안이 뜨지 않는다', async ({ page, request }) => {
    await enter(page, request);
    await stubStatus(page, [GOPLS_MISSING]);
    await openFile(page, 'notes.txt');
    await page.waitForTimeout(700);
    await expect(offer(page)).toHaveCount(0);
  });

  // V-LSP-20 · FR-LSP-45: `다시 보지 않기` 는 **그 언어**에 대한 것이다. 파일마다
  // 뜨면 그것이 곧 고장이다.
  test('다시 보지 않기를 누르면 다른 파일에서도 뜨지 않는다', async ({ page, request }) => {
    await enter(page, request);
    await stubStatus(page, [GOPLS_MISSING]);
    await openFile(page, 'main.go');
    await expect(offer(page)).toBeVisible({ timeout: 10000 });
    await offer(page).locator('.fe-offer-no').click();
    await expect(offer(page)).toHaveCount(0);

    // 같은 언어의 다른 파일 — 다시 뜨지 않는다.
    await openFile(page, 'pkg/deep/helper.go');
    await page.waitForTimeout(700);
    await expect(offer(page)).toHaveCount(0);
  });

  // FR-LSP-11: 받을 수 없으면 **무엇이 없어서** 그런지가 이름으로 보이고, 받기
  // 대신 설정으로 가는 길이 보인다.
  test('받을 수 없으면 그 이유가 이름으로 보인다', async ({ page, request }) => {
    await enter(page, request);
    await stubStatus(page, [{ ...GOPLS_MISSING, canInstall: false }]);
    await openFile(page, 'main.go');

    await expect(offer(page)).toBeVisible({ timeout: 10000 });
    await expect(offer(page)).toContainText('go');
    await expect(offer(page).locator('.fe-offer-go')).toHaveCount(0);
    await expect(offer(page).locator('.fe-offer-set')).toBeVisible();
  });
});
