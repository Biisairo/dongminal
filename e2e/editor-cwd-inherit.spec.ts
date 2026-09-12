import { join } from 'path';

import { APIRequestContext } from '@playwright/test';
import {
  test, expect, waitSettled, gotoSettled, gitFixture, cleanGitFixture,
} from './fixtures';
import { TMP, realPath, tmpPath } from './osenv';
// @ts-ignore
import * as fs from 'fs';
// @ts-ignore
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
// (FR-EDT-50·51, D-8).
//
// **FR-1·FR-2 는 뒤집혔다** (WORKBENCH_REVIEW_SRS FR-WBR-20 / D-WBR-1).
//
//   이전 계약: Editor 창에서 새 창을 열면 편집 중 파일의 디렉터리를 승계한다.
//             옛 두 경로가 막힌 뒤 `_mkWindow` 가 그 규칙의 마지막 관측점이었다
//             (UX_REVISION_SRS FR-CWD-1)
//   새  계약: **새 창은 홈에서 뜬다.** 승계는 같은 창의 새 탭·분할에만 남는다
//             (FR-WBR-21) — FR-3 이 그것을 잰다
//   이유:     사용자 지시("터미널은 홈에서 시작하는 것이 맞다")
//
// 그래서 FR-1·FR-2 는 이제 **승계하지 않는다**를 잰다. 그 둘이 없으면 뒤집힌
// 자리가 아무 시험에도 걸리지 않고, 다음 사람이 옛 규칙으로 되돌려도 초록이다.

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
  await waitSettled(page);
}

function makeFileInDir(): { filePath: string; expectedCwd: string } {
  const dir = fs.mkdtempSync(path.join(TMP, 'mdcwd-'));
  const fp = path.join(dir, 'doc.md');
  fs.writeFileSync(fp, '# doc\n\nhello\n');
  // macOS resolves /var → /private/var; shell-reported cwd uses the realpath.
  return { filePath: fp, expectedCwd: realPath(dir) };
}

// 도구가 아무 지시 없이 열리는 자리 — `os.UserHomeDir()` 이다 (`toolhub/tool.go`
// 의 `userHome`, "언제나 사용자의 홈이다"). 서버가 root 에디터의 경로로 같은 값을
// 주므로(FR-EDT-13) 그것을 기준으로 삼는다 — 테스트가 홈을 따로 계산하지 않는다.
async function serverHome(page): Promise<string> {
  const h = await page.evaluate(() => (window as any).app?.testing.editors?.home as string);
  expect(h, '서버가 홈을 주지 않았다').toBeTruthy();
  return h;
}

async function paneCwd(request, toolId: string): Promise<string> {
  const r = await request.get('/api/cwd?tool=' + toolId);
  const j = await r.json();
  return j.cwd as string;
}

/**
 * 그 도구의 cwd 가 `want` 가 될 때까지 기다린다.
 *
 * **관측의 길이 OS 마다 다르기 때문이다.** POSIX 는 서버가 그 프로세스의 cwd 를
 * 직접 읽으므로(`/proc`·lsof) 도구가 서는 즉시 옳은 값이 나온다. Windows 는 그
 * 길이 없어(`windowsProcInfo.CWD` 는 언제나 거짓) **셸 훅의 보고**가 유일한
 * 출처이고, 그 보고는 첫 프롬프트가 돌아야 온다 — 그 전까지 서버는 자기 cwd 를
 * 답한다(`cwdOrServer`). 재는 것은 "어디서 떴는가" 이지 "언제 알렸는가" 가
 * 아니므로 기다린다.
 */
async function expectCwd(request, toolId: string, want: string, msg: string) {
  await expect.poll(() => paneCwd(request, toolId), { timeout: 20000 }).toBe(want);
  expect(await paneCwd(request, toolId), msg).toBe(want);
}

// 편집기 탭을 root 에디터 창(FR-EDT-13)에 열고, 그 창을 활성 창으로, 그
// 탭이 있는 pane 을 포커스로 만든다 — `edOpenFile` 이 이 셋을 함께 보장한다
// (`app-editor.js` FR-EDT-94·102).
async function openInEditorWindow(page, filePath: string, name: string) {
  await page.evaluate(async ({ fp, nm }) => {
    const a = (window as any).app;
    const winId = await a.testing.edOpenFile(fp, { name: nm });
    if (!winId) throw new Error('editor tab open 실패 — edOn() 이 꺼져 있나?');
  }, { fp: filePath, nm: name });
}

test.describe('편집기 탭 → 새 도구의 cwd 상속', () => {
  test('FR-1 (V-WBR-20): Editor 창에서 _mkWindow 로 새 창을 열면 홈에서 뜬다 — 승계하지 않는다',
    async ({ page, request }) => {
      await gotoFresh(page, request);
      const { filePath, expectedCwd } = makeFileInDir();
      await openInEditorWindow(page, filePath, path.basename(filePath));

      const toolId = await page.evaluate(async () => {
        const a = (window as any).app;
        const c = await a.testing.mkWindow();
        return c?.tab?.toolId as string;
      });
      expect(toolId).toBeTruthy();
      const home = await serverHome(page);
      expect(home, '편집 중 파일의 디렉터리를 승계했다').not.toBe(expectedCwd);
      await expectCwd(request, toolId, home, '홈에서 뜨지 않았다');
    });

  test('FR-2 (V-WBR-20): 원격 newWindow 커맨드도 홈에서 뜬다', async ({ page, request }) => {
    await gotoFresh(page, request);
    const { filePath, expectedCwd } = makeFileInDir();
    await openInEditorWindow(page, filePath, path.basename(filePath));

    const win = await (
      await request.post('/api/commands', { data: { action: 'newWindow', args: {} } })
    ).json();
    expect(win.ok, `newWindow 실패: ${JSON.stringify(win)}`).toBeTruthy();
    const toolId: string = win.newTabs?.[0]?.toolId;
    expect(toolId).toBeTruthy();
    const home = await serverHome(page);
    expect(home, '편집 중 파일의 디렉터리를 승계했다').not.toBe(expectedCwd);
    await expectCwd(request, toolId, home, '홈에서 뜨지 않았다');
  });

  // FR-WBR-23: 명시하면 그것이 이긴다 — 팀 창이 서는 길이다.
  test('FR-2b (V-WBR-24): 원격 newWindow 가 args.cwd 를 받으면 그 경로에서 뜬다',
    async ({ page, request }) => {
      await gotoFresh(page, request);
      const { expectedCwd } = makeFileInDir();

      const win = await (
        await request.post('/api/commands',
          { data: { action: 'newWindow', args: { cwd: expectedCwd } } })
      ).json();
      expect(win.ok, `newWindow 실패: ${JSON.stringify(win)}`).toBeTruthy();
      const toolId: string = win.newTabs?.[0]?.toolId;
      expect(toolId).toBeTruthy();
      await expectCwd(request, toolId, expectedCwd, '지정한 cwd 에서 뜨지 않았다');
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

/**
 * 묶음 CWD — **새 창의 첫 도구는 홈에서 뜬다** (FR-CWD-*).
 *
 * cwd 를 물려받는 규칙이 이 파일의 주제다 — 새 창은 포커스 칸의 cwd 를
 * 물려받지 않고, 같은 창의 새 탭은 물려받는다.
 *
 * `TEST-7` 로 `ux-revision` 에서 옮겨 왔다 — 납품 묶음이 아니라 **이 기능**이
 * 주제인 자리다. 단정은 옮기면서 바꾸지 않았다.
 */

const UXRFX = tmpPath('dm-uxr-editor-cwd-inherit-' + process.pid);
test.beforeAll(() => { gitFixture(UXRFX) });
test.afterAll(() => { cleanGitFixture(UXRFX) });
const uxrFx = (n: string) => realPath(join(UXRFX, n));

test.describe('묶음 W — 새 창의 cwd (FR-CWD-*)', () => {
  const toolCwd = async (request: APIRequestContext, toolId: string) =>
    (await (await request.get('/api/cwd?tool=' + toolId)).json()).cwd as string;

  /**
   * 그 도구의 cwd 가 `want` 가 될 때까지 기다린다.
   *
   * **관측의 길이 OS 마다 다르기 때문이다.** POSIX 는 서버가 그 프로세스의 cwd 를
   * 직접 읽으므로(`/proc`·lsof) 도구가 서는 즉시 옳은 값이 나온다. Windows 는 그
   * 길이 없어(`windowsProcInfo.CWD` 는 언제나 거짓) **셸 훅의 보고**가 유일한
   * 출처이고, 그 보고는 첫 프롬프트가 돌아야 온다 — 그 전까지 서버는 자기 cwd 를
   * 답한다(`cwdOrServer`). 재는 것은 "어디서 떴는가" 이지 "언제 알렸는가" 가
   * 아니므로 기다린다 (editor-cwd-inherit 의 `expectCwd` 와 같은 규약).
   */
  const expectToolCwd = async (
    request: APIRequestContext, toolId: string, want: string, msg?: string,
  ) => {
    await expect.poll(() => toolCwd(request, toolId), { timeout: 20000 }).toBe(want);
    expect(await toolCwd(request, toolId), msg).toBe(want);
  };

  /**
   * **뒤집혔다** — WORKBENCH_REVIEW_SRS FR-WBR-20 / D-WBR-1.
   *
   *   이전 계약: 새 창의 첫 도구가 포커스 분할 칸의 cwd 를 물려받는다 (FR-CWD-1)
   *   새  계약: 새 창은 **홈**에서 뜬다. 승계는 같은 창의 새 탭·분할에만 남는다
   *             (FR-WBR-21) — 아래 V-CWD-3 이 그것을 잰다
   *   이유:     사용자 지시("터미널은 홈에서 시작하는 것이 맞다")
   *
   * 명시적 지정(FR-CWD-3)은 그대로 이긴다 — V-CWD-2 가 그 자리다.
   */
  test('V-CWD-1 (V-WBR-20): 새 창의 첫 도구는 홈에서 뜬다 — 포커스 칸을 물려받지 않는다',
    async ({ page, request }) => {
      await gotoSettled(page);
      // 지금 분할 칸의 도구를 어떤 디렉터리로 보낸다 — 셸에 cd 를 치는 대신
      // 그 경로에서 만든 도구를 기준으로 삼는다 (터미널 입력은 느리고 흔들린다).
      const here = uxrFx('basic');
      const base = await page.evaluate(async ([cwd]) => {
        const app = (window as any).app;
        await app.addTab(app.focused, 'terminal', { cwd });
        const win = app.ws.windows.find((w: any) => w.id === app.ws.activeWindow);
        const pane = win.layout;
        return pane.tabs.find((t: any) => t.id === pane.activeTab).toolId;
      }, [here]);
      await expectToolCwd(request, base, here);

      const made = await page.evaluate(async () => {
        const app = (window as any).app;
        const r = await app.testing.mkWindow();
        app.render();
        return r.tab.toolId;
      });
      // 도구가 아무 지시 없이 열리는 자리는 사용자의 홈이다 (`toolhub` 의
      // `userHome` — "언제나 사용자의 홈이다"). 서버가 root 에디터의 경로로 같은
      // 값을 준다 (FR-EDT-13).
      const home = await page.evaluate(() => (window as any).app?.testing.editors?.home as string);
      expect(home, '서버가 홈을 주지 않았다').toBeTruthy();
      await expectToolCwd(request, made, home);
      expect(await toolCwd(request, made), '새 창이 포커스 칸의 cwd 를 물려받았다').not.toBe(here);
    });

  // FR-WBR-21: 같은 창 안에서 하나 더 여는 것은 뜻이 다르다 — 그쪽은 그대로
  // 승계한다 (UX_REVISION_SRS A6 은 남는다).
  test('V-CWD-3 (V-WBR-21): 같은 창의 새 탭은 그 칸의 cwd 를 그대로 받는다',
    async ({ page, request }) => {
      await gotoSettled(page);
      const here = uxrFx('basic');
      await page.evaluate(async ([cwd]) => {
        const app = (window as any).app;
        await app.addTab(app.focused, 'terminal', { cwd });
      }, [here]);

      const made = await page.evaluate(async () => {
        const app = (window as any).app;
        const before = new Set([...app.tools.keys()]);
        await app.addTab(app.focused, 'terminal');
        return [...app.tools.keys()].find((k) => !before.has(k)) as string;
      });
      await expectToolCwd(request, made, here, '같은 창의 새 탭이 승계를 잃었다');
    });

  test('V-CWD-2: dmctl 이 보낸 cwdTool 이 기준이 된다', async ({ page, request }) => {
    await gotoSettled(page);
    const here = uxrFx('basic');
    const caller = await page.evaluate(async ([cwd]) => {
      const app = (window as any).app;
      await app.addTab(app.focused, 'terminal', { cwd });
      const win = app.ws.windows.find((w: any) => w.id === app.ws.activeWindow);
      const pane = win.layout;
      return pane.tabs.find((t: any) => t.id === pane.activeTab).toolId;
    }, [here]);
    // 포커스를 다른 분할 칸으로 옮겨도, 호출한 셸(caller)이 기준이어야 한다
    // (FR-CWD-4: 조정자가 어느 창을 보고 있든 자기 cwd 에서 팀 창이 열린다).
    await page.evaluate(() => (window as any).app.split('horizontal'));
    await expect(page.locator('#area .pn')).toHaveCount(2, { timeout: 10000 });
    const made = await page.evaluate(async ([tid]) => {
      const app = (window as any).app;
      let out: any = null;
      const orig = app.testing.echoResult;
      app.testing.echoResult = (_: any, r: any) => { out = r };
      app.testing.execRemote('newWindow', { name: 'team', cwdTool: tid, reqId: 'probe' });
      await new Promise(r => setTimeout(r, 800));
      app.testing.echoResult = orig;
      return out && out.newTabs[0].toolId;
    }, [caller]);
    expect(made, 'newWindow 가 탭을 만들지 않았다').toBeTruthy();
    await expectToolCwd(request, made, here);
  });
});

// ── 묶음 C — 창 닫기 ──

