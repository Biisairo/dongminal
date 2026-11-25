/**
 * Otterminal — git 창의 **골격** 상수 (FE_MODULE_BOUNDARY_SRS FR-FMB-1).
 *
 * 창 하나 · 고정 탭 여덟 · 뷰 필드 · 진입점, 그리고 좌측 GIT 섹션
 * (GIT_SRS §3.2 / FR-GIT-9~17). 어느 탭에도
 * 속하지 않고 **탭이라는 것 자체를 세우는** 것들이 여기 산다.
 *
 * `constants.js` **뒤**, `constants-editor.js` **앞**에 로드된다 — 그쪽의
 * `ED_DD_AXIS` 가 이 파일의 `GIT_AXIS` 를 참조한다.
 *
 * **탭별 상수는 갈라져 나갔다.** 고칠 자리를 파일 이름이 말한다:
 *
 *   constants-git-changes.js    Changes · 소실 · 스테이징 · 서브모듈 알림 · 툴팁
 *   constants-git-commit.js     커밋 · 파괴적 동작 확인 · 다이얼로그 골격
 *   constants-git-detect.js     변경 감지 2계층 — 주기와 그 가변 전역
 *   constants-git-diff.js       Diff · Console
 *   constants-git-history.js    History · 커밋 상세 · 컨텍스트 메뉴 프레임워크
 *   constants-git-refs.js       Branches · Stash
 *   constants-git-remote.js     원격 · Worktrees · Submodules
 *   constants-git-actions.js    동작 상수와 `GIT_WRITE_ERR` (DRIFT_RECLAIM_SRS FR-DRC-13)
 */
// Git 창은 워크스페이스 전체에 1개다 (FR-GIT-26). 이름은 고정 — 활성 리포를
// 이름에 반영하면 창 목록에서 같은 창이 계속 이름을 바꿔 식별성이 떨어진다.
const GIT_WINDOW_NAME='Git';

// UX_BATCH12_SRS FR-RTB-7: Diff 탭 전용 패널의 키에서 루트와 탭 id 를 가르는 글자.
// 경로에 나올 수 없는 제어 문자다.
const GIT_DIFF_TAB_SEP='\u0001';

// Git 창 내부의 고정 탭. 생성·삭제되지 않는다 (FR-GIT-28).
// pending 인 탭은 M1 에서 자리만 있고 "준비 중" 을 표시한다.
const GIT_VIEWS=[
  {key:'changes',  name:t('git.view.changes')},
  // `diff` 의 뷰 객체는 `_diffView` 이지만 `field` 를 두지 않는다 — 편집기를 들고
  // 있어 언마운트가 아니라 `destroy()` 를 지나야 풀린다 (FR-GIT-56). 같은 목록에
  // 넣으면 그 차이가 지워진다.
  {key:'diff',     name:t('git.view.diff')},
  {key:'history',  name:t('git.view.history'),   field:'_historyView'},
  {key:'branches', name:t('git.view.branches'),  field:'_branchesView'},
  {key:'stash',    name:t('git.view.stash'),     field:'_stashView'},
  {key:'console',  name:t('git.view.console'),   field:'_consoleView'},
  // FR-GIT-28 (개정): 고정 탭이 7개가 된다. 요청이 "관리 **탭**" 이었으므로 기존 탭
  // 안에 밀어 넣지 않는다 — 그러면 Branches 탭이 두 가지 일을 한다.
  {key:'worktrees', name:t('git.view.worktrees'), field:'_worktreesView'},
  // UX_BATCH5_SRS FR-SUB-6: 고정 탭이 8개가 된다. Worktrees 바로 뒤인 이유는 둘이
  // 같은 성질이기 때문이다 — 저장소 안에 있으나 **자기 .git 을 가진 것**들이고,
  // 둘 다 `openGitWindow` 로 열린다 (D-10).
  {key:'submodules', name:t('git.view.submodules'), field:'_submodulesView'},
];
// REFACTOR_STABILIZATION_SRS FR-RST-20·21: 뷰 객체를 가진 탭의 **필드 이름**.
//
// 목록을 손으로 또 적지 않고 `GIT_VIEWS` 에서 파생시킨다. 종전에는 이 집합이
// 다섯 자리에 손으로 열거돼 있었고, 여덟 번째 탭(Submodules)이 그중 넷에서
// 빠져 있었다 — 필드 선언·탭 활성화 시 재조회·`dropView` 언마운트·`detach`.
// 뷰를 더하는 비용이 여섯 자리였기 때문에 생긴 결함이며, 파생시키면 그 비용이
// **배열 한 줄**이 된다.
const GIT_PANEL_VIEW_FIELDS=GIT_VIEWS.filter(v=>v.field).map(v=>v.field);
const GIT_VIEW_FIELD_BY_KEY=Object.fromEntries(
  GIT_VIEWS.filter(v=>v.field).map(v=>[v.key,v.field]));
// OPTIMIZE_REFACTOR_SRS FR-OPT-4-9: 관측 회차가 다시 받는 목록 뷰. 보이지 않으면 표식만
// 남기고 활성화할 때 받는다 (`_reloadViews`·`_staleTake`). Console·Diff 는 자기 규약이 있다.
const GIT_STALE_VIEWS=['history','branches','stash','worktrees','submodules'];
// REPO_TAB_UNIFY_SRS FR-RTU-21 / D-RTU-5: Changes 사이드 머리의 진입점.
//
// **Changes 는 여기 없다** — 그것은 사이드 자신이고(FR-RTU-32), 나머지 여섯만
// 본문 탭으로 열린다. 아이콘인 이유는 사이드가 좁기 때문이고, 무엇인지는 툴팁이
// 말한다. 순서는 `GIT_VIEWS` 를 따른다 — 두 자리가 다른 순서를 말하지 않는다.
//
// **`Diff` 도 여기 없다** (FR-RTU-21 개정). 다른 여섯과 성질이 다르기 때문이다:
// 나머지는 이 줄이 유일한 진입점이지만 Diff 는 **변경 목록의 파일을 누르면 이미
// 열리고**(git-change-rows 의 행 클릭), 커밋 축도 `showCommitDiff` 가 스스로 연다.
// 게다가 대상 없이 누르면 경로도 축도 빈 `0/0` 껍데기가 열렸다 — 다른 여섯은
// 대상 없이도 자기 내용을 가진다.
/**
 * UI_KIT_SRS FR-GLY-4: **`icon` 은 이제 스프라이트 이름이다** (문자가 아니다).
 *
 * 이 여섯은 인계 노트가 "git 패널 아이콘 완료" 로 적은 묶음에서 빠져 있었다 —
 * 그쪽은 fetch·pull·push 와 행 동작이었고, 본문 뷰로 가는 진입점 여섯은 여전히
 * 문자였다. `⏲≣⊞` 는 폰트마다 모양이 크게 달라 특히 그랬다.
 */
const GIT_SIDE_ACTIONS=[
  {key:'history',  icon:'git-history',      label:t('git.view.history'),title:'History'},
  {key:'branches', icon:'git-branch', label:t('git.view.branches'),title:'Branches'},
  {key:'stash',    icon:'archive',  label:t('git.view.stash'),title:'Stash'},
  {key:'console',  icon:'square-terminal',   label:t('git.view.console'),title:'Console'},
  {key:'worktrees',icon:'folders',label:t('git.view.worktrees'),title:'Worktrees'},
  {key:'submodules',icon:'blocks',label:t('git.view.submodules'),title:'Submodules'},
];

// REPO_TAB_UNIFY_SRS FR-RTU-25·26: 저장소가 아닌 자리와 거기서 만드는 길.
//
// **사실만 말하고 끝내지 않는다.** "저장소가 아닙니다" 는 사용자가 이미 아는
// 것이고, 알고 싶은 것은 여기서 무엇을 할 수 있는가다.
const GIT_INIT_ACTION='repo_init';
const GIT_INIT_NOT_REPO=t('git.init_not_repo');
const GIT_INIT_RUN='git init';
const GIT_INIT_CONFIRM=t('git.init_confirm');
const GIT_INIT_HINT=t('git.init_hint');
const GIT_INIT_FAIL=t('git.init_fail');

const GIT_PENDING_HINT=t('git.pending_hint');
const GIT_NO_REPO_HINT=t('git.no_repo_hint');

// 배지는 서버의 마지막 관측값이다. Git 탭이 활성일 때만 이
// 호출이 `observe=1` 을 실어 핀 전부를 관측한다 (FR-GOB-8·10) — 그 밖에서는 캐시만
// 읽으므로 git 을 실행하지 않는다 (FR-GIT-24).

// 배지를 "낡음" 으로 볼 관측 나이. Git 탭 안에서는 매 주기 관측이 도므로 이 값을
// 넘지 않는다 — 넘었다면 관측이 실제로 멎은 것이다 (FR-GOB-14). 주기에서
// 파생시키는 이유는 둘이 같은 사실의 앞뒤이기 때문이다.
//
// POLL_INTERVAL_SETTINGS_SRS FR-PIS-12 / D-7: 주기가 설정이 되면서 **계수만**
// 남는다. ms 로 굳혀 두면 주기를 바꿔도 이 기준만 옛 값에 남는다. 곱셈은
// `gitBadgeStaleMs()` 가 한다.
const GIT_BADGE_STALE_FACTOR=4;

// FR-FLW-11: 핀이 하나도 없을 때. follow 행이 늘 한 줄을 채우고 있었으므로 이
// 섹션은 빈 적이 없었다 — 이제는 있고, 빈 자리는 고장처럼 보인다.
const GIT_REPOS_NONE=t('git.repos_none');
// FR-ETR-31~33: `/api/cwd` 의 `source` 어휘. 서버의 상수(`cwdSourceTool`)와 짝이며, 문자열을 여러
// 곳에 흩뿌리면 한쪽만 바뀐다.
const GIT_CWD_SOURCE_TOOL='tool';
const GIT_PIN_FAIL_LABEL=t('git.pin_fail_label');

// ── 부팅 코드가 읽는 git 상수 (PERF D-32, perf/M3_DESIGN.md D-M3-4) ──
//
// 다른 `constants-git-*.js` 는 `git` 묶음 맨 앞에 서고 git 화면을 처음 열 때 실린다. 사이드바 목록·
// 탐색기·편집기의 변경 표시·탭 추가처럼 그 전에 도는 부팅 코드가 읽는 값만 여기로 옮겼다 — 이름과
// 값은 그대로다. 옮길 것은 scripts/check-lazy-boundary.mjs 가 알려 준다.
/**
 * 화면의 그룹 하나가 서버 응답의 어느 배열들인가 (D-7·D-8).
 *
 * 서버는 네 배열을 그대로 보낸다 — 각 행이 자기 출신을 알아야 폐기가 옳은 명령으로
 * 가고(FR-CMG-4), 응답 모양은 e2e·다른 뷰·다이얼로그가 함께 딛는 공개 계약이다.
 * 여기 없는 키는 서버 배열 이름이 곧 그룹 이름이다.
 */
const GIT_GROUP_SRC={working:['changes','untracked']};
// 그룹이 diff 축을 결정한다 (FR-GIT-52). 값은 /api/git/diff-content 의 axis 인자다.
// commit-parent 는 다른 셋과 달리 리비전을 인자로 받는다 (FR-GIT-138·139) —
// worktree·index·HEAD 는 암묵적 리비전이지만 커밋 축은 두 커밋을 명시해야 한다.
const GIT_AXIS={STAGED:'index-head',UNSTAGED:'worktree-index',CONFLICT:'worktree-head',
  COMMIT:'commit-parent'};
const GIT_ERR_NOT_REPO=t('git.err_not_repo');
const GIT_ERR_GIT_MISSING=t('git.err_git_missing');
const GIT_RMS_PIN_REASON=t('git.rms_pin_reason');
// FR-GIT-211: 트리의 들여쓰기 단위. 탐색기 트리가 행 padding 을 이 값으로 세운다.
// Git 트리는 padding 과 깊이 세로선을 CSS 토큰(`--git-tree-pad0`·`--git-indent`)
// 하나에서 계산한다 (FR-OPT-1-12) — 두 곳에 적으면 한쪽만 고쳐져 선이 글자와
// 어긋난다. 들여쓰기 단위(12)는 두 트리가 같다.
const GIT_TREE_INDENT=12;
const GIT_TREE_PAD0=6;
const GIT_ST_CLASS={M:'mod',A:'add',D:'del',R:'ren',C:'cpy','?':'new',U:'conf'};
//
// porcelain v2 `sub` 필드(`S<c><m><u>`)의 자리값. 파싱은 `gitSubParts` 한 곳이
// 하고(FR-SDN-2), 그 함수가 읽는 글자를 여기서 정한다 — 값을 함수 안에 박으면
// 형식이 어디서 왔는지 알 수 없게 된다.
const GIT_SUB_IS_SUB='S';
const GIT_SUB_COMMIT='C';
const GIT_SUB_MODIFIED='M';
const GIT_SUB_UNTRACKED='U';
// GIT_ACTIONS_SRS · DRIFT_RECLAIM_SRS FR-DRC-13: 쓰기 실패 사유의 표. 사이드바 핀 행의 title 과
// 편집기의 부분 스테이징도 이 표를 지난다.
const GIT_WRITE_ERR={
  bad_request:t('git.write_err.bad_request'),
  confirmation_required:t('git.write_err.confirmation_required'),
  not_a_git_repo:GIT_ERR_NOT_REPO,
  // FR-RMS-17: 사이드바 핀 행의 title 도 이 표를 지난다 — 사유 코드를 날것으로
  // 보이면 사용자는 그것이 무엇인지 모른다.
  repo_missing:GIT_RMS_PIN_REASON,
  git_missing:GIT_ERR_GIT_MISSING,
  git_timeout:t('git.write_err.git_timeout'),
  git_failed:t('git.write_err.git_failed'),
  git_unavailable:t('git.write_err.git_unavailable'),
  // 잡의 거부 (FR-GIT-101). 라벨을 한 자리에 둔다.
  job_busy:t('git.write_err.job_busy'),
  job_not_found:t('git.write_err.job_not_found'),
  // REPO_FIX 01 §7.1: 쓰기 배타·lock·stash·충돌 해결·종료.
  repo_busy:t('git.write_err.repo_busy'),
  index_locked:t('git.write_err.index_locked'),
  stash_moved:t('git.write_err.stash_moved'),
  branch_exists:t('git.write_err.branch_exists'),
  resolve_partial:t('git.write_err.resolve_partial'),
  server_shutdown:t('git.write_err.server_shutdown'),
  no_remote:t('git.write_err.no_remote'),
};
// 워킹 트리의 파일과 구분되지 않으면 사용자는 그 자리의 편집이 저장소에 반영된다고
// 오해한다 — 탭 이름이 그것을 말한다.
const GIT_HEAD_TAB_SUFFIX=' (HEAD)';
// 부분 스테이징의 방향 (GIT_ACTIONS_SRS §3.7, FR-GIT-278·279).
const GIT_PATCH_STAGE='stage';
const GIT_PATCH_UNSTAGE='unstage';
const GIT_PATCH_REVERT='revert';
