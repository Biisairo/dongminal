import { execFileSync, spawn } from 'child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

import { test as base, expect } from '@playwright/test';

import { E2E_BIN, E2E_HOME, E2E_PORT0 } from '../playwright.config';
import { stopDaemon } from './daemon-cleanup';
import { realPath } from './osenv';


/**
 * 상태 변경 요청의 기본 헤더 (`REQUEST_GATE_SRS` FR-RQG-5).
 *
 * **본문이 없어도 JSON 을 밝혀야 한다.** `POST /api/tools?cwd=…` 처럼 쿼리만으로
 * 셸을 만드는 종단이 있어서 본문 유무로 예외를 두면 그 경로가 열린다.
 *
 * `data` 를 객체로 주는 호출은 Playwright 가 알아서 밝히므로 이 상수가 필요 없다.
 * **필요한 것은 본문이 없는 호출**이고, 그것을 빠뜨리면 415 가 조용히 돌아온다 —
 * 아래 두 정리 함수가 그렇게 실패하고 있었고, 회수되지 않은 도구가 뒤 스펙의
 * 개수 단정을 무너뜨렸다 (`bg-kill` 의 "1이어야 하는데 6").
 */
export const JSON_HDR = { 'Content-Type': 'application/json' };

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
      await request.delete('/api/tools/' + tool.id, { headers: JSON_HDR });
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
    await request.post('/api/tools/attention/clear-all', { headers: JSON_HDR });
  } catch {
    // 서버가 아직 안 떴으면 무시
  }
}

/**
 * 한 워커의 서버 인스턴스 (E2E_PARALLEL_SRS FR-EPL-1).
 *
 * **격리의 단위를 프로세스가 아니라 인스턴스로 옮긴 것이 이 병렬의 전부다.**
 * 종전에는 `webServer` 가 인스턴스 하나를 띄우고 1,257항목이 그것을 공유했다 —
 * 픽스처가 매 테스트 앞에서 워크스페이스를 비우므로(E2E_QUIESCENCE_SRS) 둘이
 * 동시에 돌면 한쪽이 다른 쪽의 화면을 지웠다. 워커마다 인스턴스를 하나씩 주면
 * 그 규약이 그대로 성립한다: 비우는 대상이 자기 것이다.
 */
type DmServer = { port: number; home: string; baseURL: string };

async function pingUntilUp(url: string, limitMs: number) {
  const until = Date.now() + limitMs;
  let last = '';
  while (Date.now() < until) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
      last = 'HTTP ' + r.status;
    } catch (e: any) {
      last = String((e && e.message) || e);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`서버가 ${limitMs}ms 안에 뜨지 않았다 (${url}) — 마지막: ${last}`);
}

/**
 * 페이지를 열던 순간의 가시성. 실패한 테스트에서만 읽는다 (아래 afterEach).
 *
 * 러너에서 페이지가 뒤에 있으면 폴링과 Monaco 명령이 함께 멎는데, 그 상태는
 * 실패 뒤에 물어보면 이미 사라져 있다 — 그래서 그때 찍어 둔다.
 */
/**
 * 워커 서버에 물려줄 환경 (FR-EPL-1).
 *
 * **이 저장소를 dongminal 안에서 개발하면 도구 셸의 환경에 그 인스턴스의 정체가
 * 들어 있다** — `DONGMINAL_HOST`·`DONGMINAL_PORT`·`DONGMINAL_TOOL_ID`·
 * `DONGMINAL_HISTFILE` 는 서버가 자기 자식에게 심어 주는 값이고, `npx playwright`
 * 는 그 자식 중 하나다. 그대로 물려주면 워커의 서버가 **개발자의 인스턴스인 척**
 * 뜬다 — 워커마다 자기 인스턴스를 갖는다는 이 픽스처의 전제가 그 자리에서 깨진다.
 *
 * 실측(2026-09-10): `DONGMINAL_HOST=0.0.0.0` 이 물려지자 노출 게이트
 * (REQUEST_GATE_SRS FR-RQG-20)가 기동을 거부했고, e2e 1,449건이 전부 픽스처
 * 단계에서 무너졌다. **게이트는 옳았다** — 물려준 쪽이 틀렸다.
 *
 * `DONGMINAL_HOME`·`DONGMINAL_TOOL_HOME` 은 아래에서 명시로 덮으므로 여기 없다.
 */
const INHERITED_INSTANCE_ENV = [
  'DONGMINAL_HOST',
  'DONGMINAL_PORT',
  'DONGMINAL_TOOL_ID',
  'DONGMINAL_HISTFILE',
];

function hermeticEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of INHERITED_INSTANCE_ENV) delete env[k];
  return env;
}

const pageEnvAtOpen = new WeakMap<any, any>();

export const test = base.extend<{ cleanTools: void }, { dmServer: DmServer }>({
  /**
   * 이 워커의 서버를 띄우고, 워커가 끝날 때 서버와 **데몬**을 함께 세운다
   * (FR-EPL-1·4·5).
   *
   * `parallelIndex` 를 쓰는 이유는 포트다 — `workerIndex` 는 워커가 다시 뜰
   * 때마다 커지므로 포트가 끝없이 흘러간다. `parallelIndex` 는 0..workers-1 에
   * 머물고, 그 자리의 앞 워커는 이 픽스처의 teardown 을 이미 지났다.
   */
  dmServer: [
    async ({}, use, workerInfo) => {
      const i = workerInfo.parallelIndex;
      const port = E2E_PORT0 + i;
      const home = E2E_HOME + '/w' + i;
      // 도구 셸의 홈은 인스턴스 홈 **아래의 별도 칸**이다 (FR-EPL-3) — 인스턴스
      // 홈을 그대로 주면 셸이 `.zsh_history`·`.zcompdump` 를 workspace·tools 와
      // 같은 디렉터리에 쓰고, 그 쓰기가 인스턴스의 저장과 같은 자리에서 겹친다.
      const toolHome = home + '/tool-home';
      mkdirSync(toolHome, { recursive: true });

      const child = spawn(E2E_BIN, ['start', '--foreground'], {
        env: {
          ...hermeticEnv(),
          PORT: String(port),
          DONGMINAL_HOME: home,
          DONGMINAL_TOOL_HOME: toolHome,
        },
        // 서버의 말은 **모아 두었다가 실패했을 때만** 낸다. 그대로 흘리면 워커
        // 수만큼의 요청 로그가 리포터의 줄을 덮어, 무엇이 몇 개 실패했는지 로그만
        // 보고는 알 수 없다 (Windows 1차 실행에서 실측한 그 문제다).
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let tail = '';
      child.stderr?.on('data', (b: any) => { tail = (tail + String(b)).slice(-4000) });
      let exited: string | null = null;
      child.on('exit', (code, sig) => { exited = `code=${code} signal=${sig}` });

      try {
        // 러너의 첫 기동은 느리다 (FR-EPL-5).
        await pingUntilUp(`http://localhost:${port}/api/ping`, 90_000);
      } catch (err) {
        throw new Error(
          `워커 ${i} 의 서버 기동 실패 (port=${port}, home=${home})` +
          (exited ? ` — 프로세스 종료: ${exited}` : '') +
          `\n${err}\n--- 서버 stderr (마지막 4KB) ---\n${tail}`);
      }

      await use({ port, home, baseURL: `http://localhost:${port}` });

      // 데몬을 먼저 세운다 — 웹서버만 죽이면 detach 된 dongminald 가 자기 도구
      // 셸들의 PTY 를 계속 붙든다 (FR-EPL-4).
      stopDaemon(home);
      try { child.kill('SIGTERM') } catch { /* 이미 종료 */ }
    },
    { scope: 'worker', auto: true },
  ],

  // FR-EPL-2: 스펙은 `page.goto('/')` · `request.get('/api/…')` 를 그대로 쓴다.
  // 어느 인스턴스를 보는가는 여기서만 정해진다 (NFR-EPL-2).
  baseURL: async ({ dmServer }, use) => { await use(dmServer.baseURL) },

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
 * **"재렌더는 앱의 정상 동작이므로 견디는 쪽은 테스트다" 는 절반만 맞다**
 * (`11-git-polling.md §5`, 2026-09-12 정정). 목록·탭 바의 다시 그리기는 정상
 * 동작이 맞다. 그러나 **탭이 통째로 사라지던 것은 정상 동작이 아니었다** —
 * 원인은 관측이 아니라 워크스페이스 재채택이었고(git 관측은 `render()` 를
 * 부르지 않는다, `app-git.js:610`), `OPTIMISTIC_LAYOUT_SRS` 가 그것을 닫았다.
 *
 * 남은 재시도가 견디는 것은 **행/탭의 교체**다: 눌러 보고, 그 뷰가 앞에 오지
 * 않았으면 다시 누른다. 스펙마다 이 재시도를 흩뿌리지 않도록 여기 한 자리에
 * 둔다 — 같은 클릭이 29개 파일에 복제돼 있었고, 그래서 한 곳을 고쳐도 다음
 * 실행에서는 다른 파일이 같은 이유로 무너졌다.
 */
/**
 * 실패한 테스트의 **가시성·포커스**를 남긴다.
 *
 * 이 두 값이 폴링(`document.hidden`)과 Monaco 명령(포커스)의 전제이므로, 요청이
 * 0건인 실패는 거의 언제나 여기서 갈린다. 통과한 테스트에는 아무 것도 찍지 않는다.
 */
test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return;
  let now: any = null;
  try {
    now = await page.evaluate(() => ({
      hidden: document.hidden,
      visibility: document.visibilityState,
      focused: document.hasFocus(),
    }));
  } catch { /* 페이지가 닫혔다 */ }
  const atOpen = pageEnvAtOpen.get(page) ?? null;
  const line = `[진단:가시성] ${testInfo.title} | 열 때=${JSON.stringify(atOpen)} | 실패 때=${JSON.stringify(now)}`;
  testInfo.annotations.push({ type: 'page-visibility', description: line });
  console.log(line);
});

export async function clickGitView(page: any, view: string) {
  await expect(async () => {
    // **탭이 없으면 먼저 연다.**
    //
    //   이전 근거: "워크스페이스가 다시 적용되면 그 탭이 통째로 사라질 수 있다"
    //   지금:      그 갈래는 `OPTIMISTIC_LAYOUT_SRS` FR-OPL-1 이 닫았다 —
    //              원격 채택은 아직 나가지 못한 로컬 탭을 덮지 않는다
    //   남는 이유: 창을 갈아타거나 이 스펙이 아직 그 뷰를 연 적이 없을 수 있다.
    //              여는 것은 멱등이므로 이미 있으면 아무 일도 하지 않는다
    const tab = page.locator(`#area .pn-tab[data-git-view="${view}"]`);
    if (await tab.count() === 0) {
      await page.evaluate((v: string) => (window as any).app?.gitPanel?.openView(v), view);
    }
    await tab.first().click({ timeout: 5000 });
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
 * 행의 **인라인 동작**을 누른다 (DRIFT_RECLAIM_SRS FR-DRC-18).
 *
 * 그 버튼들은 겹에 있고 기본이 `pointer-events:none` 이다 — 행이 hover·선택일
 * 때만 눌린다 (`style-git.css` 의 `.git-file-acts`). 그래서 스펙들은 `row.hover()`
 * 한 번을 앞에 두었다.
 *
 * **hover 한 번으로는 부족하다.** 목록은 관측이 닿을 때마다 다시 그려지고
 * (`reconcileList`), 행이 교체되면 마우스가 움직이지 않은 새 요소에는 `:hover` 가
 * 붙지 않는다. 그 사이에 누르면 클릭이 겹을 지나 **경로 라벨에 맞는다** —
 * playwright 가 그것을 그대로 적어 준다:
 *
 *     <span class="git-file-path">…</span> intercepts pointer events
 *
 * 전량 회차에서 `git-changes` C12·C13·C14 가 이 자리로 흔들렸다. 재렌더는 앱의
 * 정상 동작이므로 **견디는 쪽은 테스트다** — `clickRow`·`openRowMenu` 와 같은
 * 골격이다: 다시 hover 하고, 눌러 보고, 아니면 다시.
 */
export async function clickRowAct(
  page: any, row: any, act: string, verify?: () => Promise<void>,
) {
  const btn = row.locator(`.git-file-act[data-act="${act}"]`);
  await expect(async () => {
    // 매 회차 다시 올린다 — 앞 회차와 다른 요소일 수 있다.
    await row.hover({ timeout: 5000 });
    await btn.click({ timeout: 5000 });
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
  else await page.evaluate(() => (window as any).app.testing.sbSetTab('repo'));
  await page.waitForFunction(
    () => !document.getElementById('sb-panel-repo')?.hasAttribute('hidden'),
    undefined, { timeout: 10000 });
}

/**
 * EDITOR_TAB_SRS FR-EDT-13·42: Editor 창(root 에디터 포함)이 이제 항상 최소
 * 하나 존재한다. `ws.windows` 를 그대로 세거나 인덱싱하는 스펙은 그 창까지
 * 세어 개수·순서가 밀린다. Git 창도 이미 같은 이유로 제외 대상이었다
 * (`app-git.js` `plainWindows`).
 *
 * 앱 내부의 `plainWindows()` 를 재사용하지 않고 여기서 같은 조건을 독립적으로
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
 * e2e 가 통과한다 — 검사가 검사를 멈춘다. `plainWindows` 가 앱의 `plainWindows()`
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

  /**
   * **페이지를 앞으로 가져온 뒤에 연다** (E2E_HIDDEN_PAGE 조사).
   *
   * `timer-hub` 는 `document.hidden` 이면 폴링 job 을 재우고(`timer-hub.js:117·319`),
   * Monaco 의 명령은 편집기가 포커스를 쥐어야 선다. 러너에서 페이지가 뒤에 있으면
   * 그 둘이 함께 멎어, "바깥의 변화가 화면에 따라오는가" 를 재는 스펙과 호버·정의
   * 이동이 **요청 0건**으로 실패한다 — 느린 것이 아니라 오지 않는 것이므로 상한을
   * 늘려도 낫지 않는다.
   *
   * 여는 순간의 상태를 먼저 남긴다. 앞으로 가져온 **뒤**에는 언제나 visible 이라,
   * 원래 어땠는지는 이 자리에서만 알 수 있다.
   */
  try {
    pageEnvAtOpen.set(page, await page.evaluate(() => ({
      hidden: document.hidden,
      visibility: document.visibilityState,
      focused: document.hasFocus(),
    })));
  } catch { /* about:blank 조차 아직 없다 */ }
  await page.bringToFront().catch(() => { /* 이 브라우저는 못 한다 */ });

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
 * FR-EQS-3: **연속으로** 조용해야 정착이다 — `save()` 는 비행이 끝난 다음 틱에
 * 다음 비행을 세울 수 있다 (FR-WSC-9).
 */
/**
 * 브라우저가 **다음 그림**을 그릴 때까지 기다린다 (`TEST-16`).
 *
 * `render()` 뒤의 고정 대기를 대신한다. 그 자리에서 기다리던 것은 시간이 아니라
 * 레이아웃·페인트 한 바퀴이고, `requestAnimationFrame` 두 번이면 그것이 끝난다 —
 * `300ms` 같은 값은 그 한 바퀴를 **넉넉히 덮으려고** 고른 숫자였을 뿐이다.
 *
 * **상한을 둔다.** 페이지가 뒤로 밀리면 `rAF` 는 멎는다 (러너에서 실제로
 * 일어난다 — `fixtures` 의 가시성 진단이 그 때문에 있다). 그때 영원히 기다리는
 * 대신 상한에서 풀어 준다: 이 함수는 "그림이 한 바퀴 돌았다" 를 **보장**하는
 * 것이 아니라 고정 대기를 **대체**하는 것이고, 뒤따르는 단정이 사실을 가린다.
 */
export async function nextFrames(page: any, n = 2, capMs = 2000) {
  await page.evaluate(
    ({ k, cap }: { k: number; cap: number }) =>
      new Promise<void>((res) => {
        let i = 0;
        const t = setTimeout(res, cap);
        const step = () => {
          if (++i >= k) { clearTimeout(t); res() } else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }),
    { k: n, cap: capMs },
  );
}

/**
 * status 안전망 폴링의 주기를 **그 자리에서** 바꾼다 (`TEST-17`·`TEST-19`).
 *
 * 기본은 30초다 (`GIT_STATUS_POLL_MS`) — 서버가 변화를 방송하므로 브라우저의
 * 폴링은 안전망으로 남았다 (`GIT_PUSH_OBSERVE_SRS`). 그래서 **방송이 닿지 않는
 * 사건**은 그 30초를 실제로 기다려야 화면에 오른다: 저장소 폴더가 사라지는
 * 것이 그렇다.
 *
 * **설정으로는 못 넣는다.** 주기가 사용자 설정이 되면서 하한이 10초이고
 * (`settings-schema.js`), 그 밖의 값은 저장하면 기본값으로 되돌아간다 —
 * 화면에서 고를 수 없는 값을 파일로는 넣을 수 있다면 선택지를 나눈 이유가
 * 사라지기 때문이다 (POLL_INTERVAL_SETTINGS_SRS FR-PIS-8·8a). 검사가 원하는
 * 것은 사용자 설정이 아니라 **그 자리의 값**이다. 설정 방송이 이 값을 지우지
 * 않는 것은 FR-PIS-8a 의 `!==undefined` 가드가 지켜 준다.
 *
 * `git-polling.spec.ts` 의 `fastSafetyNet` 과 `git-repo-missing.spec.ts` 의
 * `backoffBase` 가 같은 것을 따로 들고 있었다. 둘의 차이는 활성 패널까지
 * 다시 거는가 하나뿐이었고, **더 넓은 쪽**을 취했다 — 다시 거는 대상이 늘어도
 * 재는 것은 달라지지 않는다.
 *
 * **주기를 재는 검사는 이것을 쓰지 마라.** 소실 상태의 주기는 안전망과 무관한
 * 고정값이고(`GIT_REPO_MISSING_POLL_MS`, FR-RMS-26) 그것을 재는 자리가 따로
 * 있다 (`git-repo-missing` M7).
 */
export async function setSafetyNet(page: any, ms: number) {
  await page.evaluate((v: number) => {
    (window as any).gitStatusInterval = v;
    const app = (window as any).app;
    if (app.testing.gitPanels) for (const p of app.testing.gitPanels.values()) p._reschedule();
    if (app.gitPanel && app.gitPanel._reschedule) app.gitPanel._reschedule();
  }, ms);
}

export async function waitSettled(page: any, timeout = 15000) {
  await page.waitForFunction(
    () => {
      const a = (window as any).app;
      if (!a) return false;
      const quiet = !a.testing.saveInflight && !a.testing.savePending && !a.testing.wsApplyInflight;
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
  /**
   * 뷰를 여는 일과 **그것이 실제로 섰는지**를 한 묶음으로 본다
   * (DRIFT_RECLAIM_SRS FR-DRC-19).
   *
   * `a.gitPanel` 은 **활성 창의 루트와 포커스 칸**의 패널을 주는 getter 다
   * (`_gitRootOfActive`). `.ed-side` 가 DOM 에 섰다는 것과 그 창이 활성이 됐다는
   * 것은 다르므로, 이 사이에 부르면 **다른 패널에 뷰를 연다** — 보이는 창에는
   * 탭이 하나도 생기지 않고, 뒤따르는 단언이 `0 !== 7` 로 끝난다 (전량 회차에서
   * `git-remote` R20 이 그 자리였다).
   *
   * 한 번 더 부르는 것은 멱등이므로(이미 열린 뷰는 아무 일도 하지 않는다) 열어
   * 보고, 섰는지 보고, 아니면 다시 — `clickGitView` 와 같은 골격이다.
   */
  await expect(async () => {
    await page.evaluate(() => {
      const a = (window as any).app;
      a.testing.edSetSide(a.testing.aw(), 'changes');
      const p = a.gitPanel;
      if (!p) throw new Error('gitPanel 이 아직 없다');
      for (const v of ['diff', 'history', 'branches', 'stash', 'console', 'worktrees', 'submodules']) {
        p.openView(v);
      }
    });
    await expect(page.locator('#area .pn-tab[data-git-view]'))
      .toHaveCount(GIT_VIEW_TABS, { timeout: 5000 });
  }).toPass({ timeout: 25000 });
  // 로컬 16벌 중 14벌이 보던 단언 — 사이드가 실제로 섰는가.
  //
  // **모바일에서는 보지 않는다.** 그 열여섯은 전부 데스크톱 스펙이었고, 모바일은
  // 창의 모양이 달라 이 자리가 같은 뜻을 갖지 않는다 — 넣었더니 모바일 스펙이
  // `element(s) not found` 로 무너졌다 (실측).
  const mobile = await page.evaluate(() => document.body.classList.contains('mobile'));
  if (!mobile) {
    await expect(page.locator('#area .ed-side .git-view.git-changes')).toBeVisible({ timeout: 20000 });
  }
  // 첫 관측. 이것이 닿아야 그룹 개수·버튼 활성이 뜻을 갖는다.
  //
  // 관측의 **주인**까지 확인하려 `gitPanel.repo === repo` 를 걸어 봤으나 그 값은
  // Repo 창의 root 라 보낸 경로와 다를 수 있어 영원히 기다렸다 — 되돌렸다.
  //
  // 상한이 45초인 것은 **병렬의 부하** 때문이다 (E2E_PARALLEL_SRS D-6). 이 대기가
  // 딛는 것은 `git status` 한 바퀴이고, 같은 기계에서 도는 다른 워커의 `git` 들과
  // 자리를 다툰다 — 20초에서 회차마다 서로 다른 git 스펙 몇이 여기 걸렸고, 하나씩
  // 격리해 돌리면 모두 통과했다. 재는 것은 "관측이 닿는가" 이지 "몇 초에 닿는가"
  // 가 아니다.
  //
  // **30초도 모자랐다.** `git-*` 스펙은 파일 이름 순 분할에서 한 샤드에 몰리고
  // (8샤드 중 4번이 8분 — 다른 샤드의 세 배), 그 샤드의 스펙들은 서로의 `git`
  // 과 자리를 다툰다. 전량 회차마다 **다른** 스펙이 여기 걸렸다 —
  // `git-live-triggers` TC-GLW-3·5 · `git-polling` P4. 같은 근거로 상한을 45초로
  // 올린 자리가 이미 있다 (`git-repo-missing.spec.ts` 의 `MISSING_WAIT_MS`,
  // 20→45). 성공하면 즉시 통과하므로 늘리는 비용은 실패할 때뿐이다.
  await page.waitForFunction(
    () => !!(window as any).app?.gitPanel?.statusOf(),
    undefined, { timeout: 45000 });
}

/**
 * 편집기 목록에 루트를 더하고 **서버가 저장한 철자**를 돌려준다.
 *
 * 검사가 보낸 문자열과 서버가 저장하는 문자열은 같지 않을 수 있다 —
 * `wsentry.NormalizePath` 가 `EvalSymlinks`+`Clean` 을 지나므로 심링크·짧은
 * 이름(`RUNNER~1`)·구분자가 그 자리에서 바뀐다. 창을 찾는 쪽은 **문자열 완전
 * 일치**이므로(`edWindowFor`), 검사가 자기 철자를 들고 있으면 그 창을 영원히
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

/**
 * 그 픽스처를 지운다. 스크립트가 자기 표식(`.dm-git-fixture`)을 확인한다.
 *
 * **실패해도 던지지 않는다** (FR-CEM-15 와 같은 규약). Windows 는 열린 핸들이
 * 있는 디렉터리를 지우지 못하고(`rm: Device or resource busy`), 서버가 그
 * 저장소를 관측하는 동안은 늘 그렇다 — 그 실패가 `afterAll` 에서 던지면 마지막
 * 검사가 **뒷정리 때문에** 빨개진다 (러너 실측).
 */
export function cleanGitFixture(out: string) {
  try {
    runFixture(['--clean', out]);
  } catch { /* 뒷정리다 — 러너의 임시 디렉터리는 job 과 함께 사라진다 */ }
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
 * 디렉터리를 **반드시** 지운다 — 소실을 *만드는* 자리다 (FR-CEM-19).
 *
 * `rmTree` 와 뜻이 다르다. 저것은 뒷정리라 실패해도 삼키지만, 이것은 검사의
 * **전제**를 만든다: 지워지지 않으면 그 뒤의 단정이 뜻을 잃는다.
 *
 * Windows 는 열린 핸들이 있는 디렉터리를 지우지 못한다. 서버는 그 저장소를
 * 폴링하며 `git` 자식 프로세스를 계속 띄우므로, 그 프로세스가 살아 있는 동안은
 * `EBUSY` 다 — 다만 **잠깐씩 비는 틈이 있다**(폴링 사이). 그 틈을 기다린다:
 * 15초는 폴링 주기의 여러 배다. 그래도 안 되면 던진다.
 */
export async function rmTreeHard(p: string, limitMs = 45_000) {
  const until = Date.now() + limitMs;
  let last: any = null;
  for (;;) {
    try {
      rmSync(p, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
      return;
    } catch (e) {
      last = e;
      if (Date.now() > until) break;
      // **매번 처음부터 다시 시도한다.** node 의 내부 재시도는 실패한 그 한
      // 자리만 다시 두드리는데, 우리가 노리는 것은 서버의 폴링이 띄운 `git`
      // 자식이 **없는 순간**이다 — 그 틈은 짧고 주기적이므로 바깥에서 되풀이해야
      // 만난다. **잠들며** 기다린다: 바쁜 대기는 이벤트 루프를 막아 브라우저
      // 조작까지 멈춘다.
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw last;
}

/**
 * 그 뿌리의 Editor 창으로 옮기고, **그 창이 실제로 활성이 될 때까지** 기다린다
 * (CI_E2E_MATRIX_SRS FR-CEM-23).
 *
 * `switchWindow` 를 부르고 `.ed-tree .ed-row` 가 보이기만 기다리면 **아무 창의
 * 트리라도 그 조건을 만족한다.** 앱은 사용자의 홈을 뿌리로 하는 편집기를 늘 하나
 * 세우므로(FR-EDT-13) 그 창의 트리에는 언제나 행이 있고, 전환이 뒤늦은 워크스페이스
 * 적용에 덮여도 검사는 그것을 모른 채 진행한다 — 그 뒤의 모든 단정이 남의 트리를
 * 본다 (러너 실측: 화면에 뜬 것이 검사의 뿌리가 아니라 `C:\Users\runneradmin`
 * 이었다).
 *
 * 구분자는 견주기 전에 맞춘다. 서버가 저장한 철자와 검사가 든 철자는 같은 자리를
 * 가리키면서도 구분자만 다를 수 있다 (FR-CEM-11).
 */
export async function switchToEditorRoot(page: any, root: string, timeout = 15000) {
  await page.waitForFunction(
    (r: string) => {
      const a = (window as any).app;
      if (!a?.testing.edWindows) return false;
      const key = (p: any) => String(p == null ? '' : p).replace(/\\/g, '/');
      const win = a.testing.edWindows().find((x: any) => x.editor && key(x.editor.root) === key(r));
      if (!win) return false;
      if (key(a.testing.edRootOf(a.testing.aw())) === key(r)) return true;
      a.switchWindow(win.id);
      return false;
    },
    root, { timeout, polling: 100 },
  );
  // **전환을 정착시킨다** (E2E_QUIESCENCE_SRS FR-EQS-6·7). 전환은 워크스페이스를
  // 바꾸고 그 저장은 뒤따른다 — 비행 중에 서버의 낡은 스냅샷이 적용되면 활성
  // 창이 조용히 되돌아가고, 그 뒤의 단정은 남의 창을 본다 (러너 실측: 파일은
  // 옳은 창에 열렸는데 화면에 뜬 트리는 홈이었다).
  await waitSettled(page);
}

/**
 * 사이드를 **Explorer 로 세우고** 트리가 설 때까지 기다린다.
 *
 * UX_BATCH6_SRS FR-DSP-1 로 Repo 창의 기본 사이드가 `Changes` 가 됐다. 탐색기를
 * 재는 스펙은 그 자리를 **명시로** 연다 — 기본값에 기대던 동안은 기본값이 바뀌는
 * 날 전부가 함께 무너진다 (실측: 이 개정 하나에 일곱 스펙이 걸렸다).
 *
 * `openGit` 이 Changes 를 명시로 여는 것과 같은 규약이다 (fixtures.ts:552).
 */
export async function openExplorerSide(page: any, timeout = 15000) {
  await page.evaluate(() => {
    const a = (window as any).app;
    const w = a.testing.aw();
    if (w) a.testing.edSetSide(w, 'explorer');
  });
  await page.waitForSelector('.ed-win .ed-explorer .ed-tree', { timeout });
}

/**
 * 데스크톱으로 열고 **화면이 멎을 때까지** 기다린다 (`TEST-7`).
 *
 * `gotoWithEditors` 와 다른 점은 기다리는 대상이다 — 그쪽은 편집기 창이 서기를,
 * 이쪽은 저장이 가라앉기를 본다 (E2E_QUIESCENCE_SRS). 창 수나 목록 순서를 세는
 * 검사는 뒤엣것이 필요하다: 뿌리 편집기 창들이 초기 저장이 도는 동안 뒤늦게
 * 서기 때문이다.
 */
export async function gotoSettled(page: any) {
  await page.context().addInitScript(() => { sessionStorage.setItem('displayMode', 'desktop') });
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
  await waitSettled(page);
}

/**
 * **편집기 높이보다 짧은** 400줄 문서 (`TEST-7`).
 *
 * `size:'fit'` 이 덮지 못하던 구간이 바로 이 길이다 (`UX_BATCH8_SRS §2.3`) —
 * 미니맵이 스크롤바와 어긋나는 것이 거기서 보인다. 동시에 미니맵이 **서기는
 * 하는** 길이라 미리보기 버튼의 자리(FR-DRB-3)를 재는 데도 쓰인다.
 */
export const EDITOR_DOC_400 = ['# 제목', '', '본문 하나.', '',
  ...Array.from({ length: 400 }, (_, i) => `line ${i + 1} 내용 ${i + 1}`)].join('\n') + '\n';

/** 그 문서를 담은 루트를 세우고 그 Editor 창으로 들어간다 (`TEST-7`). */
export async function enterDocRoot(page: any, request: any, base: string, name: string): Promise<string> {
  const root = join(base, name);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'doc.md'), EDITOR_DOC_400);
  const saved = await addEditorRoot(request, root);
  await waitForInit(page);
  await switchToEditorRoot(page, saved);
  return saved;
}

/** `doc.md` 를 열고 **Monaco 가 실제로 설 때까지** 기다린다 (`TEST-7`). */
export async function openDocFile(page: any, root: string) {
  await page.evaluate((p: string) => (window as any).app.testing.edOpenFile(p, { pin: true }),
    root + '/doc.md');
  await page.waitForFunction(() => {
    const eds = [...(window as any).app.fileEditors.values()];
    return eds.some((e: any) => e._editor && e.name === 'doc.md');
  }, undefined, { timeout: 30000 });
}

/** 열려 있는 `doc.md` 를 dirty 로 만든다 (`TEST-7`). */
export async function makeDocDirty(page: any, text = 'ZZ') {
  await page.evaluate((t: string) => {
    const v = [...(window as any).app.fileEditors.values()]
      .find((e: any) => e._editor && e.name === 'doc.md') as any;
    v._editor.executeEdits('spec', [{ range: new (window as any).monaco.Range(1, 1, 1, 1), text: t }]);
  }, text);
  await page.waitForFunction(
    () => [...(window as any).app.fileEditors.values()].some((e: any) => e._dirty),
    undefined, { timeout: 10000 });
}

/**
 * 편집기 목록에 루트를 더한다 (`TEST-17`).
 *
 * 다섯 파일이 **한 글자도 다르지 않은** 지역 함수로 들고 있던 것이다. 경로가
 * 갈리면 "무엇이 실패했는가" 의 답도 갈린다 — 실패 문구까지 같아야 한 자리다.
 *
 * 서버가 저장한 철자가 필요하면 `addEditorRoot` 를 쓴다 (그쪽은 돌려준다).
 */
export async function addEditor(request: any, p: string) {
  const r = await request.post('/api/editors/add', { data: { path: p } });
  expect(r.ok(), `editors/add 실패: ${await r.text()}`).toBeTruthy();
}

/**
 * 데스크톱으로 열고 **Editor 창이 설 때까지** 기다린다 (`TEST-17`).
 *
 * 여섯 파일이 같은 것을 따로 들고 있었다. 기다리는 둘이 핵심이다: 터미널의
 * helper textarea 는 앱이 섰다는 뜻이고, `edWindows().length > 0` 은 편집기
 * 표면이 섰다는 뜻이다 — 뒤엣것 없이 루트를 고르면 아직 없는 창을 찾는다.
 *
 * **변종은 올리지 않았다** (`E2E_HELPER_RECLAIM_SRS`): `notes-live-explorer`
 * 는 `sidebarTab` 을 지우고, `sandbox-*` 는 다른 버튼을 기다리며,
 * `git-submodule-notice` 는 정착까지 본다. 겉이 같아 보인다고 합치면 그 스펙이
 * 재려던 것과 다른 것을 재게 된다.
 */
export async function gotoWithEditors(page: any) {
  await page.context().addInitScript(() => { sessionStorage.setItem('displayMode', 'desktop') });
  await page.goto('/');
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
  await page.waitForFunction(
    () => !!(window as any).app?.testing.editors && (window as any).app.testing.edWindows().length > 0,
    undefined, { timeout: 15000 });
}

/** 그 루트의 Editor 창으로 가서 탐색기를 연다 (`TEST-17`, 다섯 파일 공통). */
export async function openExplorerAt(page: any, root: string) {
  await switchToEditorRoot(page, root);
  await openExplorerSide(page);
}

/**
 * 루트를 세우고 그 Editor 창의 탐색기로 들어간다 (`TEST-17`).
 *
 * **첫 행이 보이는 것까지가 이 준비다** — 뿌리 조회가 끝났다는 뜻이고, 그 전에
 * 행을 찾으면 아직 비어 있는 트리를 본다.
 */
export async function enterExplorer(page: any, request: any, root: string) {
  await addEditor(request, root);
  await gotoWithEditors(page);
  await openExplorerAt(page, root);
  await expect(page.locator('.ed-tree .ed-row').first()).toBeVisible({ timeout: 10000 });
}

/**
 * **쓸 수 있는 빈 디렉터리**의 자리를 준다 (FR-CEM-25).
 *
 * "지우고 새로 만든다" 는 POSIX 에서는 언제나 되지만 Windows 에서는 아니다 —
 * 서버가 그 자리를 관측하고 있으면 `EBUSY` 다. 그때 실패로 끝내면 검사가 **시작도
 * 못 한다**.
 *
 * 지울 수 있으면 그 자리를 쓰고, 지울 수 없으면 **옆에 새 자리를 판다.** 검사가
 * 원한 것은 그 이름이 아니라 "깨끗한 자리" 이므로 뜻이 달라지지 않는다.
 */
export function freshDir(p: string): string {
  try {
    rmSync(p, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
    mkdirSync(p, { recursive: true });
    return p;
  } catch {
    const alt = p + '-' + Date.now().toString(36);
    mkdirSync(alt, { recursive: true });
    return alt;
  }
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
    // 자리를 먼저 확보한다 (FR-CEM-25) — 앞 검사의 사본을 서버가 아직 붙들고
    // 있으면 그 이름은 쓸 수 없고, 그때는 옆자리가 답이다.
    const dst = freshDir(join(root, 'copy-' + tag));
    copyDir(join(root, name), dst);
    // 서버가 저장하는 것과 같은 모양이다 (FR-CEM-11) — `EvalSymlinks` 를 지난 뒤의
    // **그 OS 의 정규형**이다. `osenv.realPath` 를 지나는 것이 규약인 이유는
    // Windows 의 **짧은 이름**이다: 순수 JS 의 `realpathSync` 는 `RUNNER~1` 을
    // 그대로 두고, 서버는 긴 이름으로 답한다 — 그 둘은 문자열로 같지 않아
    // `edWindowFor` 가 방금 더한 창을 찾지 못한다 (러너 실측).
    return realPath(dst);
  };
}

export { expect };
