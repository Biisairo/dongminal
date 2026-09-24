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
 * (`constants-editor.js` 가 git 버킷의 값을 딛는다 — `ED_DD_AXIS` 가 `GIT_AXIS`
 * 를 참조하는 자리 하나이고, 이 순서가 그것을 만족시킨다. 종전에 예로 들던
 * `EDITOR_GIT_POLL_MS` 는 `GIT_REPOS_POLL_MS` 의 별칭이었고
 * POLL_INTERVAL_SETTINGS_SRS FR-PIS-12 로 사라졌다.)
 *
 * **선언만 옮기는 것이 아니다.** `Object.assign(GIT_WRITE_ERR, …)` 처럼 뒤에서
 * 값을 덧붙이는 top-level 문장이 있고, 그것은 대상 상수와 **같은 파일·같은
 * 순서**로 가야 한다 — 갈라 놓으면 로드 시점에 ReferenceError 다.
 */
// SEQ 는 서버가 **좌표**를 통보하는 프레임이다 (TERMINAL_RESUME_SRS FR-TRS-6).
// 페이로드 9 바이트 — 오프셋 8(빅엔디언) + 전량 재생 여부 1. 재접속의 `since` 가
// 이 값에서 나온다.
// SIZE 는 서버가 **PTY 의 크기**를 통보하는 프레임이다 (M9_SRS FR-M9-3).
// 페이로드 4 바이트 — cols 2 + rows 2, 빅엔디언. 크기의 주인이 아닌 창은 이 값을
// 따르고 자기 `fit()` 결과를 PTY 에 보내지 않는다 (D-M9-3).
const OP={INPUT:0,RESIZE:1,OUTPUT:0,ERROR:1,EXIT:2,TOOLID:3,SEQ:4,SIZE:5,REPLY_SEAT:6};
// TERMINAL_RESUME_SRS FR-TRS-18b: `OpSeq` 플래그 바이트의 비트.
// bit0 은 종전의 값 `1`(전량 재생)과 같고, bit1 이 "그 도구가 alt screen 안이다" 다.
const SEQ_FLAG_FULL=1, SEQ_FLAG_ALT=2;
const enc=new TextEncoder(), dec=new TextDecoder();
// PAGE_TITLE_SRS FR-PGT-7: 설정이 비었을 때 쓰는 페이지 제목.
const DEFAULT_PAGE_TITLE='Dongminal';

// ── 부팅 화면 (BOOT_SCREEN_SRS) ──
// 마지막에 적용한 테마의 **최종 CSS 변수 맵**이 사는 자리. `index.html` 의 head
// 인라인 스크립트가 첫 페인트 전에 이것을 읽는다 — 그 스크립트는 constants.js
// 보다 먼저 돌므로 **키 문자열이 그쪽에도 리터럴로 적혀 있다**. 바꿀 때는 둘을
// 함께 바꾼다 (FR-BTS-3).
const THEME_VARS_KEY='dm.themeVars';
// M8 FR-B-6 (UX-11): 종전에 CSS `content` 로만 있던 문구 셋. DOM 텍스트가 됐다.
const SLOT_EMPTY_HINT=t('core.slot_empty_hint');
const DROP_FILES_HINT=t('core.drop_files_hint');
const CLICK_TO_FOCUS_HINT=t('core.click_to_focus_hint');
// SYSTEM_THEME_FOLLOW_SRS FR-STF-5: 선주입이 두 맵 중 하나를 고를지의 스위치.
const THEME_FOLLOW_KEY='dm.themeFollow';
// 걷힘 애니메이션. 화면이 이미 준비된 뒤의 시간이므로 짧다.
const BOOT_FADE_MS=180;
// FR-BTS-14: 준비 신호가 오지 않아도 이 시간이 지나면 걷는다. 서버가 답하지
// 않는다고 화면이 영구히 잠기면, 사용자는 무엇이 잘못됐는지 볼 길조차 없다.
const BOOT_MAX_MS=6000;

// BOOT_SCREEN_REUSE_SRS D-BTR-8: 다시 세울 때의 단계 문구. 부르는 자리마다 적으면
// 같은 장면이 자리마다 다른 말을 한다.
const BOOT_STEP_RELOAD=t('core.boot_step_reload');
const BOOT_STEP_VERSION=t('core.boot_step_version');
const BOOT_STEP_BACKUP=t('core.boot_step_backup');

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
/* D-5a: 레벨당 .1 이다 (종전 .04).
 *
 *   이전 동작: 기본 5 에서 알파 .2 — 반전이 20% 만 섞여 어느 테마에서든 옅은
 *              흰빛 하나로 수렴했다 (접수: "그냥 흰색같아서")
 *   새  동작: 기본 5 가 .5, 10 이 1.0(완전 반전)
 *   이유:     세기를 곡선의 **가장자리**에만 몰아 준다 — 20px 안쪽부터는
 *             `UFE_ALPHA_MID_RATIO` 로 급히 떨어지므로 글자 위의 영향은 종전과
 *             거의 같고, 띠 자체는 실제로 반대색으로 보인다 */
const UFE_ALPHA_PER_LEVEL=.1;
// D-8c: 중간 정지점은 세기에서 파생한다. 선형으로 사라지게 두면 사이드바(150px)와
// 탑바가 통째로 깊이 안에 들어 그 글자들의 대비가 깎인다(실측) — 세기를 가장자리
// 쪽으로 몰면 띠는 그대로 보이면서 글자 위의 영향은 사라진다.
const UFE_ALPHA_MID_RATIO=.27;
// FR-UFE-15 / SETTINGS_CONTROLS_SRS D-7: 0 은 숫자가 아니라 상태다.
const UFE_LEVEL_OFF_LABEL=t('core.ufe_level_off_label');
// FR-UFE-18: 레인지에서 손을 뗀 뒤 미리보기를 유지하는 시간.
const UFE_PREVIEW_MS=1400;
// 미리보기 동안 붙는 클래스. style.css 가 같은 이름을 안다.
const UFE_PREVIEW_CLASS='ufe-preview';

/* ── 알림 가장자리 (ALERT_MOBILE_CONTEXT_SRS 묶음 AED) ──
 *
 * 포커스 표시와 **같은 규약, 다른 값**이다 (D-9): 손잡이 하나(0~10), 기본 5,
 * 0 이 곧 끔. 저장 키를 따로 두는 이유는 취향이 다르기 때문이다 — 포커스 표시는
 * 상시 켜져 있고, 알림은 드물게·강하게 온다.
 *
 * 레벨당 .1 이므로 기본 5 가 알파 .5 다. 이 띠는 맥박하며 사라졌다 나타나므로
 * 정지한 띠보다 눈에 잘 들어온다 — 같은 세기라도 더 강하게 읽힌다.
 */
const ATTN_EDGE_LEVEL_DEFAULT=5;
const ATTN_EDGE_LEVEL_MAX=10;
const ATTN_EDGE_ALPHA_PER_LEVEL=.1;
const ATTN_EDGE_PREVIEW_MS=1400;
const ATTN_EDGE_PREVIEW_CLASS='ae-preview';
// FR-AED-6: 알림이 있는 동안 documentElement 에 붙는 클래스. style.css 가 같은 이름을 안다.
const ATTN_EDGE_ON_CLASS='attn-edge-on';

/**
 * FR-AEV-15: 알람에 곁들이는 **내용**의 표시 상한(글자).
 *
 * 서버는 이미 활동 필드를 자른다(`ActivityDetailMax`) — 이 값은 그보다 짧은 **화면의
 * 상한**이다. 데스크톱 알림은 본문이 길면 OS 가 제멋대로 자르고, 알림 센터의 한
 * 줄도 자리가 좁다. codex 의 `last-assistant-message` 는 문단 단위로 올 수 있다.
 */
const ATTN_DETAIL_VIEW_MAX=140;

// 활동 패널 자동 새로고침 주기 기본값(ms). 설정에서 변경(per-device localStorage).
// 비정상 종료·hook 누락으로 SSE 가 안 와도 주기적으로 서버와 동기화 (FR-AAP-19).
const AGENTS_POLL_DEFAULT=5000;
/**
 * POLL_INTERVAL_SETTINGS_SRS FR-PIS-16 / D-3: **저장 자리가 서버 설정으로 옮겼다.**
 *
 * 종전에는 `localStorage` 였고(app.js 의 접근자), 그래서 다섯 주기 중 이것 하나만
 * 다른 브라우저 창에 전파되지 않았다. 나머지 넷과 같은 자리에 두면 `settings_changed`
 * 전파(FR-SYN)를 그대로 받는다. 상수는 기본값으로 남는다 (FR-PIS-11).
 */
var agentsPollInterval=AGENTS_POLL_DEFAULT;
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
/**
 * 사이드바 폭의 하한·상한 (M6 `FE-18`).
 *
 *   이전 동작: `100`·`400` 이 **네 자리에 리터럴**로 있었다 — `app.js`·
 *             `app-cmd.js`(둘 다 `Math.max(100,Math.min(400,…))`),
 *             `input-binding.js`(드래그의 허용 구간), `index.html`(첫 페인트의
 *             복원). 한 곳만 고치면 드래그로는 갈 수 없는 폭이 저장에서 살아남거나
 *             그 반대가 된다
 *   새  동작: 상수 둘이다
 *   이유:     `SIDEBAR_COLLAPSE_AT_PX` 의 주석이 이미 *"최소 폭(100)보다 작아야
 *             한다"* 로 그 값을 **참조**하고 있었다 — 참조하는 값이 이름을 갖지
 *             않으면 그 관계는 주석에만 산다
 *
 * **`index.html` 의 첫 페인트 스크립트는 예외다** (D-SBW-1): 그 한 줄은 어떤
 * 스크립트보다 먼저 돌아야 하므로(FR-SBC-5) 상수를 볼 수 없다. 그래서 거기에는
 * 숫자가 남고, 아래 게이트 대신 **그 자리의 주석**이 이 상수를 가리킨다.
 */
const SIDEBAR_W_MIN_PX=100;
const SIDEBAR_W_MAX_PX=400;
/** 그 구간으로 접는다. 저장·복원·드래그가 전부 이 한 자리를 지난다. */
function clampSidebarWidth(w){
  return Math.max(SIDEBAR_W_MIN_PX,Math.min(SIDEBAR_W_MAX_PX,w));
}
/**
 * UX_BATCH10_SRS FR-UXB-6 / D-UXB-1: **폭은 이 창의 것이다.**
 *
 *   이전 동작: `ws.sidebarWidth` — 워크스페이스에 실려 서버로 갔다
 *   새  동작: `sessionStorage` — 창 하나의 치수다
 *   이유:     워크스페이스는 모든 기기가 함께 본다. 데스크톱에서 끈 폭이
 *             휴대폰 접속에 강제됐고, 그것은 `displayMode` 가 이미 같은 이유로
 *             워크스페이스에서 나온 길이다 (app.js 의 두 `delete`)
 *
 * **`index.html` 의 첫 페인트 스크립트는 예외다** (D-SBW-1 과 같은 근거) — 그
 * 한 줄은 이 함수보다 먼저 돌아야 하므로 키 이름을 직접 적는다.
 */
const SIDEBAR_W_KEY='sidebarWidth';
/**
 * 범위로 강제해 담는다 (FR-UXB-10) — 손으로 고친 값 하나가 화면을 못 쓰게 하지
 * 않는다. **읽는 짝이 여기 없는 것이 맞다**: 복원은 첫 페인트 스크립트 한 자리이며
 * (FR-SBC-5) 그것은 이 파일보다 먼저 돈다.
 */
function sidebarWidthStore(w){
  const v=clampSidebarWidth(w);
  try{sessionStorage.setItem(SIDEBAR_W_KEY,v)}catch{}
  return v;
}

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
/**
 * M9_SRS FR-M9-44 (M9-B25): **글자를 치는 자리에서만 더 봐주는 조합.**
 *
 * 되돌리기·다시하기다. 종전에는 입력 요소를 **통째로** 면제해서(`FR-KEY-5` 원안)
 * 이 구멍이 보이지 않았다 — 이제 차단이 그 자리에도 닿으므로, 네이티브 편집이
 * 잃으면 안 되는 것을 여기 적는다.
 *
 * 위의 `KEY_BLOCK_EXEMPT_MOD` 와 합쳐 쓴다 (복사·붙여넣기·잘라내기·전체선택은
 * 거기 이미 있다).
 */
const KEY_BLOCK_EXEMPT_TEXT=new Set(['KeyZ','KeyY']);
/**
 * UX_REVISION_SRS FR-KEY-8 (D-K2): **자리 이동과 지움.**
 *
 * FR-M9-44 가 면제를 여섯으로 좁히면서 입력기의 네이티브 편집이 통째로 막혔다 —
 * 실측: `Cmd+←` 가 커서를 움직이지 않고 `Cmd+Backspace` 가 줄을 지우지 않는다.
 * 그 개정의 진단(*"면제가 근거보다 넓었다"*)은 맞았지만 **좁힌 목록이 이번에는
 * 근거보다 좁았다**: 클립보드와 되돌리기만 셌고 커서 이동·줄 삭제를 세지 않았다.
 *
 * `Alt+←`(단어 단위)가 살아남은 것은 면제되어서가 아니라 `Ctrl`·`Meta` 가 아니라
 * FR-KEY-2 에 걸리지 않은 것이다 — 우연이었다.
 */
const KEY_EDIT_CODES=new Set([
  'ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Backspace','Delete','Home','End',
]);
/**
 * FR-KEY-8: **macOS 의 `Ctrl` 조합은 통째로 편집이다.**
 *
 * 그 자리의 편집 키는 emacs 계열이고(`Ctrl+A`·`E`·`B`·`F`·`N`·`P`·`K`·`D`·`H`·
 * `W`·`U`·`Y`·`T`·`O`) **낱자로 세면 반드시 빠뜨린다** — 이번 결함이 그 증거다.
 * 그리고 macOS 의 브라우저 액셀러레이터는 `Cmd` 기반이라 이 면제와 **겹치는
 * 것이 없다**: 넓게 면제해도 잃는 차단이 없다.
 *
 * Windows·Linux 는 반대다 — 그쪽은 `Ctrl` 이 브라우저의 것이므로 위의 코드
 * 목록만 면제한다. 같은 규칙을 양쪽에 쓰면 한쪽에서 반드시 틀린다.
 *
 * `userAgentData` 가 정본이고 `platform` 은 그것이 없는 판을 받는다 (Safari·
 * 구판 Firefox). 둘 다 없으면 macOS 가 아닌 쪽으로 읽는다 — 좁은 면제가
 * 기본값이어야 차단이 조용히 새지 않는다.
 */
const IS_MAC=(()=>{
  // 유닛 하네스는 이 파일을 `vm` 컨텍스트에서 평가한다 — 거기에는 `navigator`
  // 가 없다. 브라우저가 아닌 자리는 macOS 가 아닌 쪽으로 읽는다.
  if(typeof navigator==='undefined') return false;
  const ua=navigator.userAgentData;
  if(ua&&ua.platform) return ua.platform==='macOS';
  return /Mac/i.test(navigator.platform||'');
})();


// Built-in hotkeys are not user-rebindable and may match modifier variants
// (e.g. Ctrl OR Cmd) that the single-binding `shortcuts` table can't express.
// They are dispatched through the same `executeAction` path as user shortcuts.
const BUILTIN_HOTKEYS = [
  { match: e => e.code === 'KeyF' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey, action: 'toggleSearch' },
];

/**
 * 터미널 하나가 보관하는 스크롤백 줄 수 (M6 `FE-28`).
 *
 * **비용을 여기 적어 둔다.** 이 값은 리터럴로 있던 탓에 무엇을 재는 숫자인지
 * 어디에도 없었다.
 *
 *   한 줄     xterm 은 셀마다 코드포인트+속성을 든다 — 80칸 기준 대략 수백 바이트
 *   한 인스턴스  그 줄이 **실제로 찰 때만** 는다. 상한이지 선점이 아니다
 *   곱하기     **칸(슬롯)마다 인스턴스가 따로다.** 같은 도구를 두 칸에 보이면
 *             xterm 도 둘이고 버퍼도 둘이다 (`slotBase` 가 그 복합키를 가른다)
 *
 * 서버가 보관하는 것은 도구당 **1 MiB** 다 (`toolhub/conn.go` 의 `bufMax`).
 * 그 둘은 다른 것을 답한다 — 서버의 것은 *재접속이 되감을 수 있는 창*이고
 * (`TERMINAL_RESUME_SRS`), 이 값은 *이 화면이 위로 스크롤할 수 있는 범위*다.
 * 그래서 같은 값일 필요가 없고, 같게 맞추면 화면의 역사가 1 MiB 로 잘린다.
 *
 * **상한을 더 낮추는 것은 제품 결정이다** — 사용자가 위로 얼마나 갈 수 있는가는
 * 메모리와 맞바꾸는 값이고, 그 교환비를 여기서 정할 근거가 없다. `FE-28` 이
 * 남긴 물음이 그것이며 이 상수는 그 물음을 **볼 수 있게** 만든다.
 */
const TERM_SCROLLBACK_LINES=50000;
/**
 * 창·탭 이름의 길이 상한 (`12-func-ui.md FUI-18`).
 *
 *   이전 동작: **만들 때만** 잘랐다 — `app-layout.js` 네 자리의 `.slice(0,64)`.
 *             이름을 **바꾸는** 두 자리(`renameTab`·`rename`)는 자르지 않아,
 *             수천 자를 넣으면 워크스페이스 JSON 과 사이드바 폭이 그대로 받았다
 *   새  동작: 만들기와 바꾸기가 **같은 상한**을 지난다
 *   이유:     상한이 한쪽에만 있으면 그것은 상한이 아니다 — 우회로가 화면에
 *             버젓이 있다
 */
const ENTITY_NAME_MAX=64;
/** 이름 하나를 그 상한으로 접는다. 만들기·바꾸기가 같은 자리를 지난다. */
function clampEntityName(s){
  return String(s==null?'':s).slice(0,ENTITY_NAME_MAX);
}
/**
 * 백그라운드 복귀가 실패했을 때의 안내 (`12-func-ui.md FUI-21`).
 *
 *   이전 동작: `console.warn` 만이었다. 모달은 이미 닫혔으므로 사용자에게는
 *             **"눌렀는데 아무것도 안 됨"** 이다
 *   새  동작: 화면에 말한다
 *   이유:     실패에 출구가 없으면 사용자는 같은 것을 되풀이해 누른다 —
 *             그리고 그 도구는 여전히 백그라운드 목록에 있어 닿을 수 있다
 */
const BG_RESTORE_NO_PANE=t('core.bg_restore_no_pane');
const BG_RESTORE_FAIL=t('core.bg_restore_fail');
/**
 * 종료된 도구 탭의 출구 (`12-func-ui.md FUI-14`).
 *
 *   이전 동작: 오버레이가 **"이 탭을 닫아 주세요"** 라고만 했다. 닫는 길은
 *             탭 바의 `×` 뿐이고, 다시 셸을 여는 길은 새 탭을 만들어 그 자리로
 *             끌어오는 것뿐이었다. 워크스페이스에는 없는 toolId 를 가리키는 탭이
 *             남아, 새로고침 뒤에도 같은 회색 오버레이가 선다
 *   새  동작: 오버레이가 **닫기**와 **같은 자리에 새 셸** 둘을 준다
 *   이유:     안내가 "당신이 알아서 하세요" 로 끝나면 그것은 출구가 아니다.
 *             두 동작 다 이미 있다 (`closeTab`·`addTab`) — 없던 것은 그 자리의
 *             버튼뿐이다
 */
const TERM_EXITED_TITLE=t('core.term_exited_title');
const TERM_EXITED_SUB=t('core.term_exited_sub');
const TERM_EXITED_CLOSE=t('core.term_exited_close');
const TERM_EXITED_NEW=t('core.term_exited_new');
// FUI-15: 터미널 검색의 결과 표기. `n/N` 은 숫자라 문구가 없다.
const SEARCH_NONE=t('core.search_none');
const SEARCH_BAD_REGEX=t('core.search_bad_regex');
// TOPTS theme is set after THEMES loads (see themes.js)
var TOPTS={
  scrollback:TERM_SCROLLBACK_LINES,cursorBlink:true,cursorStyle:'block',
  // FONT_SIZE_SETTING_SRS FR-FSS-13: **`fontSize` 는 여기 없다.** 진실은 설정
  // `termFontSize` 이며 `term-pane.js` 가 생성 시점에 읽는다 — 같은 수를 두 자리에
  // 적으면 한쪽만 바뀐다. 종전에는 그 자리가 CSS 토큰 `--fs-lg` 였다 (FR-M11-15).
  lineHeight:1.2,allowProposedApi:true,logLevel:'off',
  fontFamily:"'Menlo','Monaco','Consolas','Liberation Mono','Courier New',monospace",
  theme:null,
};

// FONT_SIZE_SETTING_SRS FR-FSS-2b: `--fs-scale` 의 분모다.
//
// 본문 토큰 `--fs-lg` 의 기준 px 이며(`style.css` 의 `calc(14px * …)`), `html,body`
// 의 글자가 그것이다. 설정에 적은 수가 **곧 앱 본문 글자의 px** 인 것이 이 상수의
// 뜻이다 — 두 곳에 적으면 한쪽만 고쳐진다.
const UI_FONT_BASE_PX=14;

// ── 터미널이 스스로 내는 보고 ──

/**
 * xterm 이 `onData` 로 내는 것은 두 종류다 — **사용자가 친 키**와, 터미널이
 * 스스로 내는 **보고**다. 이 정규식이 뒤엣것이다.
 *
 * 목록은 서버의 `snapshotQueryPattern` 과 **쌍**이다: 그쪽이 재생분에서 지우는
 * 질의에 이 xterm 이 내는 답이 여기 있다 (`TERMINAL_RESUME_SRS` FR-TRS-5a).
 * 한쪽만 고치면 다시 어긋나므로 자리를 함께 적어 둔다.
 *
 *   ESC[…c      DA1·DA2 응답        ESC[…n  ESC[…R  DSR·CPR 응답
 *   ESC[…$y     DECRQM 응답          ESC]…;rgb:…    OSC 색 보고
 *   ESC P…$r…ST DECRQSS 응답         ESC[I  ESC[O   포커스 보고
 *
 * 사용자의 키와 겹치지 않는다 — 화살표(`ESC[A`~`D`)·Home(`ESC[H`)·F 키(`ESC[…~`)·
 * SGR 마우스(`ESC[<…M`)는 어느 갈래에도 걸리지 않는다.
 */
const TERM_REPORT_RE=/^(?:\x1b\[[?>=]?[0-9;]*[cnRIO]|\x1b\[[?>=]?[0-9;]*\$y|\x1b\][0-9]{1,3};rgb:[0-9a-fA-F/]*(?:\x07|\x1b\\)|\x1bP[01]\$r[^\x1b]*\x1b\\)$/;

/**
 * 그 중 **포커스 보고**다. 좌석 앞에서 갈리는 유일한 갈래이므로 따로 선다
 * (`TERM_REPLY_SEAT_SRS` FR-RPS-8): 나머지는 질의의 **답**이라 하나만 나가야
 * 하지만, 포커스는 **그 창 고유의 사실**이라 창마다 나가야 한다.
 */
const TERM_FOCUS_RE=/^\x1b\[[IO]$/;

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
const SANDBOX_WORK_LABEL={[SANDBOX_WORK_MOUNT]:t('core.sandbox_work_label.mount'),[SANDBOX_WORK_COPY]:t('core.sandbox_work_label.copy')};
// FR-SBM-1: 선택창의 두 갈래. `none` 은 고를 것이 아니라 **그 프로파일이 폴더를
// 쓰지 않는다**는 사실이므로 고르는 목록에 없다.
const SANDBOX_WORK_PICKS=[SANDBOX_WORK_MOUNT,SANDBOX_WORK_COPY];
// FR-SBM-5: 마운트에 폴더를 함께 고르면 그 창은 격리 경계가 아니다. 등급 배지는
// 프로파일의 것이므로(FR-SBM-4) 그 사실은 이 줄이 따로 말한다.
const SANDBOX_MOUNT_WARN=t('core.sandbox_mount_warn');
const SANDBOX_WORK_PICK_LABEL=t('core.sandbox_work_pick_label');
const SANDBOX_WORK_TITLE={
  [SANDBOX_WORK_MOUNT]:t('core.sandbox_work_title.mount'),
  [SANDBOX_WORK_COPY]:t('core.sandbox_work_title.copy'),
  [SANDBOX_WORK_NONE]:t('core.sandbox_work_title.none'),
};
// FR-SPK-3·4: 입력란은 언제나 보이고 비어 있다. 지금 있는 자리는 버튼으로만 넣는다.
const SANDBOX_WORKDIR_LABEL=t('core.sandbox_workdir_label');
const SANDBOX_WORKDIR_PLACEHOLDER=t('core.sandbox_workdir_placeholder');
// FR-SPK-7: 프로파일이 scratch 하나뿐일 때. 이 안내가 없으면 사용자는 프로파일을
// 늘리는 길이 있다는 것 자체를 알 수 없다.
// UX_BATCH6_SRS FR-SBM-1: 마운트는 이제 여기서 고른다 — 안내가 가리키던 것이
// 사라졌다. 남은 것은 **이미지**다: scratch 는 debian 한 벌이고, 다른 도구가
// 필요하면 dev 프로파일에 그 이미지를 적어야 한다.
const SANDBOX_DEV_HINT=t('core.sandbox_dev_hint');
const SANDBOX_DEV_SETTINGS=t('core.sandbox_dev_settings');
// FR-SPK-22: 복사본으로 연 창의 사이드바 배지.
const SANDBOX_COPY_PROGRESS=t('core.sandbox_copy_progress');
const SANDBOX_COPY_BADGE=t('core.sandbox_copy_badge');
const SANDBOX_COPY_BADGE_TITLE=t('core.sandbox_copy_badge_title');

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
// UI_KIT_SRS FR-GLY-6: 아이콘만 있는 자리는 툴팁이 유일한 이름이다.
const TAB_CLOSE_TITLE='Close this tab';

// UX_BATCH8_SRS FR-CLG-1: 닫기 가드의 문구는 **한 자리**다 — 탭 닫기와 창 닫기가
// 같은 사건을 두고 다른 말을 쓰면 같은 팝업으로 읽히지 않는다.
const CLOSE_DIRTY_MSG=t('core.close_dirty_msg');
// WINDOW_CLOSE_UNDO_SRS FR-WCU-1·2 / NFR-WCU-1: 한가한 창의 닫기는 묻지 않고
// 되돌린다. 유예는 git Undo 와 같은 5초다. `%s` 는 창 이름.
const WINDOW_CLOSE_UNDO_MS=5000;
const WINDOW_CLOSE_UNDO_TEXT=t('core.window_close_undo_text');
const WINDOW_CLOSE_UNDO_LABEL=t('core.act.window_close_undo_label');
const WINDOW_CLOSE_UNDO_TITLE='Bring the window and its shells back';

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
/**
 * `12-func-ui.md FUI-04`: **Run 을 UI 에서 멈출 길이 없었다.**
 *
 * 유일한 출구가 `삭제` 였고 그것은 **기록까지 지운다** — 진행 중인 Run 을
 * 멈추려면 무엇이 있었는지도 함께 잃어야 했다. 서버는 `close`·`detach` 를
 * 이미 노출하고 있었으므로 없던 것은 화면뿐이다.
 */
const TIP_RUNS_CLOSE='Stop this run and clean up — the record stays';
const TIP_RUNS_CLOSE_YES='Stop this run now';
const TIP_RUNS_DETACH='Detach this member — the tab closes, the tool keeps running';
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
const SBX_RT_TITLE_MISSING=t('core.sbx_rt_title_missing');
const SBX_RT_TITLE_STOPPED=t('core.sbx_rt_title_stopped');
const SBX_RT_MSG_MISSING=t('core.sbx_rt_msg_missing');
// FR-SRT-6: 이 문장이 없으면 사용자는 설치하고도 같은 모달을 다시 본다 — 런타임을
// 찾는 일은 서버가 뜰 때 한 번뿐이다 (`sandboxplace.Wire`).
const SBX_RT_MSG_RESTART=t('core.sbx_rt_msg_restart');
const SBX_RT_MSG_STOPPED=t('core.sbx_rt_msg_stopped');
// D-5: linux 의 기동은 권한을 요구한다. 서버가 sudo 를 부르면 비밀번호를 받을 길이
// 없어 무응답으로 멈추므로, 사용자가 자기 셸에서 치는 것이 유일하게 끝나는 길이다.
const SBX_RT_MSG_MANUAL=t('core.sbx_rt_msg_manual');
const SBX_RT_START=t('core.sbx_rt_start');
const SBX_RT_COPY=t('core.sbx_rt_copy');
const SBX_RT_COPIED=t('core.sbx_rt_copied');
const SBX_RT_CLOSE=t('core.sbx_rt_close');
const SBX_RT_STARTING=t('core.sbx_rt_starting');
const SBX_RT_START_FAIL=t('core.sbx_rt_start_fail');
// 상한을 넘긴 것은 실패와 다르다 — 명령은 돌았고 데몬이 아직 안 떴을 뿐이다.
const SBX_RT_TIMEOUT=t('core.sbx_rt_timeout');
const SBX_RT_NO_CMD=t('core.sbx_rt_no_cmd');
const SBX_RT_DOCS='https://docs.docker.com/get-started/get-docker/';

// ── 파일 전송 (FILE_TRANSFER_SRS §3.3) ──

// FR-FTR-8: 완성되지 않은 OSC 시퀀스를 보류하는 상한과, 다음 청크를 기다리는
// 시간. 상한을 넘으면 OSC 가 아니라고 보고 흘려보낸다 — 종결자 없는 입력에
// 화면이 영영 멈추지 않게 한다.
const OSC_CARRY_MAX=4096;
const OSC_CARRY_MS=50;
const TERM_UPLOAD_NO_CWD=t('core.term_upload_no_cwd');

// ── 전송 알림 (TERM_XFER_NOTICE_SRS §3) ──

// FR-TXN-4: 성공은 3초, 읽고 판단할 것이 있는 알림은 8초. 진행 팝업은 0 —
// 스스로 사라지지 않는다 (FR-TXN-5).
const TOAST_MS=3000;
const TOAST_ERR_MS=8000;
const TERM_UPLOAD_BUSY=t('core.term_upload_busy');
const TERM_UPLOAD_OK=t('core.term_upload_ok');
const TERM_UPLOAD_FAIL=t('core.term_upload_fail');
const TERM_DOWNLOAD_BUSY=t('core.term_download_busy');

// ── Editor 탭 · Editor 창 (EDITOR_TAB_SRS 묶음 T·W) ──

// FR-EDT-40: 세 번째 창 타입. Git 창과 마찬가지로 판정은 이 값과의 비교 하나다.
const WINDOW_TYPE_EDITOR='editor';

// EDITOR_GIT_UX_SRS 묶음 V — 열 수 있는 형식인가.
const FILE_PROBE_API='/api/file/probe';
const FILE_RAW_API='/api/file/raw';
// M9_SRS FR-M9-24: 보던 자리의 기록 상한 (사용자 결정 2026-09-14). 넘으면 오래된
// 쪽부터 버린다 — 무한히 쌓으면 그 자체가 새는 자리다.
const FOCUS_NAV_MAX=100;
const FILE_KIND_TEXT='text';
const FILE_KIND_IMAGE='image';
const FILE_KIND_BINARY='binary';
const FILE_UNSUPPORTED_TITLE=t('core.file_unsupported_title');
const FILE_UNSUPPORTED_HINT=t('core.file_unsupported_hint');
const FILE_IMAGE_FAIL=t('core.file_image_fail');

// EDITOR_EXTERNAL_CHANGE_SRS FR-EXC-9 — 저장하려는데 그 파일이 밖에서 바뀌었다.
//
// 선택지가 둘뿐인 것은 뜻이 있다. `디스크 것으로 덮기` 는 **편집본을 확인 없이
// 버리는 쪽**이라 `FR-RTU-103`(U-10)과 정면으로 걸리고, 그것을 안전하게 주려면
// 확인을 한 번 더 물어야 하는데 그러면 확인이 두 걸음이 된다 (FR-COS-1).
// 취소하면 편집본은 화면에 그대로 남으므로 사용자가 스스로 처리할 수 있다.
// FR-EXC-11: 표식이 실려 오는 자리. 값은 **불투명**하며 클라이언트는 이름만 안다.
// RELOAD_CONTINUITY_SRS D-2 개정 — 새 판이 있으나 저장하지 않은 편집 때문에
// 자동 새로고침을 미뤘다는 알림. 누르면 사용자가 직접 고른 것이다.
const VER_HELD_MSG=t('core.ver_held_msg');
const VER_HELD_GO=t('core.ver_held_go');

// 로드맵 `FUI-05`: 저장 실패는 사유와 함께 알린다 — 테두리만으로는 무엇이
// 잘못됐는지 말하지 못한다.
const FILE_SAVE_FAIL=t('core.file_save_fail');
// REPO_FIX 03 §3A-1: 어느 인코딩으로도 풀리지 않아 읽기 전용으로 연 문서.
const FILE_UNDECODABLE_NOTE=t('core.file_undecodable');

// `FE-7`: 설정 저장 실패는 조용히 지나가지 않는다 — 사용자는 바뀐 줄 알고
// 다음 기동에서 옛 값을 만난다.
const SETTINGS_SAVE_FAIL=t('core.settings_save_fail');

const FILE_STAMP_HEADER='X-File-Stamp';
const FILE_CONFLICT_TITLE=t('core.file_conflict_title');
const FILE_CONFLICT_MSG=t('core.file_conflict_msg');
const FILE_CONFLICT_GO=t('core.file_conflict_go');
const FILE_CONFLICT_CANCEL=t('core.file_conflict_cancel');

// FILE_API_BOUNDARY_SRS FR-FAB-9 (`FUI-06`) — 상한을 넘는 파일은 올리지 않는다.
// 상한 **값**은 여기 없다. 서버가 `probe.maxBytes` 로 준다 — 두 벌이면 한쪽만
// 고쳐지고, 그때 사용자는 "열린다고 했는데 안 열린다" 를 만난다.
const FILE_TOO_LARGE_TITLE=t('core.file_too_large_title');
const FILE_TOO_LARGE_HINT=t('core.file_too_large_hint');
const FILE_TOO_LARGE_DOWNLOAD=t('core.file_too_large_download');
const FILE_DOWNLOAD_API='/api/download';

// FR-EDT-110 의 종단. M2 는 목록 조회·추가·제거·재정렬만 쓴다.
const EDITORS_API='/api/editors';

// ── 터미널의 복사 (EXPLORER_TRANSFER_IGNORE_SRS 묶음 F · FR-ETR-40·41) ──
//
// 마지막 수단의 창이다. 앞의 두 단(clipboard API · execCommand)이 실패하는 것은
// 코드가 아니라 **환경이 정하는 것**이라, 이 창이 없으면 복사는 "될 때도 있고
// 안 될 때도 있는 것" 이 된다 (D-12).
const TERM_COPY_ID='term-copy';
const TERM_COPY_TITLE=t('core.term_copy_title');
const TERM_COPY_WHY=t('core.term_copy_why');
const TERM_COPY_DO=t('core.term_copy_do');
const TERM_COPY_MANUAL=t('core.term_copy_manual');
const TERM_COPY_CLOSE=t('core.term_copy_close');

// ── 내부 새로고침 (SOFT_RELOAD_SRS 묶음 C · FR-SRL-8~11) ──
//
// 페이지를 다시 여는 것은 가진 것을 전부 버리는 일이다 — 편집기의 미저장 내용,
// 탐색기의 펼침·스크롤, Git 패널의 열린 탭이 함께 사라진다. 이쪽은 **서버의
// 사실만 다시 받는다.**
const RELOAD_BTN_ID='soft-reload-btn';
const RELOAD_TITLE='Reload the app without a full page refresh';
const RELOAD_BUSY_TITLE=t('core.reload_busy_title');

// ── 레이아웃 프리셋 ──
//
// 프리셋의 대상은 **일반 창**이다. Editor 창은 pane 이 없는 것이 정상이고
// (FR-EDT-55) 그 layout(null)을 저장하면 불러오기가 새 창의 layout 을 지워
// 창은 사라지고 도구만 남는다. 그럴 때 저장을 거절하고 사유를 남긴다.
const PRESET_PANEL_ID='panel-presets';
const PRESET_MSG_CLASS='preset-msg';
const PRESET_SAVE_NO_PLAIN=t('core.preset_save_no_plain');
// CONTEXT_MENU_UNIFY_SRS FR-CMU-8·10: 탭·터미널 본문의 컨텍스트 메뉴 문구.
const TAB_MENU_NEW=t('core.tab_menu_new');
const TAB_MENU_RENAME=t('core.tab_menu_rename');
const TAB_MENU_CLOSE=t('core.tab_menu_close');
const TAB_MENU_RENAME_GIT_NO=t('core.tab_menu_rename_git_no');
const TAB_MENU_NEW_NO=t('core.tab_menu_new_no');
const TERM_MENU_COPY=t('core.term_menu_copy');
const TERM_MENU_PASTE=t('core.term_menu_paste');
const TERM_MENU_SELECT_ALL=t('core.term_menu_select_all');
const TERM_MENU_FIND=t('core.term_menu_find');
const TERM_MENU_COPY_NO=t('core.term_menu_copy_no');
const TERM_MENU_PASTE_NO=t('core.term_menu_paste_no');
const TERM_MENU_PASTE_DENIED=t('core.term_menu_paste_denied');
// 로드맵 M7 `FUI-25`: 삭제의 인라인 확인 문구와 로드 실패 알림.
const PRESET_DEL_Q=t('core.preset_del_q');
const PRESET_LOAD_FAIL=t('core.preset_load_fail');
