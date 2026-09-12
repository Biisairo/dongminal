import { Page } from '@playwright/test';

import {
  test, expect, waitForInit, gotoSettled,
} from './fixtures';

// 묶음 V (ORCHESTRATION_V2_SRS §3.5) — Run 시각화의 **브라우저 쪽**.
//
// 서버 계약(V-RVZ-10 응답에 본문이 없음, V-RVZ-11 메시지 500건 상한)은
// internal/webserver/httpapi 의 Go 테스트가 맡는다. 여기서 고정하는 것은 화면이
// 그 응답을 어떻게 그리는가다 — 그래서 `/api/runs` 와 `/api/runs/<id>/graph` 를
// route 로 흉내 낸다. 실제 Run 을 띄우면 멤버 상태·컨텍스트 추정이 시간에 따라
// 흔들려 `점선 2개` 같은 단정이 결정론적이지 않다.
//
// V-RVZ-4(폴링 0건)는 서버가 SSE 를 실제로 쏘아야 확인되므로 여기 없다 — 통합
// 단계에서 조정자가 확인한다. 대신 SSE 수신 경로(_onRunChanged)가 화면을
// 깨뜨리지 않는다는 것(V-RVZ-12)은 여기서 고정한다.

const RUN_EMPTY_TEXT = '진행 중인 Run 이 없다';
const RUN_GONE_TEXT = '이 Run 은 더 이상 없다';

const RUN_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const RUN_B = 'bbbbbbbb-2222-4222-8222-222222222222';

// 서버 시각은 Unix **초**다 (internal/webserver/domain/run/store.go 의 now()).
const NOW = () => Math.floor(Date.now() / 1000);

// 계약은 omitempty 다 — 없는 값은 **키 자체가 없다**. 고정된 형을 세우면 그
// 사실이 스펙에서 사라지므로 느슨하게 둔다.
//
// 항상 있는 키는 넷뿐이다 — `members`·`edges`·`messages`·`timeline` (비면 `[]`).
// `headless` 는 false 면 키가 없으므로 아래 헬퍼도 참일 때만 싣는다.
type Json = Record<string, any>;

function member(id: string, role: string, over: Json = {}): Json {
  return { id, role, agent: 'claude', toolId: 'tool-' + id, state: 'working', createdAt: NOW() - 300, ...over };
}

// 멤버 5명(헤드리스 2) · 승계 1쌍 · critical 1명 · 실측 토큰 1명 —
// V-RVZ-5·6·7 과 V-12 가 한 Run 에서 읽힌다.
function graphA(): Json {
  const t = NOW();
  const members = [
    member('m1', '작가'),
    member('m2', '비평가', { headless: true, state: 'waiting', contextRatio: 0.31, contextLevel: 'ok' }),
    member('m3', '심판', { headless: true, state: 'working', contextRatio: 0.93, contextLevel: 'critical' }),
    // 승계로 들어온 멤버는 `succeededFrom` 을 들고 오며, 서버는 이 멤버에
    // `member_add` 를 내지 않고 `succeed` 만 낸다 (같은 시각에 두 줄이 되지 않게).
    member('m4', '기록', { state: 'succeeded', succeededFrom: 'm1', tabId: 'tab-m4' }),
    // FR-RCX-1·2: **실측 토큰**을 가진 멤버. 추정(`~`)과 실측을 한 화면에서
    // 가르려면 둘 다 있어야 한다 (m3 가 추정 쪽이다).
    member('m5', '편집', {
      state: 'working', contextRatio: 0.128, contextLevel: 'ok',
      contextTokens: 128000, contextLimit: 1000000,
    }),
  ];
  return {
    runId: RUN_A, short: 'a1b2', objective: '토론으로 초안을 다듬는다',
    state: 'open', isolation: 'per-member',
    createdAt: t - 720, coordinatorToolId: 'tool-coord',
    members,
    // 방향 있는 (from,to) 쌍마다 1건이다 — A→B 와 B→A 는 합쳐지지 않는다.
    // `count` 는 **보관된 메시지** 기준이며 500건 상한에 잘린 건은 빠진다.
    edges: [
      { from: 'coordinator', to: 'm1', count: 12, lastAt: t - 5 },
      { from: 'm1', to: 'coordinator', count: 3, lastAt: t - 600 },
      { from: 'm1', to: 'm2', count: 40, lastAt: t - 900 },
      // 끝점이 이 Run 의 멤버가 아닌 엣지 — 팀 간 통신이면 다른 Run 의 멤버
      // uuid 가 온다. 화면은 죽지 않고 이것을 건너뛴다 (V-RVZ-5 가 함께 센다).
      { from: 'm1', to: 'outsider-9999', count: 5, lastAt: t - 40 },
    ],
    messages: [],
    // `text` 의 뜻은 kind 마다 다르다 — run_start=목적, member_add·succeed=역할,
    // report=`succeeded|failed`, close=abort 사유(정상 종료면 키 없음).
    // 시간 오름차순으로 이미 정렬돼 온다.
    timeline: [
      { at: t - 720, kind: 'run_start', text: '토론으로 초안을 다듬는다' },
      { at: t - 700, kind: 'member_add', memberId: 'm1', text: '작가' },
    ],
  };
}

function graphB(): Json {
  const t = NOW();
  return {
    runId: RUN_B, short: 'c3d4', objective: '리팩터 검토',
    state: 'closed', isolation: 'none',
    createdAt: t - 60, closedAt: t - 10, coordinatorToolId: 'tool-coord-b',
    members: [member('n1', '검토자', { state: 'done', outcome: 'succeeded', tabId: 'tab-n1', reportedAt: t - 20 })],
    edges: [], messages: [],
    timeline: [
      { at: t - 60, kind: 'run_start', text: '리팩터 검토' },
      { at: t - 20, kind: 'report', memberId: 'n1', text: 'succeeded' },
    ],
  };
}

// 모달의 목록은 /api/runs 이며 레코드 요약이다 (graph 와 다른 종단이다).
function listOf(...graphs: Json[]) {
  return graphs.map((g) => ({
    id: g.runId, short: g.short, objective: g.objective,
    state: g.state, isolation: g.isolation, createdAt: g.createdAt,
    members: g.members,
  }));
}

async function mockRuns(page: Page, list: Json[], graphs: Record<string, Json>) {
  // `**/api/runs` 는 그 경로로 **끝나는** URL 만 잡는다 — /graph 는 걸리지 않는다.
  await page.route('**/api/runs', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ runs: list }) }));
  await page.route('**/api/runs/*/graph', (route) => {
    const id = new URL(route.request().url()).pathname.split('/')[3];
    const g: Json | undefined = graphs[id];
    // FR-RVZ-9 의 근거는 404 다 — 없는 Run 은 오류가 아니라 상태다.
    if (!g) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"unknown_run"}' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(g) });
  });
}

async function openModal(page: Page) {
  await page.click('#runs-btn');
  await expect(page.locator('#runs-modal .runs-box')).toBeVisible();
}

const runRow = (page: Page, id: string) => page.locator(`#runs-modal .runs-row[data-runid="${id}"]`);

// 활성 창의 탭 개수. 새 탭이 생겼는지/안 생겼는지를 세는 유일한 자리다.
function tabCount(page: Page) {
  return page.evaluate(() => {
    const app = (window as any).app;
    const w = app.ws.windows.find((x: any) => x.id === app.ws.activeWindow);
    let c = 0;
    const walk = (n: any) => { if (!n) return; c += (n.tabs || []).length; for (const ch of n.children || []) walk(ch) };
    walk(w?.layout);
    return c;
  });
}

function runTabs(page: Page) {
  return page.evaluate(() => {
    const app = (window as any).app;
    const out: { id: string; runId: string; name: string }[] = [];
    const walk = (n: any) => {
      if (!n) return;
      for (const t of n.tabs || []) if (t.type === 'run') out.push({ id: t.id, runId: t.runId, name: t.name });
      for (const c of n.children || []) walk(c);
    };
    for (const w of app.ws.windows) walk(w.layout);
    return out;
  });
}

test.describe('Run 시각화 (묶음 V)', () => {

  test('V-RVZ-1: Run 0개면 모달이 빈 안내를 낸다', async ({ page }) => {
    await mockRuns(page, [], {});
    await waitForInit(page);
    await openModal(page);

    await expect(page.locator('#runs-modal .runs-empty-t')).toHaveText(RUN_EMPTY_TEXT);
    // FR-RVZ-4: 다음 행동을 함께 낸다 — "없다" 만으로는 무엇을 하라는 말이 없다.
    await expect(page.locator('#runs-modal .runs-empty-h')).toContainText('/dongminal:team');
    await expect(page.locator('#runs-modal .runs-row')).toHaveCount(0);
  });

  test('V-RVZ-2: 행을 클릭하면 모달이 닫히고 현재 분할 칸에 대시보드 탭이 생긴다', async ({ page }) => {
    const a = graphA(), b = graphB();
    await mockRuns(page, listOf(a, b), { [RUN_A]: a, [RUN_B]: b });
    await waitForInit(page);
    const before = await tabCount(page);

    await openModal(page);
    await expect(page.locator('#runs-modal .runs-row')).toHaveCount(2);
    await runRow(page, RUN_A).click();

    await expect(page.locator('#runs-modal')).toHaveCount(0);
    expect(await tabCount(page)).toBe(before + 1);

    // FR-RVZ-8: 이름은 `Run <short>` 다.
    const tabs = await runTabs(page);
    expect(tabs).toHaveLength(1);
    expect(tabs[0].name).toBe('Run a1b2');
    expect(tabs[0].runId).toBe(RUN_A);

    // FR-RVZ-10: 네 영역이 전부 그려진다.
    const view = page.locator('#area .run-view.vis');
    await expect(view).toBeVisible();
    await expect(view.locator('.run-summary')).toContainText('Run a1b2');
    await expect(view.locator('.run-summary')).toContainText('토론으로 초안을 다듬는다');
    await expect(view.locator('.run-graph')).toBeVisible();
    await expect(view.locator('.run-card')).toHaveCount(5);
    await expect(view.locator('.run-tl-row')).toHaveCount(2);
  });

  test('V-RVZ-3: 같은 Run 을 다시 열면 새 탭이 생기지 않고 기존 탭으로 포커스가 간다', async ({ page }) => {
    const a = graphA(), b = graphB();
    await mockRuns(page, listOf(a, b), { [RUN_A]: a, [RUN_B]: b });
    await waitForInit(page);

    await openModal(page);
    await runRow(page, RUN_A).click();
    await expect(page.locator('#area .run-view.vis')).toBeVisible();
    const after1 = await tabCount(page);
    const firstTabId = (await runTabs(page))[0].id;

    // 다른 탭을 활성으로 만들어 두어야 "포커스가 옮겨졌다"가 관측된다.
    await page.evaluate(() => (window as any).app.addTab((window as any).app.focused));
    await expect.poll(() => tabCount(page)).toBe(after1 + 1);

    await openModal(page);
    await runRow(page, RUN_A).click();

    // FR-RVZ-7: 탭은 늘지 않는다.
    expect(await tabCount(page)).toBe(after1 + 1);
    expect(await runTabs(page)).toHaveLength(1);
    // 그리고 그 탭이 활성이다.
    const active = await page.evaluate(() => {
      const app = (window as any).app;
      const w = app.ws.windows.find((x: any) => x.id === app.ws.activeWindow);
      let id: string | null = null;
      const walk = (n: any) => {
        if (!n) return;
        if (n.tabs && n.id === app.focused) id = n.activeTab;
        for (const c of n.children || []) walk(c);
      };
      walk(w?.layout);
      return id;
    });
    expect(active).toBe(firstTabId);
    await expect(page.locator('#area .run-view.vis')).toBeVisible();
  });

  test('V-RVZ-5: 헤드리스 멤버는 점선 노드다 (5명 중 2명)', async ({ page }) => {
    const a = graphA();
    await mockRuns(page, listOf(a), { [RUN_A]: a });
    await waitForInit(page);
    await openModal(page);
    await runRow(page, RUN_A).click();
    await expect(page.locator('#area .run-view.vis')).toBeVisible();

    const view = page.locator('#area .run-view.vis');
    // 조정자 노드는 멤버가 아니므로 세지 않는다.
    await expect(view.locator('.run-node:not(.coord)')).toHaveCount(5);
    await expect(view.locator('.run-node.headless')).toHaveCount(2);
    await expect(view.locator('.run-node:not(.coord):not(.headless)')).toHaveCount(3);
    // 점선은 클래스가 아니라 실제로 그려진 선이어야 한다.
    const dash = await view.locator('.run-node.headless .run-node-box').first()
      .evaluate((el) => getComputedStyle(el).strokeDasharray);
    expect(dash).not.toBe('none');

    // 끝점이 이 Run 의 멤버가 아닌 엣지는 노드도 선도 만들지 않는다 —
    // 화면이 죽지도, 이름 없는 상자를 세우지도 않는다.
    await expect(view.locator('.run-node[data-node="outsider-9999"]')).toHaveCount(0);
    await expect(view.locator('.run-edge-msg')).toHaveCount(3);
  });

  test('V-RVZ-6: critical 멤버는 노드 게이지와 모달 행 배지로 드러난다', async ({ page }) => {
    const a = graphA();
    await mockRuns(page, listOf(a), { [RUN_A]: a });
    await waitForInit(page);
    await openModal(page);

    // 모달 행의 경고 배지 — critical 이 하나라도 있으면 그것이 이긴다.
    await expect(runRow(page, RUN_A).locator('.runs-ctx.lv-critical')).toBeVisible();

    await runRow(page, RUN_A).click();
    const view = page.locator('#area .run-view.vis');
    await expect(view).toBeVisible();
    // 노드 하단 게이지가 오류색이다.
    await expect(view.locator('.run-node[data-node="m3"] .run-gauge.lv-critical')).toHaveCount(1);
    // 추정이 없는 멤버(m1)에는 게이지 자체가 없다 — "모른다" 는 ok 가 아니다.
    await expect(view.locator('.run-node[data-node="m1"] .run-gauge')).toHaveCount(0);
    await expect(view.locator('.run-card[data-member="m3"] .run-card-ctx.lv-critical')).toBeVisible();
  });

  /**
   * ALERT_MOBILE_CONTEXT_SRS V-12 (FR-RCX-1·2·5) — **숫자가 툴팁 밖으로 나온다.**
   *
   * 툴팁은 마우스를 올려야 보이고 터치에는 없다. 접수한 말("run 의 context
   * 표기")이 그 자리를 본문으로 옮기라는 것이다.
   */
  test('V-12 (FR-RCX-1·2·5): 카드 본문에 토큰·한계·퍼센트가 있다', async ({ page }) => {
    const a = graphA();
    await mockRuns(page, listOf(a), { [RUN_A]: a });
    await waitForInit(page);
    await openModal(page);
    await runRow(page, RUN_A).click();
    const view = page.locator('#area .run-view.vis');
    await expect(view).toBeVisible();

    // 실측 토큰이 있는 멤버는 **무엇을 무엇으로 나눈 값인지**를 본문에 적는다.
    await expect(view.locator('.run-card[data-member="m5"] .run-card-ctx'))
      .toHaveText('128k / 1.0M · 13%');   // `_runTokens` 는 M 단위에 소수 한 자리다
    // FR-RCX-2: 실측이 없어 바이트 추정으로 낸 값은 `~` 를 유지한다 — 추정과
    // 실측이 같은 얼굴이면 안 된다.
    await expect(view.locator('.run-card[data-member="m3"] .run-card-ctx'))
      .toHaveText('ctx ~93% ⚠');
    // FR-RCX-5: 값이 없으면 아무것도 적지 않는다. "모른다" 와 "0%" 는 다르다.
    await expect(view.locator('.run-card[data-member="m1"] .run-card-ctx')).toHaveCount(0);
  });

  /**
   * V-14 (FR-RCX-9·11) — **조정자도 자기 사용량을 보인다.**
   *
   * 접수한 물음("조정자 스스로의 context 사용량은 확인 못하나?")의 화면 쪽이다.
   * 서버가 관측을 버리던 자리를 고쳤고(FR-RCX-6), 여기서는 그것이 그려지는지 잰다.
   */
  test('V-14 (FR-RCX-9): 조정자 노드에 게이지와 숫자가 뜬다', async ({ page }) => {
    const a = graphA();
    a.coordinator = { contextTokens: 700000, contextLimit: 1000000, contextRatio: 0.7, contextLevel: 'warn' };
    await mockRuns(page, listOf(a), { [RUN_A]: a });
    await waitForInit(page);
    await openModal(page);
    await runRow(page, RUN_A).click();
    const view = page.locator('#area .run-view.vis');
    await expect(view).toBeVisible();

    const coord = view.locator('.run-node.coord');
    await expect(coord.locator('.run-gauge.lv-warn')).toHaveCount(1);
    await expect(coord.locator('.run-node-ctx')).toHaveText('70%');
  });

  // FR-RCX-11: 필드가 없던 옛 레코드는 빈 값이며 아무것도 그리지 않는다.
  test('V-14 (FR-RCX-11): 조정자 관측이 없으면 아무것도 그리지 않는다', async ({ page }) => {
    const a = graphA();
    await mockRuns(page, listOf(a), { [RUN_A]: a });
    await waitForInit(page);
    await openModal(page);
    await runRow(page, RUN_A).click();
    const view = page.locator('#area .run-view.vis');
    await expect(view).toBeVisible();

    await expect(view.locator('.run-node.coord .run-gauge')).toHaveCount(0);
    await expect(view.locator('.run-node.coord .run-node-ctx')).toHaveCount(0);
  });

  test('V-RVZ-7: 승계가 있으면 굵은 화살표가 그려진다', async ({ page }) => {
    const a = graphA();
    await mockRuns(page, listOf(a), { [RUN_A]: a });
    await waitForInit(page);
    await openModal(page);
    await runRow(page, RUN_A).click();
    const view = page.locator('#area .run-view.vis');
    await expect(view).toBeVisible();

    // m1 → m4 (m4.succeededFrom === 'm1'). 승계는 메시지 엣지와 다른 종류다.
    const succ = view.locator('.run-edge-succ');
    await expect(succ).toHaveCount(1);
    const w = await succ.evaluate((el) => parseFloat(getComputedStyle(el).strokeWidth));
    const msgW = await view.locator('.run-edge-msg').first()
      .evaluate((el) => parseFloat(getComputedStyle(el).strokeWidth));
    expect(w).toBeGreaterThan(msgW);
  });

  // 이 테스트가 "탭 0개" 로 실패하면 원인은 화면이 아니라 `web/js/core/helpers.js`
  // 의 `clean()` 이다 — 도구에 매이지 않은 탭의 면제 목록이 타입 이름으로
  // 열거돼 있어서, 거기 'run' 이 없으면 로드마다 탭이 버려진다.
  test('V-RVZ-8: Run 탭은 새로고침 후에도 남고 대시보드가 복원된다', async ({ page, request }) => {
    const a = graphA();
    await mockRuns(page, listOf(a), { [RUN_A]: a });
    await waitForInit(page);
    await openModal(page);
    await runRow(page, RUN_A).click();
    await expect(page.locator('#area .run-view.vis')).toBeVisible();

    // 저장이 서버에 닿은 뒤에 새로고침한다 — 닿기 전이면 확인하는 것이 없다.
    await expect.poll(async () => {
      const r = await request.get('/api/workspace');
      return r.ok() ? (await r.text()).includes('"type":"run"') : false;
    }, { timeout: 10000 }).toBe(true);

    await page.reload();
    await page.waitForSelector('#area .pn', { timeout: 15000 });

    const tabs = await runTabs(page);
    expect(tabs).toHaveLength(1);
    expect(tabs[0].runId).toBe(RUN_A);
    await expect(page.locator('#area .run-view.vis')).toBeVisible();
    await expect(page.locator('#area .run-view.vis .run-summary')).toContainText('Run a1b2');
  });

  test('V-RVZ-9: Run 이 사라지면 그렇게 말하고 탭은 남는다', async ({ page }) => {
    const a = graphA();
    await mockRuns(page, listOf(a), { [RUN_A]: a });
    await waitForInit(page);
    await openModal(page);
    await runRow(page, RUN_A).click();
    await expect(page.locator('#area .run-view.vis')).toBeVisible();
    const before = await tabCount(page);

    // Run 이 사라졌다 — /graph 가 404 를 낸다.
    await mockRuns(page, [], {});
    await page.evaluate((id) => (window as any).app.testing.onRunChanged({ runId: id }), RUN_A);

    await expect(page.locator('#area .run-view .run-miss.vis')).toHaveText(RUN_GONE_TEXT);
    // FR-RVZ-9: 탭을 자동으로 닫지 않는다 — 사용자가 만든 것은 사용자가 닫는다.
    expect(await tabCount(page)).toBe(before);
    expect(await runTabs(page)).toHaveLength(1);
  });

  test('V-RVZ-12: SSE 갱신이 hover 를 깨뜨리지 않는다', async ({ page }) => {
    const a = graphA();
    await mockRuns(page, listOf(a), { [RUN_A]: a });
    await waitForInit(page);
    await openModal(page);
    await runRow(page, RUN_A).click();
    await expect(page.locator('#area .run-view.vis')).toBeVisible();

    const node = page.locator('#area .run-view.vis .run-node[data-node="m1"]');
    await node.hover();
    // 갱신을 견딘 것이 **같은 요소**인지 보려면 값으로 되살아나지 않는 표식이
    // 필요하다 — dataset 은 다시 그려도 복원되므로 쓸 수 없다.
    await node.evaluate((el) => { (el as any).__probe = 'keep' });
    expect(await node.evaluate((el) => el.matches(':hover'))).toBe(true);

    // 타임라인만 늘어난 갱신. 노드가 읽는 값은 하나도 바뀌지 않았다.
    const next = graphA();
    // report 의 text 는 결과 문자열이다 (`succeeded|failed`).
    next.timeline = [...a.timeline, { at: NOW(), kind: 'report', memberId: 'm1', text: 'succeeded' }];
    await mockRuns(page, listOf(next), { [RUN_A]: next });
    await page.evaluate((id) => (window as any).app.testing.onRunChanged({ runId: id }), RUN_A);

    await expect(page.locator('#area .run-view.vis .run-tl-row')).toHaveCount(3);
    // NFR-RVZ-2: 같은 요소가 그대로 서 있고 hover 도 그대로다.
    expect(await node.evaluate((el) => (el as any).__probe)).toBe('keep');
    expect(await node.evaluate((el) => el.matches(':hover'))).toBe(true);
  });
});

/**
 * `12-func-ui.md FUI-04` — **Run 을 기록을 잃지 않고 멈춘다.**
 *
 * 접수한 결함: *"Run 을 UI 에서 중단·정리할 길이 없다 — 유일한 출구가 기록까지
 * 지우는 삭제. 서버는 `close`·`detach` 를 이미 노출한다."*
 */
test.describe('FUI-04 — Run 의 출구', () => {
  // 종단을 가로채 **무엇이 나갔는지**를 잰다. 실제 Run 을 띄우면 멤버 상태가
  // 시간에 따라 흔들려 단정이 결정론적이지 않다 (이 파일의 규약).
  function captureRunPost(page: Page, path: string) {
    const seen: any[] = [];
    page.route('**' + path, (route) => {
      seen.push(JSON.parse(route.request().postData() || '{}'));
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    });
    return seen;
  }

  test('V-FUI-4a: 열린 Run 에만 종료가 서고, 닫힌 Run 에는 서지 않는다', async ({ page }) => {
    const a = graphA(), b = graphB();   // a=open, b=closed
    await mockRuns(page, listOf(a, b), { [RUN_A]: a, [RUN_B]: b });
    await waitForInit(page);
    await openModal(page);

    await expect(runRow(page, RUN_A).locator('.runs-close')).toHaveCount(1);
    // 끝난 것을 또 끝내는 버튼은 뜻이 없다.
    await expect(runRow(page, RUN_B).locator('.runs-close')).toHaveCount(0);
    // 삭제는 둘 다에 남는다 — 종료가 삭제를 대신하지 않는다.
    await expect(runRow(page, RUN_A).locator('.runs-del')).toHaveCount(1);
    await expect(runRow(page, RUN_B).locator('.runs-del')).toHaveCount(1);
  });

  test('V-FUI-4b: 종료는 확인을 거치고 그 문구가 삭제와 다르다', async ({ page }) => {
    const a = graphA();
    await mockRuns(page, listOf(a), { [RUN_A]: a });
    const posts = captureRunPost(page, '/api/runs/close');
    await waitForInit(page);
    await openModal(page);

    await runRow(page, RUN_A).locator('.runs-close').click();
    const confirm = runRow(page, RUN_A).locator('.runs-confirm');
    await expect(confirm).toHaveAttribute('data-kind', 'close');
    // **기록이 남는다** 는 것이 두 출구의 차이 전부다 — 문구가 그것을 말한다.
    await expect(confirm.locator('.runs-q')).toContainText('기록은 남는다');
    expect(posts).toHaveLength(0);   // 확인 전에는 아무것도 나가지 않는다

    await confirm.locator('.runs-yes').click();
    await expect.poll(() => posts.length, { timeout: 10000 }).toBe(1);
    expect(posts[0].runId).toBe(RUN_A);
    // `force` 가 없으면 미보고 멤버에서 서버가 거부하고, 사용자는 그 목록을
    // 화면에서 해소할 길이 없다.
    expect(posts[0].force).toBe(true);
  });

  test('V-FUI-4c: 삭제의 확인은 그대로 남는다 — 두 출구가 섞이지 않는다', async ({ page }) => {
    const a = graphA();
    await mockRuns(page, listOf(a), { [RUN_A]: a });
    await waitForInit(page);
    await openModal(page);

    await runRow(page, RUN_A).locator('.runs-del').click();
    const confirm = runRow(page, RUN_A).locator('.runs-confirm');
    await expect(confirm).toHaveAttribute('data-kind', 'delete');
    await expect(confirm.locator('.runs-q')).toContainText('기록도 함께 사라진다');
  });

  test('V-FUI-4d: 붙어 있는 멤버 카드에만 분리가 서고, 누르면 detach 가 나간다',
    async ({ page }) => {
      const a = graphA();
      await mockRuns(page, listOf(a), { [RUN_A]: a });
      const posts = captureRunPost(page, '/api/runs/detach');
      await waitForInit(page);
      await openModal(page);
      await runRow(page, RUN_A).click();
      await expect(page.locator('#area .run-view.vis')).toBeVisible();

      const cards = page.locator('#area .run-view.vis .run-card');
      await expect(cards.first()).toBeVisible();
      // `tabId` 없는 멤버(헤드리스)는 서버가 `member_not_attached` 로 거절한다 —
      // 누를 수 있게 보이면 그 버튼은 거짓말이다.
      const attached = page.locator('#area .run-view.vis .run-card:has(.run-card-detach)');
      const n = await attached.count();
      expect(n).toBeGreaterThan(0);
      expect(n).toBeLessThan(await cards.count());

      const id = await attached.first().getAttribute('data-member');
      await attached.first().locator('.run-card-detach').click();
      await expect.poll(() => posts.length, { timeout: 10000 }).toBe(1);
      expect(posts[0].memberId).toBe(id);
    });

  test('V-FUI-4e: 분리 클릭이 그 도구로 끌고 가지 않는다', async ({ page }) => {
    const a = graphA();
    await mockRuns(page, listOf(a), { [RUN_A]: a });
    captureRunPost(page, '/api/runs/detach');
    await waitForInit(page);
    await openModal(page);
    await runRow(page, RUN_A).click();
    await expect(page.locator('#area .run-view.vis')).toBeVisible();
    const before = await tabCount(page);

    await page.locator('#area .run-view.vis .run-card .run-card-detach').first().click();
    // **예외 (`TEST-16`)**: 탭이 **늘지 않음**을 잰다.
    await page.waitForTimeout(500);
    // 카드 클릭은 "그 도구로 간다" 다. 분리하려는 손이 거기로 끌려가면 무엇이
    // 일어났는지 읽히지 않는다.
    expect(await tabCount(page)).toBe(before);
  });
});

/**
 * 묶음 RUN — **슬롯을 인지하는 점프와 지목** (FR-RUN-1·2·6a·6b).
 *
 * Run 카드 클릭이 지나는 길이다. 종전에는 `ws.activeWindow` 만 바꿔서, 슬롯
 * 모드에서는 아무 일도 일어나지 않았다.
 *
 * `TEST-7` 로 `ux-batch6` 에서 옮겨 왔다 — 납품 묶음이 아니라 **이 기능**이
 * 주제인 자리다. 단정은 옮기면서 바꾸지 않았다.
 */

// ── 묶음 N — 슬롯을 인지하는 점프 ────────────────────

// V-RUN-1 (FR-RUN-1): 점프하면 **포커스 칸이 그 창을 받는다.**
//
// 종전에는 `ws.activeWindow` 만 바꿨다. 슬롯 모드에서 무엇이 보이는가는
// `_slots.windows` 가 정하므로 아무 일도 일어나지 않았다 — Run 카드 클릭이
// 그 길을 지난다 (접수 ⑧).
//
// **포커스 칸을 옮기지 않는 것**이 요점이다 — 사용자가 서 있는 칸에 떠야 한다
// (FR-SVS-12). `switchWindow` 와 같은 한 줄을 지난다.
test('V-RUN-1 (FR-RUN-1): 점프하면 포커스 칸이 그 창을 받는다',
  async ({ page }) => {
    await waitForInit(page);
    const info = await page.evaluate(async () => {
      const a = (window as any).app;
      await a.addWindow();            // 둘째 창
      const wins = a.testing.plainWindows();
      const w0 = wins[0], w1 = wins[wins.length - 1];
      a.slotAdd();
      a.slotOpen(0, w0.id);
      a.slotOpen(1, w1.id);
      a.slotFocusTo(0);
      a.render();
      return {
        focusedBefore: a.testing.slotFocused(),
        slot0Before: a.testing.slots.windows[0],
        target: w1.layout.tabs[0].toolId, w0: w0.id, w1: w1.id,
      };
    });
    expect(info.focusedBefore).toBe(0);
    expect(info.slot0Before).toBe(info.w0);
    expect(info.target).toBeTruthy();

    const after = await page.evaluate((toolId: string) => {
      const a = (window as any).app;
      a.testing.jumpToTool(toolId);
      return { focused: a.testing.slotFocused(), slot0: a.testing.slots.windows[0], active: a.ws.activeWindow };
    }, info.target);
    expect(after.focused, '포커스 칸이 옮겨졌다 — FR-SVS-12 가 깨진다').toBe(0);
    expect(after.slot0, '포커스 칸이 그 창을 받지 않았다 — 화면은 그대로다').toBe(info.w1);
    expect(after.active).toBe(info.w1);
  });

// 단일 슬롯의 동작은 종전과 같다 (FR-RUN-2).
test('V-RUN-1 (FR-RUN-2): 단일 슬롯의 점프는 종전과 같다', async ({ page }) => {
  await waitForInit(page);
  const got = await page.evaluate(async () => {
    const a = (window as any).app;
    await a.addWindow();
    const wins = a.testing.plainWindows();
    const w1 = wins[wins.length - 1];
    a.switchWindow(wins[0].id);
    const toolId = w1.layout.tabs[0].toolId;
    a.testing.jumpToTool(toolId);
    return { active: a.ws.activeWindow, want: w1.id, slots: !!a.testing.slots };
  });
  expect(got.slots, '단일 슬롯 전제가 깨졌다').toBe(false);
  expect(got.active).toBe(got.want);
});

// V-GLV-3 (FR-GLV-6): 거부당한 대상은 폴링이 다시 받지 않는다.

// ── 묶음 N — closeTab 의 지목 ────────────────────────

// V-RUN-4 (FR-RUN-6a): 서버가 방송하는 `closeTab` 은 **탭 uuid** 로 지목한다.
// 좌표는 자리라 앞의 탭이 닫히면 뒤의 것이 밀린다.
test('V-RUN-4 (FR-RUN-6a): uuid 로 지목한 탭이 닫힌다', async ({ page }) => {
  await waitForInit(page);
  const got = await page.evaluate(async () => {
    const a = (window as any).app;
    await a.addTab();
    const win = a.testing.aw();
    const tabs = win.layout.tabs;
    const victim = tabs[0].id;
    a.testing.execRemote('closeTab', { location: victim, force: true });
    await new Promise((r) => setTimeout(r, 600));
    const left = (a.testing.aw().layout.tabs || []).map((t: any) => t.id);
    return { victim, left };
  });
  expect(got.left, 'uuid 로 지목한 탭이 닫히지 않았다').not.toContain(got.victim);
});

// V-RUN-4 (FR-RUN-6b): 없는 자리를 지목하면 **아무것도 닫지 않는다.**
//
// 종전에는 포커스 탭이 닫혔다 — 이미 닫힌 탭을 한 번 더 닫으라는 요청이 사용자의
// 터미널을 없앴다.
test('V-RUN-4 (FR-RUN-6b): 없는 자리를 지목한 closeTab 은 아무것도 닫지 않는다',
  async ({ page }) => {
    await waitForInit(page);
    const got = await page.evaluate(async () => {
      const a = (window as any).app;
      const before = (a.testing.aw().layout.tabs || []).map((t: any) => t.id);
      a.testing.execRemote('closeTab', { location: 'no-such-tab-uuid', force: true });
      await new Promise((r) => setTimeout(r, 600));
      const after = (a.testing.aw().layout.tabs || []).map((t: any) => t.id);
      return { before, after };
    });
    expect(got.after, '엉뚱한 탭을 닫았다').toEqual(got.before);
  });

/**
 * 묶음 DEL·FIT — **Run 삭제와 대시보드 맞춤** (FR-DEL-* · FR-FIT-*).
 *
 * Run 의 표면이 이 파일의 주제다 — 삭제가 확인을 거치고, 좁은 칸에서 카드가
 * 줄어든다.
 *
 * `TEST-7` 로 `ux-revision` 에서 옮겨 왔다 — 납품 묶음이 아니라 **이 기능**이
 * 주제인 자리다. 단정은 옮기면서 바꾸지 않았다.
 */

test.describe('묶음 D — Run 삭제 (FR-DEL-*)', () => {
  test('V-DEL-1·2·3: 삭제는 확인을 거치고, 버튼 클릭이 대시보드를 열지 않는다', async ({ page }) => {
    await gotoSettled(page);
    const toolId = await page.evaluate(() => {
      const app = (window as any).app;
      const w = app.ws.windows.find((x: any) => x.id === app.ws.activeWindow);
      return w.layout.tabs[0].toolId;
    });
    // Run 하나를 연다. 조정자는 이 창의 도구다 — 살아 있으므로 수거되지 않는다.
    // 앞선 스펙이 남긴 Run 이 목록에 있을 수 있으므로 **이 Run 의 행**만 본다.
    const runId = await page.evaluate(async ([tid]) => {
      const r = await fetch('/api/runs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ objective: 'e2e 삭제 대상', projection: 'dedicated-window', toolId: tid }),
      });
      return (await r.json()).id;
    }, [toolId]);

    await page.locator('#runs-btn').click();
    const row = page.locator(`#runs-modal .runs-row[data-runid="${runId}"]`);
    await expect(row).toBeVisible({ timeout: 10000 });
    const tabsBefore = await page.locator('.pn-tab').count();

    // FR-DEL-3: 첫 클릭은 확인이다.
    await row.locator('.runs-del').click();
    await expect(row.locator('.runs-confirm')).toBeVisible();
    // FR-DEL-2: 여기까지 탭이 하나도 늘지 않았다 — 대시보드가 열리지 않았다.
    expect(await page.locator('.pn-tab').count()).toBe(tabsBefore);

    await row.locator('.runs-yes').click();
    // FR-DEL-5: 그 행이 목록에서 사라진다.
    await expect(row).toHaveCount(0, { timeout: 10000 });
  });
});

// ── 묶음 F — 대시보드 맞춤 ──

test.describe('묶음 F — 대시보드 맞춤 (FR-FIT-*)', () => {
  test('V-FIT-2·3: 좁은 칸에서 축소되고, 넓은 칸에서 확대되지 않는다', async ({ page }) => {
    await gotoSettled(page);
    const toolId = await page.evaluate(() => {
      const app = (window as any).app;
      const w = app.ws.windows.find((x: any) => x.id === app.ws.activeWindow);
      return w.layout.tabs[0].toolId;
    });
    const runId = await page.evaluate(async ([tid]) => {
      const r = await fetch('/api/runs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ objective: 'e2e fit', projection: 'dedicated-window', toolId: tid }),
      });
      return (await r.json()).id;
    }, [toolId]);
    await page.evaluate(async ([id]) => {
      const app = (window as any).app;
      await app.addTab(app.focused, 'run', { runId: id, short: String(id).slice(0, 8) });
    }, [runId]);

    const svg = page.locator('.run-view .run-graph');
    await expect(svg).toBeVisible({ timeout: 10000 });
    // 멤버가 없으면 배치 폭은 RUN_MIN_W(720)이다. 1280 뷰포트에서는 남는 폭만큼
    // **키우되 상한(1.5배)을 넘지 않는다** (FR-FIT-3).
    await expect.poll(async () => Number(await svg.getAttribute('width')), { timeout: 10000 })
      .toBeGreaterThan(720);
    expect(Number(await svg.getAttribute('width'))).toBeLessThanOrEqual(720 * 1.5);

    // 칸을 좁힌다 — 사이드바를 넓혀 콘텐츠를 줄인다.
    await page.setViewportSize({ width: 700, height: 720 });
    await expect
      .poll(async () => Number(await svg.getAttribute('width')), { timeout: 10000 })
      .toBeLessThan(720);
    // FR-FIT-2: 비율이 유지된다 (viewBox 는 그대로, width/height 가 같은 비로 준다).
    const [w, h] = await Promise.all([svg.getAttribute('width'), svg.getAttribute('height')]);
    const vb = (await svg.getAttribute('viewBox'))!.split(' ').map(Number);
    expect(Math.abs(Number(w) / vb[2] - Number(h) / vb[3])).toBeLessThan(0.02);
  });
});

// ── 묶음 N — 도구 이름의 단일 출처 ──

