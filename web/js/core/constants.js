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
 * 터미널·모바일 입력(`constants-term.js`) · 샌드박스(`constants-sandbox.js`) · 툴팁(`constants-tips.js`) ·
 * Editor 창·파일(`constants-file.js`)은 이 파일 바로 뒤에 실리는 주제 파일로 옮겼다 (REFACTOR3_FE_REST5_SRS FR-FR5-20).
 *
 * 로드 순서: constants.js → constants-{term,sandbox,tips,file}.js → constants-git.js → constants-editor.js
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
const DEFAULT_PAGE_TITLE='Otterminal';

// ── 부팅 화면 (BOOT_SCREEN_SRS) ──
// 마지막에 적용한 테마의 **최종 CSS 변수 맵**이 사는 자리. `index.html` 의 head
// 인라인 스크립트가 첫 페인트 전에 이것을 읽는다 — 그 스크립트는 constants.js
// 보다 먼저 돌므로 **키 문자열이 그쪽에도 리터럴로 적혀 있다**. 바꿀 때는 둘을
// 함께 바꾼다 (FR-BTS-3).
const THEME_VARS_KEY='otter.themeVars';
// M8 FR-B-6 (UX-11): 종전에 CSS `content` 로만 있던 문구 셋. DOM 텍스트가 됐다.
const SLOT_EMPTY_HINT=t('core.slot_empty_hint');
const DROP_FILES_HINT=t('core.drop_files_hint');
const CLICK_TO_FOCUS_HINT=t('core.click_to_focus_hint');
// SYSTEM_THEME_FOLLOW_SRS FR-STF-5: 선주입이 두 맵 중 하나를 고를지의 스위치.
const THEME_FOLLOW_KEY='otter.themeFollow';
// THEME_SEED_COLOR_SRS FR-SEED-12: 메인색을 껐다 다시 켤 때 돌아올 색 (이 브라우저에서만).
const SEED_LAST_KEY='otter.seedLast';
// REFACTOR3_FE_REST2_SRS FR-FR2-13 (FC-19): 초 ↔ 밀리초. 서버 시각(Unix 초)과 `Date.now()` 를 잇는 자리가 쓴다.
const MS_PER_SEC=1000;
// 걷힘 애니메이션. 화면이 이미 준비된 뒤의 시간이므로 짧다. `#boot` 의 페이드
// (`--dur-base`, .15s)가 끝난 뒤에 떼므로 그보다 짧아지면 안 된다.
const BOOT_FADE_MS=180;
// FR-BTS-14: 준비 신호가 오지 않아도 이 시간이 지나면 걷는다. 서버가 답하지
// 않는다고 화면이 영구히 잠기면, 사용자는 무엇이 잘못됐는지 볼 길조차 없다.
const BOOT_MAX_MS=6000;
// PERF_OPTIMIZATION_SRS FR-SPA-4 · D-39: 프레임 시작부터 `TIMERS.frame` 의 `idle` 작업을 돌려도 되는 시간.
const FRAME_BUDGET_MS=8;

// BOOT_SCREEN_REUSE_SRS D-BTR-8: 다시 세울 때의 단계 문구. 부르는 자리마다 적으면
// 같은 장면이 자리마다 다른 말을 한다.
const BOOT_STEP_RELOAD=t('core.boot_step_reload');
const BOOT_STEP_VERSION=t('core.boot_step_version');
const BOOT_STEP_BACKUP=t('core.boot_step_backup');

// ── 포커스를 잃은 창의 가장자리 표시 (UNFOCUSED_EDGE_SRS 묶음 UFE) ──
// D-8: 표시 여부는 `documentElement` 의 클래스 하나로 정한다 — 포커스는 초당
// 여러 번 오갈 수 있고, 그때마다 DOM 을 짓고 허물 이유가 없다. 세기·깊이·전이
// 시간은 CSS 변수(`--ufe-*`, style-system.css)에 산다: 그 값들을 읽는 것은 CSS 뿐이다.
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
// 기본값·최댓값(`UFE_LEVEL_DEFAULT`·`UFE_LEVEL_MAX`)은 표에서 파생한다 (settings-defaults.js).
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
// 미리보기 동안 붙는 클래스. style-system.css 가 같은 이름을 안다.
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
// 기본값·최댓값은 표에서 파생한다 (settings-defaults.js).
const ATTN_EDGE_ALPHA_PER_LEVEL=.1;
const ATTN_EDGE_PREVIEW_MS=1400;
const ATTN_EDGE_PREVIEW_CLASS='ae-preview';
// FR-AED-6: 알림이 있는 동안 documentElement 에 붙는 클래스. style-system.css 가 같은 이름을 안다.
const ATTN_EDGE_ON_CLASS='attn-edge-on';

/**
 * FR-AEV-15: 알람에 곁들이는 **내용**의 표시 상한(글자).
 *
 * 서버는 이미 활동 필드를 자른다(`ActivityDetailMax`) — 이 값은 그보다 짧은 **화면의
 * 상한**이다. 데스크톱 알림은 본문이 길면 OS 가 제멋대로 자르고, 알림 센터의 한
 * 줄도 자리가 좁다. codex 의 `last-assistant-message` 는 문단 단위로 올 수 있다.
 */
const ATTN_DETAIL_VIEW_MAX=140;

// 에이전트 활동 상태의 어휘 (OPTIMIZE_REFACTOR_SRS FR-OPT-10-1). 짝은 Go 의
// `internal/shared/activity` 이고, `scripts/check-activity-vocab.sh` 가 두 목록을 대조한다.
// `ENDED` 는 종료 신호 — 카드를 거둔다.
const ACTIVITY_STATE=Object.freeze({WORKING:'working',WAITING:'waiting',DONE:'done',IDLE:'idle',ENDED:'ended'});
// 상태별 아이콘 — 색(.ag-state.<state>)과 함께 상태를 구분.
// UX_AUDIT_FIX_SRS FR-UXF-100 (D-36): 스프라이트 이름이다(이전 글자 `● ✓ … ○`).
// ICON_SET_SRS FR-ICN-8 (D-ICN-16): 넷 다 채우지 않는다 — 이전 `dot`(채움)·`check`·`more-horizontal`·`circle` 은 알림 점·현재 표시·메뉴·체크박스와 겹쳤다.
const AGENT_STATE_ICON={[ACTIVITY_STATE.WORKING]:'loader-circle',[ACTIVITY_STATE.DONE]:'circle-check',[ACTIVITY_STATE.WAITING]:'hourglass',[ACTIVITY_STATE.IDLE]:'circle-dashed'};
// UX_AUDIT_FIX_SRS FR-UXF-40: 상태의 보이는 글자. 상태값(데이터)은 그대로다.
const AGENT_STATE_LABEL={
  [ACTIVITY_STATE.WORKING]:t('activity.state_working'),
  [ACTIVITY_STATE.DONE]:t('activity.state_done'),
  [ACTIVITY_STATE.WAITING]:t('activity.state_waiting'),
  [ACTIVITY_STATE.IDLE]:t('activity.state_idle'),
};


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


// PERF_OPTIMIZATION_SRS FR-CON-7 (`perf/CHANNEL_PROTOCOL.md` §7): 채널의 ping 주기(숨었을 때),
// 침묵 판정의 유예, 재연결 백오프. 보일 때의 ping 주기는 `statsInterval` 이다.
const CHAN_PING_HIDDEN_MS=30000;
const CHAN_SILENCE_GRACE_MS=5000;
const CHAN_RETRY_MIN_MS=500;
const CHAN_RETRY_MAX_MS=10000;
// PERF M3 D-36 (FR-SPA-3): 탭 본문이 보이지 않게 된 뒤 잠들기까지. 그 안에 다시 보이면 잠들지 않는다. D-16 의 터미널 지연과 같은 값이다.
const SCREEN_SLEEP_MS=2000;
/** 상태 토픽(PERF M1 C3) 변화를 복원에 넘기기 전에 모으는 시간. 한 틱의 변화는 한 번으로 합친다. */
const STATE_TOPIC_COALESCE_MS=0;

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
// FR-SBC-4 / D-4: 접힘은 "이 화면이 보는 방식" 이므로 워크스페이스에 두지 않는다 — 두면
// 다른 기기의 화면 폭에 맞춘 선택이 이 기기로 넘어온다. 자리는 sessionStorage(탭별)다
// (PANEL_LAYOUT_SRS FR-PLY-1 이 localStorage 를 대체했다).
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
// OPTIMIZE_REFACTOR_SRS FR-OPT-12-6 (FEU-17): Agents 패널 폭의 구간. 드래그와 복원이 같은
// 구간을 지난다 — 두 자리에 숫자를 적으면 드래그로 갈 수 없는 폭이 복원에서 살아남는다.
const AGENTS_W_MIN_PX=160;
const AGENTS_W_MAX_PX=480;
/** UX_BATCH12_SRS FR-ACF-6: Activity 손잡이가 이 폭 아래로 끌리면 레일이 된다 (사이드바와 같은 값). */
const AGENTS_COLLAPSE_AT_PX=SIDEBAR_COLLAPSE_AT_PX;
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
 * 한 줄은 `sidebarWidthStore`(`ui/input-binding.js`)보다 먼저 돌아야 하므로 키 이름을 직접 적는다.
 */
const SIDEBAR_W_KEY='sidebarWidth';

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
// 워크스페이스 스키마 판. 서버는 이보다 낮은 판의 저장을 거부한다 (FR-EM-2a).
const WS_SCHEMA_VERSION=2;
// 사이드바 탭 직행 단축키의 수 — 숫자 키 1..9 (FR-SBT-21).
const SB_JUMP_MAX=9;
// 입력 중인 설정의 저장을 미루는 시간 (OPTIMIZE_REFACTOR_SRS FR-OPT-5-2).
// 글자·드래그마다 설정 blob 전체를 PUT 하지 않는다. 확정(blur·change)은 기다리지 않는다.
const SETTINGS_SAVE_DEBOUNCE_MS=500;

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


// FONT_SIZE_SETTING_SRS FR-FSS-2b: `--fs-scale` 의 분모다.
//
// 본문 토큰 `--fs-lg` 의 기준 px 이며(`style.css` 의 `calc(14px * …)`), `html,body`
// 의 글자가 그것이다. 설정에 적은 수가 **곧 앱 본문 글자의 px** 인 것이 이 상수의
// 뜻이다 — 두 곳에 적으면 한쪽만 고쳐진다.
const UI_FONT_BASE_PX=14;

// ── Git 창 (GIT_SRS §3.4 / FR-GIT-25~31) ──

// 창의 type 은 없을 수 있다. 없으면 terminal 이다 — 기존 workspace.json 이 그대로
// 로드돼야 한다 (FR-GIT-25). 판정은 항상 WINDOW_TYPE_GIT 인지로만 한다.
const WINDOW_TYPE_TERMINAL='terminal';
const WINDOW_TYPE_GIT='git';
const WINDOW_TYPE_CHAT='chat'; // CHAT_WINDOW_SRS FR-CW-1: 채팅 창. 노드에 하나다
const TAB_TYPE_GIT='git';
// FR-OPT-11-7 (FEC-31): 나머지 탭 타입. 워크스페이스에 저장되는 값이라 바꾸지 않는다.
const TAB_TYPE_TERMINAL='terminal';
const TAB_TYPE_EDITOR='editor';
const TAB_TYPE_RUN='run';
// PEER_CHAT_SRS §3.11: 채팅 방 하나의 탭. 레코드는 `{id, name, type:'chat', roomId}` 다.
const TAB_TYPE_CHAT='chat';


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
// 값은 표(`tabWidthPx`)가 갖고 `TAB_WIDTH_*` 는 거기서 파생한다 (settings-defaults.js).

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


// ── Run 목록 (OPTIMIZE_REFACTOR_SRS FR-OPT-4-10) ──

// FEU-8: `run_changed` 가 몰려 와도 목록(`/api/runs`) 재조회는 이 창 안에서 한 번이다.
// 멤버 메시지 하나마다 이벤트가 오므로 합치지 않으면 이벤트 수만큼 겹쳐 나간다.
const RUN_LIST_COALESCE_MS=250;
// FR-RVZ-12: "최근 통신" 의 경계. 서버 시각은 Unix **초**다 (Go 기준선 run/store.go 의 now()).
//
// 경계를 닫힌 구간(<=)으로 두는 이유는 브라우저 시계와 서버 시계를 비교하기
// 때문이다 — 해상도가 1초라 열린 구간이면 경계에서 강조가 깜빡인다.
const RUN_RECENT_SEC=30;
// 강조가 꺼질 시각 뒤에 다시 그리는 여유. 경계가 닫힌 구간이라 딱 그 시각에 그리면 아직 강조 중이다.
const RUN_DECAY_SLACK_MS=50;

// ── 한 화면이 쓰는 주기 (REFACTOR3_FE_REST2_SRS FR-FR2-14) ──

/** ACTIVITY_STATE_SUBAGENT_SRS FR-ASV-42: 관측이 이보다 오래되면 `as of HH:MM` 을 보인다 (`activity-list.js`). */
const LIMIT_STALE_MS=10*60*MS_PER_SEC;
/** 텔레그램 등록 코드의 남은 시간을 다시 그리는 주기 (`settings-telegram.js`). 등록 여부는 토픽이 준다. */
const TG_PAIR_TICK_MS=2000;
/** 간선 초대의 남은 시간을 다시 그리는 주기 (`settings-edges.js`). */
const EDGE_REMAIN_TICK_MS=1000;
/** 검색창이 열린 채 대상이 바뀌면 이만큼 뒤에 첫 결과로 다시 찾는다 (`tool-search.js`). */
const SEARCH_FIRST_DELAY_MS=50;


// ── 내부 새로고침 (SOFT_RELOAD_SRS 묶음 C · FR-SRL-8~11) ──
//
// 페이지를 다시 여는 것은 가진 것을 전부 버리는 일이다 — 편집기의 미저장 내용,
// 탐색기의 펼침·스크롤, Git 패널의 열린 탭이 함께 사라진다. 이쪽은 **서버의
// 사실만 다시 받는다.**
const RELOAD_BTN_ID='soft-reload-btn';
// UX_AUDIT_FIX_SRS FR-UXF-2: 상단바·칸 머리글 제목의 구분점.
const TITLE_SEP=' · ';
// UX_AUDIT_FIX_SRS FR-UXF-28: 작업 목록 스냅샷이 이만큼 이어서 실패하면 안내를 세운다 — 한 번은 일시적일 수 있다.
const ACT_STALE_AFTER=2;
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
