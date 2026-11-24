/**
 * Otterminal — 터미널·모바일 입력 상수 (REFACTOR3_FE_REST5_SRS FR-FR5-20).
 *
 * 모바일 키바·터치 입력 · 터미널 WS 재접속·입력 보류·직접 보내는 키 · 스크롤백·xterm 옵션(`TOPTS`)·
 * 종료·검색 문구 · 터미널이 스스로 내는 보고 · 파일 전송·전송 알림 · 터미널의 복사.
 * `constants.js` 에서 절째로 옮겼다 — 값과 이름은 그대로다.
 *
 * `constants.js` **바로 뒤**에 로드된다. `keybar.js` 가 로드 시점에 `MKB_KEYS` 를 딛는다.
 */
// 모바일 키바 제스처 상수 (USER_CHECKLIST_FIXES_SRS FR-MTB-2/4/5).
// TAP_SLOP: 이 거리를 넘으면 탭이 아니라 스크롤로 넘긴다.
// GHOST_CLICK: touchend 처리 후 이 시간 안에 오는 click 은 합성분으로 본다.
const MKB_LONG_PRESS_MS=600;
const MKB_DOUBLE_TAP_MS=350;
const MKB_TAP_SLOP_PX=10;
const MKB_GHOST_CLICK_MS=700;
/**
 * MOBILE_UX_OVERHAUL_SRS FR-MUX-50: 길게 누르기 → 컨텍스트 메뉴. iOS Safari 는 길게 눌러도
 * `contextmenu` 를 보내지 않는다. 터미널·편집기·입력칸은 자기 길게 누르기(선택)를 가지므로 뺀다.
 */
const MOBILE_LONG_PRESS_MS=500;
// FR-MUX-60: 이 높이보다 낮은 터치 화면은 Auto 에서 모바일이다 (가로 휴대폰 ≤ 430, 태블릿 ≥ 600).
const MOBILE_LANDSCAPE_MAX_H=500;
const MOBILE_LONG_PRESS_SKIP='.xterm,.tp,.cm-editor,input,textarea,select,[contenteditable]';
/**
 * FR-OPT-11-2 (FEC-34): 모바일 키바의 키 표. 보내는 바이트는 이스케이프로 적는다 —
 * 날 제어 문자는 편집기에서 보이지 않는다.
 *
 * `send` 는 sticky 수식을 거치고, `raw` 는 거치지 않는다. `mod` 는 수식 키, `act` 는 동작이다.
 * `id` 는 설정 `keybar` 가 가리키는 이름이다(UX_AUDIT_FIX_SRS FR-UXF-93). `⌨` 는 구성 대상이 아니라 없다.
 */
const MKB_KEYS=Object.freeze([
  // FR-MKB-8: `⌨` 는 **맨 왼쪽**이다. 종전에는 열일곱 개 중 열일곱 번째였고,
  // 키보드를 내리려면 키바를 끝까지 가로로 밀어야 했다. 이제 이 버튼은
  // 키보드를 **올리는** 유일한 길이기도 하므로(FR-MKB-4) 손이 먼저 닿는
  // 자리에 있어야 한다.
  // UX_AUDIT_FIX_SRS FR-UXF-7: 글자 대신 아이콘을 그린다 — `⌨` 가 글꼴 대체로 `▬` 처럼 보였다(진단 M3). 라벨은 이름표의 열쇠로 남는다.
  {label:'⌨',act:'kb',icon:'keyboard'},
  {id:'esc',label:'Esc',send:'\x1b'},
  {id:'tab',label:'Tab',send:'\t'},
  // FR-MKB-15: 소프트 키보드를 내려 둔 채 쓰는 길이 `⌨` 로 생겼으므로
  // (FR-MKB-4), 그 상태에서 줄을 넘길 자리가 있어야 한다. `Tab` 옆인 것은
  // 둘 다 **입력을 확정하는 키**이기 때문이고, `Ctrl`–`^C` 쌍(D-4)은
  // 건드리지 않는다.
  {id:'enter',label:'⏎',send:'\r'},
  {id:'ctrl',label:'Ctrl',mod:'ctrl'},
  // FR-MKB-9·10 / D-4·D-12: `Ctrl` 바로 옆이다. 소프트 키보드를 올리지
  // 않기로 하면(③) `Ctrl` 을 켠 뒤 `c` 를 칠 자리가 사라지므로, 접수한 말이
  // 그 둘을 한 문장에 담고 있었다. **모디파이어를 거치지 않고** 곧바로
  // `0x03` 을 보낸다 — 중단은 급할 때 누르는 것이고, 두 번 눌러야 하는
  // 중단은 중단이 아니다. `Ctrl` 의 sticky 를 읽지도 바꾸지도 않는다.
  {id:'ctrlc',label:'^C',raw:'\x03'},
  {id:'alt',label:'Alt',mod:'alt'},
  {id:'up',label:'↑',send:'\x1b[A'},
  {id:'down',label:'↓',send:'\x1b[B'},
  {id:'left',label:'←',send:'\x1b[D'},
  {id:'right',label:'→',send:'\x1b[C'},
  {id:'pipe',label:'|',send:'|'},
  {id:'tilde',label:'~',send:'~'},
  {id:'slash',label:'/',send:'/'},
  {id:'hyphen',label:'-',send:'-'},
  {id:'home',label:'Home',send:'\x1b[H'},
  {id:'end',label:'End',send:'\x1b[F'},
  {id:'pgup',label:'PgUp',send:'\x1b[5~'},
  {id:'pgdn',label:'PgDn',send:'\x1b[6~'},
]);
// 키바 버튼의 전체 이름 — title·aria-label 이 된다.
const MKB_FULL_NAMES=Object.freeze({
  'Esc':'Escape','Tab':'Tab','⏎':'Enter','Ctrl':'Control (modifier)','Alt':'Alt (modifier)',
  '↑':'Arrow Up','↓':'Arrow Down','←':'Arrow Left','→':'Arrow Right',
  '|':'Pipe','~':'Tilde','/':'Slash','-':'Hyphen',
  'Home':'Home','End':'End','PgUp':'Page Up','PgDn':'Page Down',
  // UX_BATCH5_SRS FR-TIP-2: 이 표는 전부 영어다 — long-press 툴팁도 같은
  // 값을 쓰므로 접수한 말("영어로 무슨 버튼인지")이 그대로 성립한다.
  // FR-MKB-5: 버튼 하나가 두 방향을 가지므로 이름도 방향을 말하지 않는다.
  '⌨':'Toggle keyboard',
  // FR-MKB-11: 무엇을 보내는지 이름이 말한다.
  '^C':'Interrupt (Ctrl+C)',
});

// 모바일 TUI 입력·스크롤 교정 (MOBILE_TUI_INPUT_SCROLL_SRS FR-MTI-18).
// TOUCH_GAIN: 1 — 글자가 손가락을 따라온다 (UX_BATCH11_SRS FR-MTS-2). 종전 2.5 는 프레임당 wheel
//   하나로 합치며 마우스 리포팅 TUI 의 행을 버리던 손실(FR-MTS-1 이 고쳤다)을 메우던 값이다.
// TOUCH_SLOP: 이 거리를 넘기 전에는 탭으로 보고 xterm 에 그대로 넘긴다.
// FLING_*: 손을 뗀 뒤의 관성 (FR-MTS-5). 속도는 px/ms, DECAY 는 FRAME_MS 당 곱하는 값이고
//   MIN_V 밑에서 멈춘다. VELOCITY_WINDOW: 처음 속도를 재는 최근 표본의 창. DECAY 0.97 (FR-MTS-10).
// LPR_*: 마우스 리포팅 TUI 가 보고 하나에 움직이는 줄 수를 화면 비교로 잴 때 (FR-MTS-9) — 짝의 최소 수,
//   믿는 줄 수의 상한, 기다리는 시간.
// INFLIGHT_*: 화면에 아직 반영되지 않은 보고의 최대 수와, 출력이 없을 때 반영으로 보는 시간 (FR-MTS-11).
// KB_EPS: 키보드 높이 잡음. 이 미만의 변화로는 재적용하지 않는다.
// KB_UP: 이 높이를 넘으면 소프트 키보드가 떠 있다고 본다.
const MTI_TOUCH_GAIN=1;
const MTI_TOUCH_SLOP_PX=8;
const MTI_FLING_DECAY=0.97;
const MTI_LPR_MIN_MATCH=3;
const MTI_LPR_MAX=10;
const MTI_LPR_TIMEOUT_MS=400;
const MTI_INFLIGHT_MAX=2;
const MTI_INFLIGHT_TIMEOUT_MS=300;
const MTI_FRAME_MS=1000/60;
const MTI_FLING_MIN_V=0.4/MTI_FRAME_MS;
const MTI_FLING_MAX_V=120/MTI_FRAME_MS;
const MTI_VELOCITY_WINDOW_MS=100;
const MTI_KB_EPS_PX=4;
const MOBILE_KB_UP_PX=80;
// 스크롤 제스처 뒤에 오는 합성 마우스 이벤트를 무시하는 창 (FR-MTI-29).
const MTI_SYNTH_MOUSE_MS=700;

// OPTIMIZE_REFACTOR_SRS FR-OPT-12-1: 터미널 재접속 백오프(`TermChannel`). 첫 시도는 즉시,
// 이후 200 → ×2.5(500 까지는 빠르게, 1000 상한) → ×1.2(10 s 상한). 기다리는 시간에만 ±20%
// 지터를 얹는다 — 서버가 다시 뜬 뒤 모든 탭이 같은 순간에 몰리지 않게 한다. 다음 지연 값
// 자체(`_retryDelay`)에는 얹지 않는다: 백오프가 자라는지(FR-RCS-3)는 그 값으로 잰다.
const TERM_WS_RETRY_FIRST_MS=200;
const TERM_WS_RETRY_FAST_UNTIL_MS=500;
const TERM_WS_RETRY_FAST_FACTOR=2.5;
const TERM_WS_RETRY_FAST_MAX_MS=1000;
const TERM_WS_RETRY_FACTOR=1.2;
const TERM_WS_RETRY_MAX_MS=10000;
const TERM_WS_RETRY_JITTER=0.2;
// 다시 붙은 뒤 "다시 연결" 오버레이를 걷기까지의 여유.
const TERM_OVERLAY_HIDE_MS=300;
// 연결 중(readyState 0)에 쌓아 두는 송신 프레임 상한. 넘치면 가장 오래된 것을 버린다.
const TERM_SEND_QUEUE_MAX=64;
// UX_BATCH11_SRS FR-HIN-3·4: 한 번 연결된 뒤 끊긴 동안 붙잡는 사용자 입력의 상한(UTF-8 바이트)과
// 배너 미리보기의 글자 수.
const TERM_HELD_MAX=64*1024;
const TERM_HELD_PREVIEW_CHARS=200;
// FR-OPT-12-1 (FEU-15): 터미널이 xterm 대신 직접 보내는 키. 조합(수식키) → 키 → 바이트열.
const TERM_KEY_SEQ={shiftEnter:[0x1b,0x0d],lineStart:[0x01],lineEnd:[0x05],wordBack:[0x1b,0x62],wordFwd:[0x1b,0x66]};
const TERM_KEY_MAP={meta:{ArrowLeft:'lineStart',ArrowRight:'lineEnd'},alt:{ArrowLeft:'wordBack',ArrowRight:'wordFwd'}};

/**
 * 페이지 수명 동안 받아들이는 WebGL 컨텍스트 손실 횟수 (TERMINAL_GPU_RENDER_SRS FR-TGR-11).
 * 여기에 이르면 그 페이지는 GPU 렌더링을 다시 시도하지 않는다.
 */
const TERM_GPU_LOSS_LIMIT=3;
const META_API='/api/meta';
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
  // PERF D-25: **`scrollback` 도 여기 없다.** 설정 `termScrollback` 이며 `term-pane.js` 가 생성 시점에 읽는다.
  cursorBlink:true,cursorStyle:'block',
  // FONT_SIZE_SETTING_SRS FR-FSS-13: **`fontSize` 는 여기 없다.** 진실은 설정
  // `termFontSize` 이며 `term-pane.js` 가 생성 시점에 읽는다 — 같은 수를 두 자리에
  // 적으면 한쪽만 바뀐다. 종전에는 그 자리가 CSS 토큰 `--fs-lg` 였다 (FR-M11-15).
  lineHeight:1.2,allowProposedApi:true,logLevel:'off',
  // UX_BATCH11_SRS FR-TCP-5: mac 에서 마우스를 쓰는 TUI 위에서도 Option+드래그로 선택한다.
  macOptionClickForcesSelection:true,
  fontFamily:"'Menlo','Consolas','Liberation Mono','Courier New',monospace",
  theme:null,
};

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

/**
 * xterm 이 내는 **SGR 마우스 보고**다 (`UX_BATCH11_SRS` FR-HIN-9). 사용자 입력이
 * 아니므로 보류하지 않는다. 터미널 요소가 떨어진 순간에 잰 좌표는 `NaN` 이다.
 */
const TERM_MOUSE_RE=/^(?:\x1b\[<\d+;(?:-?\d+|NaN);(?:-?\d+|NaN)[Mm])+$/;

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
