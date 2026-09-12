/**
 * Dongminal — e2e 가 보는 **공개 계약** (APP_TESTING_CONTRACT_SRS FR-ATC-1~7).
 *
 * ## 왜 있는가
 *
 * e2e 가 프론트의 private 상태를 **507곳에서 86파일에 걸쳐** 직접 만지고 있었다
 * (`05-test.md TEST-6`). 대가는 둘이다:
 *
 *   ① 리팩터가 결함이 아니라 **이름 변경**으로 깨진다. `edWindows` 를 고치려면
 *     33곳의 e2e 를 함께 열어야 하고, 그러면 그 리팩터의 diff 에서 "무엇이
 *     바뀌었나" 가 보이지 않는다
 *   ② e2e 가 **무엇을 계약으로 여기는지** 아무도 모른다. 114개 이름 중 어느
 *     것이 약속이고 어느 것이 마침 거기 있던 필드인지 구분이 없다
 *
 * 이 파일이 그 결합을 **86파일에서 한 자리로** 옮긴다. 내부 이름이 바뀌면 고칠
 * 자리는 여기 하나다 (FR-ATC-2).
 *
 * ## 무엇이 아닌가
 *
 * **`app.testing = app` 이 아니다** (D-ATC-1). 그냥 되내보내면 결합을 이름만
 * 바꾼 것이고, e2e 가 내일 새 내부에 닿는 것을 아무것도 막지 못한다. 아래
 * 목록은 **유한하고 diff 에 보인다** — 새 이름이 필요하면 이 파일을 먼저 고쳐야
 * 하고, 그 커밋이 "e2e 가 내부를 하나 더 보기 시작했다" 를 말한다.
 *
 * ## 규칙
 *
 *   이름    내부 이름에서 앞의 `_` 를 뗀 것. 승격된 이름(`FE-4`)은 이미 `_` 가
 *           없어 그대로다 (FR-ATC-4 · FR-FMB-44) — **e2e 가 보는 이름은 불변**
 *   읽기    **읽는 시점**에 계산한다. 함수도 그때 바인딩한다 (FR-ATC-5) —
 *           미리 바인딩하면 e2e 가 갈아 끼운 구현이 계약을 지나지 않는다
 *   쓰기    열려 있다 (FR-ATC-5a). 12개 이름 24곳이 상태를 인공으로 세운다
 *   빌드    갈래를 두지 않는다 (D-ATC-2) — 프로덕션에서 빼면 e2e 가 검증한
 *           것과 사용자가 받는 것이 다른 프로그램이 된다
 *
 * ## 절이 곧 목차다
 *
 * 아래 절 여덟이 "이 화면이 무엇을 약속하는가" 의 목록이다. 한 절이 유난히
 * 길면 그 축이 과하게 열려 있다는 뜻이고, 그것이 `FE-4`(계층 역전)를 닫을 때의
 * 지도가 된다.
 */

// 계약의 이름 목록. **절이 곧 목차다** — 이름을 더하기 전에 어느 절인지 정한다.
const APP_TESTING_NAMES = [
  // ── 창·칸·탭 (layout) ──
  //
  // 창 목록과 그 안의 칸·탭. `aw` 는 활성 창, `plainWindows` 는 Editor·Git 을 뺀 것이다.
  'aw', '_mkWindow', 'plainWindows', 'flattenPanes', 'isEditorWin', 'isGitWin',
  '_lastPlainWindow', 'moveTabToPane', 'moveTabToWindow', '_findEditorTab', 'slotFocused',
  'slotWindow', 'slotRenderFlush', '_slotRenderPending', 'windowFocused',
  '_windowFocusOwner', '_confirmClose', 'drag',
  // `TEST-6` 의 게이트 구멍으로 계약 밖에 남아 있던 것 (FR-FMB-45a).
  '_collectPanes', 'mPaneIdx', '_slots', 'splitPaneWithTab',
  '_loadPreset', '_savePreset', '_renderPresets',

  // ── 편집기·탐색기 (editor) ──
  //
  // Repo 창의 좌우 두 표면. `editors` 는 목록의 원본 자료구조다 (D-ATC-5).
  '_edActiveEditor', 'edActiveTree', '_edConfirm', 'edDirtyDiff', '_edDocs', '_edHome',
  'editors', 'edMutate', 'edNotes', '_edOff', 'edOpenFile', 'edOpenWindow',
  '_edQuickOpen', '_edReconcile', 'edRemove', 'edRootOf', '_edSearchOpen', '_edSearchRoot',
  'edSetSide', 'edStores', '_edTrees', '_edVisibleTrees', 'edWindowFor', 'edWindows',
  // 같은 구멍 (FR-FMB-45a). 사이드의 **폭**은 탭 선택과 다른 축이다 (REPO_SIDE_WIDTH_SRS).
  'edEnsurePane', '_edGitInterval', 'edSideOf', 'edSideWidth',
  'edSetSideWidth', '_edMigrateSideWidth', 'edStore', 'edTree',

  // ── git ──
  //
  // 관측기·패널은 (루트, 칸)마다 하나다 — e2e 가 그 모양을 알아야 재는 것이 있다.
  '_gitJobChip', '_gitObservers', 'gitOpenFile', 'gitPanelAt', 'gitPanels', 'gitPin',
  'gitRepos', 'gitReposRefresh', '_gitRootOfActive', 'gitSignal', 'gitUnpin', '_gitWdAt',
  'gitWindow',
  // 같은 구멍 (FR-FMB-45a).
  '_gitPanelRoot', '_onGitChanged',

  // ── 도구·터미널·Run (tool) ──
  //
  // 도구는 서버(데몬)가 소유하는 실행 실체다. 전경 이름(`_fg*`)과 복원(`_restore*`)이 그 수명의 두 축이다.
  'focusedTerminal', 'findToolLocation', 'jumpToTool', '_killTool', '_toolName',
  '_onToolActivity', '_onToolAttention', '_onToolForeground', '_fgApply', '_fgMap', 'fgNames',
  '_fgRestore', '_isToolFocusedActive', '_restoreBegin', '_restoreLive', '_restoreNote',
  '_restoreTool', '_restoreVoid', '_bg', '_runsPanel', '_onRunChanged',
  // 같은 구멍 (FR-FMB-45a).
  '_isToolBusy',

  // ── 사이드바·상태바 (sidebar) ──
  //
  // 탭과 레일, 그리고 하단 상태바.
  'sbBusy', '_sbJumpTo', 'sbRail', '_sbSetTab', 'sbTab', 'setSidebarCollapsed',
  'updateStatusBar', '_stats',

  // ── 주의·활동·알림 (attention) ──
  //
  // `_attn` 은 toolId → 사유의 Map 이다 (FR-PAN-9·16).
  '_attn', '_attnBeep', '_attnClear', '_attnRefresh', '_attnRestore', '_activity',
  '_activityRestore', '_notify', 'agentsStartPoll', 'agentsToggle',

  // ── 전파·저장 (sync) ──
  //
  // SSE 구독과 워크스페이스 저장. 두 축이 한 절에 있는 이유는 둘이 같은 경주를 만들기 때문이다 (WORKSPACE_SAVE_CONFLICT_SRS).
  '_sse', '_sseGen', '_sseSeen', '_cmdES', '_subscribeCommands', '_execRemote', '_echoResult',
  'save', 'saveSettings', '_onWorkspaceChanged', '_wsApplyInflight', '_focusCh',
  // 같은 구멍 (FR-FMB-45a). 저장의 **비행 중**과 **대기 중**은 다른 사실이다.
  '_applyRemoteWorkspace', '_saveInflight', '_savePending',

  // ── 그 밖 (misc) ──
  //
  // 위 어느 축에도 들지 않는 것. **이 절이 길어지면 축이 하나 빠진 것이다.**
  '_applyPageTitle', '_lspDefLangs', '_lspOnDiagnostics', '_mKbH', 'modKbd', '_mobileVvApply',
  '_scheduleMobileFit', 'resizeCheck',
  '_lspHoverLangs', '_lspRootOfPath',
];

/**
 * 계약 하나를 만든다 (FR-ATC-5·5a).
 *
 * 게터가 **읽을 때** 값을 가져오고, 함수면 그때 바인딩한다. 세터는 내부에
 * 그대로 쓴다 — 감싸지 않는다: e2e 가 갈아 끼우는 것은 내부 그 자체이고,
 * 여기서 변형하면 그 검사가 재는 것이 달라진다.
 */
function appTestingApi(app) {
  const api = {};
  for (const name of APP_TESTING_NAMES) {
    // 이름 규칙에 예외가 없다 (FR-ATC-4, FE_MODULE_BOUNDARY_SRS FR-FMB-44 로 개정):
    // **계약의 이름은 내부 이름에서 앞의 `_` 를 뗀 것**이다. `FE-4` 가 디렉터리를
    // 넘는 이름 148개를 승격하면서 그것들은 이미 `_` 가 없다 — 그래서 "뗀다" 가
    // "있으면 뗀다" 가 됐다. **e2e 가 보는 이름은 그대로다** (그것이 요점이다).
    const key = name.startsWith('_') ? name.slice(1) : name;
    Object.defineProperty(api, key, {
      enumerable: true,
      get() {
        const v = app[name];
        return (typeof v === 'function') ? v.bind(app) : v;
      },
      set(v) { app[name] = v },
    });
  }
  return api;
}

/**
 * `window.app.testing`.
 *
 * 한 번 만들어 들고 있는다 — 게터가 매번 내부를 다시 읽으므로 값은 늘 최신이고
 * (FR-ATC-5), 접근마다 객체를 만들면 `evaluate` 한 번에 114개 게터가 새로 선다.
 */
Object.defineProperty(App.prototype, 'testing', {
  get() {
    if (!this._testingApi) this._testingApi = appTestingApi(this);
    return this._testingApi;
  },
  configurable: true,
});
