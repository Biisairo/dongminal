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
  {key:'history',  name:'History'},
  {key:'branches', name:'Branches'},
  {key:'stash',    name:'Stash'},
  {key:'console',  name:'Console'},
  // FR-GIT-28 (개정): 고정 탭이 7개가 된다. 요청이 "관리 **탭**" 이었으므로 기존 탭
  // 안에 밀어 넣지 않는다 — 그러면 Branches 탭이 두 가지 일을 한다.
  {key:'worktrees', name:'Worktrees'},
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
// commit-parent 는 다른 셋과 달리 리비전을 인자로 받는다 (FR-GIT-138·139) —
// worktree·index·HEAD 는 암묵적 리비전이지만 커밋 축은 두 커밋을 명시해야 한다.
const GIT_AXIS={STAGED:'index-head',UNSTAGED:'worktree-index',CONFLICT:'worktree-head',
  COMMIT:'commit-parent'};
const GIT_GROUP_AXIS={
  staged:GIT_AXIS.STAGED,   changes:GIT_AXIS.UNSTAGED,
  untracked:GIT_AXIS.UNSTAGED, conflicts:GIT_AXIS.CONFLICT,
};
const GIT_AXIS_LABEL={
  'index-head':'index ↔ HEAD','worktree-index':'worktree ↔ index','worktree-head':'worktree ↔ HEAD',
  'commit-parent':'commit ↔ parent',
};
// 원격 버튼은 M3 가 살렸다 — 라벨·title·다이얼로그는 아래 원격 작업 절에 있다.
const GIT_PREVIEW_HINT='파일을 선택하세요';
const GIT_LOADING_HINT='불러오는 중…';
const GIT_STALE_NOTE='갱신 실패';
// FR-GIT-238: 새로고침. 이모지를 쓰지 않는다 (FR-GIT-187·192 와 같은 어휘).
const GIT_REFRESH_LABEL='⟳';
const GIT_REFRESH_TITLE='새로고침 — 상태·History·Branches·Console 을 전부 다시 받는다';
const GIT_ERR_NOT_REPO='저장소가 아닙니다';
const GIT_ERR_GIT_MISSING='git 을 찾을 수 없습니다';
// 파일 목록은 한 번에 다 그리지 않는다 (FR-GIT-42). 스크롤이 끝에 닿을 때마다
// 이만큼 늘린다.
const GIT_FILE_ROW_CHUNK=200;
const GIT_FILE_VIEW_KEY='gitFileView'; // 플랫/트리 선택은 기기별 취향이다
// FR-GIT-211: 트리의 들여쓰기 단위. 행의 padding 과 깊이 세로선이 **같은 값**을
// 딛는다 — 두 곳에 적으면 한쪽만 고쳐져 선이 글자와 어긋난다. CSS 는 이 값을
// `--git-indent` 로 받는다.
const GIT_TREE_INDENT=12;
const GIT_TREE_PAD0=6;
// 우클릭 메뉴는 GIT_MENUS.file 이다 (FR-GIT-41·146, git-menu.js).

// ── 스테이징 (GIT_SRS §3A.1 / FR-GIT-64~73) ──

// 그룹별 일괄 동작. tracked / untracked 구분은 그룹이 이미 하고 있으므로 그룹별
// 일괄이 곧 FR-GIT-68 이다 — 버튼을 더 만들지 않는다. conflicts 는 일괄이 없다:
// 충돌 stage 는 "해결됨 표시" 라 한 번에 밀어 넣을 동작이 아니다 (FR-GIT-72).
const GIT_GROUP_BULK={staged:'unstage',changes:'stage',untracked:'stage'};
// 행 hover 버튼. 그룹이 할 수 있는 동작만 보인다 — staged 행의 `+` 는 뜻이 없다.
// FR-GIT-236: Open File 이 먼저다 — 읽는 동작을 쓰는 동작 앞에 둔다. 되돌리기가
// 늘 끝에 오므로 파괴적인 것이 손에서 가장 멀다.
const GIT_ROW_ACTS={
  staged:['openFile','unstage'], changes:['openFile','stage','discard'],
  untracked:['openFile','stage','discard'], conflicts:['openFile','ours','theirs','stage'],
};
const GIT_ACT_LABEL={openFile:'↗',stage:'+',unstage:'−',discard:'↺',ours:'Ours',theirs:'Theirs'};
// ours·theirs 의 툴팁은 **진행 중인 조작에 따라 달라지므로** 여기 두지 않는다 —
// 행이 GIT_SIDE_TITLE 에서 그때 고른다 (FR-GIT-224).
const GIT_ACT_TITLE={openFile:'파일 열기',stage:'스테이지',unstage:'언스테이지',discard:'변경 버리기'};
const GIT_BULK_LABEL={stage:'Stage All',unstage:'Unstage All'};
// FR-GIT-70: staged 와 unstaged 를 동시에 가진 파일. 체크박스의 indeterminate 와
// 행 클래스 둘로 구분한다 — 색만으로는 무엇이 다른지 알 수 없다.
const GIT_PARTIAL_TITLE='일부만 스테이지됨';
// FR-GIT-72: 충돌 파일의 stage 는 "해결됨 표시" 다. 파괴적이 아니므로 1단계 확인이다.
const GIT_ACT_RESOLVE='resolve_mark';
const GIT_RESOLVE_TITLE='충돌을 해결됨으로 표시합니다';
const GIT_RESOLVE_NOTE='스테이지한 뒤에도 언스테이지로 되돌릴 수 있습니다';
// FR-GIT-224: 충돌 파일 하나를 한쪽으로 받아 해결한다. **파괴적이다** — 워킹
// 트리의 충돌 표식과 손대던 내용이 사라지고 되살릴 값이 없다.
//
// **`ours`/`theirs` 의 뜻은 진행 중인 조작에 따라 뒤집힌다.** merge 중에는 ours 가
// 현재 브랜치이지만 rebase 중에는 ours 가 올려놓는 대상이고 내 커밋이 theirs 다.
// 라벨은 git 의 낱말 그대로 두고(FR-GIT-200) 툴팁이 어느 쪽인지 밝힌다.
const GIT_ACT_RESOLVE_SIDE='resolve_side';
const GIT_RESOLVE_SIDE_TITLE='한쪽 내용으로 덮고 해결됨으로 표시합니다';
const GIT_RESOLVE_SIDE_NOTE='충돌 표식과 손대던 내용은 되살릴 값이 없습니다. 충돌 상태로 되돌리려면 아래를 실행합니다';
// 진행 중인 조작별 설명. 모르면 둘 다 밝힌다 — 틀린 한쪽을 단정하지 않는다.
const GIT_SIDE_TITLE={
  merge:{ours:'현재 브랜치(ours) 쪽 내용으로 덮습니다',theirs:'병합해 들어오는(theirs) 쪽 내용으로 덮습니다'},
  rebase:{ours:'올려놓는 대상(ours) 쪽 내용으로 덮습니다 — 내 커밋이 아닙니다',
          theirs:'내 커밋(theirs) 쪽 내용으로 덮습니다'},
  '':{ours:'ours 쪽 내용으로 덮습니다 (rebase 중에는 올려놓는 대상 쪽입니다)',
      theirs:'theirs 쪽 내용으로 덮습니다 (rebase 중에는 내 커밋 쪽입니다)'},
};
// preflight 의 코드값 → 조작 이름.
const GIT_OP_BY_BLOCK={merge_in_progress:'merge',rebase_in_progress:'rebase',
  cherry_pick_in_progress:'rebase',revert_in_progress:'rebase'};

// FR-GIT-89~92: discard. 파괴적 판정은 /api/git/policy 가 한다 — 이 이름은 그
// 목록의 키이고, 목록을 프론트에 복제하지 않는다.
const GIT_ACT_DISCARD='discard';
const GIT_DISCARD_TITLE='워킹 트리의 변경을 폐기합니다';
// O8: stash 를 자동 생성하지 않는다 — 안내만 한다.
const GIT_DISCARD_NOTE='폐기 전에 아래를 실행하면 stash 로 남습니다 (자동 실행하지 않습니다)';
// FR-GIT-73 · §7.1 I2: git 은 경로별로 처리해 진짜 롤백이 없다. 부분 적용을
// 조용히 넘기지 않는 것이 요구사항이고, 그것을 이 안내가 맡는다.
const GIT_PARTIAL_NOTE='일부만 적용됐습니다 — 아래 경로가 바뀌었습니다';
const GIT_WRITE_FAIL='동작이 실패했습니다';
const GIT_NOTE_CLOSE='Close';
const GIT_WRITE_ERR={
  bad_request:'잘못된 요청입니다',
  confirmation_required:'확인이 필요합니다',
  not_a_git_repo:GIT_ERR_NOT_REPO,
  git_missing:GIT_ERR_GIT_MISSING,
  git_timeout:'git 실행이 시간을 초과했습니다',
  git_failed:'git 이 실패했습니다',
  git_unavailable:'git 을 쓸 수 없습니다',
  // 원격 작업 고유의 거부 (FR-GIT-101). 라벨을 한 자리에 둔다.
  job_busy:'이 저장소의 원격 작업이 이미 진행 중입니다',
  job_not_found:'그 작업을 찾을 수 없습니다',
  no_remote:'밀 원격을 정할 수 없습니다',
};

// ── 커밋 (GIT_SRS §3A.2 / FR-GIT-74~85) ──

const GIT_COMMIT_PLACEHOLDER='커밋 메시지';
// FR-GIT-74: 기본 2줄에서 시작해 입력만큼 자라고, 이 줄 수를 넘으면 내부
// 스크롤로 넘긴다. 경계 드래그 결과는 기기별이라 localStorage 에 남는다.
const GIT_COMMIT_ROWS=2;
const GIT_COMMIT_MAX_ROWS=12;
const GIT_COMMIT_LINE_PX=17;   // lineHeight 를 읽지 못하는 환경의 대체값
const GIT_COMMIT_HEIGHT_KEY='gitCommitHeight';
// FR-GIT-75 · O6: draft 는 ws.git.drafts[<repo>] 다. 입력이 멈춘 뒤 저장한다 —
// 키 하나마다 PUT 을 보내지 않는다.
const GIT_COMMIT_DRAFT_DEBOUNCE_MS=300;
const GIT_COMMIT_BTN='Commit';
const GIT_COMMIT_MORE='▾';
const GIT_COMMIT_AMEND='amend';
// FR-GIT-79: VSCode 의 조합 명령 20개를 이 체크박스 3개가 대체한다. **선택을
// localStorage 에 남기지 않는다** — no-verify 가 기억되면 훅이 조용히 계속 꺼진다.
const GIT_COMMIT_OPTS=[
  {key:'signoff', label:'sign-off (--signoff)'},
  {key:'noVerify',label:'no-verify (--no-verify)'},
  {key:'all',     label:'commit all (-a)'},
];
const GIT_COMMIT_GPG='서명 커밋'; // FR-GIT-85
// FR-GIT-84: 왜 못 누르는지 보이지 않으면 요구사항 실패다.
const GIT_COMMIT_WHY_EMPTY='커밋 메시지를 입력하세요';
const GIT_COMMIT_WHY_NOTHING='staged 변경이 없습니다 — 파일을 스테이지하거나 commit all 을 켜세요';
const GIT_COMMIT_RUNNING='커밋 중…';
// FR-GIT-81·83 · O7: 5초 고정. 만료는 서버 토큰이 함께 강제한다.
const GIT_UNDO_MS=5000;
const GIT_UNDO_TEXT='커밋했습니다';
const GIT_UNDO_LABEL='Undo';
const GIT_UNDO_FAIL='되돌릴 수 없습니다 — undo 창이 지났습니다';
// FR-GIT-88: 무엇이 왜 막혔고 어떻게 푸는지를 함께 보인다. Fix 는 복사 가능하다.
const GIT_PREFLIGHT_TITLE='커밋 전 검사가 막았습니다';
const GIT_PREFLIGHT_FIX='해소';
const GIT_PREFLIGHT_COPY='Copy';
// FR-GIT-87: 막지 않고 알린다. 파괴적이 아니므로 1단계 확인이다.
const GIT_ACT_DETACHED='commit_detached';
const GIT_DETACHED_TITLE='이 커밋은 어느 브랜치에도 속하지 않습니다';
// preflight 가 아직 오지 않았어도 status 가 detached 를 안다 — 경고가 응답 왕복에
// 걸려 조용히 넘어가지 않게 그때의 사유를 여기 둔다.
const GIT_DETACHED_REASON='HEAD 가 브랜치를 가리키지 않습니다 (detached)';
const GIT_DETACHED_NOTE='브랜치를 만들어 이 커밋을 가리키게 하면 남습니다';
// preflight 의 코드값. 서버(internal/git/preflight.go)와 같은 문자열이다.
const GIT_WARN_DETACHED='detached_head';
const GIT_ERR_PREFLIGHT='preflight_blocked';
const GIT_ERR_UNDO_EXPIRED='undo_expired';
const GIT_ERR_EMPTY_MESSAGE='empty_message';
const GIT_ERR_NOTHING_STAGED='nothing_staged';

// ── 상태바 chip (GIT_SRS §3.7 / FR-GIT-57~59) ──

// 기존 상태바 항목의 이모지(📁·💻)와 달리 글자 기호를 쓴다 — 폭이 일정해 chip 이
// 갱신마다 흔들리지 않는다 (GIT_SURFACE_MAP S6).
const GIT_SB_BRANCH_ICON='⎇';
const GIT_SB_DIRTY_ICON='●';
const GIT_SB_TITLE='Git 창 열기';

// ── 파괴적 동작 확인 (GIT_SRS §3A.3 / FR-GIT-90~97·174~178) ──

const GIT_CONFIRM_TITLE='되돌릴 수 없는 동작입니다';
const GIT_CONFIRM_CONTINUE='계속';
const GIT_CONFIRM_RUN='Run';
const GIT_CONFIRM_CANCEL='Cancel';
const GIT_CONFIRM_COPY='Copy';
const GIT_CONFIRM_HINT_LABEL='복구 수단';
const GIT_CONFIRM_RUNNING='Running…';
const GIT_CONFIRM_FAIL='동작이 실패했습니다';
// FR-GIT-92: 값을 얻지 못한 hint 를 조용히 빈 칸으로 두지 않는다.
const GIT_CONFIRM_NO_HINT='복구 수단이 없습니다 — 이 동작은 되돌릴 수 없습니다';
// FR-GIT-178: 알리기만 한다. 다시 열게 강제하지도, 실행을 막지도 않는다.
const GIT_CONFIRM_CHANGED='대상이 변경되었습니다';
// FR-GIT-91: 개수는 목록과 함께 보이는 것이다 — 개수만 보이면 요구사항 실패다.
const GIT_CONFIRM_COUNT_LABEL='대상';

// ── 다이얼로그 공통 골격 (GIT_SRS §3D.3 / FR-GIT-171~178) ──

// 골격의 기본 이름. 흡수한 다이얼로그는 자기 id·클래스 접두를 그대로 유지한다 —
// 공유하는 것은 골격이고 이름은 각자의 것이다.
const GIT_DIALOG_ID='git-dialog';
const GIT_DIALOG_NS='gd';
// 필드 종류. **자격증명을 받는 종류는 없다** (FR-GIT-104).
const GIT_DIALOG_TEXT='text';
const GIT_DIALOG_CHECK='check';
const GIT_DIALOG_RADIO='radio';
// 실행을 막는 사유의 종류. `pending` 은 사유를 보이지 않고 실행만 막는다 —
// 판정을 모르는 동안 열어 두면 위반이 그대로 지나간다 (FR-GIT-159).
const GIT_DIALOG_WHY='why';
const GIT_DIALOG_WHY_PENDING='pending';
// FR-GIT-178 의 상태 지문에 넣는 그룹. 대상 파일들의 `xy` 조합이다.
const GIT_DIALOG_FP_GROUPS=['staged','changes','conflicts','untracked'];

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
const GIT_DIFF_WS_LABEL='Ignore Whitespace';
// FR-GIT-55: Monaco 로드 실패는 Git 창의 나머지를 멈추지 않는다 — diff 자리에만
// 사유를 보인다.
const GIT_DIFF_MONACO_FAIL='에디터를 불러올 수 없습니다 — 네트워크를 확인하세요';
const GIT_DIFF_LOAD_FAIL='diff 를 불러오지 못했습니다';
// 커밋·discard 로 대상이 목록에서 사라진 경우 (§3.3). 아무 파일이나 임의로
// 보이지 않고 사실만 알린다.
const GIT_DIFF_GONE_NOTE='선택한 파일이 목록에서 사라졌습니다';
// FR-GIT-46·47·48: 본문을 못 주는 쪽은 안내만으로 끝나지 않는다 — 서버가 실은
// 메타(oid·크기)를 안내 아래 줄로 보인다. 서버가 준 값만 쓴다.
const GIT_META_SIZED=new Set(['binary','too_large']);
const GIT_LFS_KIND='lfs';
// oid 는 sha256 64자다. 그대로 두면 안내 줄을 넘기므로 앞자리만 보인다 —
// git 이 해시를 축약해 보이는 것과 같은 관례다.
const GIT_LFS_OID_PREFIX='sha256:';
const GIT_LFS_OID_ABBREV=12;
const GIT_META_SEP=' · ';
// 양쪽 메타가 다를 때만 쪽을 밝힌다. diff 에디터의 좌·우가 곧 이전·이후다.
const GIT_META_SIDE={orig:'이전',mod:'이후'};
const GIT_META_LABEL_SEP=': ';
const GIT_DIFF_ERR={
  bad_request:'잘못된 diff 요청입니다',
  not_found:'파일을 찾을 수 없습니다',
  not_a_git_repo:GIT_ERR_NOT_REPO,
  git_missing:GIT_ERR_GIT_MISSING,
};

// ── Console 탭 (GIT_UI_REVISION_SRS FR-GIT-218) ──

// Console 은 터미널이 아니다. dongminal 이 사용자를 대신해 실행한 git 명령의
// 기록이며, 그 명령들은 서버 프로세스 안에서 돌아 사용자의 터미널에는 남지 않는다.
//
// 폴링(FR-GIT-18~24)은 1초에 한 번 기록되므로 거르지 않으면 목록이 그것으로만
// 찬다. 기본은 쓰기와 실패만 보이고, 토글이 읽기까지 연다.
const GIT_CON_READS_LABEL='Show Reads';
const GIT_CON_REFRESH='Refresh';
const GIT_CON_EMPTY='아직 실행한 명령이 없습니다';
const GIT_CON_EMPTY_READS='기록이 없습니다';
const GIT_CON_FAIL='기록을 불러오지 못했습니다';
const GIT_CON_DESTRUCTIVE='파괴적';
const GIT_CON_CWD='cwd';
// 읽기까지 열었을 때만 큰 목록이 된다. 그 전에는 쓰기만 남아 훨씬 짧다.
const GIT_CON_LIMIT=500;
// 쓰기가 끝나면 곧바로 다시 읽는다 — 방금 한 일이 이력의 맨 위에 있어야 한다.
// 그 밖에는 탭이 활성일 때만 받는다 (History·Branches·Stash 와 같은 규약).
const GIT_CON_POLL_MS=2000;

// ── History 탭 (GIT_SRS §3C / FR-GIT-113~134) ──

// 가상 스크롤 (FR-GIT-116). **고정 행 높이**로 계산한다 — 가변 높이는 10,000행에서
// 측정 비용이 스크롤을 먹는다. 값은 목록의 CSS 변수로 실려 CSS 와 JS 가 같은
// 숫자를 딛는다.
const GIT_HIST_ROW_H=30;   // = --git-row-min (FR-GIT-226). CSS 와 어긋나면 가상 스크롤이 틀어진다
const GIT_HIST_ROW_H_MOBILE=34; // 손가락으로 짚을 수 있는 높이
const GIT_HIST_OVERSCAN=6;      // 화면 위·아래로 더 그리는 여유 행
// 인라인 상세(FR-GIT-135)의 높이. **펼침은 한 번에 하나만** 허용하므로 오프셋
// 계산은 행 하나의 예외만 알면 된다 — 여러 개를 허용하면 가변 높이 문제가
// 되돌아온다. 내용이 넘치면 상세 안에서 스크롤한다.
const GIT_HIST_DETAIL_H=240;

// 페이징 (FR-GIT-114·115). 서버의 LogInitialLimit·LogPageLimit 과 같은 값이다.
const GIT_LOG_INITIAL=300;
const GIT_LOG_PAGE=100;
// 스크롤 끝에서 이만큼 남았을 때 다음 페이지를 부른다.
const GIT_LOG_NEAR_END_PX=200;

// 레인 (O11). 20 은 실제 저장소에서 압축이 거의 걸리지 않는 값이고, 모바일은
// 그래프 열이 메시지를 밀어내지 않는 선이다.
const GIT_LANE_MAX_DESKTOP=20;
const GIT_LANE_MAX_MOBILE=10;
const GIT_HIST_LANE_W=12; // 레인 하나의 폭(px)
const GIT_HIST_DOT_R=3;
// 레인 색은 **현재 테마의 팔레트**에서 뽑는다 (FR-GIT-119). 여기 두는 것은 색이
// 아니라 팔레트의 키다 — 색 리터럴을 코드에 두면 테마를 바꿔도 그래프가 따라오지
// 않는다 (V47).
const GIT_LANE_COLOR_KEYS=[
  'blue','green','yellow','magenta','cyan','red',
  'brightBlue','brightGreen','brightYellow','brightMagenta','brightCyan','brightRed',
];

// 정렬 (FR-GIT-128). 값은 /api/git/log 의 order 인자다.
const GIT_HIST_ORDERS=[
  {key:'date',       label:'date'},
  {key:'author-date',label:'author-date'},
  {key:'topo',       label:'topo'},
];

// 필터 (FR-GIT-130). 가능한 것을 git 옵션으로 내려보낸다 — 키는 질의 인자 이름이다.
const GIT_HIST_FILTERS=[
  {key:'author',label:'Author'},
  {key:'since', label:'Since'},
  {key:'until', label:'Until'},
  {key:'path',  label:'Path'},
];
const GIT_HIST_APPLY='Apply';

// 검색 두 모드 (FR-GIT-129). **두 결과가 다를 수 있음이 드러나야 한다.**
const GIT_SEARCH_LOADED='loaded';
const GIT_SEARCH_REPO='repo';
const GIT_SEARCH_PLACEHOLDER='검색';
const GIT_SEARCH_MODE_LABEL={loaded:'로드된 범위',repo:'저장소 전체'};
const GIT_SEARCH_MODE_TITLE={
  loaded:'이미 받은 커밋만 걸러냅니다 — 즉시',
  repo:'git 에 grep 을 내려보냅니다 — 느립니다',
};
// 로드 범위에서 0건이면 저장소 전체를 권한다 — 권하지 않으면 사용자는 "없다"와
// "아직 안 받았다"를 구분할 수 없다.
const GIT_SEARCH_NONE='로드된 %n개 중에는 없습니다';
const GIT_SEARCH_TRY_REPO='Search Whole Repo';

// jump (FR-GIT-131). 상한을 넘으면 찾지 못했다고 알린다 — 무한히 받아 오지 않는다.
const GIT_JUMP_MAX_PAGES=20;
const GIT_JUMP_PLACEHOLDER='해시·브랜치·태그';
const GIT_JUMP_GO='Go';
const GIT_JUMP_NOT_FOUND='찾지 못했습니다';
const GIT_JUMP_SEARCHING='찾는 중…';
// 찾은 행은 잠깐 강조한다 — 스크롤만 하면 어느 줄로 갔는지 알 수 없다.
const GIT_JUMP_FLASH_MS=2000;

// 날짜 (O12). 상대시간이 기본이고 절대시간은 title 로 항상 닿는다. 선택은 기기별
// 취향이라 localStorage 에 남는다 (gitFileView·gitDiffSideBySide 와 같은 방식).
const GIT_DATE_FORMAT_KEY='gitDateFormat';
const GIT_DATE_RELATIVE='relative';
const GIT_DATE_ABSOLUTE='absolute';
const GIT_REL_NOW='방금';
// [단위 길이(ms), 접미사]. 큰 단위부터 본다.
const GIT_REL_UNITS=[
  [31536000000,'년'],[2592000000,'개월'],[604800000,'주'],
  [86400000,'일'],[3600000,'시간'],[60000,'분'],
];

// 컬럼 반응형 (FR-GIT-125). `ResizeObserver` 로 목록 폭을 본다 — 미디어 쿼리는 창
// 폭이라 분할 안의 Git 창에서 쓸 수 없다. 숨김 순서는 Commit → Date → Author 이고
// 그래프·메시지는 항상 남는다.
const GIT_HIST_BREAKS=[
  {w:720,cls:'hide-hash'},
  {w:560,cls:'hide-date'},
  {w:420,cls:'hide-author'},
];

// refs 사이드바 (FR-GIT-122·123)
const GIT_REF_GROUPS=[
  {kind:'local', name:'Local'},
  {kind:'remote',name:'Remote'},
  {kind:'tag',   name:'Tags'},
];
const GIT_REF_ALL='전체 (--all)';
// upstream 이 사라진 것은 ahead/behind 0 과 **다르다** — 구분하지 않으면 사용자가
// 동기화된 브랜치로 읽는다 (계약 §2.5).
const GIT_REF_GONE='upstream 사라짐';
const GIT_HIST_REF_KEY='gitHistRef'; // 리포별 선택. 실제 키는 <이것>:<repo>

// 미커밋 변경 행 (FR-GIT-127). 클릭 → Changes 탭 (표면 지도 S4).
const GIT_HIST_UNCOMMITTED='미커밋 변경';

// 실패와 상태 (FR-GIT-132). **이미 로드된 목록을 지우지 않는다.**
const GIT_HIST_LOAD_FAIL='커밋 목록을 불러오지 못했습니다';
const GIT_HIST_DETAIL_FAIL='커밋 상세를 불러오지 못했습니다';
const GIT_HIST_EMPTY='커밋이 없습니다';
const GIT_HIST_LOADING='불러오는 중…';
const GIT_HIST_END='마지막입니다';
const GIT_HIST_LOADED_N='%n개 로드';
// FR-GIT-120: 상한을 넘어 접힌 행. 표식 없이 접으면 그래프가 조용히 틀려 보인다.
const GIT_HIST_COMPRESSED='레인 상한을 넘어 압축됐습니다';

// ── 커밋 상세 (GIT_SRS §3C.2 / FR-GIT-135~145) ──

const GIT_DETAIL_PARENTS='부모';
const GIT_DETAIL_FILES='변경 파일';
const GIT_DETAIL_NO_FILES='변경 파일이 없습니다';
const GIT_DETAIL_PARENT_PICK='비교 부모';
const GIT_DETAIL_ROOT='루트 커밋';
// FR-GIT-138: 커밋 축의 대상은 워킹 트리 목록과 다른 축이다 — 어느 두 리비전을
// 비교하는지 함께 보인다. 축 이름만 보이면 사용자는 어느 부모와의 비교인지 알 수
// 없다 (FR-GIT-139).
const GIT_DIFF_REV_ABBREV=8;
const GIT_DIFF_REV_RANGE='..';

// ── 컨텍스트 메뉴 프레임워크 (GIT_SRS §3C.2 / FR-GIT-146) ──

// FR-GIT-144: detached 가 됨을 사전 경고한다. 파괴적이 아니므로 1단계 확인이다 —
// dirty 면 그 뒤에 묶음 N 의 3선택이 이어진다 (FR-GIT-157, O14).
const GIT_CHECKOUT_DETACHED_ACT='checkout_detached';
const GIT_CHECKOUT_DETACHED_TITLE='HEAD 가 브랜치를 떠납니다 (detached)';

// ── Branches 탭 (GIT_SRS §3D.1 / FR-GIT-147~160) ──

// 목록은 /api/git/refs 다 (FR-GIT-147) — 14단계가 이름·대상·upstream·ahead/behind 를
// 이미 준다. 여기서 새 조회를 만들지 않는다.
const GIT_REF_KIND_LOCAL='local';
const GIT_REF_KIND_REMOTE='remote';
const GIT_REF_KIND_TAG='tag';

// 트리의 최상위 그룹 (FR-GIT-148·149). 즐겨찾기가 가장 위다 — 사용자가 고정한
// 것이 먼저 보이지 않으면 고정의 뜻이 없다.
// 즐겨찾기를 뺀 세 그룹의 key 는 **ref 의 kind 그대로**다 — 두 벌의 이름을 두면
// 한쪽만 고쳐진다.
const GIT_BR_GROUP_FAV='fav';
const GIT_BR_GROUPS=[
  {key:GIT_BR_GROUP_FAV,   name:'★ 즐겨찾기'},
  {key:GIT_REF_KIND_LOCAL, name:'로컬'},
  {key:GIT_REF_KIND_REMOTE,name:'원격'},
  {key:GIT_REF_KIND_TAG,   name:'태그'},
];
const GIT_BR_SEARCH_PLACEHOLDER='이름 검색';
const GIT_BR_NEW='+ New Branch';
const GIT_BR_EMPTY='이름이 일치하는 ref 가 없습니다';
const GIT_BR_LOAD_FAIL='브랜치 목록을 불러오지 못했습니다';
const GIT_BR_RETRY='Retry';
// 즐겨찾기는 workspace.json 최상위 git.favorites[<repo>] 다 (O13). 접힘 상태는
// 기기별 취향이라 localStorage 다 (FR-GIT-150) — 실제 키는 <이것>:<repo>.
const GIT_BR_FAV_FIELD='favorites';
const GIT_BR_COLLAPSE_KEY='gitBrCollapsed';
const GIT_BR_FAV_MARK='★';
const GIT_BR_FAV_ON_TITLE='즐겨찾기에서 빼기';
const GIT_BR_FAV_OFF_TITLE='즐겨찾기에 넣기';
const GIT_BR_CURRENT_MARK='✓';
// 접두사 그룹핑은 이름의 첫 조각이다 (FR-GIT-150).
const GIT_BR_PREFIX_SEP='/';

// FR-GIT-155·156: checkout. 원격 ref 는 같은 이름의 로컬을 만들며 추적을 설정한다 —
// 그러므로 두 항목은 뜻이 다르고, 어느 쪽이 왜 막혔는지 사유로 알린다.
const GIT_BR_CHECKOUT_LOCAL='Checkout as local';
const GIT_MENU_CURRENT='현재 브랜치입니다';
const GIT_MENU_REMOTE_REF='원격 브랜치입니다 — Checkout as local 을 쓰세요';
const GIT_MENU_LOCAL_ONLY='원격 브랜치에서만 쓸 수 있습니다';

// FR-GIT-157 · O14: dirty checkout 의 선택지. **순서가 제시 순서이고 첫 항목이
// 기본**이다 — 기본은 항상 안전한 쪽이다 (FR-GIT-97). 강제는 파괴적이므로
// GitConfirm 2단계를 거친다.
const GIT_DIRTY_OPT_CANCEL='cancel';
const GIT_DIRTY_OPT_STASH='stash';
const GIT_DIRTY_OPT_FORCE='force';
const GIT_DIRTY_OPTS=[
  {id:GIT_DIRTY_OPT_CANCEL,label:'Cancel'},
  {id:GIT_DIRTY_OPT_STASH, label:'Stash and continue'},
  {id:GIT_DIRTY_OPT_FORCE, label:'Force (discard changes)',danger:true},
];
const GIT_DIRTY_TITLE='미커밋 변경이 있는 상태의 checkout';
const GIT_DIRTY_NOTE='워킹 트리에 변경이 남아 있습니다 — 무엇을 할지 고르세요';
// 강제 checkout 은 워킹 트리의 변경을 버린다. **서버의 파괴적 목록에는 없는 이름**
// 이므로 확인 단계를 명시적으로 2로 요구한다 (계약 §1.1).
const GIT_ACT_CHECKOUT_FORCE='checkout_force';
const GIT_FORCE_TITLE='워킹 트리의 변경을 버리고 checkout 합니다';
const GIT_FORCE_NOTE='버리기 전에 아래를 실행하면 stash 로 남습니다 (자동 실행하지 않습니다)';
const GIT_STASH_BEFORE_MSG='checkout 전 자동 stash';

// FR-GIT-156: 이름 충돌의 선택지는 **서버가 준다** — 목록을 프론트가 복제하면
// 서버가 선택지를 늘려도 그것을 보이지 못한다. 라벨만 여기서 붙인다.
const GIT_BR_CONFLICT_TITLE='같은 이름의 로컬 브랜치가 이미 있습니다';
const GIT_BR_CONFLICT_LABEL={
  checkout_existing:'Checkout existing branch',
  create_other_name:'Create with another name',
  cancel:'Cancel',
};
const GIT_BR_RENAME_SUFFIX='-2'; // 다른 이름을 권할 때의 기본 후보

// 생성 다이얼로그 (FR-GIT-158·159, 검증 V68)
const GIT_BR_CREATE_TITLE='새 브랜치';
const GIT_BR_NAME_PLACEHOLDER='브랜치 이름';
const GIT_BR_START_PLACEHOLDER='시작점 (비우면 현재 HEAD)';
const GIT_BR_CREATE_CHECKOUT='만든 뒤 checkout';
const GIT_BR_CREATE_RUN='Create';
const GIT_BR_WHY_EMPTY='이름을 입력하세요';
const GIT_BR_WHY_EXISTS='같은 이름이 이미 있습니다 — 다른 이름을 쓰세요';
const GIT_BR_VALIDATE_FAIL='이름을 검사하지 못했습니다';
const GIT_BR_VALIDATE_DEBOUNCE_MS=200;

// ── Stash 탭 (GIT_SRS §3D.2 / FR-GIT-161~170) ──

const GIT_STASH_NEW='+ New Stash';
const GIT_STASH_EMPTY='stash 가 없습니다';
const GIT_STASH_LOAD_FAIL='stash 목록을 불러오지 못했습니다';
const GIT_STASH_PREVIEW_FAIL='stash 미리보기를 불러오지 못했습니다';
const GIT_STASH_PICK='stash 를 선택하세요';
const GIT_STASH_FILES='변경 파일';
const GIT_STASH_NO_FILES='변경 파일이 없습니다';
// FR-GIT-165 (검증 V57): pop 이 충돌로 끝나면 git 이 stash 를 남긴다. **조용히
// 넘기면 사용자가 작업을 잃었다고 오해한다.**
const GIT_STASH_KEPT='충돌로 stash 를 남겨 두었습니다 — 작업은 사라지지 않았습니다';
// FR-GIT-167: 변경이 없으면 생성을 비활성화하고 사유를 보인다. 사유 없이 꺼진
// 버튼은 사용자가 해소할 수 없다.
const GIT_STASH_NOTHING='저장할 변경이 없습니다';
const GIT_STASH_UNTRACKED_ONLY='추적되지 않는 파일뿐입니다 — untracked 포함을 켜세요';
// 생성 다이얼로그 (FR-GIT-166, 검증 V58)
const GIT_STASH_CREATE_TITLE='stash 생성';
const GIT_STASH_MSG_PLACEHOLDER='메시지 (선택)';
const GIT_STASH_OPT_UNTRACKED='추적되지 않는 파일 포함 (--include-untracked)';
const GIT_STASH_OPT_KEEPINDEX='index 는 그대로 남김 (--keep-index)';
const GIT_STASH_CREATE_RUN='Create';
// 우클릭 항목 (FR-GIT-162~164·168)
const GIT_STASH_APPLY='Apply';
const GIT_STASH_APPLY_INDEX='Apply (--index)';
const GIT_STASH_POP='Pop';
const GIT_STASH_DROP='Drop';
// FR-GIT-168: drop 은 파괴적이다. 이름은 서버의 파괴적 목록(/api/git/policy)의
// 키이며, 목록을 프론트에 복제하지 않는다.
const GIT_ACT_STASH_DROP='stash_drop';
const GIT_STASH_DROP_TITLE='stash 를 지웁니다';
const GIT_STASH_DROP_NOTE='gc 전이면 아래 명령으로 되살릴 수 있습니다';

// ── 원격 작업 (GIT_SRS §3B.1 / FR-GIT-98~112) ──

// FR-GIT-98·99: 버튼은 **기본 동작만** 한다. 변형(--prune·--rebase·force)은 `▾`
// 다이얼로그에서만 온다 — 여기서 라벨과 사유를 붙인다.
const GIT_REMOTE_KINDS=['fetch','pull','push'];
const GIT_REMOTE_LABEL={fetch:'Fetch',pull:'Pull',push:'Push'};
const GIT_REMOTE_TITLE={
  fetch:'원격을 가져옵니다 (git fetch)',
  pull:'가져와 현재 브랜치에 합칩니다 (git pull)',
  push:'현재 브랜치를 원격에 밀어 올립니다 (git push)',
};
const GIT_REMOTE_MORE='▾';
const GIT_REMOTE_MORE_TITLE='옵션';
const GIT_REMOTE_WHY_NO_STATUS='저장소 상태를 아직 읽지 못했습니다';
// FR-GIT-101: 진행 중에는 같은 리포의 다른 원격 버튼도 막는다. 사유 없이 꺼진
// 버튼은 사용자가 해소할 수 없다.
const GIT_REMOTE_WHY_BUSY='이 저장소의 원격 작업이 진행 중입니다';
// argv 는 그대로 보인다 — 무엇이 실행됐는지 모르면 다이얼로그의 선택이 반영됐는지
// 사용자가 확인할 수 없다 (FR-GIT-109·110).
const GIT_PROGRESS_FLAG='--progress';
// 보존 줄 수 상한. 서버의 JobLineCap 과 같은 값이다 — 더 들고 있어도 서버가 주지
// 않는다.
const GIT_JOB_LINE_CAP=2000;
// SSE 가 끊기면 마지막 seq 부터 다시 잇는다 (계약 §2.3.1).
const GIT_JOB_RETRY_MS=1000;
const GIT_JOB_RETRY_MAX=5;
const GIT_JOB_RUNNING='진행 중…';
const GIT_JOB_OK='완료';
const GIT_JOB_FAIL='실패';
const GIT_JOB_CANCELED='취소했습니다';
const GIT_JOB_CANCELING='취소하는 중…';
const GIT_JOB_CLOSE='Close';
const GIT_JOB_COPY='Copy Output';
const GIT_JOB_STREAM_FAIL='출력이 끊겼습니다 — 다시 잇는 중…';
const GIT_JOB_START_FAIL='원격 작업을 시작하지 못했습니다';
// FR-GIT-102: 취소는 **부분 적용 가능성을 알린다** — 원격에 절반이 올라간 뒤
// 끊길 수 있다. 그 사실을 확인 문구에 명시한다.
const GIT_ACT_JOB_CANCEL='job_cancel';
const GIT_JOB_CANCEL='Cancel';
const GIT_JOB_CANCEL_TITLE='진행 중인 원격 작업을 끊습니다';
const GIT_JOB_CANCEL_NOTE='끊긴 시점까지 원격에 일부가 적용된 채로 끝날 수 있습니다';
// FR-GIT-104: **자격증명을 받지 않는다.** 입력을 만들지 않고 터미널에서 수행하도록
// 안내만 한다 — 만들지 않는 것이 유일한 보장이다.
const GIT_JOB_AUTH_NOTE='자격증명이 필요합니다 — dongminal 은 자격증명을 받지도 저장하지도 않습니다. 터미널 탭에서 아래를 실행하세요';
const GIT_JOB_AUTH_COPY='Copy Command';
// FR-GIT-105: 선택지는 **서버가 준 순서 그대로** 그린다. 순서가 곧 우선순위이고
// force 는 마지막이며 강조하지 않는다.
const GIT_JOB_REJECT_NOTE='원격이 앞서 있어 거부됐습니다 — 아래에서 고르세요';
// 이름은 서버(internal/git/job.go)와 같은 문자열이다. 목록과 순서는 서버가 준다.
const GIT_JOB_FIX_REBASE='fetch_rebase';
const GIT_JOB_FIX_MERGE='fetch_merge';
const GIT_JOB_FIX_LEASE='force_with_lease';
const GIT_JOB_FIX_LABEL={
  fetch_rebase:'가져와 rebase (git pull --rebase)',
  fetch_merge:'가져와 merge (git pull)',
  force_with_lease:'강제로 밀어 올리기 (--force-with-lease)',
};
// FR-GIT-111: pull 이 충돌을 남기면 Changes 탭으로 보낸다. 해결 UI 는 M3 범위 밖이다.
const GIT_JOB_CONFLICT_NOTE='충돌이 남았습니다 — Changes 탭의 충돌 그룹에서 확인하세요';
// FR-GIT-100: upstream 이 없으면 Push 는 Publish 다. 서버가 실행 전에 되묻는다
// (계약 §2.3.1 ①) — 그 확인을 이 문구가 맡는다. 파괴적이 아니므로 1단계다.
const GIT_ACT_PUBLISH='publish';
const GIT_PUBLISH_TITLE='upstream 을 설정하며 밀어 올립니다';
// FR-GIT-106: force 는 `--force-with-lease` 가 기본이고 `--force` 는 2단계 확인을
// 거친다. 이름은 서버의 파괴적 목록(/api/git/policy)의 키이며 목록을 복제하지 않는다.
const GIT_ACT_FORCE_PUSH='force_push';
const GIT_FORCE_PUSH_TITLE='원격의 커밋을 덮어씁니다';
const GIT_FORCE_PUSH_NOTE='덮어쓰기 전에 아래로 원격의 현재 커밋을 적어 두세요 — 덮어쓴 뒤에는 원격의 reflog 에만 남습니다';
// `▾` 다이얼로그 (FR-GIT-109·110). **첫 선택지가 기본이고 그것이 안전한 쪽이다**
// (FR-GIT-97·173).
const GIT_REMOTE_DIALOGS={
  fetch:{title:'Fetch 옵션',run:'Fetch',fields:[
    {key:'prune',type:'check',label:'사라진 원격 브랜치 정리 (--prune)'},
    {key:'tags',type:'radio',label:'태그',opts:[
      {v:'',label:'기본 (저장소 설정에 맡김)'},
      {v:'yes',label:'모든 태그 (--tags)'},
      {v:'no',label:'태그 없음 (--no-tags)'},
    ]},
  ]},
  pull:{title:'Pull 옵션',run:'Pull',fields:[
    {key:'mode',type:'radio',label:'합치는 방식',opts:[
      {v:'',label:'기본 (merge)'},
      {v:'rebase',label:'rebase (--rebase)'},
      {v:'ff-only',label:'fast-forward 만 (--ff-only)'},
      {v:'no-ff',label:'항상 머지 커밋 (--no-ff)'},
    ]},
  ]},
  push:{title:'Push 옵션',run:'Push',fields:[
    {key:'force',type:'radio',label:'강제',opts:[
      {v:'',label:'강제하지 않음'},
      {v:'lease',label:'--force-with-lease'},
      {v:'force',label:'--force'},
    ]},
  ]},
};
// FR-GIT-112: 진행 중 원격 작업은 Git 창을 보지 않아도 알 수 있어야 한다.
const GIT_SB_JOB_ICON='⇅';
const GIT_SB_JOB_SUFFIX='…';
const GIT_SB_JOB_TITLE='진행 중인 원격 작업';

// ── Worktrees 탭 (GIT_REVIEW4_SRS §3.6.5 / FR-GIT-240~244) ──

const GIT_WT_ADD='+ New Worktree';
const GIT_WT_EMPTY='worktree 가 없습니다';
const GIT_WT_LOAD_FAIL='worktree 목록을 불러오지 못했습니다';
const GIT_WT_DETACHED='detached';
const GIT_WT_MAIN='main';
// 소유 표식 (FR-GIT-240). **사용자 것은 표식이 없다** — 그것이 기본이기 때문이다.
// 이모지를 쓰지 않는다 (FR-GIT-187·192).
const GIT_WT_OWN_LABEL={run:'Run',outside:'외부'};
const GIT_WT_OWN_TITLE={
  run:'Run 격리가 만든 worktree 입니다 — 여기서 지울 수 없습니다',
  outside:'dongminal 밖에서 만든 worktree 입니다 — 여기서 지울 수 없습니다',
};
// 행 동작 (FR-GIT-244). 제거는 사용자 것에만 붙고, 열기는 활성 리포 행에 붙지
// 않는다 — 눌리지만 아무 일도 하지 않는 버튼은 고장으로 읽힌다 (FR-GIT-180).
// FR-GIT-249: 핀은 **상태의 토글**이다 — 이미 핀된 것에 Pin 을 다시 보이면 눌러도
// 아무 일이 없고(서버 pin 은 멱등이다) 사용자는 그것을 고장으로 읽는다.
const GIT_WT_ACT_LABEL={open:'Open',pin:'Pin',unpin:'Unpin',term:'Shell',remove:'Remove'};
const GIT_WT_ACT_TITLE={
  open:'이 worktree 를 활성 리포로 엽니다',
  pin:'GIT 섹션에 핀합니다',
  unpin:'GIT 섹션의 핀을 풉니다',
  term:'이 worktree 에서 터미널 탭을 엽니다 (Git 창이 아닌 창)',
  remove:'이 worktree 를 지웁니다',
};
const GIT_WT_CREATE_TITLE='새 worktree 를 만듭니다';
const GIT_WT_CREATE_RUN='Create';
const GIT_WT_NAME_PH='이름 — 디렉터리 이름이 됩니다';
const GIT_WT_REF_PH='대상 ref — 브랜치·태그·커밋';
const GIT_WT_OPT_NEWBRANCH='이 이름으로 새 브랜치를 만든다';
const GIT_WT_NEED_NAME='이름이 필요합니다';
const GIT_WT_NEED_REF='대상 ref 가 필요합니다';
const GIT_WT_CREATED='만들었습니다: ';
const GIT_WT_PINNED='핀했습니다: ';
const GIT_WT_PIN_FAIL='핀하지 못했습니다';
const GIT_WT_UNPINNED='핀을 풀었습니다: ';
const GIT_WT_UNPIN_FAIL='핀을 풀지 못했습니다';
const GIT_WT_REMOVE_TITLE='worktree 를 지웁니다';
const GIT_WT_REMOVE_NOTE='디렉터리가 사라집니다. 저장하지 않은 변경이 남아 있으면 거부됩니다.';
// 제거는 200 으로 오면서 `removed:false` 일 수 있다 — 사유를 그 자리에 보인다
// (FR-GIT-243: 사용자의 작업을 지우지 않는다).
const GIT_WT_RESIDUE={
  'dirty':'저장하지 않은 변경이 있어 지우지 않았습니다',
  'unsafe-path':'이 경로는 지울 수 있는 영역이 아닙니다',
  'remove-failed':'git 이 제거하지 못했습니다',
  'branch-retained':'트리는 지웠으나 브랜치가 남았습니다',
};
const GIT_WT_REMOVE_FAIL='worktree 를 지우지 못했습니다';

// ── 진행 중 작업 (GIT_ACTIONS_SRS §3.1 / FR-GIT-251·252) ──
//
// merge·rebase·cherry-pick·revert 가 충돌로 멈추면 중간 상태가 남는다. 그 사실과
// **나갈 길**이 함께 보이지 않으면 사용자는 GUI 안에 갇힌다.
const GIT_OP_MERGE='merge';
const GIT_OP_REBASE='rebase';
const GIT_OP_CHERRY='cherry-pick';
const GIT_OP_REVERT='revert';
const GIT_OP_LABEL={
  [GIT_OP_MERGE]:'머지가 진행 중입니다',
  [GIT_OP_REBASE]:'리베이스가 진행 중입니다',
  [GIT_OP_CHERRY]:'체리픽이 진행 중입니다',
  [GIT_OP_REVERT]:'리버트가 진행 중입니다',
};
// 리베이스의 "몇 번째 중". 보이지 않으면 사용자는 끝났는지 알 수 없다.
const GIT_OP_AT='%n/%t';
const GIT_OP_CONTINUE='continue';
const GIT_OP_SKIP='skip';
const GIT_OP_ABORT='abort';
// 순서는 서버가 준다 (`/api/git/policy` 의 operations) — 목록을 여기 복제하면
// merge 에 없는 Skip 이 생기고, 눌리면 exit 128 로만 실패한다. 이 표는 **라벨**뿐이다.
const GIT_OP_ACT_LABEL={
  [GIT_OP_CONTINUE]:'Continue',
  [GIT_OP_SKIP]:'Skip',
  [GIT_OP_ABORT]:'Abort',
};
const GIT_OP_ACT_TITLE={
  [GIT_OP_CONTINUE]:'해결한 내용으로 이어서 진행합니다',
  [GIT_OP_SKIP]:'이 커밋을 건너뜁니다',
  [GIT_OP_ABORT]:'작업을 중단하고 시작 전 상태로 돌아갑니다',
};
const GIT_ACT_OP_ABORT='operation_abort';
const GIT_OP_ABORT_TITLE='진행 중인 작업을 중단합니다';
const GIT_OP_ABORT_NOTE='이 작업 중 해결한 내용이 사라집니다 — 저장소가 시작 전 상태로 돌아갑니다.';
// 진행 중 작업 때문에 막힌 메뉴 항목의 사유 (FR-GIT-252).
const GIT_MENU_OP_BUSY='%s — 먼저 그 작업을 끝내거나 중단하세요';

// ── Console 의 검색·replay (GIT_ACTIONS_SRS §3.8 / FR-GIT-281) ──
const GIT_CON_SEARCH_PH='명령·경로·오류 검색';
const GIT_CON_REPLAY='Replay';
const GIT_CON_REPLAY_TITLE='이 명령을 다시 실행합니다';
// 다시 도는 것도 같은 문을 지난다 — 그래서 이 실행도 기록에 남고, 원래 것이
// 파괴적이었으면 확인도 2단계다.
const GIT_CON_REPLAY_NOTE='서버가 자기 기록에서 꺼낸 명령을 그대로 다시 실행합니다. 저장소 상태가 그때와 다르면 결과도 다릅니다.';
const GIT_ACT_REPLAY='replay';
const GIT_CON_REPLAY_FAIL='다시 실행하지 못했습니다';
const GIT_CON_SEARCH_NONE='검색과 일치하는 기록이 없습니다';
// ── 태그 동작 (GIT_ACTIONS_SRS §3.3 / FR-GIT-260~262) ──

// 안내문은 한국어, 버튼은 영어다 (FR-GIT-202).
const GIT_TAG_NEW='새 태그 생성…';
const GIT_TAG_CREATE_AT='여기에 태그 생성…';
const GIT_TAG_CREATE_TITLE='새 태그를 만듭니다';
const GIT_TAG_CREATE_RUN='Create Tag';
const GIT_TAG_NAME_PH='태그 이름 — v1.0.0';
const GIT_TAG_REF_PH='대상 — 비우면 HEAD';
const GIT_TAG_MSG_PH='태그 메시지 — annotated·signed 에만 쓰입니다';
// 종류 (FR-GIT-260). **첫 선택지가 기본이고 그것이 안전한 쪽이다** (FR-GIT-173) —
// lightweight 는 객체를 만들지 않으므로 메시지도 서명 키도 필요 없다. 값은 서버의
// `write.TagKinds` 와 같은 문자열이다.
const GIT_TAG_KIND_LIGHT='';
const GIT_TAG_KIND_ANNOTATED='annotated';
const GIT_TAG_KIND_SIGNED='signed';
const GIT_TAG_KIND_LABEL='종류';
const GIT_TAG_KIND_OPTS=[
  {v:GIT_TAG_KIND_LIGHT,    label:'lightweight (ref 만 만든다)'},
  {v:GIT_TAG_KIND_ANNOTATED,label:'annotated (-a · 메시지가 남는다)'},
  {v:GIT_TAG_KIND_SIGNED,   label:'signed (-s · 서명 키가 필요하다)'},
];
// 입력 중 판정 (FR-GIT-260). 브랜치 생성과 같은 어휘를 쓴다 — 사유가 달라야
// 사용자가 무엇을 할지 안다.
const GIT_TAG_WHY_EMPTY='태그 이름이 필요합니다';
const GIT_TAG_WHY_EXISTS='같은 이름의 태그가 이미 있습니다 — 다른 이름을 쓰세요';
const GIT_TAG_WHY_NEED_MSG='annotated·signed 태그에는 메시지가 필요합니다';
const GIT_TAG_VALIDATE_FAIL='태그 이름을 검사하지 못했습니다';
// 메뉴 항목 (FR-GIT-261·262). 로컬과 원격은 **다른 항목**이다 — 하나가 다른 하나를
// 자동으로 하지 않는다.
const GIT_TAG_PUSH='Push to remote';
const GIT_TAG_PUSH_ALL='Push all tags';
const GIT_TAG_DELETE='Delete (local)';
const GIT_TAG_DELETE_REMOTE='Delete (remote)';
// 확인 (FR-GIT-89·92). 이름은 서버의 파괴적 목록(/api/git/policy)의 키이며 목록을
// 복제하지 않는다.
const GIT_ACT_TAG_DELETE='tag_delete';
const GIT_ACT_REMOTE_REF_DELETE='remote_ref_delete';
const GIT_TAG_DELETE_TITLE='로컬 태그를 지웁니다';
const GIT_TAG_DELETE_NOTE='로컬에서만 지웁니다 — 원격의 같은 태그는 그대로 남습니다. 아래 명령으로 되살릴 수 있습니다';
const GIT_TAG_DELETE_REMOTE_TITLE='원격의 태그를 지웁니다';
const GIT_TAG_DELETE_REMOTE_NOTE='원격에서만 지웁니다 — 로컬의 같은 태그는 그대로 남습니다. 아래 명령으로 되살릴 수 있습니다';
// 되살릴 oid 를 화면에서 얻지 못한 경우의 자리. 서버는 실행 **전에** 진짜 oid 로
// hint 를 남기므로(FR-GIT-92) 복구 수단 자체가 사라지는 것은 아니다.
const GIT_TAG_OID_UNKNOWN='<oid — /api/git/recovery 에 기록된 값>';
// 원격 이름을 클라이언트가 정하지 않는다 (FR-GIT-100 과 같은 규약) — 요청은 빈
// 값으로 보내고 서버가 정한다. 이 값은 **확인 문구에 보일 명령**의 자리를 채울
// 뿐이며, 저장소의 upstream 에서 뽑지 못했을 때만 쓰인다.
const GIT_TAG_REMOTE_FALLBACK='origin';
// 원격을 지나는 태그 동작의 라우트. `GitRemote.run` 은 kind 로 URL 을 만들므로
// 기본 규칙(`/api/git/<kind>`)과 다른 것만 여기 둔다 (FR-GIT-262).
const GIT_TAG_KIND_PUSH='tag-push';
const GIT_TAG_KIND_DELETE_REMOTE='tag-delete-remote';
const GIT_REMOTE_URL={
  [GIT_TAG_KIND_PUSH]:'/api/git/tag/push',
  [GIT_TAG_KIND_DELETE_REMOTE]:'/api/git/tag/delete-remote',
};
// ── stash·파일·미커밋 동작 (FR-GIT-272~277) ──
// 안내문은 한국어, 버튼은 영어다 (FR-GIT-202). 확인은 항목이 쓰지 않는다 —
// `warn`/`destructive` 선언만 하면 GitMenu 가 GitDialog/GitConfirm 을 거친다.

// stash 우클릭 (FR-GIT-272)
const GIT_STASH_BRANCH='Branch from stash…';
const GIT_STASH_COPY_NAME='stash 이름 복사';
const GIT_STASH_COPY_HASH='stash 해시 복사';
const GIT_STASH_BRANCH_TITLE='stash 에서 브랜치를 만듭니다';
const GIT_STASH_BRANCH_RUN='Create';
const GIT_STASH_BRANCH_NAME_PH='브랜치 이름';
const GIT_STASH_BRANCH_NEED_NAME='브랜치 이름이 필요합니다';
// stash 목록 필터 (FR-GIT-272). 메시지와 기준 브랜치를 함께 본다.
const GIT_STASH_FILTER_PH='메시지·브랜치 필터';
const GIT_STASH_FILTER_NONE='필터에 맞는 stash 가 없습니다';

// 파일 우클릭 (FR-GIT-273·274·275)
const GIT_FILE_IGNORE='Add to .gitignore';
const GIT_FILE_OPEN_HEAD='Open File (HEAD)';
const GIT_FILE_HISTORY='File history';
const GIT_IGNORE_FAIL='.gitignore 에 추가하지 못했습니다';
const GIT_IGNORE_DUP='이미 .gitignore 에 있습니다';
const GIT_HEAD_OPEN_FAIL='HEAD 의 내용을 열지 못했습니다';
// 워킹 트리의 파일과 구분되지 않으면 사용자는 그 자리의 편집이 저장소에 반영된다고
// 오해한다 — 탭 이름이 그것을 말한다.
const GIT_HEAD_TAB_SUFFIX=' (HEAD)';

// 미커밋 행 (FR-GIT-277). Clean 만 파괴적이다.
const GIT_UNC_STASH='Stash…';
const GIT_UNC_RESET='Reset (mixed)';
const GIT_UNC_CLEAN='Clean';
const GIT_ACT_CLEAN_UNTRACKED='clean_untracked';
const GIT_UNC_CLEAN_TITLE='추적되지 않는 파일을 지웁니다';
// 되살릴 수 없으므로 hint 는 되돌리는 명령이 아니라 **먼저 담아 두는** 명령이다
// (discard 의 선례, FR-GIT-92).
const GIT_UNC_CLEAN_NOTE='추적되지 않는 파일은 git 에 저장된 적이 없어 지운 뒤에는 되살릴 수 없습니다. 지우기 전에 아래 명령으로 담아 둘 수 있습니다.';
const GIT_UNC_CLEAN_CMD='git stash push -u';
const GIT_UNC_NOTHING='대상이 없습니다';
// ── 부분 스테이징 (FR-GIT-278·279) ──
//
// 패치는 **서버가 만든다** (GIT_ACTIONS_SRS D6). 클라이언트는 좌표만 보낸다 —
// (경로, 축, hunk 번호, 줄 범위, 관측 식별자). 패치 문자열을 만드는 코드가 이쪽에
// 없어야 하고, 그래서 여기에는 라벨과 축 표만 있다.
const GIT_PATCH_STAGE='stage';
const GIT_PATCH_UNSTAGE='unstage';
const GIT_PATCH_REVERT='revert';
// 부분 스테이징이 있는 축은 둘뿐이다 — 서버가 그 둘만 받는다. 충돌·커밋 축에는
// 방향이 정해지지 않아 조각을 넣을 수 없다.
const GIT_HUNK_AXES=new Set([GIT_AXIS.UNSTAGED,GIT_AXIS.STAGED]);
// 축마다 붙는 동작. **방향이 축에서 갈린다** — worktree↔index 는 올리고 버리는
// 축이고, index↔HEAD 는 내리는 축이다.
const GIT_HUNK_ACTS={
  [GIT_AXIS.UNSTAGED]:[GIT_PATCH_STAGE,GIT_PATCH_REVERT],
  [GIT_AXIS.STAGED]:[GIT_PATCH_UNSTAGE],
};
// 버튼은 영어다 (FR-GIT-202). 줄 범위를 골랐을 때는 라벨이 바뀐다 — 무엇에 걸리는
// 동작인지 누르기 전에 보여야 한다.
const GIT_HUNK_LABEL={stage:'Stage hunk',unstage:'Unstage hunk',revert:'Revert hunk'};
const GIT_HUNK_LINE_LABEL={stage:'Stage lines',unstage:'Unstage lines',revert:'Revert lines'};
const GIT_HUNK_TITLE={
  stage:'이 조각만 스테이지합니다',
  unstage:'이 조각만 스테이지에서 내립니다',
  revert:'이 조각을 워킹 트리에서 버립니다 — 되돌릴 수 없습니다',
};
const GIT_HUNK_LINE_CLASS={'+':' add','-':' del',' ':'','\\':' meta'};
const GIT_HUNK_LOADING='조각을 불러오는 중…';
const GIT_HUNK_LOAD_FAIL='조각을 불러오지 못했습니다';
const GIT_HUNK_NONE='이 파일에는 나눌 조각이 없습니다';
const GIT_HUNK_HINT='줄을 누르면 범위가 잡힙니다 — Shift 로 넓히고, 같은 줄을 다시 누르면 놓습니다';
const GIT_HUNK_SEL_LABEL='선택 ';
const GIT_HUNK_SEL_SEP='~';
const GIT_HUNK_CLEAR='Clear';
const GIT_HUNK_CLEAR_TITLE='줄 선택을 지웁니다';
const GIT_HUNK_TARGET_SEP=' · ';
// revert 는 파괴적이다 (FR-GIT-279) — discard 와 같은 뜻이므로 그 이름을 쓴다.
const GIT_HUNK_REVERT_TITLE='고른 줄을 워킹 트리에서 버립니다';
// O8 의 선례: stash 를 자동 생성하지 않는다 — 실행할 명령을 보여 준다.
const GIT_HUNK_REVERT_NOTE='버리기 전에 아래를 실행하면 파일 전체가 stash 로 남습니다 (자동 실행하지 않습니다)';
// 부분 스테이징 고유의 거부. 목록을 두 벌 두지 않으려고 기존 표에 얹는다 —
// 쓰기 실패의 사유를 읽는 자리는 GIT_WRITE_ERR 하나뿐이어야 한다.
Object.assign(GIT_WRITE_ERR,{
  stale_observation:'그 사이 파일이 바뀌었습니다 — 조각을 다시 받아 고르세요',
  patch_empty:'고른 범위에 바뀐 줄이 없습니다',
});
