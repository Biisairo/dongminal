import { test, expect } from './fixtures';

// /dongminal:team 과 /dongminal:workflow 스킬이 실제로 밟는 접합면을 라이브 서버에서
// 검증한다. 스킬 문서는 명령·인자만 적혀 있어 정적 대조로는 "그 이름이 존재한다"
// 까지만 알 수 있다 — 여기서 실제 왕복이 통하는지, 응답에서 스킬이 기대하는 필드가
// 나오는지를 확인한다.
//
// 접합면은 MCP 에서 dmctl + HTTP 로 교체됐다 (SKILL_INJECTION_SRS). dmctl 은 아래
// 엔드포인트를 부르는 얇은 CLI 이므로, 여기서 같은 엔드포인트를 직접 호출하는 것이
// 스킬이 밟는 경로와 동일하다. 브라우저 페이지를 함께 띄우는 이유는 그것이
// /api/commands/sse 구독자이기 때문이다 — 스킬의 delivered>0 전제를 만족시킨다.

async function waitForInit(page: any) {
  await page.context().addInitScript(() => {
    sessionStorage.setItem('displayMode', 'desktop');
  });
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
}

// dmctl list-workspace 가 /api/state 를 읽어 만드는 행에서 스킬이 캡처하는 값들.
async function firstTab(request: any): Promise<{ uuid: string; toolId: string }> {
  const state = await (await request.get('/api/state')).json();
  const walk = (n: any): any => {
    if (!n) return null;
    for (const t of n.tabs || []) if (t.id && t.toolId) return t;
    for (const c of n.children || []) { const r = walk(c); if (r) return r; }
    return null;
  };
  for (const w of state.workspace?.windows || []) {
    const t = walk(w.layout);
    if (t) return { uuid: t.id, toolId: t.toolId };
  }
  throw new Error('참조된 탭이 없다');
}

test.describe('스킬이 부르는 접합면 (라이브)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForInit(page);
  });

  // dmctl who-am-i / list-workspace 가 파싱하는 필드가 서버 응답에 있는지.
  // 스킬은 이 중 uuid 를 모든 단계의 식별자로 보관한다.
  test('/api/state 가 스킬이 캡처하는 식별자를 낸다', async ({ request }) => {
    const state = await (await request.get('/api/state')).json();
    expect(state.workspace, 'workspace 트리가 없다').toBeTruthy();
    expect(Array.isArray(state.tools), 'tools 배열이 없다').toBe(true);

    const { uuid, toolId } = await firstTab(request);
    expect(uuid).toBeTruthy();
    expect(toolId).toBeTruthy();
    // 스킬의 계약은 "이 값이 좌표 라벨이 아니다" 다 — 라벨은 다른 창이 닫히면
    // reflow 되지만 이 id 는 탭에 고정된다. 형식은 uuid 로 바뀌었지만
    // (WORKSPACE_IDENTITY_SRS FR-WID-1) 마이그레이션된 구 id 도 유효하므로
    // (FR-WID-2) 여기서 형식을 단정하지는 않는다.
    expect(uuid).not.toMatch(/^W\d+\.P\d+\.T\d+$/);
    expect(uuid).not.toBe(toolId);

    // v1 어휘가 남아 있으면 스킬의 파싱 지시가 어긋난다.
    const raw = JSON.stringify(state);
    expect(raw).not.toMatch(/"region"|"paneId"|"session_uuid"/);
  });

  test('/api/whoami 가 uuid·라벨을 돌려준다', async ({ request }) => {
    const { toolId } = await firstTab(request);
    const r = await request.get(`/api/whoami?toolId=${toolId}`);
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.toolId).toBe(toolId);
    expect(body.uuid, 'who-am-i 에 uuid 가 없다 — 스킬의 BOSS 캡처가 깨진다').toBeTruthy();
    expect(body.label).toMatch(/^W\d+\.P\d+\.T\d+$/);
  });

  // /dongminal:team §2 의 호출 형태 그대로. 스킬은 응답의 newTabs[0].uuid 를
  // SEED 로 캡처하므로 그 필드가 실제로 오는지가 계약이다.
  test('split-h --at <uuid> -n 이 분할 칸을 늘리고 newTabs 를 돌려준다', async ({ page, request }) => {
    const before = await page.locator('#area .pn').count();
    const { uuid } = await firstTab(request);

    const r = await request.post('/api/commands', {
      data: { action: 'splitH', args: { location: uuid, keepFocus: true } },
    });
    expect(r.status(), `splitH 가 ${r.status()} 로 거부됐다`).toBe(200);
    const body = await r.json();
    expect(body.delivered, '구독 중인 브라우저가 없다').toBeGreaterThan(0);
    if (!body.timedOut) {
      expect(Array.isArray(body.newTabs), 'newTabs 가 배열이 아니다').toBe(true);
      expect(body.newTabs.length, '생성 명령인데 newTabs 가 비었다').toBeGreaterThan(0);
      expect(body.newTabs[0].uuid, 'newTabs[0].uuid 가 없다 — 스킬의 SEED 캡처가 깨진다').toBeTruthy();
      expect(body.newTabs[0].toolId).toBeTruthy();
    }
    await expect(page.locator('#area .pn')).toHaveCount(before + 1, { timeout: 10000 });
  });

  // 스킬의 "식별자는 항상 UUID" 원칙의 서버측 근거.
  test('좌표 location 은 거부된다', async ({ request }) => {
    const r = await request.post('/api/commands', {
      data: { action: 'focus', args: { location: 'W1.P1.T1' } },
    });
    expect(r.status(), '좌표 location 이 통과했다').toBe(400);
    // 안내는 실재하는 조회 수단을 가리켜야 한다.
    expect(await r.text()).toContain('list-workspace');
  });

  test('rename-tab / rename-window 가 통한다', async ({ request }) => {
    const { uuid } = await firstTab(request);

    for (const [action, name] of [['renameTab', 'sk-tab'], ['renameWindow', 'sk-window']]) {
      const r = await request.post('/api/commands', {
        data: { action, args: { location: uuid, name } },
      });
      expect(r.status(), `${action} 이 ${r.status()} 로 거부됐다`).toBe(200);
    }

    await expect.poll(async () => {
      const state = await (await request.get('/api/state')).json();
      return (state.workspace?.windows || []).map((w: any) => w.name);
    }, { timeout: 10000 }).toContain('sk-window');
  });
});

// 에이전트 접합면 3종 (SKILL_INJECTION_SRS 묶음 B). dmctl read-screen /
// send-input / msg 가 부르는 경로다. Go 테스트는 fake 어댑터로 검증하므로
// 실제 PTY 왕복은 여기서만 확인된다.
test.describe('에이전트 접합면의 PTY 왕복 (라이브)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForInit(page);
  });

  test('send-input → read-screen 왕복', async ({ request }) => {
    const { uuid } = await firstTab(request);
    const marker = 'SKILL_CONTRACT_' + Date.now();

    const r = await request.post('/api/tools/input', {
      data: { id: uuid, text: `echo ${marker}`, execute: true },
    });
    expect(r.status(), `send-input 이 ${r.status()} 로 실패했다`).toBe(200);

    await expect.poll(async () => {
      const out = await (await request.get(
        `/api/tools/output?id=${uuid}&bytes=8192&strip=1`)).json();
      return out.text || '';
    }, { timeout: 10000 }).toContain(marker);
  });

  test('read-screen 은 ANSI 를 제거하고 read-output 은 유지한다', async ({ request }) => {
    const { uuid } = await firstTab(request);
    // 색을 내는 출력을 만든다.
    await request.post('/api/tools/input', {
      data: { id: uuid, text: `printf '\\033[31mRED_MARK\\033[0m\\n'`, execute: true },
    });

    await expect.poll(async () => {
      const out = await (await request.get(
        `/api/tools/output?id=${uuid}&bytes=8192&strip=1`)).json();
      return out.text || '';
    }, { timeout: 10000 }).toContain('RED_MARK');

    const stripped = await (await request.get(
      `/api/tools/output?id=${uuid}&bytes=8192&strip=1`)).json();
    const raw = await (await request.get(
      `/api/tools/output?id=${uuid}&bytes=8192`)).json();
    // eslint-disable-next-line no-control-regex
    expect(stripped.text, 'strip=1 인데 ESC 가 남아 있다').not.toMatch(/\x1b\[/);
    // eslint-disable-next-line no-control-regex
    expect(raw.text, 'raw 응답에 ESC 가 없다').toMatch(/\x1b\[/);
  });

  // 엔벨로프는 서버가 조립한다 (FR-API-3). 수신 도구 화면에 그 형태로 도달하는지가
  // 팀 협업 전체의 전제다.
  test('msg 가 엔벨로프로 감싸 수신 도구에 도달한다', async ({ request }) => {
    const { uuid } = await firstTab(request);
    const marker = 'ENVELOPE_BODY_' + Date.now();

    const r = await request.post('/api/tools/message', {
      data: { to: uuid, from: uuid, message: marker },
    });
    expect(r.status(), `msg 가 ${r.status()} 로 실패했다`).toBe(200);
    const body = await r.json();
    // 헤더 표시는 사람 가독성용 라벨로 정규화된다.
    expect(body.from).toMatch(/^W\d+\.P\d+\.T\d+$/);
    expect(body.to).toMatch(/^W\d+\.P\d+\.T\d+$/);

    await expect.poll(async () => {
      const out = await (await request.get(
        `/api/tools/output?id=${uuid}&bytes=16384&strip=1`)).json();
      return out.text || '';
    }, { timeout: 10000 }).toContain('DONGMINAL-AGENT-MSG');

    const out = await (await request.get(
      `/api/tools/output?id=${uuid}&bytes=16384&strip=1`)).json();
    expect(out.text, '엔벨로프 본문이 도달하지 않았다').toContain(marker);
  });

  test('없는 식별자는 404 로 거부된다', async ({ request }) => {
    for (const [path, data] of [
      ['/api/tools/input', { id: 'no-such-uuid', text: 'x' }],
      ['/api/tools/message', { to: 'no-such-uuid', message: 'x' }],
    ] as [string, any][]) {
      const r = await request.post(path, { data });
      expect(r.status(), `${path} 가 없는 식별자를 통과시켰다`).toBe(404);
    }
    const g = await request.get('/api/tools/output?id=no-such-uuid');
    expect(g.status()).toBe(404);
  });

  // 묶음 S — 상태·대기 계약 (RUN_ORCHESTRATION_SRS FR-STA-1/2/5).
  // 재작성될 Barrier 가 화면 스크래핑 대신 밟을 경로다. Go 단위 테스트는 가짜
  // toolaccess 로 도는 반면 여기서는 실제 도구·실제 해석기를 통과한다.
  test('activity/get 이 살아있는 도구의 상태를 낸다', async ({ request }) => {
    const { uuid, toolId } = await firstTab(request);
    const r = await request.get(`/api/tools/activity/get?id=${uuid}`);
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.toolId).toBe(toolId);
    expect(body.live, '살아있는 도구가 live=false 다').toBe(true);
    expect(typeof body.state).toBe('string');

    const miss = await request.get('/api/tools/activity/get?id=no-such-uuid');
    expect(miss.status()).toBe(404);
  });

  test('wait 이 훅 상태 전이를 따라간다 — working 은 대기, idle 은 ready', async ({ request }) => {
    const { uuid, toolId } = await firstTab(request);

    await request.post('/api/tools/activity/set', {
      data: { toolId, state: 'working', tool: 'Bash', detail: 'sleep 600' },
    });
    const busy = await (
      await request.get(`/api/tools/activity/wait?id=${uuid}&for=ready&timeoutMs=300`)
    ).json();
    expect(busy.status, 'working 인데 ready 로 풀렸다').toBe('timeout');
    expect(busy.state).toBe('working');

    await request.post('/api/tools/activity/set', { data: { toolId, state: 'idle' } });
    const ready = await (
      await request.get(`/api/tools/activity/wait?id=${uuid}&for=ready&timeoutMs=5000`)
    ).json();
    expect(ready.status).toBe('ready');
    expect(ready.reason, 'ready 근거가 훅이어야 한다').toBe('hook');
  });

  // FR-STA-5: 권한 확인 대기(waiting)는 준비완료가 아니다. 현재 스킬의 화면
  // fingerprint 는 이 구분을 못 해 권한 대기를 준비완료로 오인한다.
  test('waiting 은 ready 가 아니라 blocked 다', async ({ request }) => {
    const { uuid, toolId } = await firstTab(request);
    await request.post('/api/tools/activity/set', { data: { toolId, state: 'waiting' } });

    const started = Date.now();
    const body = await (
      await request.get(`/api/tools/activity/wait?id=${uuid}&for=ready&timeoutMs=60000`)
    ).json();
    expect(body.status).toBe('blocked');
    expect(Date.now() - started, 'blocked 는 즉시 반환해야 한다').toBeLessThan(5000);

    // 뒷 스펙이 이 도구를 쓰므로 상태를 되돌린다.
    await request.post('/api/tools/activity/set', { data: { toolId, state: 'idle' } });
  });

  // MCP 는 제거됐다 (SKILL_INJECTION_SRS 묶음 F). 라우트가 되살아나면 이중
  // 접합면이 생기므로 여기서 막는다.
  test('MCP 엔드포인트는 더 이상 없다', async ({ request }) => {
    for (const path of ['/mcp/sse', '/mcp/message']) {
      const r = await request.get(path);
      expect(r.status(), `${path} 가 살아 있다`).toBe(404);
    }
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

    // 복귀 대상을 명시한다. location 생략 경로의 폴백은 FR-BGR-7 이 담당하고
    // background-restore-at.spec.ts 의 TC-BGR-8/9 가 직접 덮는다. 여기서 검증할
    // 계약은 스킬·오케스트레이터가 쓰는 방식 — 대상을 명시하는 쪽이다
    // (USER_CHECKLIST_FIXES 묶음 D — detach --restore <toolId> --at <uuid>).
    //
    // /api/tools/background 가 참이 되는 시점은 브라우저가 워크스페이스를 아직
    // 저장하기 전이다. 유일한 탭을 detach 했으면 창이 사라지고 새 창이 만들어지는
    // 중이므로, 그 전에 /api/state 를 읽으면 곧 없어질 탭 uuid 를 집어 restoreTool
    // 이 서버의 IsKnownTabID 게이트에서 400 이 된다. 분리한 도구가 트리에서 사라진
    // 스냅샷에서 골라야 결정적이다.
    let survivor: { uuid: string; toolId: string } | null = null;
    await expect.poll(async () => {
      const st = await (await request.get('/api/state')).json();
      const tabs: any[] = [];
      const walk = (n: any) => {
        if (!n) return;
        for (const t of n.tabs || []) if (t.id && t.toolId) tabs.push(t);
        for (const c of n.children || []) walk(c);
      };
      for (const w of st.workspace?.windows || []) walk(w.layout);
      if (!tabs.length || tabs.some((t) => t.toolId === toolId)) return false;
      survivor = { uuid: tabs[0].id, toolId: tabs[0].toolId };
      return true;
    }, { timeout: 10000 }).toBe(true);
    const r2 = await request.post('/api/commands', {
      data: { action: 'restoreTool', args: { toolId, location: survivor!.uuid } },
    });
    expect(r2.status()).toBe(200);
    expect((await r2.json()).delivered, '구독 중인 브라우저가 없다').toBeGreaterThan(0);
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
