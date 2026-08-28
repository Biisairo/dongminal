import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

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
// windowFocusMap 은 창별 "지금 보고 있는 탭"이다. `-n`(keepFocus)이 실제로
// 보장하는 것이 이것이며, /api/focus 의 owners(어느 클라이언트가 그 창의 포커스를
// 소유하나)와는 다른 개념이다 — 새 창이 owners 항목을 갖는 것은 정상이고 등록도
// 비동기라 경합한다.
async function windowFocusMap(request: any): Promise<Record<string, string>> {
  const state = await (await request.get('/api/state')).json();
  const wins = state?.workspace?.windows ?? [];
  // 관측 대상이 없으면 "전후가 같다"가 공허하게 참이 된다. 실재를 못박는다.
  expect(wins.length, '워크스페이스에 창이 없다 — 단정이 공허해진다').toBeGreaterThan(0);
  const out: Record<string, string> = {};
  const walk = (node: any): string => node?.activeTab ?? (node?.children ?? []).map(walk).join(',');
  for (const w of wins) out[w.id] = walk(w.layout);
  return out;
}

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

  // ORCHESTRATION_V2_SRS FR-IDU-4: 접합면은 좌표 라벨을 **400** 으로 거부한다.
  //
  // 404("그런 것이 없다")와 갈라야 하는 이유는 진단이 곧 수정 지시여야 하기
  // 때문이다 — 살아 있는 탭을 라벨로 부른 것은 "없는 대상"이 아니라 "잘못된
  // 부름"이고, 에이전트는 그 차이를 알아야 uuid 로 고쳐 부른다.
  //
  // 위의 404 케이스와 짝이다: 같은 종단에 없는 uuid 를 주면 404, 살아 있는 탭의
  // 라벨을 주면 400 이다.
  test('접합면은 좌표 라벨을 400 으로 거부한다 (FR-IDU-4)', async ({ page, request }) => {
    // 라벨이 **실재해야** 이 계약을 검증한다 — 없는 라벨은 그냥 404 라서
    // "잘못된 부름" 과 "없는 대상" 이 갈리는지를 보여주지 못한다.
    // waitForInit 이 창·분할 칸·탭 하나를 보장하므로 W1.P1.T1 이 존재한다.
    await waitForInit(page);
    const label = 'W1.P1.T1';

    for (const [path, data] of [
      ['/api/tools/input', { id: label, text: 'x' }],
      ['/api/tools/message', { to: label, message: 'x' }],
    ] as [string, any][]) {
      const r = await request.post(path, { data });
      expect(r.status(), `${path} 가 좌표 라벨을 통과시켰다`).toBe(400);
      // 진단은 대안을 가리켜야 한다 (FR-IDU-2).
      expect(await r.text()).toContain('uuid');
    }

    const g = await request.get(`/api/tools/output?id=${label}`);
    expect(g.status(), 'GET 경로가 좌표 라벨을 통과시켰다').toBe(400);

    // 레이아웃 경로는 이 변경의 대상이 아니다 (FR-IDU-5) — 예전부터 400 이고
    // 그대로다. 두 경로가 같은 코드를 갈라 쓰지 않는다는 회귀 방어다.
    const cmd = await request.post('/api/commands', {
      data: { action: 'focus', args: { location: label } },
    });
    expect(cmd.status()).toBe(400);
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

  // 묶음 R — Run 레코드 (RUN_ORCHESTRATION_SRS FR-RUN-1/2/6/7/11, FR-PRE-5).
  // 조정자가 팀원 매핑을 대화 기록이 아니라 서버에 두는 경로다.
  test('run 기록이 시작·등록·보고·종료를 한 바퀴 돈다', async ({ request }) => {
    const { uuid, toolId } = await firstTab(request);

    const started = await request.post('/api/runs', {
      data: { objective: 'e2e 계약 확인', projection: 'inline', isolation: 'none' },
    });
    expect(started.status()).toBe(200);
    const run = await started.json();
    expect(run.state).toBe('open');
    expect(run.id, 'run id 가 없다').toBeTruthy();

    const added = await request.post('/api/runs/members', {
      data: { runId: run.id, role: 'e2e-writer', agent: 'claude', id: uuid },
    });
    expect(added.status()).toBe(200);
    const member = await added.json();
    expect(member.toolId).toBe(toolId);
    // 조정자가 이후 명령의 location 으로 쓰는 값이다 (FR-RUN-9).
    expect(member.tabId).toBe(uuid);

    // 같은 도구를 두 번 등록하면 1:1 이 깨진다.
    const dup = await request.post('/api/runs/members', {
      data: { runId: run.id, role: 'dup', agent: 'claude', id: uuid },
    });
    expect(dup.status()).toBe(409);

    // 상태는 조회 시점에 파생된다 — 훅이 working 을 보고하면 멤버도 working 이다.
    await request.post('/api/tools/activity/set', { data: { toolId, state: 'working' } });
    const status = await (await request.get(`/api/runs?id=${run.id}`)).json();
    expect(status.members[0].state).toBe('working');

    // 미보고 멤버가 있으면 close 는 거부된다.
    const refused = await request.post('/api/runs/close', { data: { runId: run.id } });
    expect(refused.status()).toBe(409);
    expect((await refused.json()).error).toBe('unreported_members');

    // 보고 권한은 발신 도구다. 멤버가 아닌 정체로는 보고할 수 없다.
    const forged = await request.post('/api/runs/report', {
      data: { toolId: 'no-such-tool', outcome: 'succeeded', summary: 'x' },
    });
    expect(forged.status()).toBe(403);
    expect((await forged.json()).error).toBe('sender_not_member');

    const reported = await request.post('/api/runs/report', {
      data: { toolId, outcome: 'succeeded', summary: '했다. 봤다. 남았다.' },
    });
    expect(reported.status()).toBe(200);
    expect((await reported.json()).state).toBe('done');

    // 정확히 한 번이다.
    const again = await request.post('/api/runs/report', {
      data: { toolId, outcome: 'succeeded', summary: '또' },
    });
    expect(again.status()).toBe(409);

    const closed = await request.post('/api/runs/close', { data: { runId: run.id } });
    expect(closed.status()).toBe(200);
    const body = await closed.json();
    expect(body.state).toBe('closed');
    // 도구를 서버가 닫지 않는다 — 정리 대상만 돌려준다 (FR-BG-3 의 확인창 회피).
    expect(body.cleanup[0].tabId).toBe(uuid);
    const stillThere = await request.get(`/api/tools/activity/get?id=${uuid}`);
    expect(stillThere.status(), 'close 가 도구를 종료했다').toBe(200);

    await request.post('/api/tools/activity/set', { data: { toolId, state: 'idle' } });
  });

  // FR-PRE-1/3: 프리앰블은 평문이며 Run·Member uuid 가 박혀 있고, 기록에서
  // 다시 만들 수 있어야 한다. 조립 주체는 서버다 — 조정자가 uuid 를 옮겨 적지
  // 않는 것이 이 경로의 요점이다.
  test('멤버 프리앰블이 조립되고 기록에서 재조회된다', async ({ request }) => {
    const { uuid, toolId } = await firstTab(request);
    const run = await (
      await request.post('/api/runs', {
        data: { objective: '프리앰블 확인', projection: 'inline', isolation: 'none' },
      })
    ).json();

    const member = await (
      await request.post('/api/runs/members', {
        data: { runId: run.id, role: 'e2e-critic', agent: 'claude', id: uuid, brief: '형식만 본다' },
      })
    ).json();

    const p: string = member.preamble;
    expect(p, '생성 응답에 프리앰블이 없다').toBeTruthy();
    expect(p.trimStart().startsWith('{'), '프리앰블은 평문이다').toBe(false);
    for (const want of [run.id, member.id, '형식만 본다', 'dmctl run report', 'AskUserQuestion']) {
      expect(p, `프리앰블에 ${want} 가 없다`).toContain(want);
    }
    // 자리표시자가 아니라 실제 uuid 가 박힌 실행 가능한 예제여야 한다.
    expect(p).toContain(`dmctl run report --run ${run.id} --member ${member.id}`);
    // 화면 fingerprint 는 이 계열에서 추방 대상이다 (FR-SKL-2).
    for (const banned of ['Thinking...', '[대기]']) {
      expect(p).not.toContain(banned);
    }

    // 재조회가 같은 텍스트를 낸다 — 붙여넣기가 실패해도 되찾을 수 있다.
    const again = await request.get(`/api/runs/preamble?member=${member.id}`);
    expect(again.status()).toBe(200);
    expect((await again.json()).preamble).toBe(p);

    // FR-ADP-3: 알 수 없는 에이전트 id 는 기록에 들어가지 못한다.
    const bogus = await request.post('/api/runs/members', {
      data: { runId: run.id, role: 'x', agent: 'gpt-9', id: uuid },
    });
    expect(bogus.status()).toBe(400);
    expect((await bogus.json()).detail).toContain('gpt-9');

    await request.post('/api/runs/report', {
      data: { toolId, outcome: 'succeeded', summary: '했다. 봤다. 남았다.' },
    });
    await request.post('/api/runs/close', { data: { runId: run.id } });
  });

  // TC-SKL-1/3 — team 스킬이 의존하는 전용 창 절차의 기본 동작.
  //
  // 스킬 본문은 산문이라 테스트되지 않는다. 대신 그 절차가 **딛고 서는 것**을
  // 여기서 못박는다 — 전용 창 생성이 사용자 공간을 건드리지 않는다는 것, 그리고
  // 팀 매핑이 대화 기록 없이 기록만으로 되찾힌다는 것.
  test('전용 창 Run 이 사용자 공간을 건드리지 않고 기록만으로 되찾힌다', async ({ page, request }) => {
    // 포커스는 **클라이언트 상태**다. 워크스페이스 JSON 으로는 관측되지 않으므로
    // 브라우저를 띄워 거기서 읽는다 (§4.3: 브라우저 트리를 단정할 거면 브라우저를 본다).
    await waitForInit(page);
    const clientActive = () => page.evaluate(() => (window as any).app.ws.activeWindow);
    const activeBefore = await clientActive();
    expect(activeBefore, '클라이언트 활성 창을 못 읽었다 — 단정이 공허해진다').toBeTruthy();

    const wsBefore = await (await request.get('/api/state')).json();
    const focusBefore = await windowFocusMap(request);

    // 1. 전용 창 — 응답이 창·시드 uuid 를 직접 준다 (list-workspace 재조회 없음).
    const win = await (
      await request.post('/api/commands', {
        // 페이로드는 {action, args:{...}} 다 — dmctl 과 같은 형태여야 keepFocus 가
        // 브라우저까지 도달한다. 평평하게 보내면 조용히 유실되고, 전용 창이
        // 사용자 화면을 차지한다 (이 테스트를 쓰다 실제로 밟았다).
        data: { action: 'newWindow', args: { name: 'e2e-run-window', keepFocus: true } },
      })
    ).json();
    expect(win.ok, `newWindow 실패: ${JSON.stringify(win)}`).toBeTruthy();
    const winId: string = win.newWindows?.[0];
    const seed: string = win.newTabs?.[0]?.uuid;
    expect(winId, '창 uuid 가 응답에 없다').toBeTruthy();
    expect(seed, '시드 탭 uuid 가 응답에 없다').toBeTruthy();

    // 2. 사용자의 창들이 **그대로**다 — 전용 창이 방어를 구조로 푸는 근거다.
    //    새 창만 늘고, 기존 창의 활성 탭은 하나도 움직이지 않아야 한다.
    const focusWithRun = await windowFocusMap(request);
    expect(Object.keys(focusWithRun), '전용 창이 워크스페이스에 나타나지 않았다').toContain(winId);
    delete focusWithRun[winId];
    expect(focusWithRun, '전용 창 생성이 사용자 창의 활성 탭을 옮겼다').toEqual(focusBefore);

    // 3. TC-SKL-1 의 핵심 — 사용자가 **보고 있는 창이 바뀌지 않았다.**
    //    keepFocus 를 빼면 여기서 걸린다 (그 반증도 확인했다).
    await expect
      .poll(clientActive, { timeout: 5_000 })
      .toBe(activeBefore);
    expect(winId, '전용 창이 사용자 화면을 차지했다').not.toBe(await clientActive());

    // 4. Run 을 열고 시드를 멤버로 묶는다.
    const run = await (
      await request.post('/api/runs', {
        data: { objective: 'e2e 전용 창', projection: 'dedicated-window', windowId: winId },
      })
    ).json();
    const member = await (
      await request.post('/api/runs/members', {
        data: { runId: run.id, role: 'e2e-worker', agent: 'claude', id: seed, brief: '아무것도 하지 않는다' },
      })
    ).json();
    expect(member.tabId).toBe(seed);

    // 5. TC-SKL-3: 매핑표 없이 기록만으로 멤버 전원을 되찾는다.
    const status = await (await request.get(`/api/runs?id=${run.id}`)).json();
    expect(status.members).toHaveLength(1);
    expect(status.members[0].role).toBe('e2e-worker');
    expect(status.members[0].tabId).toBe(seed);
    expect(status.windowId).toBe(winId);

    // 6. 미보고 멤버가 있으면 close 가 거부된다 — 정리 가드.
    const refused = await request.post('/api/runs/close', { data: { runId: run.id } });
    expect(refused.status()).toBe(409);

    await request.post('/api/runs/report', {
      data: { toolId: member.toolId, outcome: 'succeeded', summary: '했다. 봤다. 남았다.' },
    });
    const closed = await request.post('/api/runs/close', { data: { runId: run.id } });
    expect(closed.status()).toBe(200);

    // 7. 정리 — 팀원 탭을 닫으면 전용 창은 스스로 사라진다 (close-window 불필요).
    await request.post('/api/commands', { data: { action: 'closeTab', args: { location: seed } } });
    await expect
      .poll(async () => {
        const st = await (await request.get('/api/state')).json();
        return JSON.stringify(st).includes(winId);
      }, { timeout: 10_000 })
      .toBe(false);

    // 8. TC-SKL-1: 사용자 공간이 전후로 같다 — 전용 창은 흔적을 남기지 않는다.
    const wsAfter = await (await request.get('/api/state')).json();
    expect(JSON.stringify(wsAfter)).toBe(JSON.stringify(wsBefore));
    expect(await windowFocusMap(request)).toEqual(focusBefore);
    expect(await clientActive()).toBe(activeBefore);
  });

  // FR-RUN-7: 멤버 등록은 탭에 runId 표식을 남기고 close 가 되돌린다.
  // 표식은 보조이며 진실은 runs.json 이다 — 그래서 실패해도 등록은 성공한다.
  test('멤버 등록이 워크스페이스에 runId 표식을 남긴다', async ({ request }) => {
    const { uuid } = await firstTab(request);
    const run = await (
      await request.post('/api/runs', {
        data: { objective: '표식 확인', projection: 'inline', isolation: 'none' },
      })
    ).json();
    await request.post('/api/runs/members', {
      data: { runId: run.id, role: 'marker', agent: 'claude', id: uuid },
    });

    const findTab = async () => {
      const state = await (await request.get('/api/state')).json();
      const walk = (n: any): any => {
        if (!n) return null;
        for (const t of n.tabs || []) if (t.id === uuid) return t;
        for (const c of n.children || []) { const r = walk(c); if (r) return r; }
        return null;
      };
      for (const w of state.workspace?.windows || []) {
        const t = walk(w.layout);
        if (t) return t;
      }
      return null;
    };

    const marked = await findTab();
    expect(marked?.runId, '탭에 runId 표식이 없다').toBe(run.id);
    // 표식이 기존 필드를 훼손하면 안 된다.
    expect(marked?.toolId).toBeTruthy();

    await request.post('/api/runs/close', { data: { runId: run.id, force: true } });
    const cleared = await findTab();
    expect(cleared?.runId, 'close 후에도 표식이 남았다').toBeUndefined();
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

// 묶음 W — worktree 격리 (RUN_ORCHESTRATION_SRS §3.4). 여기서만 확인할 수 있는
// 것은 **실제 바이너리의 배선**이다: Go 테스트는 서버 구조체에 관리자를 직접
// 꽂지만, 운영 경로에서는 main 이 $DONGMINAL_HOME/worktrees 로 만들어 주입한다.
//
// 대상 저장소는 이 스펙이 만든 임시 저장소다 — 운영 저장소·사용자 홈을 건드리지
// 않는다 (§4.3, 함정 1~3).
test.describe('worktree 격리의 HTTP 계약 (라이브)', () => {
  let repo = '';

  test.beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'dmn-e2e-repo-'));
    repo = realpathSync(repo);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    git('init', '-b', 'main');
    git('config', 'user.email', 'e2e@example.com');
    git('config', 'user.name', 'e2e');
    writeFileSync(join(repo, 'README.md'), 'x\n');
    git('add', '.');
    git('commit', '-m', 'init');
  });

  test.afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  test('격리 Run 이 트리를 만들고 close 가 정리한다', async ({ page, request }) => {
    await waitForInit(page);
    const { uuid, toolId } = await firstTab(request);

    const started = await request.post('/api/runs', {
      data: { objective: 'e2e 격리', projection: 'inline', isolation: 'per-run', cwd: repo },
    });
    expect(started.status(), await started.text()).toBe(200);
    const run = await started.json();
    expect(run.repo).toBe(repo);
    expect(run.base).toBe('main');
    const wt = run.worktree;
    expect(wt?.path, '공유 worktree 가 없다').toBeTruthy();
    // 관리 루트 밖에 만들면 정리의 안전 가드가 무의미해진다 (FR-WKT-10). 루트는
    // $DONGMINAL_HOME/worktrees 다. (playwright.config 의 E2E_HOME 을 여기서 읽지
    // 않는 이유: 그 값은 모듈 평가 시점의 Date.now()·pid 라 워커 프로세스에서
    // 다시 계산되어 서버가 쓰는 값과 어긋난다.)
    expect(wt.path, `worktrees 루트 밖이다: ${wt.path}`)
      .toMatch(/dongminal-e2e-[^/]+\/worktrees\//);
    expect(existsSync(wt.path), '경로가 실제로 만들어지지 않았다').toBe(true);
    // --no-track: base 의 upstream 을 물려받지 않는다 (FR-WKT-2).
    expect(() => execFileSync('git', ['rev-parse', '--abbrev-ref', `${wt.branch}@{upstream}`],
      { cwd: wt.path, stdio: 'pipe' })).toThrow();

    const added = await request.post('/api/runs/members', {
      data: { runId: run.id, role: 'e2e-writer', agent: 'claude', id: uuid },
    });
    expect(added.status()).toBe(200);
    const member = await added.json();
    expect(member.worktree.path, 'per-run 멤버는 공유 트리를 받는다').toBe(wt.path);
    // FR-PRE-4: 멤버가 자기 작업 위치를 화면에서 추론하게 두지 않는다.
    expect(member.preamble).toContain(wt.path);

    await request.post('/api/runs/report', {
      data: { toolId, outcome: 'succeeded', summary: '했다. 봤다. 남았다.' },
    });
    const closed = await request.post('/api/runs/close', { data: { runId: run.id } });
    expect(closed.status()).toBe(200);
    const body = await closed.json();
    expect(body.worktrees).toHaveLength(1);
    expect(body.worktrees[0].removed, `잔여물: ${JSON.stringify(body.worktrees[0])}`).toBe(true);
    expect(body.residue).toBe(0);
    expect(existsSync(wt.path), 'clean 트리가 정리되지 않았다').toBe(false);

    await request.post('/api/tools/activity/set', { data: { toolId, state: 'idle' } });
  });

  test('dirty 트리는 보존되고 잔여물로 보고된다', async ({ page, request }) => {
    await waitForInit(page);
    const { uuid, toolId } = await firstTab(request);

    const run = await (await request.post('/api/runs', {
      data: { objective: 'e2e 잔여물', projection: 'inline', isolation: 'per-member', cwd: repo },
    })).json();
    const member = await (await request.post('/api/runs/members', {
      data: { runId: run.id, role: 'e2e-dirty', agent: 'claude', id: uuid },
    })).json();
    const path = member.worktree.path;
    // 경로 확인 뒤에만 쓴다 — 빈 값이면 join 이 이 저장소 안에 파일을 만든다 (§4.3).
    expect(path, `worktrees 루트 밖이다: ${path}`).toMatch(/dongminal-e2e-[^/]+\/worktrees\//);
    const work = join(path, '작업물.txt');
    writeFileSync(work, '지우면 안 된다\n');

    const closed = await (await request.post('/api/runs/close',
      { data: { runId: run.id, force: true } })).json();
    expect(closed.worktrees[0].residue).toBe('dirty');
    expect(closed.residue).toBe(1);
    expect(existsSync(work), '사용자 작업이 삭제됐다').toBe(true);

    // 기록이 잔여물을 기억한다 — close 를 지켜보지 못한 세션이 알 유일한 경로다.
    const status = await (await request.get(`/api/runs?id=${run.id}`)).json();
    expect(status.members[0].worktree.residue).toBe('dirty');

    rmSync(path, { recursive: true, force: true });
    execFileSync('git', ['worktree', 'prune'], { cwd: repo, stdio: 'pipe' });
    await request.post('/api/tools/activity/set', { data: { toolId, state: 'idle' } });
  });

  test('비git 디렉터리의 격리 Run 은 명확히 실패한다', async ({ request }) => {
    const plain = realpathSync(mkdtempSync(join(tmpdir(), 'dmn-e2e-plain-')));
    const r = await request.post('/api/runs', {
      data: { objective: 'e2e 비git', projection: 'inline', isolation: 'per-member', cwd: plain },
    });
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toBe('not_a_git_repo');
    rmSync(plain, { recursive: true, force: true });
  });
});
