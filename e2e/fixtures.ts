import { execFileSync } from 'child_process';
import { realpathSync, rmSync } from 'fs';
import { join } from 'path';

import { test as base, expect } from '@playwright/test';

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
async function resetWorkspace(request: any) {
  try {
    const get = await request.get('/api/workspace');
    if (!get.ok()) return;
    const rev = get.headers()['etag'] || '0';
    await request.put('/api/workspace', {
      headers: { 'If-Match': rev, 'Content-Type': 'application/json' },
      data: '{"schemaVersion":2,"windows":[]}',
    });
  } catch {
    // 서버가 아직 안 떴으면 무시 — 첫 테스트가 goto 에서 다시 기다린다.
  }
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
 * GIT_SIDEBAR_TABS_SRS §4.1 — Git 패널은 이제 사이드바 탭 뒤에 있다 (FR-SBT-1·2).
 *
 * `Windows` 가 기본 탭이므로(FR-SBT-7) Git 요소를 **보거나 누르는** 스펙은 먼저
 * 탭을 열어야 한다. 스펙마다 탭 클릭을 흩뿌리지 않고 여기 한 줄로 둔다.
 *
 * 탭 자체가 화면에 없는 상황(모바일 드로어가 닫혀 있다)에서는 클릭 대신 같은
 * 진입점을 직접 부른다 — 그런 스펙이 재려는 것은 탭 전환이 아니라 그 뒤의 패널이다.
 */
export async function openGitTab(page: any) {
  const tab = page.locator('.sb-tab[data-panel="git"]');
  const box = await tab.boundingBox();
  const vp = page.viewportSize();
  // 모바일 드로어가 닫혀 있으면 사이드바는 화면 밖으로 밀려 있다 — 눌릴 수 없다.
  const clickable = !!box && box.y >= 0 && box.x >= 0 && (!vp || box.y + box.height <= vp.height);
  if (clickable) await tab.click();
  else await page.evaluate(() => (window as any).app._sbSetTab('git'));
  await page.waitForFunction(
    () => !document.getElementById('sb-panel-git')?.hasAttribute('hidden'),
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
export const GIT_VIEW_TABS = 7;

/**
 * 앱이 뜨고 포커스된 칸의 터미널이 입력을 받을 준비가 될 때까지 기다린다.
 *
 * 37개 스펙이 바이트 동일한 본문을 각자 갖고 있던 것을 여기로 거뒀다
 * (FR-EHR-1·2). **변종 26개는 옮기지 않았다** — 모바일 진입이나 다른 초기
 * 스크립트를 쓰는 것들이고, 겉이 같아 보인다고 합치면 그 스펙이 재려던 것과
 * 다른 것을 재게 된다.
 */
export async function waitForInit(page: any) {
  await page.context().addInitScript(() => {
    sessionStorage.setItem('displayMode', 'desktop');
  });
  await page.goto('/');
  // Wait for init() → render() → xterm readiness inside the focused pane.
  await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', { timeout: 15000 });
}

/**
 * Git 창을 열고 고정 탭이 다 설 때까지 기다린다 (FR-EHR-4).
 */
export async function openGit(page: any, repo: string) {
  await page.evaluate((r: string) => (window as any).app.openGitWindow(r), repo);
  await expect(page.locator('#area .pn-tab[data-git-view]')).toHaveCount(GIT_VIEW_TABS);
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
    rmSync(dst, { recursive: true, force: true });
    execFileSync('cp', ['-R', join(root, name), dst]);
    return realpathSync(dst);
  };
}

export { expect };
