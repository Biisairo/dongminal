import { test, expect } from './fixtures';
// @ts-ignore
import * as fs from 'fs';
// @ts-ignore
import * as os from 'os';
// @ts-ignore
import * as path from 'path';

// SRS: MD_FOCUS_NEW_PANE_CWD_SRS.md
//   FR-1: 파일 탭이 활성인 분할 칸의 +addTab 은 그 파일의 디렉터리에서 시작
//   FR-2: 같은 상태에서의 split 도 그 파일의 디렉터리에서 시작
//   FR-3: terminal 탭이 활성이면 그 도구의 cwd 를 상속(회귀 보호)
//
// 원래 이 SRS 의 대상은 markdown 뷰어 탭이었다. 뷰어는 8dc0a3f 에서 내장
// 편집기(editor 탭)로 대체됐고 동작 규칙은 그대로 살아 있어(app.js
// _paneNewToolRef), 스펙을 editor 탭으로 이관했다.
//
// EDITOR_TAB_SRS FR-EDT-94 로 편집기 탭은 Editor 창에서만 열린다 — 일반 창의
// pane 에 `addTab(...,'editor')` 하는 옛 셋업은 더 이상 성립하지 않는다
// (`app-layout.js:229-235` 가 조용히 막는다). 그 창 안에서 새 도구를 만드는
// 옛 경로(같은 pane 의 addTab, 같은 창의 split)도 함께 막혔다 — Editor 창은
// `type!=='editor'` 탭을 받지 않고(FR-EDT-54) 분할은 드래그드롭만 허용된다
// (FR-EDT-50·51, D-8). 반면 `_paneNewToolRef` 의 editor 분기(app-layout.js:487-494)는
// 그대로 살아 있고, **Editor 창에서 새 창을 여는 경로**(`_mkWindow`,
// app-layout.js:80)가 그것을 여전히 태운다. FR-1·FR-2 는 그 경로의 두 진입점 —
// 브라우저 내부 직접 호출과 원격 커맨드(`dmctl new-window`) — 으로 같은 규칙을 잰다.

async function resetWorkspace(request) {
  const get = await request.get('/api/workspace');
  const rev = get.headers()['etag'] || '0';
  await request.put('/api/workspace', {
    headers: { 'If-Match': rev, 'Content-Type': 'application/json' },
    data: '{"schemaVersion":2,"windows":[]}',
  });
}

async function gotoFresh(page, request) {
  await resetWorkspace(request);
  await page.context().addInitScript(() => {
    sessionStorage.setItem('displayMode', 'desktop');
    try { localStorage.clear(); } catch {}
  });
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
}

function makeFileInDir(): { filePath: string; expectedCwd: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdcwd-'));
  const fp = path.join(dir, 'doc.md');
  fs.writeFileSync(fp, '# doc\n\nhello\n');
  // macOS resolves /var → /private/var; shell-reported cwd uses the realpath.
  return { filePath: fp, expectedCwd: fs.realpathSync(dir) };
}

async function paneCwd(request, toolId: string): Promise<string> {
  const r = await request.get('/api/cwd?tool=' + toolId);
  const j = await r.json();
  return j.cwd as string;
}

// 편집기 탭을 root 에디터 창(FR-EDT-13)에 열고, 그 창을 활성 창으로, 그
// 탭이 있는 pane 을 포커스로 만든다 — `_edOpenFile` 이 이 셋을 함께 보장한다
// (`app-editor.js` FR-EDT-94·102).
async function openInEditorWindow(page, filePath: string, name: string) {
  await page.evaluate(async ({ fp, nm }) => {
    const a = (window as any).app;
    const winId = await a._edOpenFile(fp, { name: nm });
    if (!winId) throw new Error('editor tab open 실패 — _edOn() 이 꺼져 있나?');
  }, { fp: filePath, nm: name });
}

test.describe('편집기 탭 → 새 도구의 cwd 상속', () => {
  test('FR-1: Editor 창에서 _mkWindow 로 새 창을 열면 편집 중 파일의 디렉터리를 상속', async ({ page, request }) => {
    await gotoFresh(page, request);
    const { filePath, expectedCwd } = makeFileInDir();
    await openInEditorWindow(page, filePath, path.basename(filePath));

    const toolId = await page.evaluate(async () => {
      const a = (window as any).app;
      const c = await a._mkWindow();
      return c?.tab?.toolId as string;
    });
    expect(toolId).toBeTruthy();
    expect(await paneCwd(request, toolId)).toBe(expectedCwd);
  });

  test('FR-2: 원격 newWindow 커맨드(dmctl new-window)도 같은 창에서 그 디렉터리를 상속', async ({ page, request }) => {
    await gotoFresh(page, request);
    const { filePath, expectedCwd } = makeFileInDir();
    await openInEditorWindow(page, filePath, path.basename(filePath));

    const win = await (
      await request.post('/api/commands', { data: { action: 'newWindow', args: {} } })
    ).json();
    expect(win.ok, `newWindow 실패: ${JSON.stringify(win)}`).toBeTruthy();
    const toolId: string = win.newTabs?.[0]?.toolId;
    expect(toolId).toBeTruthy();
    expect(await paneCwd(request, toolId)).toBe(expectedCwd);
  });

  test('FR-3: terminal 탭이 활성이면 여전히 그 도구의 cwd 를 상속 (회귀)', async ({ page, request }) => {
    await gotoFresh(page, request);

    // Initial pane is terminal; capture its cwd.
    const parentCwd = await page.evaluate(async () => {
      const a = (window as any).app;
      const s = a.ws.windows.find((x: any) => x.id === a.ws.activeWindow);
      const walk = (n: any, out: any[]) => { if (!n) return; if (n.type === 'pane') out.push(n); else if (n.children) n.children.forEach((c: any) => walk(c, out)); };
      const regs: any[] = []; walk(s.layout, regs);
      const pid = regs[0].tabs[0].toolId;
      const r = await fetch('/api/cwd?tool=' + pid);
      const j = await r.json();
      return j.cwd as string;
    });
    expect(parentCwd).toBeTruthy();

    const newPaneId = await page.evaluate(async () => {
      const a = (window as any).app;
      const before = new Set([...a.tools.keys()]);
      await a.addTab(a.focused, 'terminal');
      return [...a.tools.keys()].find((k) => !before.has(k)) as string;
    });
    expect(await paneCwd(request, newPaneId)).toBe(parentCwd);
  });
});
