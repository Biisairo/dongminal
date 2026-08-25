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

// ── Git 창 (GIT_SRS §3.4 / FR-GIT-25~31) ──

// 창의 type 은 없을 수 있다. 없으면 terminal 이다 — 기존 workspace.json 이 그대로
// 로드돼야 한다 (FR-GIT-25). 판정은 항상 WINDOW_TYPE_GIT 인지로만 한다.
const WINDOW_TYPE_TERMINAL='terminal';
const WINDOW_TYPE_GIT='git';
const TAB_TYPE_GIT='git';

// Git 창은 워크스페이스 전체에 1개다 (FR-GIT-26). 이름은 고정 — 활성 리포를
// 이름에 반영하면 창 목록에서 같은 창이 계속 이름을 바꿔 식별성이 떨어진다.
const GIT_WINDOW_NAME='Git';

// Git 창 내부의 고정 탭. 생성·삭제되지 않는다 (FR-GIT-28).
// pending 인 탭은 M1 에서 자리만 있고 "준비 중" 을 표시한다.
const GIT_VIEWS=[
  {key:'changes',  name:'Changes'},
  {key:'diff',     name:'Diff'},
  {key:'history',  name:'History',  pending:true},
  {key:'branches', name:'Branches', pending:true},
  {key:'stash',    name:'Stash',    pending:true},
  {key:'console',  name:'Console',  pending:true},
];
const GIT_PENDING_HINT='이후 마일스톤에서 제공됩니다';
const GIT_NO_REPO_HINT='리포를 선택하세요';

// ── 좌측 GIT 섹션 (GIT_SRS §3.2 / FR-GIT-9~17) ──

// GIT 섹션 목록 갱신 주기(ms). 배지는 서버의 마지막 관측값이라 자주 부를 이유가
// 없다 — 이 호출은 git 을 실행하지 않는다 (FR-GIT-24).
const GIT_REPOS_POLL_MS=3000;

// follow 대상이 저장소가 아닐 때의 표시. 마지막 유효 리포를 남기지 않는다 (FR-GIT-10).
const GIT_NOT_REPO_LABEL='저장소 아님';

// FR-GIT-12: M1 에는 공통 다이얼로그 규약이 없다 (M5 묶음 P). prompt·alert 를 쓴다.
const GIT_ADD_REPO_PROMPT='추가할 리포 경로 (절대경로)';
const GIT_PIN_FAIL_LABEL='리포 추가 실패';

// ── Changes 탭 (GIT_SRS §3.3 / FR-GIT-32~42) ──

// 그룹 순서. 충돌이 맨 위인 이유는 그것이 먼저 해결돼야 하는 상태이기 때문이다.
const GIT_GROUPS=[
  {key:'conflicts',name:'Conflicts'},
  {key:'staged',   name:'Staged'},
  {key:'changes',  name:'Changes'},
  {key:'untracked',name:'Untracked'},
];
// 그룹이 diff 축을 결정한다 (FR-GIT-52). 값은 /api/git/diff-content 의 axis 인자다.
const GIT_AXIS={STAGED:'index-head',UNSTAGED:'worktree-index',CONFLICT:'worktree-head'};
const GIT_GROUP_AXIS={
  staged:GIT_AXIS.STAGED,   changes:GIT_AXIS.UNSTAGED,
  untracked:GIT_AXIS.UNSTAGED, conflicts:GIT_AXIS.CONFLICT,
};
const GIT_AXIS_LABEL={
  'index-head':'index ↔ HEAD','worktree-index':'worktree ↔ index','worktree-head':'worktree ↔ HEAD',
};
// M1 에는 파괴적 동작이 하나도 없다 — 자리만 두고 사유를 title 로 알린다.
const GIT_COMMIT_HINT='M2 에서 제공됩니다';
const GIT_REMOTE_HINT='M3 에서 제공됩니다';
const GIT_PREVIEW_HINT='파일을 선택하세요';
const GIT_LOADING_HINT='불러오는 중…';
const GIT_STALE_NOTE='갱신 실패';
const GIT_ERR_NOT_REPO='저장소가 아닙니다';
const GIT_ERR_GIT_MISSING='git 을 찾을 수 없습니다';
// 파일 목록은 한 번에 다 그리지 않는다 (FR-GIT-42). 스크롤이 끝에 닿을 때마다
// 이만큼 늘린다.
const GIT_FILE_ROW_CHUNK=200;
const GIT_FILE_VIEW_KEY='gitFileView'; // 플랫/트리 선택은 기기별 취향이다
// 우클릭 메뉴 (FR-GIT-41). **저장소를 바꾸는 항목은 하나도 없다.**
const GIT_CTX_ITEMS=[
  {key:'openChanges',label:'Open Changes'},
  {key:'openFile',   label:'Open File'},
  {key:'copyPath',   label:'Copy Path'},
];

// ── 변경 감지 3계층 (GIT_SRS §3.3 / FR-GIT-18~24) ──

// 기본 주기(ms). 0 이면 그 계층을 끈다 (FR-GIT-23).
const GIT_SIGNATURE_POLL_MS=500;
const GIT_STATUS_POLL_MS=1000;
// 즉시 신호는 몰아서 온다 — 셸 훅·에디터 저장·포커스 복귀가 겹친다. 하나로 합쳐
// status 를 연발하지 않게 한다 (FR-GIT-20).
const GIT_SIGNAL_DEBOUNCE_MS=150;
// 주기는 설정으로 덮을 수 있다 (FR-GIT-23) — statsInterval 과 같은 방식이다.
var gitSignatureInterval=GIT_SIGNATURE_POLL_MS;
var gitStatusInterval=GIT_STATUS_POLL_MS;

// ── Diff (GIT_SRS §3.6 / FR-GIT-43~56) ──

// DiffEditor 옵션. ignoreTrimWhitespace 는 Monaco 기본값(true)을 뒤집는다 —
// git 은 공백 변경을 변경으로 취급하기 때문이다 (FR-GIT-50).
const GIT_DIFF_OPTIONS={
  renderSideBySide:true,
  useInlineViewWhenSpaceIsLimited:true,
  renderSideBySideInlineBreakpoint:900,
  hideUnchangedRegions:{enabled:true},
  ignoreTrimWhitespace:false,
  readOnly:true,
  originalEditable:false,
  automaticLayout:true,
  scrollBeyondLastLine:false,
  renderOverviewRuler:false,
};
// Changes 탭의 미리보기는 좁다. 접기와 inline 전환을 더 이르게 건다.
const GIT_PREVIEW_INLINE_BREAKPOINT=560;
// 서버의 DiffSide.kind (FR-GIT-45~48). text 와 absent 만 본문을 그린다 —
// absent 는 빈 내용으로 다뤄야 추가·삭제 파일의 diff 가 성립한다.
const GIT_DIFF_DRAWABLE=new Set(['text','absent']);
// 보기 모드와 공백무시는 기기별 취향이다 (§3.3).
const GIT_DIFF_SIDE_KEY='gitDiffSideBySide';
const GIT_DIFF_WS_KEY='gitDiffIgnoreWs';
const GIT_DIFF_MODE_LABEL={side:'side-by-side',inline:'unified'};
const GIT_DIFF_WS_LABEL='공백무시';
// FR-GIT-55: Monaco 로드 실패는 Git 창의 나머지를 멈추지 않는다 — diff 자리에만
// 사유를 보인다.
const GIT_DIFF_MONACO_FAIL='에디터를 불러올 수 없습니다 — 네트워크를 확인하세요';
const GIT_DIFF_LOAD_FAIL='diff 를 불러오지 못했습니다';
// 커밋·discard 로 대상이 목록에서 사라진 경우 (§3.3). 아무 파일이나 임의로
// 보이지 않고 사실만 알린다.
const GIT_DIFF_GONE_NOTE='선택한 파일이 목록에서 사라졌습니다';
const GIT_DIFF_ERR={
  bad_request:'잘못된 diff 요청입니다',
  not_found:'파일을 찾을 수 없습니다',
  not_a_git_repo:GIT_ERR_NOT_REPO,
  git_missing:GIT_ERR_GIT_MISSING,
};
