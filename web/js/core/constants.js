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
const SEARCH_RESEARCH_DELAY=50;
// PAGE_TITLE_SRS FR-PGT-7: 설정이 비었을 때 쓰는 페이지 제목.
const DEFAULT_PAGE_TITLE='Dongminal';

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
// 새 버전(index.html 의 ?v=) 확인 주기. 열려 있는 페이지가 옛 JS 를 계속
// 돌리는 것을 사용자가 알 수 있게 한다 (FR-MTI-33).
const VERSION_CHECK_MS=60000;

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

const MOD_CODES=new Set(['ControlLeft','ControlRight','AltLeft','AltRight','MetaLeft','MetaRight','ShiftLeft','ShiftRight']);
/**
 * UX_REVISION_SRS FR-KEY-4: 브라우저 기본 동작을 **막지 않는** 키.
 *
 * 둘로 나뉜다. ① 앱이 고장났을 때의 탈출구 — 새로고침·전체화면·개발자도구.
 * ② 클립보드와 선택 — 터미널에서 고른 글자를 복사하지 못하게 되면 그것이
 * 차단이 아니라 고장이다. 사용자가 이 키들을 단축키로 배정하면 그때는 매칭
 * 경로가 먼저 잡아 preventDefault 하므로 자유도는 그대로다 (FR-KEY-1).
 */
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

// ── 파일 전송 (FILE_TRANSFER_SRS §3.3) ──

// FR-FTR-8: 완성되지 않은 OSC 시퀀스를 보류하는 상한과, 다음 청크를 기다리는
// 시간. 상한을 넘으면 OSC 가 아니라고 보고 흘려보낸다 — 종결자 없는 입력에
// 화면이 영영 멈추지 않게 한다.
const OSC_CARRY_MAX=4096;
const OSC_CARRY_MS=50;
const TERM_UPLOAD_NO_CWD='✗ 이 터미널의 폴더를 알 수 없어 업로드하지 않았습니다';

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
const RELOAD_TITLE='내부 새로고침 — 서버 상태를 다시 가져옵니다';
const RELOAD_BUSY_TITLE='다시 가져오는 중…';

// ── 레이아웃 프리셋 ──
//
// 프리셋의 대상은 **일반 창**이다. Editor 창은 pane 이 없는 것이 정상이고
// (FR-EDT-55) 그 layout(null)을 저장하면 불러오기가 새 창의 layout 을 지워
// 창은 사라지고 도구만 남는다. 그럴 때 저장을 거절하고 사유를 남긴다.
const PRESET_PANEL_ID='panel-presets';
const PRESET_MSG_CLASS='preset-msg';
const PRESET_SAVE_NO_PLAIN='저장할 일반 창이 없습니다 — 터미널 창을 열고 다시 시도하세요';
