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

test.describe('편집기 탭 → 새 도구의 cwd 상속', () => {
  test('FR-1: 편집기 탭이 활성인 분할 칸의 addTab 이 그 파일의 디렉터리를 상속', async ({ page, request }) => {
    await gotoFresh(page, request);
    const { filePath, expectedCwd } = makeFileInDir();

    // 편집기 탭을 열어 포커스된 분할 칸의 활성 탭으로 만든다.
    await page.evaluate((fp) => {
      const a = (window as any).app;
      a.addTab(a.focused, 'editor', { name: fp.split('/').pop(), filePath: fp });
    }, filePath);
    await page.waitForTimeout(150);

    // + new terminal tab in same pane.
    const newPaneId = await page.evaluate(async () => {
      const a = (window as any).app;
      const rid = a.focused;
      const before = new Set([...a.tools.keys()]);
      await a.addTab(rid, 'terminal');
      const after = [...a.tools.keys()].find((k) => !before.has(k));
      return after as string;
    });
    expect(newPaneId).toBeTruthy();
    expect(await paneCwd(request, newPaneId)).toBe(expectedCwd);
  });

  test('FR-2: 같은 상태에서의 split 도 그 파일의 디렉터리를 상속', async ({ page, request }) => {
    await gotoFresh(page, request);
    const { filePath, expectedCwd } = makeFileInDir();

    await page.evaluate((fp) => {
      const a = (window as any).app;
      a.addTab(a.focused, 'editor', { name: fp.split('/').pop(), filePath: fp });
    }, filePath);
    await page.waitForTimeout(150);

    const newPaneId = await page.evaluate(async () => {
      const a = (window as any).app;
      const before = new Set([...a.tools.keys()]);
      await a.split('h');
      const after = [...a.tools.keys()].find((k) => !before.has(k));
      return after as string;
    });
    expect(newPaneId).toBeTruthy();
    expect(await paneCwd(request, newPaneId)).toBe(expectedCwd);
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
