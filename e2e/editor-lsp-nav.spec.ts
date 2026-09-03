/**
 * EDITOR_LSP_SRS M2 (묶음 C·F) — V-LSP-13·14·15·19·21.
 *
 * **서버 응답을 stub 한다.** 세션·프로토콜은 Go 검사가 이미 재고(TC-LSP-50~80),
 * 여기서 재려는 것은 그 답을 받아 **우리 탭 시스템으로 옮기는 경로**다 — Monaco 의
 * peek 이 그 일을 못 하기 때문에 우리가 맡은 바로 그 부분이다 (그 SRS §2.11 / D-8b).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { APIRequestContext, Page } from '@playwright/test';

import { test, expect } from './fixtures';

const j = (...p: string[]) => path.join(...p);
let BASE = '';
let ROOT = '';

test.beforeAll(() => {
  BASE = fs.realpathSync(fs.mkdtempSync(j(os.tmpdir(), 'dm-lspnav-')));
  ROOT = j(BASE, 'root');
  // 정의가 **다른 파일, 그리고 깊은 겹**에 있다 — 조상 펼치기까지 걸린다.
  fs.mkdirSync(j(ROOT, 'pkg', 'deep'), { recursive: true });
  fs.writeFileSync(j(ROOT, 'main.go'), 'package main\n\nfunc main() {\n\thelper()\n}\n');
  fs.writeFileSync(j(ROOT, 'pkg', 'deep', 'helper.go'),
    'package deep\n\n// helper 는 여기 있다.\nfunc helper() {\n}\n');
  fs.writeFileSync(j(ROOT, 'notes.txt'), 'plain text\n');
  ROOT = fs.realpathSync(ROOT);
});
test.afterAll(() => {
  if (BASE) fs.rmSync(BASE, { recursive: true, force: true });
});

async function enter(page: Page, request: APIRequestContext) {
  const r = await request.post('/api/editors/add', { data: { path: ROOT } });
  expect(r.ok(), `editors/add 실패: ${await r.text()}`).toBeTruthy();
  await page.context().addInitScript(() => { sessionStorage.setItem('displayMode', 'desktop') });
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
  await page.waitForFunction(
    () => !!(window as any).app?._editors && (window as any).app._edWindows().length > 0,
    undefined, { timeout: 15000 });
  await page.evaluate((root) => {
    const a = (window as any).app;
    const win = a._edWindows().find((x: any) => x.editor && x.editor.root === root);
    if (!win) throw new Error('Editor 창이 없다: ' + root);
    a.switchWindow(win.id);
  }, ROOT);
  await expect(page.locator('.ed-tree .ed-row').first()).toBeVisible({ timeout: 10000 });
}

async function openFile(page: Page, rel: string) {
  await page.evaluate((p) => (window as any).app._edOpenFile(p), `${ROOT}/${rel}`);
  await page.waitForFunction((p) => {
    const v = (window as any).app._edActiveEditor();
    return !!(v && v._editor && String(v.filePath).endsWith(p) && v.el.offsetParent !== null);
  }, rel, { timeout: 20000 });
}

// 커서를 그 자리에 둔다 — 요청이 싣는 좌표가 이것이다.
async function putCursor(page: Page, line: number, col: number) {
  await page.evaluate(([l, c]) => {
    const ed = (window as any).app._edActiveEditor()._editor;
    ed.setPosition({ lineNumber: l, column: c });
    ed.focus();
  }, [line, col] as const);
}

type Loc = { path: string; line: number; col: number };

// 정의·참조 응답을 대신한다. `seen` 에 요청 본문이 쌓인다.
async function stubLSP(page: Page, kind: 'definition' | 'references',
  body: { locations?: Loc[]; reason?: string }, seen?: any[]) {
  await page.route(`**/api/lsp/${kind}`, async (route: any) => {
    if (seen) seen.push(JSON.parse(route.request().postData() || '{}'));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ locations: body.locations || [], ...(body.reason ? { reason: body.reason } : {}) }),
    });
  });
}

const activePath = (page: Page) => page.evaluate(
  () => String((window as any).app._edActiveEditor()?.filePath || ''));

// 그 파일의 편집기가 **실제로 설** 때까지 기다린다.
//
// 활성 탭이 바뀌는 것과 Monaco 가 서는 것은 다른 시점이다 — 새로 여는 파일은
// Monaco 생성이 비동기이므로, 경로만 보고 커서를 읽으면 `_editor` 가 아직 null 이다.
async function waitEditorAt(page: Page, abs: string) {
  await page.waitForFunction((p) => {
    const v = (window as any).app._edActiveEditor();
    return !!(v && v._editor && String(v.filePath) === p);
  }, abs, { timeout: 20000 });
}
const cursor = (page: Page) => page.evaluate(() => {
  const p = (window as any).app._edActiveEditor()._editor.getPosition();
  return { line: p.lineNumber, col: p.column };
});
const note = (page: Page) => page.locator('.file-editor:visible .fe-note.vis');

test.describe('코드 탐색 — 정의·참조 이동 (M2)', () => {
  // V-LSP-13 · FR-LSP-23·26 / D-3
  test('정의가 다른 파일이면 탭으로 열리고 그 줄로 가며 탐색기에서 보인다', async ({ page, request }) => {
    await enter(page, request);
    await openFile(page, 'main.go');
    await putCursor(page, 4, 3);

    const seen: any[] = [];
    await stubLSP(page, 'definition',
      { locations: [{ path: `${ROOT}/pkg/deep/helper.go`, line: 4, col: 6 }] }, seen);

    // 깊은 겹은 아직 접혀 있다 — 이것이 출발점이다.
    await expect(page.locator(`.ed-tree .ed-row[data-path="${ROOT}/pkg/deep/helper.go"]`)).toHaveCount(0);

    await page.keyboard.press('F12');
    await waitEditorAt(page, `${ROOT}/pkg/deep/helper.go`);
    expect(await cursor(page)).toEqual({ line: 4, col: 6 });

    // FR-LSP-23 / D-3: **현재 텍스트와 좌표가 실려 갔다.** 텍스트가 없으면 디스크만
    // 보는 서버가 방금 쓴 함수를 모른다.
    expect(seen.length, '정의 요청이 가지 않았다').toBeGreaterThan(0);
    expect(seen[0].root).toBe(ROOT);
    expect(seen[0].path).toBe(`${ROOT}/main.go`);
    expect(seen[0].text).toContain('func main()');
    expect(seen[0].line).toBe(4);
    expect(seen[0].col).toBe(3);

    // FR-EKB-6 을 딛는다 — 조상이 모두 펼쳐지고 그 행이 선택으로 표시된다.
    for (const p of [`${ROOT}/pkg`, `${ROOT}/pkg/deep`, `${ROOT}/pkg/deep/helper.go`]) {
      await expect(page.locator(`.ed-tree .ed-row[data-path="${p}"]`)).toBeVisible({ timeout: 10000 });
    }
  });

  // V-LSP-14 · FR-LSP-27 — 돌아올 수 없으면 그 이동은 길을 잃는 일이 된다.
  test('뒤로 가기가 뛴 자리로 돌아온다', async ({ page, request }) => {
    await enter(page, request);
    await openFile(page, 'main.go');
    await putCursor(page, 4, 3);
    await stubLSP(page, 'definition',
      { locations: [{ path: `${ROOT}/pkg/deep/helper.go`, line: 4, col: 6 }] });

    await page.keyboard.press('F12');
    await expect.poll(() => activePath(page), { timeout: 15000 })
      .toBe(`${ROOT}/pkg/deep/helper.go`);

    await page.keyboard.press('Control+Alt+Minus');
    await waitEditorAt(page, `${ROOT}/main.go`);
    expect(await cursor(page)).toEqual({ line: 4, col: 3 });
  });

  // V-LSP-15 · FR-LSP-28 / D-9 — 침묵은 고장과 구별되지 않는다.
  test('서버가 사유를 주면 그 사유가 보인다', async ({ page, request }) => {
    await enter(page, request);
    await openFile(page, 'main.go');
    await putCursor(page, 4, 3);
    await stubLSP(page, 'definition',
      { reason: 'gopls 가 없어 코드 탐색을 할 수 없습니다 — 설정 ▸ Code 에서 받으세요' });

    await page.keyboard.press('F12');
    await expect(note(page)).toBeVisible({ timeout: 10000 });
    await expect(note(page)).toContainText('gopls');
    // 옮기지 않았다 — 사유가 왔으면 그 자리에 머문다.
    expect(await activePath(page)).toBe(`${ROOT}/main.go`);
  });

  // V-LSP-15 · FR-LSP-28: 결과가 비어도 그 사실이 보인다.
  test('정의가 없으면 그 사실이 보인다', async ({ page, request }) => {
    await enter(page, request);
    await openFile(page, 'main.go');
    await putCursor(page, 1, 1);
    await stubLSP(page, 'definition', { locations: [] });

    await page.keyboard.press('F12');
    await expect(note(page)).toBeVisible({ timeout: 10000 });
    await expect(note(page)).toContainText('정의');
  });

  // FR-LSP-22·25: 참조는 **하나여도 목록**이다 — 몇 개인지가 그 기능의 답이다.
  test('참조는 목록으로 뜨고 고르면 그 줄로 열린다', async ({ page, request }) => {
    await enter(page, request);
    await openFile(page, 'main.go');
    await putCursor(page, 4, 3);
    const seen: any[] = [];
    await stubLSP(page, 'references', {
      locations: [
        { path: `${ROOT}/main.go`, line: 4, col: 2 },
        { path: `${ROOT}/pkg/deep/helper.go`, line: 4, col: 6 },
      ],
    }, seen);

    await page.keyboard.press('Shift+F12');
    const panel = page.locator('.ed-find.vis');
    await expect(panel).toBeVisible({ timeout: 10000 });
    await expect(panel.locator('.ed-find-row')).toHaveCount(2);
    await expect(panel.locator('.ed-find-note')).toContainText('2');

    // 둘째를 고른다 — 그 줄로 열린다.
    await panel.locator('.ed-find-row').nth(1).click();
    await waitEditorAt(page, `${ROOT}/pkg/deep/helper.go`);
    expect(await cursor(page)).toEqual({ line: 4, col: 6 });
  });

  // V-LSP-19 · FR-LSP-40b — 편집기가 없거나 지원 언어가 아니면 삼키지 않는다.
  test('편집기가 없는 탭에서는 F12 를 삼키지 않는다', async ({ page, request }) => {
    await enter(page, request);
    // 터미널 창으로 옮긴다 — Editor 창이 아니면 이 키는 우리 것이 아니다.
    await page.evaluate(() => {
      const a = (window as any).app;
      const term = a.ws.windows.find((w: any) => !a._isEditorWin(w));
      if (!term) throw new Error('터미널 창이 없다');
      a.switchWindow(term.id);
    });
    await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 10000 });

    let asked = false;
    await page.route('**/api/lsp/definition', async (route: any) => {
      asked = true;
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"locations":[]}' });
    });
    await page.keyboard.press('F12');
    await page.waitForTimeout(500);
    expect(asked, 'Editor 창이 아닌데 언어 서버에 물었다').toBe(false);
  });

  // V-LSP-21 · FR-LSP-40: 설정에서 바꾼 키로 동작한다 — 조합이 코드에 박혀 있지 않다.
  test('설정에서 바꾼 키로 정의 이동이 된다', async ({ page, request }) => {
    await enter(page, request);
    await openFile(page, 'main.go');
    await putCursor(page, 4, 3);
    await stubLSP(page, 'definition',
      { locations: [{ path: `${ROOT}/pkg/deep/helper.go`, line: 4, col: 6 }] });

    await page.evaluate(() => { (window as any).shortcuts.edGotoDef = 'Ctrl+Shift+KeyY' });

    // 옛 기본값은 더 이상 듣지 않는다.
    await page.keyboard.press('F12');
    await page.waitForTimeout(400);
    expect(await activePath(page)).toBe(`${ROOT}/main.go`);

    await page.keyboard.press('Control+Shift+KeyY');
    await expect.poll(() => activePath(page), { timeout: 15000 })
      .toBe(`${ROOT}/pkg/deep/helper.go`);
  });
});

test.describe('코드 탐색 — 호버 (M3)', () => {
  // V-LSP-16 · FR-LSP-29·38: 호버는 **Monaco 의 provider** 로 뜬다 — 말풍선은
  // 같은 파일 안의 일이므로 탭 시스템을 알 필요가 없다 (D-8).
  test('심볼에 호버하면 타입이 보인다', async ({ page, request }) => {
    await enter(page, request);
    await openFile(page, 'main.go');

    const seen: any[] = [];
    await page.route('**/api/lsp/hover', async (route: any) => {
      seen.push(JSON.parse(route.request().postData() || '{}'));
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ markdown: 'func helper()' }),
      });
    });

    // 마우스를 흉내내지 않고 Monaco 에게 그 자리의 호버를 띄우라고 시킨다 —
    // 재려는 것은 provider 의 속이지 마우스 이동이 아니다.
    await putCursor(page, 4, 3);
    await page.evaluate(() => {
      const ed = (window as any).app._edActiveEditor()._editor;
      ed.trigger('test', 'editor.action.showHover', null);
    });

    await expect(page.locator('.monaco-editor .monaco-hover').first())
      .toContainText('func helper()', { timeout: 10000 });

    // FR-LSP-23 / D-3: 호버도 현재 텍스트를 싣는다 — 정의 이동과 같은 동기화다.
    expect(seen.length, '호버 요청이 가지 않았다').toBeGreaterThan(0);
    expect(seen[0].text).toContain('func main()');
    expect(seen[0].root).toBe(ROOT);
  });

  // FR-LSP-31: 호버가 비면 **말풍선이 뜨지 않는다.** 빈 자리에 마우스를 얹을 때마다
  // 무언가 뜨면 그것이 곧 방해다.
  test('호버가 비면 아무것도 뜨지 않는다', async ({ page, request }) => {
    await enter(page, request);
    await openFile(page, 'main.go');
    await page.route('**/api/lsp/hover', (r: any) => r.fulfill({
      status: 200, contentType: 'application/json', body: '{"markdown":""}',
    }));

    await putCursor(page, 2, 1);
    await page.evaluate(() => {
      const ed = (window as any).app._edActiveEditor()._editor;
      ed.trigger('test', 'editor.action.showHover', null);
    });
    await page.waitForTimeout(800);
    // 알림 줄도 뜨지 않는다 — 마우스를 움직일 때마다 사유가 뜨면 고장이다.
    await expect(note(page)).toHaveCount(0);
  });

  // FR-LSP-39: provider 는 언어마다 한 번이다. 편집기를 둘 세워도 호버 요청이
  // 두 번 나가지 않는다 — 나가면 같은 말풍선이 여러 번 뜬다.
  test('편집기를 여럿 세워도 호버가 한 번만 묻는다', async ({ page, request }) => {
    await enter(page, request);
    await openFile(page, 'main.go');
    await openFile(page, 'pkg/deep/helper.go');
    await openFile(page, 'main.go');

    let calls = 0;
    await page.route('**/api/lsp/hover', async (route: any) => {
      calls++;
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ markdown: 'func helper()' }),
      });
    });

    await putCursor(page, 4, 3);
    await page.evaluate(() => {
      const ed = (window as any).app._edActiveEditor()._editor;
      ed.trigger('test', 'editor.action.showHover', null);
    });
    await expect(page.locator('.monaco-editor .monaco-hover').first())
      .toContainText('func helper()', { timeout: 10000 });
    await page.waitForTimeout(500);
    expect(calls, `호버 요청이 ${calls} 번 나갔다 — provider 가 여러 번 등록됐다`).toBe(1);
  });
});

test.describe('코드 탐색 — 진단 (M4)', () => {
  // 서버가 밀어 준 진단을 흉내낸다. 실제 SSE 를 타지 않는 이유는 이 검사가 재려는
  // 것이 **밑줄을 얹는 경로**이고, SSE 배선은 Go 쪽이 잰다는 것이다.
  const push = (page: Page, path: string, items: any[]) => page.evaluate(
    ([p, its]) => (window as any).app._lspOnDiagnostics({ path: p, items: its }),
    [path, items] as const);

  const markers = (page: Page) => page.evaluate(() => {
    const v = (window as any).app._edActiveEditor();
    const model = v?._editor?.getModel();
    if (!model) return [];
    return (window as any).monaco.editor.getModelMarkers({ resource: model.uri })
      .map((m: any) => ({ line: m.startLineNumber, sev: m.severity, msg: m.message }));
  });

  // V-LSP-17 · FR-LSP-32·33·34
  test('진단이 밑줄로 서고 갱신이 앞 밑줄을 덮는다', async ({ page, request }) => {
    await enter(page, request);
    await openFile(page, 'main.go');

    await push(page, `${ROOT}/main.go`, [
      { line: 4, col: 2, endLine: 4, endCol: 8, severity: 1, message: 'undefined: helper' },
      { line: 3, col: 1, endLine: 3, endCol: 5, severity: 2, message: 'unused' },
    ]);
    await expect.poll(() => markers(page), { timeout: 10000 }).toHaveLength(2);
    const got = await markers(page);
    // LSP 의 1=에러는 Monaco 의 8 이고, 2=경고는 4 다 — 숫자가 겹치므로 표 없이
    // 넘기면 조용히 뒤바뀐다.
    expect(got.find((m: any) => m.line === 4)?.sev).toBe(8);
    expect(got.find((m: any) => m.line === 3)?.sev).toBe(4);

    // 갱신이 앞선 것을 **덮는다** — owner 가 하나이므로 겹쳐 남지 않는다.
    await push(page, `${ROOT}/main.go`, [
      { line: 5, col: 1, endLine: 5, endCol: 2, severity: 1, message: 'only one now' },
    ]);
    await expect.poll(() => markers(page), { timeout: 10000 }).toHaveLength(1);
    expect((await markers(page))[0].msg).toBe('only one now');
  });

  // FR-LSP-33: **빈 진단도 알림이다** — 고친 줄에 밑줄이 남으면 그것이 거짓말이 된다.
  test('빈 진단이 오면 밑줄이 걷힌다', async ({ page, request }) => {
    await enter(page, request);
    await openFile(page, 'main.go');
    await push(page, `${ROOT}/main.go`, [
      { line: 4, col: 2, endLine: 4, endCol: 8, severity: 1, message: 'boom' },
    ]);
    await expect.poll(() => markers(page), { timeout: 10000 }).toHaveLength(1);

    await push(page, `${ROOT}/main.go`, []);
    await expect.poll(() => markers(page), { timeout: 10000 }).toHaveLength(0);
  });

  // FR-LSP-33: 다른 파일의 진단은 이 파일에 얹히지 않는다.
  test('다른 파일의 진단은 이 파일에 얹히지 않는다', async ({ page, request }) => {
    await enter(page, request);
    await openFile(page, 'main.go');
    await push(page, `${ROOT}/pkg/deep/helper.go`, [
      { line: 1, col: 1, endLine: 1, endCol: 2, severity: 1, message: '남의 것' },
    ]);
    await page.waitForTimeout(400);
    expect(await markers(page)).toHaveLength(0);
  });

  // FR-LSP-36: 끄면 **지금 서 있는 밑줄까지** 걷힌다. 껐는데 남아 있으면 설정이
  // 듣지 않는 것으로 보인다.
  test('설정에서 끄면 밑줄이 걷히고 새 진단도 얹히지 않는다', async ({ page, request }) => {
    await enter(page, request);
    await openFile(page, 'main.go');
    await push(page, `${ROOT}/main.go`, [
      { line: 4, col: 2, endLine: 4, endCol: 8, severity: 1, message: 'boom' },
    ]);
    await expect.poll(() => markers(page), { timeout: 10000 }).toHaveLength(1);

    await page.click('#settings-btn');
    await page.click('button.mtab[data-tab="code"]');
    await expect(page.locator('#panel-code')).toBeVisible();
    await expect(page.locator('#lsp-diag')).toBeChecked();
    await page.uncheck('#lsp-diag');
    await page.click('#modal-close');

    await expect.poll(() => markers(page), { timeout: 10000 }).toHaveLength(0);
    // 꺼진 뒤에 온 진단도 얹히지 않는다.
    await push(page, `${ROOT}/main.go`, [
      { line: 4, col: 2, endLine: 4, endCol: 8, severity: 1, message: 'again' },
    ]);
    await page.waitForTimeout(400);
    expect(await markers(page)).toHaveLength(0);
  });
});

test.describe('코드 탐색 — 설치 제안 (M5)', () => {
  // 상태를 stub 한다. 이 기계에 gopls 가 있는지는 환경마다 다르므로, 있다고
  // 단정하거나 없다고 단정하면 어느 한쪽 환경에서 거짓이 된다.
  const stubStatus = (page: Page, servers: any[]) => page.route('**/api/lsp/status',
    (r: any) => r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ servers }),
    }));

  const GOPLS_MISSING = {
    id: 'gopls', langs: ['go'], exts: ['.go'],
    found: false, installer: 'go', canInstall: true,
  };

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
