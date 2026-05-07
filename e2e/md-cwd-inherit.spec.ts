import { test, expect } from '@playwright/test';
// @ts-ignore
import * as fs from 'fs';
// @ts-ignore
import * as os from 'os';
// @ts-ignore
import * as path from 'path';

// SRS: MD_FOCUS_NEW_PANE_CWD_SRS.md
//   FR-1: md region 의 +addTab 은 md 파일 디렉터리에서 시작
//   FR-2: md region 의 split 은 md 파일 디렉터리에서 시작
//   FR-3: terminal region 은 부모 pane 의 cwd 를 상속(회귀 보호)

async function resetWorkspace(request) {
  const get = await request.get('/api/workspace');
  const rev = get.headers()['etag'] || '0';
  await request.put('/api/workspace', {
    headers: { 'If-Match': rev, 'Content-Type': 'application/json' },
    data: '{}',
  });
}

async function gotoFresh(page, request) {
  await resetWorkspace(request);
  await page.context().addInitScript(() => {
    sessionStorage.setItem('displayMode', 'desktop');
    try { localStorage.clear(); } catch {}
  });
  await page.goto('/');
  await page.waitForSelector('#area .rg.focused .xterm-helper-textarea', { timeout: 15000 });
}

function makeMdInDir(): { mdPath: string; expectedCwd: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdcwd-'));
  const fp = path.join(dir, 'doc.md');
  fs.writeFileSync(fp, '# doc\n\nhello\n');
  // macOS resolves /var → /private/var; shell-reported cwd uses the realpath.
  return { mdPath: fp, expectedCwd: fs.realpathSync(dir) };
}

async function paneCwd(request, paneId: string): Promise<string> {
  const r = await request.get('/api/cwd?pane=' + paneId);
  const j = await r.json();
  return j.cwd as string;
}

test.describe('MD focus → new pane cwd inheritance', () => {
  test('FR-1: addTab terminal in md region inherits md file directory', async ({ page, request }) => {
    await gotoFresh(page, request);
    const { mdPath, expectedCwd } = makeMdInDir();

    // Open md tab → focused region's active tab becomes the md viewer.
    await page.evaluate((fp) => {
      const a = (window as any).app;
      a.addTab(a.focused, 'markdown', { name: fp.split('/').pop(), filePath: fp });
    }, mdPath);
    await page.waitForTimeout(150);

    // + new terminal tab in same region.
    const newPaneId = await page.evaluate(async () => {
      const a = (window as any).app;
      const rid = a.focused;
      const before = new Set([...a.panes.keys()]);
      await a.addTab(rid, 'terminal');
      const after = [...a.panes.keys()].find((k) => !before.has(k));
      return after as string;
    });
    expect(newPaneId).toBeTruthy();
    expect(await paneCwd(request, newPaneId)).toBe(expectedCwd);
  });

  test('FR-2: split from md region opens new pane in md file directory', async ({ page, request }) => {
    await gotoFresh(page, request);
    const { mdPath, expectedCwd } = makeMdInDir();

    await page.evaluate((fp) => {
      const a = (window as any).app;
      a.addTab(a.focused, 'markdown', { name: fp.split('/').pop(), filePath: fp });
    }, mdPath);
    await page.waitForTimeout(150);

    const newPaneId = await page.evaluate(async () => {
      const a = (window as any).app;
      const before = new Set([...a.panes.keys()]);
      await a.split('h');
      const after = [...a.panes.keys()].find((k) => !before.has(k));
      return after as string;
    });
    expect(newPaneId).toBeTruthy();
    expect(await paneCwd(request, newPaneId)).toBe(expectedCwd);
  });

  test('FR-3: terminal region addTab still inherits parent pane cwd (regression)', async ({ page, request }) => {
    await gotoFresh(page, request);

    // Initial pane is terminal; capture its cwd.
    const parentCwd = await page.evaluate(async () => {
      const a = (window as any).app;
      const s = a.ws.sessions.find((x: any) => x.id === a.ws.activeSession);
      const walk = (n: any, out: any[]) => { if (!n) return; if (n.type === 'region') out.push(n); else if (n.children) n.children.forEach((c: any) => walk(c, out)); };
      const regs: any[] = []; walk(s.layout, regs);
      const pid = regs[0].tabs[0].paneId;
      const r = await fetch('/api/cwd?pane=' + pid);
      const j = await r.json();
      return j.cwd as string;
    });
    expect(parentCwd).toBeTruthy();

    const newPaneId = await page.evaluate(async () => {
      const a = (window as any).app;
      const before = new Set([...a.panes.keys()]);
      await a.addTab(a.focused, 'terminal');
      return [...a.panes.keys()].find((k) => !before.has(k)) as string;
    });
    expect(await paneCwd(request, newPaneId)).toBe(parentCwd);
  });
});
