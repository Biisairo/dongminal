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
// 원격은 M3 다 — 자리만 두고 사유를 title 로 알린다.
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

// ── 스테이징 (GIT_SRS §3A.1 / FR-GIT-64~73) ──

// 그룹별 일괄 동작. tracked / untracked 구분은 그룹이 이미 하고 있으므로 그룹별
// 일괄이 곧 FR-GIT-68 이다 — 버튼을 더 만들지 않는다. conflicts 는 일괄이 없다:
// 충돌 stage 는 "해결됨 표시" 라 한 번에 밀어 넣을 동작이 아니다 (FR-GIT-72).
const GIT_GROUP_BULK={staged:'unstage',changes:'stage',untracked:'stage'};
// 행 hover 버튼. 그룹이 할 수 있는 동작만 보인다 — staged 행의 `+` 는 뜻이 없다.
const GIT_ROW_ACTS={
  staged:['unstage'], changes:['stage','discard'],
  untracked:['stage','discard'], conflicts:['stage'],
};
const GIT_ACT_LABEL={stage:'+',unstage:'−',discard:'↺'};
const GIT_ACT_TITLE={stage:'스테이지',unstage:'언스테이지',discard:'변경 버리기'};
const GIT_BULK_LABEL={stage:'모두 스테이지',unstage:'모두 언스테이지'};
const GIT_SEL_LABEL={stage:'스테이지',unstage:'언스테이지',discard:'버리기'};
const GIT_SEL_CLEAR='해제';
// FR-GIT-70: staged 와 unstaged 를 동시에 가진 파일. 체크박스의 indeterminate 와
// 행 클래스 둘로 구분한다 — 색만으로는 무엇이 다른지 알 수 없다.
const GIT_PARTIAL_TITLE='일부만 스테이지됨';
// FR-GIT-72: 충돌 파일의 stage 는 "해결됨 표시" 다. 파괴적이 아니므로 1단계 확인이다.
const GIT_ACT_RESOLVE='resolve_mark';
const GIT_RESOLVE_TITLE='충돌을 해결됨으로 표시합니다';
const GIT_RESOLVE_NOTE='스테이지한 뒤에도 언스테이지로 되돌릴 수 있습니다';
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
const GIT_NOTE_CLOSE='닫기';
const GIT_WRITE_ERR={
  bad_request:'잘못된 요청입니다',
  confirmation_required:'확인이 필요합니다',
  not_a_git_repo:GIT_ERR_NOT_REPO,
  git_missing:GIT_ERR_GIT_MISSING,
  git_timeout:'git 실행이 시간을 초과했습니다',
  git_failed:'git 이 실패했습니다',
  git_unavailable:'git 을 쓸 수 없습니다',
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
const GIT_UNDO_LABEL='되돌리기';
const GIT_UNDO_FAIL='되돌릴 수 없습니다 — undo 창이 지났습니다';
// FR-GIT-88: 무엇이 왜 막혔고 어떻게 푸는지를 함께 보인다. Fix 는 복사 가능하다.
const GIT_PREFLIGHT_TITLE='커밋 전 검사가 막았습니다';
const GIT_PREFLIGHT_FIX='해소';
const GIT_PREFLIGHT_COPY='복사';
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
const GIT_CONFIRM_RUN='실행';
const GIT_CONFIRM_CANCEL='취소';
const GIT_CONFIRM_COPY='복사';
const GIT_CONFIRM_HINT_LABEL='복구 수단';
const GIT_CONFIRM_RUNNING='실행 중…';
const GIT_CONFIRM_FAIL='동작이 실패했습니다';
// FR-GIT-92: 값을 얻지 못한 hint 를 조용히 빈 칸으로 두지 않는다.
const GIT_CONFIRM_NO_HINT='복구 수단이 없습니다 — 이 동작은 되돌릴 수 없습니다';
// FR-GIT-178: 알리기만 한다. 다시 열게 강제하지도, 실행을 막지도 않는다.
const GIT_CONFIRM_CHANGED='대상이 변경되었습니다';
// FR-GIT-91: 개수는 목록과 함께 보이는 것이다 — 개수만 보이면 요구사항 실패다.
const GIT_CONFIRM_COUNT_LABEL='대상';

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
