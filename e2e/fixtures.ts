import { execFileSync } from 'child_process';
import { cpSync, rmSync } from 'fs';
import { join } from 'path';

import { test as base, expect } from '@playwright/test';

import { realPath } from './osenv';


// FR-RST-10: 워크스페이스 리셋의 409 재시도 횟수. 겹침은 앞 테스트의 마지막
// 저장 하나가 원인이므로 몇 번이면 충분하다 — 무한 재시도는 서버가 정말 바쁠 때
// 테스트 시작을 무한정 미룬다.
const RESET_WS_TRIES = 5;

// e2e 는 만든 도구를 정리하지 않는다. 스펙이 workspace 를 비우거나 탭을
// 직접 지워도 서버측 도구(PTY)는 그대로 남는다 — 브라우저의 closeTab 경로만
// 도구를 종료하기 때문이다.
//
// 그렇게 누적된 고아 도구는 다음 페이지 로드에서 전부 "재연결 대상"으로
// 미리 생성된다 (app.js init: 서버 도구마다 숨겨진 터미널 + WebSocket).
// 수십 개가 쌓이면 포커스된 터미널의 WS open 이 늦어져 waitForInit 이
// 타임아웃하고, 스펙 대부분이 순서 의존으로 무너진다.
//
// 매 테스트 전에 **어떤 탭도 참조하지 않는** 도구만 회수한다. 참조된 도구와
// workspace 는 건드리지 않으므로 파일 내 테스트 간 상태 의존은 보존된다.
async function reapOrphanTools(request: any) {
  let state: any;
  try {
    const r = await request.get('/api/state');
    if (!r.ok()) return;
    state = await r.json();
  } catch {
    return;
  }
  const referenced = new Set<string>();
  const walk = (n: any) => {
    if (!n) return;
    for (const t of n.tabs || []) if (t.toolId) referenced.add(t.toolId);
    for (const c of n.children || []) walk(c);
  };
  for (const w of state?.workspace?.windows || []) walk(w.layout);

  for (const tool of state?.tools || []) {
    if (!tool?.id || referenced.has(tool.id)) continue;
    try {
      await request.delete('/api/tools/' + tool.id);
    } catch {
      // 이미 종료된 도구는 무시
    }
  }
}

// 테스트 간 워크스페이스 누적은 순서 의존 실패의 주 원인이다. 앞선 테스트가
// 만든 창·탭이 남아 있으면 "포커스된 분할 칸의 활성 탭" 이 터미널이 아니게 되고
// waitForInit 의 .xterm-helper-textarea 대기가 hidden 상태로 타임아웃한다.
// 매 테스트 전에 빈 워크스페이스로 되돌린다 — 브라우저가 첫 도구를 새로 만든다.
// REFACTOR_STABILIZATION_SRS FR-RST-10: **한 번 미는 것으로는 부족하다.**
//
// 앞 테스트의 마지막 저장이 아직 날고 있으면 이 PUT 이 409 로 밀린다
// (WORKSPACE_SAVE_CONFLICT_SRS: 서버는 If-Match 가 현재 rev 와 다르면 거절한다).
// 종전 코드는 응답 상태를 보지 않고 catch 가 통째로 삼켰으므로, 리셋이 실패한
// 사실을 **아무도 몰랐다** — 워크스페이스가 안 비워진 채 다음 테스트가 시작됐고,
// 창·뷰·핀이 앞 테스트 것으로 남아 무작위 실패를 만들었다 (SRS §2.1 뿌리 2).
//
// 세 단계(reset→reap→clearAttention)가 이 함수에 **직렬 의존**하는 것이 피해를
// 키운다: 리셋이 밀리면 `reapOrphanTools` 의 "참조됨" 판정까지 앞 테스트 기준으로
// 빗나가 회수가 통째로 어긋난다.
//
// 그래서 밀린 만큼 다시 밀고, **비워졌는지를 값으로 확인한다.**
async function resetWorkspace(request: any) {
  const EMPTY = '{"schemaVersion":2,"windows":[]}';
  for (let attempt = 0; attempt < RESET_WS_TRIES; attempt++) {
    let get: any;
    try {
      get = await request.get('/api/workspace');
    } catch {
      return; // 서버가 아직 안 떴다 — 첫 테스트가 goto 에서 다시 기다린다.
    }
    if (!get.ok()) return;
    // 이미 비어 있으면 밀 이유가 없다. 불필요한 PUT 은 그 자체가 다음 저장과
    // 겹칠 씨앗이다.
    const body = await get.text();
    if (isEmptyWorkspace(body)) return;

    const rev = get.headers()['etag'] || '0';
    let put: any;
    try {
      put = await request.put('/api/workspace', {
        headers: { 'If-Match': rev, 'Content-Type': 'application/json' },
        data: EMPTY,
      });
    } catch {
      return;
    }
    if (put.ok()) return;
    // 409 가 아니면 재시도해도 같은 답이다 — 그때는 조용히 넘어가되 삼키지 않는다.
    if (put.status() !== 409) {
      console.warn(`[fixtures] 워크스페이스 리셋 실패 (status ${put.status()})`);
      return;
    }
    // 409 다: 그 사이 누가 밀어 올렸다. 새 etag 로 다시 읽어 민다.
  }
  console.warn(`[fixtures] 워크스페이스 리셋이 ${RESET_WS_TRIES}회 409 로 밀렸다`);
}

// 워크스페이스가 비었는가. 창이 하나도 없으면 비었다 — 나머지 키(git.pinned·
// editors)는 이 함수의 관심이 아니다: 리셋이 되돌리려는 것은 **창 누적**이다.
function isEmptyWorkspace(body: string): boolean {
  let ws: any;
  try {
    ws = JSON.parse(body);
  } catch {
    return false; // 읽을 수 없으면 비었다고 말하지 않는다.
  }
  return !ws || !Array.isArray(ws.windows) || ws.windows.length === 0;
}

// 주의 알림은 도구가 사라져도 서버에 남고 배지 개수·모아보기 목록에 누적된다.
// 개수를 단정하는 스펙(attention.spec.ts)이 앞선 테스트의 알림에 오염되므로
// 매 테스트 전에 비운다.
async function clearAttention(request: any) {
  try {
    await request.post('/api/tools/attention/clear-all');
  } catch {
    // 서버가 아직 안 떴으면 무시
  }
}

export const test = base.extend<{ cleanTools: void }>({
  cleanTools: [
    async ({ request }, use) => {
      await resetWorkspace(request);
      await reapOrphanTools(request);
      await clearAttention(request);
      await use();
    },
    { auto: true },
  ],
});

/**
 * Git 뷰 탭(`Branches`·`History`·`Stash`…)을 누른다.
 *
 * **`page.click` 을 직접 쓰지 않는 이유가 있다.** 본문 탭 바는 관측이 닿을
 * 때마다 다시 그려지므로, 누르려던 행이 그 사이 DOM 에서 떨어져 나가거나
 * ("element was detached") 위치가 계속 바뀌어 playwright 의 안정성 검사를
 * 통과하지 못한다 ("waiting for element to be visible, enabled and stable").
 * 둘 다 전체 실행에서 실제로 관측된 실패다.
 *
 * 재렌더는 앱의 정상 동작이므로 **테스트가 견뎌야 한다**: 눌러 보고, 그 뷰가
 * 앞에 오지 않았으면 다시 누른다. 스펙마다 이 재시도를 흩뿌리지 않도록 여기
 * 한 자리에 둔다 — 같은 클릭이 29개 파일에 복제돼 있었고, 그래서 한 곳을 고쳐도
 * 다음 실행에서는 다른 파일이 같은 이유로 무너졌다.
 */
export async function clickGitView(page: any, view: string) {
  await expect(async () => {
    await page.locator(`#area .pn-tab[data-git-view="${view}"]`).click({ timeout: 5000 });
    await expect(page.locator('#area .pn-body .git-view.vis'))
      .toHaveClass(new RegExp('git-' + view), { timeout: 3000 });
  }).toPass({ timeout: 25000 });
}

/**
 * REFACTOR_STABILIZATION_SRS FR-RST-12 — 재렌더 경쟁에 대한 공용 방어.
 *
 * `clickGitView` 가 뷰 탭에서 증명한 골격을 행과 메뉴로 넓힌 것이다: **눌러 보고,
 * 원한 상태가 됐는지 보고, 아니면 다시.** 목록과 탭 바는 관측이 닿을 때마다 다시
 * 그려지므로 누르려던 요소가 그 사이 DOM 에서 떨어져 나갈 수 있고, 그것은 앱의
 * 정상 동작이다 — 견디는 쪽은 테스트다.
 *
 * 전체 실행 893회의 클릭 중 재시도를 가진 것이 9회(6파일)뿐이었고, 매 회차 서로
 * 다른 스펙이 무작위로 무너진 원인이 그것이었다 (SRS §2.1 뿌리 1).
 */

/** 행 하나를 누른다. `verify` 를 주면 그것이 통과할 때까지 다시 누른다. */
export async function clickRow(page: any, row: any, verify?: () => Promise<void>) {
  await expect(async () => {
    await row.click({ timeout: 5000 });
    if (verify) await verify();
  }).toPass({ timeout: 20000 });
}

/**
 * 행에서 컨텍스트 메뉴를 연다.
 *
 * 우클릭 58회(17파일) 중 **메뉴가 떴는지까지 확인하던 것은 한 곳뿐**이었다.
 * 나머지는 메뉴가 서기 전에 항목을 눌러도 그것을 알 수 없었다.
 */
export async function openRowMenu(
  page: any, row: any, opts: { kind?: string; selector?: string } = {},
) {
  const menu = page.locator(opts.selector || '.git-menu');
  await expect(async () => {
    await row.click({ button: 'right', timeout: 5000 });
    await expect(menu).toBeVisible({ timeout: 3000 });
    if (opts.kind) {
      await expect(menu).toHaveAttribute('data-kind', opts.kind, { timeout: 2000 });
    }
  }).toPass({ timeout: 20000 });
  return menu;
}

/**
 * 목록의 행이 `min` 개 이상 설 때까지 기다린다.
 *
 * 단순 폴링으로는 부족하다 — 워크스페이스 저장이 409 로 겹치면 앱은 서버 것을
 * 채택하고(WORKSPACE_SAVE_CONFLICT_SRS FR-WSC-1) 그 과정에서 뷰가 비워질 수 있다.
 * 그러면 행은 아무리 기다려도 0 이다. `revive` 는 그때 뷰를 되살리는 길이다.
 */
export async function waitRows(
  page: any, rows: any, min = 1, revive?: () => Promise<void>,
) {
  await expect(async () => {
    if (revive && (await rows.count()) < min) await revive();
    expect(await rows.count()).toBeGreaterThanOrEqual(min);
  }).toPass({ timeout: 25000 });
}

/**
 * GIT_SIDEBAR_TABS_SRS §4.1 — Git 패널은 이제 사이드바 탭 뒤에 있다 (FR-SBT-1·2).
 *
 * `Windows` 가 기본 탭이므로(FR-SBT-7) Git 요소를 **보거나 누르는** 스펙은 먼저
 * 탭을 열어야 한다. 스펙마다 탭 클릭을 흩뿌리지 않고 여기 한 줄로 둔다.
 *
 * 탭 자체가 화면에 없는 상황(모바일 드로어가 닫혀 있다)에서는 클릭 대신 같은
 * 진입점을 직접 부른다 — 그런 스펙이 재려는 것은 탭 전환이 아니라 그 뒤의 패널이다.
 */
export async function openGitTab(page: any) {
  const tab = page.locator('.sb-tab[data-panel="repo"]');
  const box = await tab.boundingBox();
  const vp = page.viewportSize();
  // 모바일 드로어가 닫혀 있으면 사이드바는 화면 밖으로 밀려 있다 — 눌릴 수 없다.
  const clickable = !!box && box.y >= 0 && box.x >= 0 && (!vp || box.y + box.height <= vp.height);
  if (clickable) await tab.click();
  else await page.evaluate(() => (window as any).app._sbSetTab('repo'));
  await page.waitForFunction(
    () => !document.getElementById('sb-panel-repo')?.hasAttribute('hidden'),
    undefined, { timeout: 10000 });
}

/**
 * EDITOR_TAB_SRS FR-EDT-13·42: Editor 창(root 에디터 포함)이 이제 항상 최소
 * 하나 존재한다. `ws.windows` 를 그대로 세거나 인덱싱하는 스펙은 그 창까지
 * 세어 개수·순서가 밀린다. Git 창도 이미 같은 이유로 제외 대상이었다
 * (`app-git.js` `_plainWindows`).
 *
 * 앱 내부의 `_plainWindows()` 를 재사용하지 않고 여기서 같은 조건을 독립적으로
 * 판정한다 — 구현이 필터를 잘못 짜면 검증 쪽도 같은 실수를 공유해 결함을
 * 가려버린다.
 */
export async function plainWindows(page: any): Promise<any[]> {
  return page.evaluate(() =>
    ((window as any).app.ws.windows || []).filter((w: any) => w && w.type !== 'git' && w.type !== 'editor'));
}

/**
 * Git 창의 고정 탭 수 (GIT_VIEWS 의 길이).
 *
 * **구현의 `GIT_VIEWS` 를 읽지 않는다.** 읽으면 그 배열에서 탭이 실수로 빠져도
 * e2e 가 통과한다 — 검사가 검사를 멈춘다. `plainWindows` 가 앱의 `_plainWindows()`
 * 를 재사용하지 않는 것과 같은 이유다.
 *
 * 고치는 것은 이 숫자가 28개 스펙에 흩어져 있던 사실뿐이다. 숫자는 여전히 e2e 가
 * 독립적으로 적고, 다만 한 자리에 적는다 (E2E_HELPER_RECLAIM_SRS FR-EHR-5).
 */
// **REPO_TAB_UNIFY_SRS FR-RTU-30·32 로 6이 됐다.** `Changes` 는 창의 **사이드**에
// 살고 본문 탭이 되지 않으므로(요구 ②) 본문에 설 수 있는 뷰는 그 나머지다.
// **UX_BATCH5_SRS FR-SUB-6 으로 Submodules 가 더해져 일곱이 됐다.**
//
// 숫자를 목록에서 **파생시킨다** — 둘을 따로 적으면 뷰가 늘 때 한쪽만 고쳐지고,
// 그 어긋남은 스펙 수십 개가 한꺼번에 깨지는 모습으로 나타난다 (이번에 겪었다).
export const GIT_BODY_VIEWS = [
  'diff', 'history', 'branches', 'stash', 'console', 'worktrees', 'submodules',
] as const;
export const GIT_VIEW_TABS = GIT_BODY_VIEWS.length;

/**
 * 앱이 뜨고 포커스된 칸의 터미널이 입력을 받을 준비가 될 때까지 기다린다.
 *
 * 37개 스펙이 바이트 동일한 본문을 각자 갖고 있던 것을 여기로 거뒀다
 * (FR-EHR-1·2). **변종 26개는 옮기지 않았다** — 모바일 진입이나 다른 초기
 * 스크립트를 쓰는 것들이고, 겉이 같아 보인다고 합치면 그 스펙이 재려던 것과
 * 다른 것을 재게 된다.
 */
/**
 * REFACTOR_STABILIZATION_SRS FR-RST-11 의 옵션.
 *
 * 27벌의 로컬 `waitForInit` 을 전부 읽고 **진짜 차이만** 뽑은 것이다 — 21벌은
 * 아래 기본값과 의미가 같았고(그중 다수는 `waitSettled` 한 줄이 빠진 옛 판),
 * 나머지 6벌의 차이가 이 네 개다.
 */
export type InitOpts = {
  /** `desktop`(기본) 또는 `mobile`. 모바일은 뷰포트까지 함께 좁힌다. */
  mode?: 'desktop' | 'mobile';
  /** 모바일 뷰포트 크기. `mode:'mobile'` 일 때만 쓰인다. */
  viewport?: { width: number; height: number };
  /**
   * 준비 판정. 기본은 "포커스된 칸의 터미널이 섰다" 이지만, 터미널을 세우지
   * 않는 화면을 재는 스펙은 자기 기준을 준다 (예: `window.GitConfirm` 이 실렸다).
   */
  readyFor?: { selector?: string; fn?: () => boolean };
  /**
   * goto **전에** 브라우저 컨텍스트에서 한 번 돌 스크립트. stub 주입처럼
   * 첫 스크립트보다 먼저 서야 하는 것이 여기 온다.
   */
  beforeGoto?: () => void;
  /**
   * **첫 로드에서만** 지울 localStorage 키.
   *
   * 그냥 지우면 안 되는 이유가 있다: 영속을 재는 스펙(고르고 새로고침하면
   * 돌아온다)이 자기 검증 대상을 지운다. sessionStorage 를 표식으로 써서 첫
   * 로드에만 지우고 reload 에서는 남긴다 — **키는 스펙마다 다르므로 값을 받는다.**
   */
  clearOnFirstLoad?: string | string[];
  /** 첫 로드에서 localStorage 전체를 비운다 (일부 회귀 스펙의 요구). */
  clearLocalStorage?: boolean;
};

/**
 * 앱이 뜨고 **화면이 멎을 때까지** 기다린다.
 *
 * FR-EQS-5: 터미널이 섰다고 화면이 멎은 것은 아니다 — 초기 저장 두 번이 아직
 * 돈다 (E2E_QUIESCENCE_SRS §2.1). 그 사이에 시작한 검증은 `_onWorkspaceChanged`
 * 가 유예되거나(§2.1) 서버가 아직 모르는 것을 읽는다(§2.2).
 *
 * **로컬 복제본 21벌에 이 마지막 한 줄이 없었다** (SRS §2.1) — 그 21개 파일은
 * 저장 두 건이 비행 중인 상태에서 단언을 시작하고 있었다.
 */
export async function waitForInit(page: any, opts: InitOpts = {}) {
  const mobile = opts.mode === 'mobile';
  const first = {
    mode: mobile ? 'mobile' : 'desktop',
    clearAll: !!opts.clearLocalStorage,
    keys: typeof opts.clearOnFirstLoad === 'string'
      ? [opts.clearOnFirstLoad]
      : (opts.clearOnFirstLoad || []),
  };
  await page.context().addInitScript((cfg: typeof first) => {
    sessionStorage.setItem('displayMode', cfg.mode);
    // initScript 는 reload 에서도 돈다. 표식을 세션에 두어 **첫 로드에서만**
    // 지운다 — 그러지 않으면 영속을 재는 스펙이 자기 검증 대상을 지운다.
    if (!sessionStorage.getItem('__dmCleared')) {
      sessionStorage.setItem('__dmCleared', '1');
      try {
        if (cfg.clearAll) localStorage.clear();
        for (const k of cfg.keys) localStorage.removeItem(k);
      } catch { /* 사생활 모드: 지울 것이 없다 */ }
    }
  }, first);
  if (opts.beforeGoto) await page.context().addInitScript(opts.beforeGoto);
  if (mobile) await page.setViewportSize(opts.viewport || { width: 420, height: 860 });

  await page.goto('/');
  const ready = opts.readyFor;
  if (ready?.fn) await page.waitForFunction(ready.fn, undefined, { timeout: 15000 });
  else await page.waitForSelector(ready?.selector || INIT_READY_SELECTOR, { timeout: 15000 });
  // BOOT_SCREEN_SRS FR-BTS-16: 부팅 화면이 살아 있는 동안의 클릭은 그 화면이
  // 받는다. 준비 판정에 "걷혔다" 를 더하지 않으면 그 클릭이 어디로 갔는지
  // 알 수 없는 무작위 실패가 된다.
  await page.waitForSelector('#boot', { state: 'detached', timeout: 15000 });
  await waitSettled(page);
}

// 기본 준비 판정: init() → render() → 포커스된 칸의 xterm 이 섰다.
const INIT_READY_SELECTOR = '#area .pn.focused .xterm-helper-textarea';

/**
 * 화면의 저장·적용이 멎을 때까지 기다린다 (E2E_QUIESCENCE_SRS 묶음 Q).
 *
 * **브라우저가 만든 것은 브라우저의 `PUT /api/workspace` 로만 서버에 남는다.**
 * `POST /api/commands` 의 응답은 "브라우저가 만들었다" 는 뜻이지 "서버에 남았다"
 * 는 뜻이 아니다 (§2.2). 그것을 서버에서 읽기 전에, 또는 새로고침으로 확인하기
 * 전에 이것을 부른다 (FR-EQS-6·7).
 *
 * FR-EQS-3: **연속으로** 조용해야 정착이다 — `_save()` 는 비행이 끝난 다음 틱에
 * 다음 비행을 세울 수 있다 (FR-WSC-9).
 */
export async function waitSettled(page: any, timeout = 15000) {
  await page.waitForFunction(
    () => {
      const a = (window as any).app;
      if (!a) return false;
      const quiet = !a._saveInflight && !a._savePending && !a._wsApplyInflight;
      const n = quiet ? ((window as any).__dmQuiet || 0) + 1 : 0;
      (window as any).__dmQuiet = n;
      return n >= 3;
    },
    undefined,
    // FR-EQS-4: 상한을 둔다. 넘으면 그 자리에서 실패로 알린다.
    { timeout, polling: 50 },
  );
  await page.evaluate(() => { (window as any).__dmQuiet = 0 });
}

/**
 * 도구 셸이 **입력을 받을 수 있을 때까지** 기다린다 (FR-CEM-13).
 *
 * `waitForInit` 이 끝났다는 것은 xterm 이 섰다는 뜻이지 셸이 떴다는 뜻이 아니다.
 * POSIX 에서는 그 차이가 보이지 않는다 — tty 입력 큐가 먼저 온 바이트를 들고
 * 있다가 셸이 읽는다. **Windows 의 ConPTY 에는 그 큐가 없다**: 세션을 열며
 * 인사말 16바이트(`\x1b[?9001h\x1b[?1004h`)를 즉시 내보내고, 그때 넣은 입력은
 * 프롬프트가 먹지 못하고 사라진다 (`httpapi/shellready_test.go` 의 실측이 같은
 * 사실을 서버 쪽에서 적어 두었다). pwsh 는 PSReadLine 을 올리는 데 초 단위가
 * 걸리므로 고정 대기로도 맞출 수 없다.
 *
 * 그래서 doctor·서버 검사와 **같은 신호**를 쓴다: 출력이 오고 **조용해지는 것**.
 */
export async function waitShellReady(page: any, sel = '#area .pn.focused .xterm-rows', timeout = 25000) {
  await page.waitForFunction(
    ({ s, quiet }: { s: string; quiet: number }) => {
      const el = document.querySelector(s) as HTMLElement | null;
      if (!el) return false;
      const txt = el.innerText || '';
      const w = window as any;
      const st = w.__dmShellQ || (w.__dmShellQ = {});
      const prev = st[s];
      const now = Date.now();
      if (!prev || prev.txt !== txt) { st[s] = { txt, at: now }; return false; }
      return txt.trim().length > 0 && now - prev.at >= quiet;
    },
    { s: sel, quiet: 700 },
    { timeout, polling: 50 },
  );
}

/**
 * 그 저장소의 Repo 창을 열고 git 뷰를 화면에 세운다 (FR-EHR-4).
 *
 * **창의 모양이 바뀌었다** (REPO_TAB_UNIFY_SRS).
 *   이전: Git 창 하나에 고정 탭 7개가 처음부터 서 있었다
 *   지금: 저장소마다 Repo 창이 있고, `Changes` 는 **사이드**에, 나머지 여섯은
 *         **본문 탭**으로 필요할 때 열린다 (FR-RTU-30·32)
 *
 * 그래서 이 헬퍼가 여섯을 미리 연다 — 기존 스펙들이 "탭을 클릭한다" 로 뷰를
 * 고르고, 그 조작은 탭이 있어야 성립한다. 사이드도 `Changes` 로 돌려 둔다:
 * 그 목록을 딛는 검증이 스펙 전반에 있다.
 */
/**
 * 저장소를 Git 창으로 열고 **첫 관측이 닿을 때까지** 기다린다.
 *
 * REFACTOR_STABILIZATION_SRS FR-RST-13: 로컬에 16벌이 복제돼 있었고 그 몸통은
 * 주석까지 바이트 동일했다. 다른 것은 마지막 한두 줄의 단언뿐이었는데, **공용판이
 * 오히려 약했다** — 탭 개수만 세고 사이드가 실제로 섰는지를 보지 않았다. 강한
 * 쪽을 채택한다.
 *
 * `statusOf()` 대기가 요점이다. 창이 서고 탭이 그려진 것과 **저장소를 읽은 것은
 * 다른 사건**이며, 뒤따르는 단언(그룹 개수·버튼 활성·HEAD 이름)은 모두 뒤쪽에
 * 기댄다. 그것을 각 스펙이 각자 기다리다 부하에서 무너졌다.
 */
export async function openGit(page: any, repo: string) {
  await page.evaluate((r: string) => (window as any).app.openGitWindow(r), repo);
  await page.waitForSelector('#area .ed-win .ed-side', { timeout: 15000 });
  await page.evaluate(() => {
    const a = (window as any).app;
    a._edSetSide(a._aw(), 'changes');
    const p = a.gitPanel;
    for (const v of ['diff', 'history', 'branches', 'stash', 'console', 'worktrees', 'submodules']) {
      p.openView(v);
    }
  });
  await expect(page.locator('#area .pn-tab[data-git-view]')).toHaveCount(GIT_VIEW_TABS);
  // 로컬 16벌 중 14벌이 보던 단언 — 사이드가 실제로 섰는가.
  //
  // **모바일에서는 보지 않는다.** 그 열여섯은 전부 데스크톱 스펙이었고, 모바일은
  // 창의 모양이 달라 이 자리가 같은 뜻을 갖지 않는다 — 넣었더니 모바일 스펙이
  // `element(s) not found` 로 무너졌다 (실측).
  const mobile = await page.evaluate(() => document.body.classList.contains('mobile'));
  if (!mobile) {
    await expect(page.locator('#area .ed-side .git-view.git-changes')).toBeVisible({ timeout: 10000 });
  }
  // 첫 관측. 이것이 닿아야 그룹 개수·버튼 활성이 뜻을 갖는다.
  //
  // 관측의 **주인**까지 확인하려 `gitPanel.repo === repo` 를 걸어 봤으나 그 값은
  // Repo 창의 root 라 보낸 경로와 다를 수 있어 영원히 기다렸다 — 되돌렸다.
  await page.waitForFunction(
    () => !!(window as any).app?.gitPanel?.statusOf(),
    undefined, { timeout: 20000 });
}

/**
 * 편집기 목록에 루트를 더하고 **서버가 저장한 철자**를 돌려준다.
 *
 * 검사가 보낸 문자열과 서버가 저장하는 문자열은 같지 않을 수 있다 —
 * `wsentry.NormalizePath` 가 `EvalSymlinks`+`Clean` 을 지나므로 심링크·짧은
 * 이름(`RUNNER~1`)·구분자가 그 자리에서 바뀐다. 창을 찾는 쪽은 **문자열 완전
 * 일치**이므로(`_edWindowFor`), 검사가 자기 철자를 들고 있으면 그 창을 영원히
 * 찾지 못한다 (Windows CI 실측).
 *
 * 그래서 짐작하지 않고 **묻는다**. 목록에서 같은 자리를 가리키는 항목을 골라
 * 그 값을 그대로 쓴다.
 */
export async function addEditorRoot(request: any, path: string): Promise<string> {
  const r = await request.post('/api/editors/add', { data: { path } });
  expect(r.ok(), `editors/add 실패: ${await r.text()}`).toBeTruthy();
  const body = await r.json();
  const key = (p: string) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const hit = ((body.list || []) as string[]).find((e) => key(e) === key(path));
  return hit || path;
}

/**
 * 검사용 저장소 픽스처를 세운다 (`e2e/git_fixture.sh`).
 *
 * 38개 스펙이 같은 두 줄을 복제하고 있었다. 한 자리로 모으는 이유는 **실패의 모양**
 * 이다 — `stdio:'ignore'` 는 스크립트의 stderr 를 버리므로, 러너에서 이것이 실패하면
 * `Command failed: bash e2e/git_fixture.sh …` 한 줄만 남고 무엇이 왜 실패했는지
 * 알 수 없다 (Windows CI 에서 실측: 21개 실패의 표면이 전부 이 한 줄이었다).
 *
 * 세 OS 모두 `bash` 로 부른다 — Windows 러너에는 git-bash 가 PATH 에 있다
 * (CI_E2E_MATRIX_SRS FR-CEM-10).
 */
export function gitFixture(out: string) {
  runFixture([out]);
}

/** 그 픽스처를 지운다. 스크립트가 자기 표식(`.dm-git-fixture`)을 확인한다. */
export function cleanGitFixture(out: string) {
  runFixture(['--clean', out]);
}

function runFixture(args: string[]) {
  try {
    // stdout 은 버리고 stderr 만 받는다 — 스크립트는 성공해도 진행 상황을 길게
    // 찍지만, 실패했을 때 필요한 것은 그 사유 한 줄이다.
    execFileSync('bash', ['e2e/git_fixture.sh', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e: any) {
    const why = String((e && e.stderr) || '').trim();
    throw new Error(`git_fixture.sh ${args.join(' ')} 실패\n${why || '(stderr 없음)'}`);
  }
}

/**
 * 임시 디렉터리를 지운다 — **지워지지 않아도 검사를 죽이지 않는다** (FR-CEM-15).
 *
 * POSIX 는 열려 있는 파일이 있어도 이름을 지운다. **Windows 는 그러지 않는다**:
 * 서버가 그 저장소를 관측하고 있으면 핸들이 남고 `rmdir` 이 `EBUSY` 로 실패한다
 * (러너 실측 — `afterAll` 의 정리가 스펙 전체를 빨갛게 만들었다).
 *
 * 그래서 둘을 한다. 먼저 **재시도**한다 — 핸들은 대개 관측 한 바퀴 뒤에 놓인다.
 * 그래도 남으면 **삼킨다**: 이 자리는 검증이 아니라 뒷정리이고, 러너의 임시
 * 디렉터리는 job 이 끝나면 통째로 사라진다.
 */
export function rmTree(p: string) {
  if (!p) return;
  try {
    rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch { /* 뒷정리다 — 남은 핸들이 검사의 판정을 바꾸지 않는다 */ }
}

/**
 * 디렉터리를 통째로 복사한다 (FR-CEM-14).
 *
 * **`cp -R` 을 부르지 않는다.** `cp` 는 git bash 의 `usr/bin` 에 있고 그 자리는
 * Windows 러너의 PATH 에 없다 — 픽스처를 만드는 이 자리는 셸을 지나지 않으므로
 * 그 명령을 부를 길이 아예 없다 (CI_E2E_MATRIX_SRS FR-CEM-10 의 예외). Node 가
 * 복사하면 두 OS 에서 같은 한 벌이다.
 */
export function copyDir(src: string, dst: string) {
  cpSync(src, dst, { recursive: true });
}

/**
 * 픽스처 저장소를 복사해 그 실제 경로를 준다.
 *
 * **팩토리인 이유는 `FIXTURES` 가 스펙마다 다르기 때문이다** (`dm-git-fx-<태그>-<pid>`,
 * 격리를 위해서다). 각 스펙이 `const copyFx = makeCopyFx(FIXTURES)` 한 줄로 받으면
 * 호출부는 한 글자도 바뀌지 않는다 (FR-EHR-3).
 */
export function makeCopyFx(root: string) {
  return (name: string, tag: string): string => {
    const dst = join(root, 'copy-' + tag);
    rmSync(dst, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    copyDir(join(root, name), dst);
    // 서버가 저장하는 것과 같은 모양이다 (FR-CEM-11) — `EvalSymlinks` 를 지난 뒤의
    // **그 OS 의 정규형**이다. `osenv.realPath` 를 지나는 것이 규약인 이유는
    // Windows 의 **짧은 이름**이다: 순수 JS 의 `realpathSync` 는 `RUNNER~1` 을
    // 그대로 두고, 서버는 긴 이름으로 답한다 — 그 둘은 문자열로 같지 않아
    // `_edWindowFor` 가 방금 더한 창을 찾지 못한다 (러너 실측).
    return realPath(dst);
  };
}

export { expect };
