import { test, expect } from './fixtures';

// skills/dongminal-team 과 dongminal-workflow 가 실제로 밟는 MCP 시퀀스를
// 라이브 서버에서 검증한다. 스킬 문서는 툴명·action·인자만 적혀 있어 정적
// 대조로는 "그 이름이 존재한다" 까지만 알 수 있다 — 여기서 실제 호출이
// 통하는지, 응답에서 스킬이 기대하는 필드가 나오는지를 확인한다.
//
// MCP SSE 전송은 POST /mcp/message 가 202 만 돌려주고 실제 JSON-RPC 응답은
// /mcp/sse 스트림으로 온다. 그래서 호출·수신을 모두 페이지 안에서 한다.
// 브라우저 페이지는 동시에 /api/commands/sse 구독자 역할도 하므로,
// workspace_command 가 delivered>0 을 받는 스킬의 전제도 함께 만족한다.

async function waitForInit(page: any) {
  await page.context().addInitScript(() => {
    sessionStorage.setItem('displayMode', 'desktop');
  });
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
}

// 페이지에 MCP 클라이언트를 심는다. window.__mcp(method, params) 가
// JSON-RPC 응답 객체로 resolve 한다.
async function installMCPClient(page: any) {
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const w = window as any;
    const pending = new Map<number, (v: any) => void>();
    let seq = 0;
    let endpoint = '';
    const es = new EventSource('/mcp/sse');
    const timer = setTimeout(() => reject(new Error('MCP SSE endpoint timeout')), 10000);
    es.addEventListener('endpoint', (e: any) => {
      endpoint = String(e.data);
      clearTimeout(timer);
      resolve();
    });
    es.addEventListener('message', (e: any) => {
      let msg: any;
      try { msg = JSON.parse(e.data); } catch { return; }
      const fn = pending.get(Number(msg.id));
      if (fn) { pending.delete(Number(msg.id)); fn(msg); }
    });
    es.onerror = () => { clearTimeout(timer); reject(new Error('MCP SSE error')); };
    w.__mcp = (method: string, params: any) => new Promise((res, rej) => {
      const id = ++seq;
      const t = setTimeout(() => { pending.delete(id); rej(new Error('MCP 응답 timeout: ' + method)); }, 15000);
      pending.set(id, (v) => { clearTimeout(t); res(v); });
      fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      }).catch(rej);
    });
  }));
}

async function callTool(page: any, name: string, args: any = {}) {
  return await page.evaluate(
    ([n, a]: [string, any]) => (window as any).__mcp('tools/call', { name: n, arguments: a }),
    [name, args] as [string, any],
  );
}

function textOf(res: any): string {
  return (res?.result?.content || []).map((c: any) => c.text || '').join('\n');
}

test.describe('스킬이 부르는 MCP 계약 (라이브)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForInit(page);
    await installMCPClient(page);
  });

  test('tools/list 가 스킬이 쓰는 7개 툴을 노출한다', async ({ page }) => {
    const res = await page.evaluate(() => (window as any).__mcp('tools/list', {}));
    const names = (res?.result?.tools || []).map((t: any) => t.name).sort();
    expect(names).toEqual([
      'list_workspace', 'read_output', 'read_screen', 'send_agent_message',
      'send_input', 'who_am_i', 'workspace_command',
    ]);
  });

  test('list_workspace 가 스킬이 파싱하는 컬럼을 낸다', async ({ page }) => {
    const txt = textOf(await callTool(page, 'list_workspace'));
    // 스킬은 uuid= / short= / toolId= 를 캡처한다 (SKILL.md §3 팁).
    expect(txt).toMatch(/label=W\d+\.P\d+\.T\d+/);
    expect(txt).toMatch(/uuid=/);
    expect(txt).toMatch(/toolId=/);
    // v1 어휘가 남아 있으면 스킬의 파싱 지시가 어긋난다.
    expect(txt).not.toMatch(/\bsession="|session_uuid=|region_uuid=/);
    expect(txt).toMatch(/window="/);
  });

  test('workspace_command(splitH, keepFocus) 가 분할 칸을 늘린다', async ({ page }) => {
    const before = await page.locator('#area .pn').count();
    const uuid = textOf(await callTool(page, 'list_workspace')).match(/uuid=([0-9a-zA-Z-]+)/)?.[1];
    expect(uuid, 'list_workspace 에서 uuid 를 못 뽑았다').toBeTruthy();

    // dongminal-team SKILL.md §2 의 호출 형태 그대로.
    const res = await callTool(page, 'workspace_command', {
      action: 'splitH', location: uuid, keepFocus: true,
    });
    expect(res.result?.isError, `splitH 실패: ${textOf(res)}`).toBeFalsy();
    await expect(page.locator('#area .pn')).toHaveCount(before + 1, { timeout: 10000 });
  });

  test('좌표 location 은 거부된다 (스킬의 uuid-only 규칙 근거)', async ({ page }) => {
    const res = await callTool(page, 'workspace_command', {
      action: 'focus', location: 'W1.P1.T1',
    });
    expect(res.result?.isError, '좌표 location 이 통과했다').toBeTruthy();
    // 안내 메시지는 실재하는 조회 수단을 가리켜야 한다. MCP 채널이므로
    // 툴명 list_workspace (HTTP/CLI 경로는 list-workspace).
    expect(textOf(res)).toContain('list_workspace');
  });

  test('detach 계열 action 은 workspace_command 로 부를 수 없다', async ({ page }) => {
    for (const action of ['detachTab', 'restoreTool']) {
      const res = await callTool(page, 'workspace_command', { action });
      expect(res.result?.isError, `${action} 이 통과했다`).toBeTruthy();
      expect(textOf(res)).toContain('unknown action');
    }
  });

  test('renameTab / renameWindow 가 통한다', async ({ page }) => {
    const uuid = textOf(await callTool(page, 'list_workspace')).match(/uuid=([0-9a-zA-Z-]+)/)?.[1];
    expect(uuid).toBeTruthy();

    const rt = await callTool(page, 'workspace_command',
      { action: 'renameTab', location: uuid, name: 'p8-tab' });
    expect(rt.result?.isError, `renameTab 실패: ${textOf(rt)}`).toBeFalsy();

    const rw = await callTool(page, 'workspace_command',
      { action: 'renameWindow', location: uuid, name: 'p8-window' });
    expect(rw.result?.isError, `renameWindow 실패: ${textOf(rw)}`).toBeFalsy();

    await expect.poll(async () =>
      textOf(await callTool(page, 'list_workspace')), { timeout: 10000 },
    ).toContain('window="p8-window"');
  });
});

// detach CLI 는 /api/commands 를 직접 쓴다. 화이트리스트 누락으로 400 이 되면
// CLI 전체가 죽지만, detach_test.go 는 httptest 스텁에 POST 하므로 그 결함을
// 볼 수 없다. 라이브 서버에서 왕복을 확인한다.
test.describe('detach CLI 의 HTTP 계약 (라이브)', () => {
  test('detachTab → 백그라운드 목록 → restoreTool 왕복', async ({ page, request }) => {
    await waitForInit(page);
    // 참조된 도구를 고른다 — 고아 도구는 브라우저가 위치를 못 찾는다.
    const state = await (await request.get('/api/state')).json();
    const toolId = await page.evaluate(() => {
      const app = (window as any).app;
      const w = app.ws.windows.find((x: any) => x.id === app.ws.activeWindow);
      const walk = (n: any): string | null => {
        if (!n) return null;
        for (const t of n.tabs || []) if (t.toolId) return t.toolId;
        for (const c of n.children || []) { const r = walk(c); if (r) return r; }
        return null;
      };
      return walk(w?.layout);
    });
    expect(toolId, `참조된 도구가 없다 (state.tools=${(state.tools || []).length})`).toBeTruthy();

    const r = await request.post('/api/commands', { data: { action: 'detachTab', args: { toolId } } });
    expect(r.status(), `detachTab 이 ${r.status()} 로 거부됐다`).toBe(200);
    expect((await r.json()).delivered).toBeGreaterThan(0);

    await expect.poll(async () => {
      const bg = await (await request.get('/api/tools/background')).json();
      return (bg.background || []).some((b: any) => b.toolId === toolId);
    }, { timeout: 10000 }).toBe(true);

    const r2 = await request.post('/api/commands', { data: { action: 'restoreTool', args: { toolId } } });
    expect(r2.status()).toBe(200);
    await expect.poll(async () => {
      const bg = await (await request.get('/api/tools/background')).json();
      return (bg.background || []).length;
    }, { timeout: 10000 }).toBe(0);
  });

  // FR-BG-6f: 마지막 탭을 detach 로 닫아 Window 가 사라지는 경로에서도 도구는
  // 백그라운드에 등록되어야 한다. closeTab 은 s.layout 이 비면 delWindow 후
  // 조기 반환하는데, 그 지점이 _setToolBackground 호출보다 앞이었다 — 도구가
  // 종료되지도, 백그라운드 목록에 오르지도 않아 어디서도 닿을 수 없게 됐다.
  test('FR-BG-6f: 유일한 탭을 detach 해 창이 사라져도 백그라운드에 등록된다', async ({ page, request }) => {
    await waitForInit(page);
    const single = await page.evaluate(() => {
      const app = (window as any).app;
      // 창 1개 · 분할 칸 1개 · 탭 1개인지 확인하고 그 도구 id 를 돌려준다.
      if (app.ws.windows.length !== 1) return null;
      const l = app.ws.windows[0].layout;
      if (!l || l.type !== 'pane' || (l.tabs || []).length !== 1) return null;
      return l.tabs[0].toolId as string;
    });
    expect(single, '초기 상태가 창1·분할칸1·탭1 이 아니다').toBeTruthy();

    const r = await request.post('/api/commands', { data: { action: 'detachTab', args: { toolId: single } } });
    expect(r.status()).toBe(200);

    await expect.poll(async () => {
      const bg = await (await request.get('/api/tools/background')).json();
      return (bg.background || []).some((b: any) => b.toolId === single);
    }, { timeout: 10000 }).toBe(true);

    // 도구는 살아 있어야 한다 (종료되지 않았다).
    const st = await (await request.get('/api/state')).json();
    expect((st.tools || []).some((t: any) => t.id === single),
      'detach 한 도구가 종료됐다').toBe(true);
  });
});
