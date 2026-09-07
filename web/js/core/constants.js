/**
 * Remote Terminal — 공용 상수
 *
 * 주제별로 갈라 둔다 (DEEPENING_REFACTOR_SRS 묶음 D). 이전에는 상수 712개가
 * 한 파일(1,586줄)에 있었고 그중 572개가 git 패널의 것이었다 — git 문구 하나를
 * 고치려고 터미널·모바일·테마가 함께 읽는 파일을 건드렸다.
 *
 * **전역 스코프는 그대로다.** 번들러가 없으므로 `index.html` 의 로드 순서가 곧
 * 의존성이며(architecture.md), 선언을 파일만 옮기고 내용은 고치지 않았다.
 *
 * 로드 순서: constants.js → constants-git.js → constants-editor.js
 * (`EDITOR_GIT_POLL_MS` 가 `GIT_REPOS_POLL_MS` 를 참조한다 — 버킷을 넘는
 * 참조는 그 하나뿐이고, 이 순서가 그것을 만족시킨다.)
 *
 * **선언만 옮기는 것이 아니다.** `Object.assign(GIT_WRITE_ERR, …)` 처럼 뒤에서
 * 값을 덧붙이는 top-level 문장이 있고, 그것은 대상 상수와 **같은 파일·같은
 * 순서**로 가야 한다 — 갈라 놓으면 로드 시점에 ReferenceError 다.
 */
const OP={INPUT:0,RESIZE:1,OUTPUT:0,ERROR:1,EXIT:2,TOOLID:3};
const enc=new TextEncoder(), dec=new TextDecoder();
// PAGE_TITLE_SRS FR-PGT-7: 설정이 비었을 때 쓰는 페이지 제목.
const DEFAULT_PAGE_TITLE='Dongminal';

// ── 부팅 화면 (BOOT_SCREEN_SRS) ──
// 마지막에 적용한 테마의 **최종 CSS 변수 맵**이 사는 자리. `index.html` 의 head
// 인라인 스크립트가 첫 페인트 전에 이것을 읽는다 — 그 스크립트는 constants.js
// 보다 먼저 돌므로 **키 문자열이 그쪽에도 리터럴로 적혀 있다**. 바꿀 때는 둘을
// 함께 바꾼다 (FR-BTS-3).
const THEME_VARS_KEY='dm.themeVars';
// 걷힘 애니메이션. 화면이 이미 준비된 뒤의 시간이므로 짧다.
const BOOT_FADE_MS=180;
// FR-BTS-14: 준비 신호가 오지 않아도 이 시간이 지나면 걷는다. 서버가 답하지
// 않는다고 화면이 영구히 잠기면, 사용자는 무엇이 잘못됐는지 볼 길조차 없다.
const BOOT_MAX_MS=6000;

// BOOT_SCREEN_REUSE_SRS D-BTR-8: 다시 세울 때의 단계 문구. 부르는 자리마다 적으면
// 같은 장면이 자리마다 다른 말을 한다.
const BOOT_STEP_RELOAD='화면을 다시 세웁니다';
const BOOT_STEP_VERSION='새 버전을 받았습니다 — 다시 엽니다';
const BOOT_STEP_BACKUP='설정을 되돌렸습니다 — 다시 엽니다';

// ── 포커스를 잃은 창의 가장자리 표시 (UNFOCUSED_EDGE_SRS 묶음 UFE) ──
// D-8: 표시 여부는 `documentElement` 의 클래스 하나로 정한다 — 포커스는 초당
// 여러 번 오갈 수 있고, 그때마다 DOM 을 짓고 허물 이유가 없다. 세기·깊이·전이
// 시간은 CSS 변수(`--ufe-*`, style.css)에 산다: 그 값들을 읽는 것은 CSS 뿐이다.
const WIN_UNFOCUSED_CLASS='win-unfocused';
/**
 * FR-UFE-10·12 / D-4a·D-8e: 가장자리 표시의 **세기 레벨**(0~10). 0 이 곧 끔이다.
 *
 * 스위치와 정도를 따로 두지 않는 이유는 "켜져 있는데 0" 이 뜻 없는 상태이기
 * 때문이고, 알파가 아니라 레벨을 저장하는 이유는 눈금과 저장값이 두 벌이 되면
 * 손으로 고친 설정 파일이 눈금 사이에 앉기 때문이다.
 *
 * D-8b: 알파는 여기서 파생한다 — `:root` 에 같은 값을 리터럴로 두지 않는다
 * (한쪽만 고쳐진다). 오버레이가 보이는 것 자체가 `win-unfocused`(JS 소관)에
 * 달렸으므로, 세기도 JS 가 세우는 편이 경계가 맞다.
 *
 * 레벨 5(기본)가 알파 .2 다 — 눈에 띄는 값 중 가장 옅은 쪽. 10 이면 .4 이고,
 * 그보다 진해지면 가장자리의 글자가 반전색에 삼켜진다.
 */
const UFE_LEVEL_DEFAULT=5;
const UFE_LEVEL_MAX=10;
const UFE_ALPHA_PER_LEVEL=.04;
// D-8c: 중간 정지점은 세기에서 파생한다. 선형으로 사라지게 두면 사이드바(150px)와
// 탑바가 통째로 깊이 안에 들어 그 글자들의 대비가 깎인다(실측) — 세기를 가장자리
// 쪽으로 몰면 띠는 그대로 보이면서 글자 위의 영향은 사라진다.
const UFE_ALPHA_MID_RATIO=.27;
// FR-UFE-15 / SETTINGS_CONTROLS_SRS D-7: 0 은 숫자가 아니라 상태다.
const UFE_LEVEL_OFF_LABEL='끔';
// FR-UFE-18: 레인지에서 손을 뗀 뒤 미리보기를 유지하는 시간.
const UFE_PREVIEW_MS=1400;
// 미리보기 동안 붙는 클래스. style.css 가 같은 이름을 안다.
const UFE_PREVIEW_CLASS='ufe-preview';

// 활동 패널 자동 새로고침 주기 기본값(ms). 설정에서 변경(per-device localStorage).
// 비정상 종료·hook 누락으로 SSE 가 안 와도 주기적으로 서버와 동기화 (FR-AAP-19).
const AGENTS_POLL_DEFAULT=5000;
// 상태별 글꼴 기호(이모지 아님) — 색(.ag-state.<state>)과 함께 상태를 구분.
const AGENT_STATE_ICON={working:'●',done:'✓',waiting:'…',idle:'○'};

// 모바일 키바 제스처 상수 (USER_CHECKLIST_FIXES_SRS FR-MTB-2/4/5).
// TAP_SLOP: 이 거리를 넘으면 탭이 아니라 스크롤로 넘긴다.
// GHOST_CLICK: touchend 처리 후 이 시간 안에 오는 click 은 합성분으로 본다.
const MKB_LONG_PRESS_MS=600;
const MKB_DOUBLE_TAP_MS=350;
const MKB_TAP_SLOP_PX=10;
const MKB_GHOST_CLICK_MS=700;

// 모바일 TUI 입력·스크롤 교정 (MOBILE_TUI_INPUT_SCROLL_SRS FR-MTI-18).
// TOUCH_GAIN: xterm 의 터치 경로는 손가락 이동을 1:1 픽셀로만 스크롤한다 —
//   실측 200px = 11행(화면 37행). 2.5배면 200px 이 화면 3/4 를 넘긴다.
// TOUCH_SLOP: 이 거리를 넘기 전에는 탭으로 보고 xterm 에 그대로 넘긴다.
// FLING_*: 손을 뗀 뒤의 관성. 프레임당 DECAY 를 곱하고 MIN_V 밑에서 멈춘다.
// KB_EPS: 키보드 높이 잡음. 이 미만의 변화로는 재적용하지 않는다.
// KB_UP: 이 높이를 넘으면 소프트 키보드가 떠 있다고 본다.
const MTI_TOUCH_GAIN=2.5;
const MTI_TOUCH_SLOP_PX=8;
const MTI_FLING_DECAY=0.93;
const MTI_FLING_MIN_V=0.4;
const MTI_FLING_MAX_V=120;
const MTI_KB_EPS_PX=4;
const MOBILE_KB_UP_PX=80;
// 스크롤 제스처 뒤에 오는 합성 마우스 이벤트를 무시하는 창 (FR-MTI-29).
const MTI_SYNTH_MOUSE_MS=700;
// `VERSION_CHECK_MS`(새 버전 확인 주기)가 여기 있었다. 감지의 계기가 주기에서
// **서버의 인사**로 바뀌면서 사라졌다 (RELOAD_CONTINUITY_SRS FR-RLC-2·2a) — 자산이
// 바뀌는 길은 프로세스 교체뿐이고 그때 SSE 가 끊기므로, 구독이 열리는 순간이 곧
// 물어볼 순간이다. 주기를 함께 두면 같은 일을 두 벌로 하며 요청만 는다.

// 복귀 대상 Pane 을 기다리는 상한 (FR-BGR-7). delWindow 는 마지막 창을 지운 뒤
// _mkWindow 를 await 하는데, 그 사이 ws.windows 가 비어 대상 Pane 이 없다.
// PTY 생성 왕복 한 번이면 끝나는 과도 상태이므로 짧게 기다렸다 재시도한다.
const RESTORE_PANE_WAIT_MS=25;
const RESTORE_PANE_WAIT_TRIES=20;

// RECONNECT_STORM_SRS FR-RCS-3 · D-2: 열린 WebSocket 이 **이만큼 유지되어야**
// 유효한 연결로 인정하고 재연결 백오프를 0 으로 되돌린다. onopen 만으로 되돌리면
// 서버가 소켓을 즉시 닫는 모든 경우에 백오프가 매 사이클 리셋되어 지연 0 의
// 무한 루프가 된다 — 실측 95 연결/초, TIME_WAIT 2,881 (§2.2).
// 서버가 즉시 닫는 실패는 모두 1초 안에 끝나므로(실측 0.6ms) 3초는 그 전부를
// 무효로 가르면서 정상 사용 중의 짧은 끊김은 유효로 인정하는 자리다.
const WS_HEALTHY_MS=3000;

// RECONNECT_STORM_SRS FR-RCS-6: 커맨드 SSE 의 재접속 백오프. **상한만 있고
// 포기는 없다.** 종전에는 20회 실패 후 영구히 포기했는데, SSE 가 죽으면
// `_applyRemoteWorkspace` 의 자가 치유(서버가 모르는 도구를 destroy)가 영영
// 돌지 않아 죽은 패널이 무한히 재접속한다 (§2.5). 실측으로 그 상태의 브라우저
// 둘이 초당 91연결을 냈다.
const SSE_RETRY_MIN_MS=1000;
const SSE_RETRY_MAX_MS=30000;

// RELOAD_CONTINUITY_SRS FR-RLC-25: 커맨드 SSE 의 **침묵 상한**과 그것을 재는 주기.
//
// `readyState` 는 브라우저가 믿는 것이지 사실이 아니다 (D-7). 잠에서 깬 기기의
// 소켓은 끊긴 줄 모른 채 `OPEN` 으로 남으며(half-open), 그동안 명령도 워크스페이스
// 갱신도 주의 알림도 오지 않는다. 사실에 가장 가까운 근거는 **최근에 무엇이
// 왔는가** 하나다.
//
// 서버는 인사를 15초마다 보낸다(`sseHelloEvery`). 그 세 배를 상한으로 두어 한두
// 번 늦는 것(네트워크 지연·탭 스로틀링·GC)을 죽음으로 읽지 않는다.
const SSE_SILENCE_MS=45000;
const SSE_SILENCE_CHECK_MS=5000;

// TOOL_LIST_UNKNOWN_SRS FR-TLU-9: 첫 화면이 도구 목록을 **모르는** 스냅숏을
// 받았을 때 다시 물어보는 횟수와 간격. 데몬 재접속은 실측 0.02초에 끝나므로
// (SRS §2.1) 2초면 충분히 넉넉하고, 상한이 있어 데몬이 돌아오지 않아도 화면은
// 선다 — 그 뒤의 회복은 SSE 의 몫이다.
const STATE_UNKNOWN_RETRIES=10;
const STATE_UNKNOWN_RETRY_MS=200;

// FR-TLU-5·6: 도구 목록을 모를 때 쓰는 "살아 있음" 판정. `Set` 과 같은 자리에
// 꽂히며 무엇을 묻든 참이라 답한다 — 모르면 **어떤 도구도 죽었다고 말할 수 없다**.
// 집합으로 만들지 않는 이유는 그 집합에 무엇을 넣어야 할지가 곧 물음이기 때문이다.
const TOOLS_ALL_LIVE={has(){return true}};

// RELOAD_CONTINUITY_SRS FR-RLC-6: 사이드바 탭이 돌아갈 창의 기억. `activeWindow`
// 와 같은 범주이므로 같은 자리(sessionStorage)에 산다 (SRS §2.3).
const RETURN_WINDOW_KEY={plain:'lastPlainWindow',editor:'lastEditorWindow'};

// ── 사이드바 접기 (SIDEBAR_COLLAPSE_SRS 묶음 SBC) ──
//
// FR-SBC-4 / D-4: 접힘은 `sidebarTab` 과 같은 범주의 "이 기기가 보는 방식" 이므로
// localStorage 에만 산다. 워크스페이스에 두면 다른 기기의 화면 폭에 맞춘 선택이
// 이 기기로 넘어온다.
// D-1·2: 클래스는 `documentElement` 에 붙는다 — index.html 의 인라인 스크립트가
// 첫 프레임에 같은 이름을 붙이며(FR-SBC-5), **그 문자열과 여기가 같아야 한다.**
const SIDEBAR_COLLAPSED_KEY='sidebarCollapsed';
const SIDEBAR_COLLAPSED_CLASS='sb-collapsed';
/**
 * FR-SBC-7 (2026-09-06 개정): **접기 버튼이 없다.** 손잡이가 그 일을 한다.
 *
 * 폭을 줄이다 이 값 아래로 끌면 접히고, 접힌 경계를 오른쪽으로 끌면 펼쳐진다 —
 * 접는 것과 좁히는 것은 사용자에게 같은 손짓의 끝과 끝이다. 최소 폭(100)보다
 * 작아야 한다: 그 사이가 "더 좁히려 했다" 는 뜻을 담는 구간이다.
 */
const SIDEBAR_COLLAPSE_AT_PX=70;

const MOD_CODES=new Set(['ControlLeft','ControlRight','AltLeft','AltRight','MetaLeft','MetaRight','ShiftLeft','ShiftRight']);
/**
 * UX_REVISION_SRS FR-KEY-4: 브라우저 기본 동작을 **막지 않는** 키.
 *
 * 둘로 나뉜다. ① 앱이 고장났을 때의 탈출구 — 새로고침·전체화면·개발자도구.
 * ② 클립보드와 선택 — 터미널에서 고른 글자를 복사하지 못하게 되면 그것이
 * 차단이 아니라 고장이다. 사용자가 이 키들을 단축키로 배정하면 그때는 매칭
 * 경로가 먼저 잡아 preventDefault 하므로 자유도는 그대로다 (FR-KEY-1).
 */
// ── 워크스페이스 저장 충돌 (WORKSPACE_SAVE_CONFLICT_SRS 묶음 R) ──
//
// 연속 충돌이 이만큼 이어지면 그 사실을 기록한다 (FR-WSC-8). 조용히 되풀이하면
// 아무도 그것이 일어나는지 모른다 — 접수한 409 로그가 그 증거였다.
const WS_SAVE_CONFLICT_WARN=4;
// 충돌 뒤 다음 저장을 미루는 시간 (FR-WSC-7). 두 화면이 서로 밀어내는 동안 그
// 사이를 벌린다. 연속 충돌 수에 비례해 늘리되 상한을 둔다 — 늘지 않으면 벌리는
// 뜻이 없고, 상한이 없으면 저장이 사실상 멎는다.
const WS_SAVE_BACKOFF_MS=200;
const WS_SAVE_BACKOFF_MAX_MS=2000;

const KEY_BLOCK_EXEMPT_BARE=new Set(['F5','F11','F12']);
const KEY_BLOCK_EXEMPT_MOD=new Set(['KeyC','KeyV','KeyX','KeyA','KeyI','KeyJ','KeyR']);


// Built-in hotkeys are not user-rebindable and may match modifier variants
// (e.g. Ctrl OR Cmd) that the single-binding `shortcuts` table can't express.
// They are dispatched through the same `executeAction` path as user shortcuts.
const BUILTIN_HOTKEYS = [
  { match: e => e.code === 'KeyF' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey, action: 'toggleSearch' },
];

// TOPTS theme is set after THEMES loads (see themes.js)
var TOPTS={
  scrollback:50000,cursorBlink:true,cursorStyle:'block',
  fontSize:14,lineHeight:1.2,allowProposedApi:true,logLevel:'off',
  fontFamily:"'Menlo','Monaco','Consolas','Liberation Mono','Courier New',monospace",
  theme:null,
};

// ── Git 창 (GIT_SRS §3.4 / FR-GIT-25~31) ──

// 창의 type 은 없을 수 있다. 없으면 terminal 이다 — 기존 workspace.json 이 그대로
// 로드돼야 한다 (FR-GIT-25). 판정은 항상 WINDOW_TYPE_GIT 인지로만 한다.
const WINDOW_TYPE_TERMINAL='terminal';
const WINDOW_TYPE_GIT='git';
const TAB_TYPE_GIT='git';

// ── 샌드박스 창의 작업 방식 (SANDBOX_PICK_COPY_SRS FR-SPK-10·23) ──
//
// 서버의 `WorkKind` 를 그대로 받는다 (`/api/sandbox/profiles` 의 `work`).
// **뜻이 다른 것은 표기가 아니라 결과다** — 마운트는 컨테이너 안 변경이 호스트에
// 남고, 복사는 남지 않는다. 그 차이를 화면 세 자리에서 같은 말로 알린다
// (FR-SPK-21): 선택창의 버튼, 입력란 도움말, 사이드바 창 배지.
// 프로파일 이름. 서버의 `ProfileScratch`·`ProfileDev` 와 같은 값이다.
const SANDBOX_PROFILE_SCRATCH='scratch';
const SANDBOX_WORK_MOUNT='mount';
const SANDBOX_WORK_COPY='copy';
const SANDBOX_WORK_NONE='none';
// UX_BATCH6_SRS FR-SBM-1: 아는 작업 방식 전부. 판정을 표 하나에서 파생시킨다 —
// 손으로 적으면 넷째가 생길 때 한쪽만 고쳐진다.
const SANDBOX_WORK_KINDS=[SANDBOX_WORK_MOUNT,SANDBOX_WORK_COPY,SANDBOX_WORK_NONE];
const SANDBOX_WORK_LABEL={[SANDBOX_WORK_MOUNT]:'마운트',[SANDBOX_WORK_COPY]:'복사'};
// FR-SBM-1: 선택창의 두 갈래. `none` 은 고를 것이 아니라 **그 프로파일이 폴더를
// 쓰지 않는다**는 사실이므로 고르는 목록에 없다.
const SANDBOX_WORK_PICKS=[SANDBOX_WORK_MOUNT,SANDBOX_WORK_COPY];
// FR-SBM-5: 마운트에 폴더를 함께 고르면 그 창은 격리 경계가 아니다. 등급 배지는
// 프로파일의 것이므로(FR-SBM-4) 그 사실은 이 줄이 따로 말한다.
const SANDBOX_MOUNT_WARN='이 창 안의 코드가 고른 폴더를 고칠 수 있습니다 — 격리 경계가 아닙니다.';
const SANDBOX_WORK_PICK_LABEL='작업 방식';
const SANDBOX_WORK_TITLE={
  [SANDBOX_WORK_MOUNT]:'고른 폴더가 컨테이너에 이어집니다. 컨테이너 안 변경이 호스트에 그대로 남습니다.',
  [SANDBOX_WORK_COPY]:'고른 폴더의 내용이 컨테이너로 복사됩니다. 컨테이너 안 변경은 호스트로 돌아오지 않습니다.',
  [SANDBOX_WORK_NONE]:'이 프로파일은 작업 폴더를 쓰지 않습니다 — 고른 폴더는 쓰이지 않습니다.',
};
// FR-SPK-3·4: 입력란은 언제나 보이고 비어 있다. 지금 있는 자리는 버튼으로만 넣는다.
const SANDBOX_WORKDIR_LABEL='작업 폴더';
const SANDBOX_WORKDIR_PLACEHOLDER='비우면 아무것도 넣지 않습니다';
// FR-SPK-7: 프로파일이 scratch 하나뿐일 때. 이 안내가 없으면 사용자는 프로파일을
// 늘리는 길이 있다는 것 자체를 알 수 없다.
// UX_BATCH6_SRS FR-SBM-1: 마운트는 이제 여기서 고른다 — 안내가 가리키던 것이
// 사라졌다. 남은 것은 **이미지**다: scratch 는 debian 한 벌이고, 다른 도구가
// 필요하면 dev 프로파일에 그 이미지를 적어야 한다.
const SANDBOX_DEV_HINT='다른 이미지가 필요하면 설정에서 dev 프로파일을 정의하세요.';
const SANDBOX_DEV_SETTINGS='설정 열기';
// FR-SPK-22: 복사본으로 연 창의 사이드바 배지.
const SANDBOX_COPY_PROGRESS='작업 폴더를 컨테이너로 복사하는 중입니다 — 크기에 따라 시간이 걸립니다.';
const SANDBOX_COPY_BADGE='복사';
const SANDBOX_COPY_BADGE_TITLE=
  '작업 폴더의 복사본입니다 — 이 창 안의 변경은 호스트로 돌아오지 않습니다.';

// UX_BATCH5_SRS FR-TIP-1: 칸의 탭 추가 버튼. `+` 만으로는 무엇이 더해지는지
// 보이지 않는다.
// ── 탭 너비 (TAB_WIDTH_SRS FR-TBW-2·3) ──
//
// 기본 160 은 VSCode 의 `tabSizingFixedMaxWidth` 기본과 같은 값이다 — "긴 이름도
// 웬만큼 보이는 폭" 으로 이미 검증된 수다.
//
// 하한 40 의 근거는 실측이다 (D-3): `.pn-tab` 은 좌우 패딩 20px + gap 4px +
// 닫기(`×`, 11px 글자 ≈ 8px) 를 쓰므로 **32px 이 이름 이전에 소비된다.** 그보다
// 좁으면 닫기가 잘려 **닫을 수 없는 탭**이 된다.
const TAB_WIDTH_DEFAULT=160;
const TAB_WIDTH_MIN=40;
const TAB_WIDTH_MAX=480;

const TAB_ADD_TITLE='Add a tab to this pane';

// ── 툴팁 (UX_BATCH5_SRS 묶음 C / FR-TIP-1·2·4) ──
//
// 라벨이 한두 낱말인 버튼들이다 — `예`·`아니오`·`확인`·`복사` 는 **무엇을** 하는지
// 말하지 않는다. 문자열은 상수 표에 산다 (FR-TIP-4).
const TIP_NOTIFY_OK='Dismiss this message';
const TIP_CLOSE_TOOL='Close this tool and end its session';
const TIP_CLOSE_CANCEL='Keep this tool open';
const TIP_CLOSE_SAVE='Save the file, then close';
const TIP_CLOSE_BG='Keep it running in the background instead of closing';
const TIP_SBX_CANCEL='Close without creating a sandbox window';
const TIP_SBX_SETTINGS='Open settings to define more sandbox profiles';
const TIP_COPY_DO='Copy the selected text to the clipboard';
const TIP_COPY_CLOSE='Close without copying';
const TIP_DEL_OK='Delete permanently — this cannot be undone';
const TIP_DEL_CANCEL='Keep it and close';
const TIP_BG_KILL_YES='Terminate this background tool';
const TIP_BG_KILL_NO='Leave it running';
const TIP_RUNS_DEL='Remove this run from the list and its history';
const TIP_RUNS_YES='Delete this run permanently';
const TIP_RUNS_NO='Keep this run';
// FR-TIP-1: 단축키 설정의 두 버튼. 키 조합과 `↺` 가 라벨이라 무엇을 하는지는
// 툴팁만 말할 수 있다.
const SHORTCUT_REBIND_TITLE='Click, then press the keys you want for this action';
const SHORTCUT_RESET_TITLE='Reset this shortcut to its default';

// ── 컨테이너 런타임의 상태 (UX_BATCH5_SRS 묶음 B / FR-SRT-1~8) ──
//
// 종전에는 프로파일이 비었다는 것 하나로 "설치 안 됨" 과 "실행 안 됨" 을 한꺼번에
// 알렸다. 그 둘은 **사용자가 할 일이 다르다** — 하나는 설치이고 하나는 실행이다.
// 그리고 데몬이 죽어도 프로파일 목록은 정상으로 오므로(§2.3 실측), 그 안내는
// 실제로 닿지도 않았다.
//
// 값은 서버의 상수와 짝이다 (`internal/shared/sandbox/runtime.go`).
const SBX_RT_OK='ok';
const SBX_RT_STOPPED='stopped';
const SBX_RT_MISSING='missing';
// FR-SRT-7: 기동 뒤 데몬이 뜨기를 기다리는 주기와 상한 (NFR-SRT-2). Docker Desktop
// 의 기동은 수십 초가 걸리므로 상한을 넉넉히 둔다.
const SBX_RT_POLL_MS=2000;
const SBX_RT_POLL_MAX_MS=60000;
const SBX_RT_TITLE_MISSING='컨테이너 런타임이 없습니다';
const SBX_RT_TITLE_STOPPED='컨테이너 런타임이 실행 중이 아닙니다';
const SBX_RT_MSG_MISSING='샌드박스 창은 컨테이너 런타임(docker) 위에서 돕니다. 아래 명령으로 설치하세요.';
// FR-SRT-6: 이 문장이 없으면 사용자는 설치하고도 같은 모달을 다시 본다 — 런타임을
// 찾는 일은 서버가 뜰 때 한 번뿐이다 (`sandboxplace.Wire`).
const SBX_RT_MSG_RESTART='설치한 뒤에는 dongminal 을 다시 시작해야 합니다.';
const SBX_RT_MSG_STOPPED='docker 는 설치되어 있으나 데몬에 닿지 못했습니다. 지금 실행할까요?';
// D-5: linux 의 기동은 권한을 요구한다. 서버가 sudo 를 부르면 비밀번호를 받을 길이
// 없어 무응답으로 멈추므로, 사용자가 자기 셸에서 치는 것이 유일하게 끝나는 길이다.
const SBX_RT_MSG_MANUAL='아래 명령을 직접 실행하세요.';
const SBX_RT_START='실행';
const SBX_RT_COPY='복사';
const SBX_RT_COPIED='복사했습니다';
const SBX_RT_CLOSE='닫기';
const SBX_RT_STARTING='실행 중입니다 — 데몬이 뜰 때까지 기다립니다…';
const SBX_RT_START_FAIL='실행하지 못했습니다';
// 상한을 넘긴 것은 실패와 다르다 — 명령은 돌았고 데몬이 아직 안 떴을 뿐이다.
const SBX_RT_TIMEOUT='기다리는 동안 데몬이 뜨지 않았습니다 — 조금 뒤 다시 눌러 보세요.';
const SBX_RT_NO_CMD='이 운영체제의 설치 명령을 알지 못합니다 — docker 문서를 참고하세요.';
const SBX_RT_DOCS='https://docs.docker.com/get-started/get-docker/';

// ── 파일 전송 (FILE_TRANSFER_SRS §3.3) ──

// FR-FTR-8: 완성되지 않은 OSC 시퀀스를 보류하는 상한과, 다음 청크를 기다리는
// 시간. 상한을 넘으면 OSC 가 아니라고 보고 흘려보낸다 — 종결자 없는 입력에
// 화면이 영영 멈추지 않게 한다.
const OSC_CARRY_MAX=4096;
const OSC_CARRY_MS=50;
const TERM_UPLOAD_NO_CWD='✗ 이 터미널의 폴더를 알 수 없어 업로드하지 않았습니다';

// ── 전송 알림 (TERM_XFER_NOTICE_SRS §3) ──

// FR-TXN-4: 성공은 3초, 읽고 판단할 것이 있는 알림은 8초. 진행 팝업은 0 —
// 스스로 사라지지 않는다 (FR-TXN-5).
const TOAST_MS=3000;
const TOAST_ERR_MS=8000;
const TERM_UPLOAD_BUSY='↑ %s 업로드 중…';
const TERM_UPLOAD_OK='✓ %s 업로드 완료 (%z)';
const TERM_UPLOAD_FAIL='✗ %s 업로드 실패';
const TERM_DOWNLOAD_BUSY='↓ %s 내려받는 중…';

// ── Editor 탭 · Editor 창 (EDITOR_TAB_SRS 묶음 T·W) ──

// FR-EDT-40: 세 번째 창 타입. Git 창과 마찬가지로 판정은 이 값과의 비교 하나다.
const WINDOW_TYPE_EDITOR='editor';

// EDITOR_GIT_UX_SRS 묶음 V — 열 수 있는 형식인가.
const FILE_PROBE_API='/api/file/probe';
const FILE_RAW_API='/api/file/raw';
const FILE_KIND_TEXT='text';
const FILE_KIND_IMAGE='image';
const FILE_KIND_BINARY='binary';
const FILE_UNSUPPORTED_TITLE='열 수 없는 형식입니다';
const FILE_UNSUPPORTED_HINT='이진 파일은 편집기로 열지 않습니다 — 열어서 저장하면 원본이 깨집니다.';
const FILE_IMAGE_FAIL='이미지를 불러오지 못했습니다';

// FR-EDT-110 의 종단. M2 는 목록 조회·추가·제거·재정렬만 쓴다.
const EDITORS_API='/api/editors';

// ── 터미널의 복사 (EXPLORER_TRANSFER_IGNORE_SRS 묶음 F · FR-ETR-40·41) ──
//
// 마지막 수단의 창이다. 앞의 두 단(clipboard API · execCommand)이 실패하는 것은
// 코드가 아니라 **환경이 정하는 것**이라, 이 창이 없으면 복사는 "될 때도 있고
// 안 될 때도 있는 것" 이 된다 (D-12).
const TERM_COPY_ID='term-copy';
const TERM_COPY_TITLE='복사';
const TERM_COPY_WHY='브라우저가 자동 복사를 막았습니다 — 아래에서 복사하세요';
const TERM_COPY_DO='복사';
const TERM_COPY_MANUAL='직접 선택해 복사하세요';
const TERM_COPY_CLOSE='닫기';

// ── 내부 새로고침 (SOFT_RELOAD_SRS 묶음 C · FR-SRL-8~11) ──
//
// 페이지를 다시 여는 것은 가진 것을 전부 버리는 일이다 — 편집기의 미저장 내용,
// 탐색기의 펼침·스크롤, Git 패널의 열린 탭이 함께 사라진다. 이쪽은 **서버의
// 사실만 다시 받는다.**
const RELOAD_BTN_ID='soft-reload-btn';
const RELOAD_TITLE='Reload the app without a full page refresh';
const RELOAD_BUSY_TITLE='다시 가져오는 중…';

// ── 레이아웃 프리셋 ──
//
// 프리셋의 대상은 **일반 창**이다. Editor 창은 pane 이 없는 것이 정상이고
// (FR-EDT-55) 그 layout(null)을 저장하면 불러오기가 새 창의 layout 을 지워
// 창은 사라지고 도구만 남는다. 그럴 때 저장을 거절하고 사유를 남긴다.
const PRESET_PANEL_ID='panel-presets';
const PRESET_MSG_CLASS='preset-msg';
const PRESET_SAVE_NO_PLAIN='저장할 일반 창이 없습니다 — 터미널 창을 열고 다시 시도하세요';
