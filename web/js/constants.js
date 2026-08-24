/**
 * Remote Terminal — constants
 */

// Binary protocol opcodes. Client→Server uses INPUT(0)/RESIZE(1).
// Server→Client uses OUTPUT(0)/ERROR(1)/EXIT(2)/SID(3).
// Same byte values are reused per direction — the protocol is directional,
// so INPUT(0) and OUTPUT(0) never conflict at the same endpoint.
const OP={INPUT:0,RESIZE:1,OUTPUT:0,ERROR:1,EXIT:2,TOOLID:3};
const enc=new TextEncoder(), dec=new TextDecoder();
const SEARCH_RESEARCH_DELAY=50;

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

// 복귀 대상 Pane 을 기다리는 상한 (FR-BGR-7). delWindow 는 마지막 창을 지운 뒤
// _mkWindow 를 await 하는데, 그 사이 ws.windows 가 비어 대상 Pane 이 없다.
// PTY 생성 왕복 한 번이면 끝나는 과도 상태이므로 짧게 기다렸다 재시도한다.
const RESTORE_PANE_WAIT_MS=25;
const RESTORE_PANE_WAIT_TRIES=20;

const MOD_CODES=new Set(['ControlLeft','ControlRight','AltLeft','AltRight','MetaLeft','MetaRight','ShiftLeft','ShiftRight']);


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
