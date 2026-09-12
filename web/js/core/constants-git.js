/**
 * Dongminal — git 창의 **골격** 상수 (FE_MODULE_BOUNDARY_SRS FR-FMB-1).
 *
 * 창 하나 · 고정 탭 여덟 · 뷰 필드 · 진입점, 그리고 좌측 GIT 섹션
 * (GIT_SRS §3.2 / FR-GIT-9~17). 어느 탭에도
 * 속하지 않고 **탭이라는 것 자체를 세우는** 것들이 여기 산다.
 *
 * `constants.js` **뒤**, `constants-editor.js` **앞**에 로드된다 — 그쪽의
 * `ED_DD_AXIS` 가 `constants-git-diff.js` 의 `GIT_AXIS` 를 참조한다.
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

// Git 창 내부의 고정 탭. 생성·삭제되지 않는다 (FR-GIT-28).
// pending 인 탭은 M1 에서 자리만 있고 "준비 중" 을 표시한다.
const GIT_VIEWS=[
  {key:'changes',  name:'Changes'},
  // `diff` 의 뷰 객체는 `_diffView` 이지만 `field` 를 두지 않는다 — Monaco 를 들고
  // 있어 언마운트가 아니라 `destroy()` 를 지나야 풀린다 (FR-GIT-56). 같은 목록에
  // 넣으면 그 차이가 지워진다.
  {key:'diff',     name:'Diff'},
  {key:'history',  name:'History',   field:'_historyView'},
  {key:'branches', name:'Branches',  field:'_branchesView'},
  {key:'stash',    name:'Stash',     field:'_stashView'},
  {key:'console',  name:'Console',   field:'_consoleView'},
  // FR-GIT-28 (개정): 고정 탭이 7개가 된다. 요청이 "관리 **탭**" 이었으므로 기존 탭
  // 안에 밀어 넣지 않는다 — 그러면 Branches 탭이 두 가지 일을 한다.
  {key:'worktrees', name:'Worktrees', field:'_worktreesView'},
  // UX_BATCH5_SRS FR-SUB-6: 고정 탭이 8개가 된다. Worktrees 바로 뒤인 이유는 둘이
  // 같은 성질이기 때문이다 — 저장소 안에 있으나 **자기 .git 을 가진 것**들이고,
  // 둘 다 `openGitWindow` 로 열린다 (D-10).
  {key:'submodules', name:'Submodules', field:'_submodulesView'},
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
// REPO_TAB_UNIFY_SRS FR-RTU-21 / D-RTU-5: Changes 사이드 머리의 진입점.
//
// **Changes 는 여기 없다** — 그것은 사이드 자신이고(FR-RTU-32), 나머지 여섯만
// 본문 탭으로 열린다. 아이콘인 이유는 사이드가 좁기 때문이고, 무엇인지는 툴팁이
// 말한다. 순서는 `GIT_VIEWS` 를 따른다 — 두 자리가 다른 순서를 말하지 않는다.
//
// **`Diff` 도 여기 없다** (FR-RTU-21 개정). 다른 여섯과 성질이 다르기 때문이다:
// 나머지는 이 줄이 유일한 진입점이지만 Diff 는 **변경 목록의 파일을 누르면 이미
// 열리고**(panel-changes 의 행 클릭), 커밋 축도 `showCommitDiff` 가 스스로 연다.
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
  {key:'history',  icon:'clock',      title:'History'},
  {key:'branches', icon:'git-branch', title:'Branches'},
  {key:'stash',    icon:'archive',    title:'Stash'},
  {key:'console',  icon:'terminal',   title:'Console'},
  {key:'worktrees',icon:'columns',    title:'Worktrees'},
  {key:'submodules',icon:'box',       title:'Submodules'},
];

// REPO_TAB_UNIFY_SRS FR-RTU-25·26: 저장소가 아닌 자리와 거기서 만드는 길.
//
// **사실만 말하고 끝내지 않는다.** "저장소가 아닙니다" 는 사용자가 이미 아는
// 것이고, 알고 싶은 것은 여기서 무엇을 할 수 있는가다.
const GIT_INIT_ACTION='repo_init';
const GIT_INIT_NOT_REPO='이 폴더는 git 저장소가 아닙니다.';
const GIT_INIT_RUN='git init';
const GIT_INIT_CONFIRM='이 폴더를 git 저장소로 만듭니다';
const GIT_INIT_HINT='되돌리려면 그 폴더의 .git 을 지우면 됩니다. 저장소가 되면 Repo 목록에도 함께 섭니다.';
const GIT_INIT_FAIL='저장소를 만들지 못했습니다';

const GIT_PENDING_HINT='이후 마일스톤에서 제공됩니다';
const GIT_NO_REPO_HINT='리포를 선택하세요';

// GIT 섹션 목록 갱신 주기(ms). 배지는 서버의 마지막 관측값이다. Git 탭이 활성일
// 때만 이 호출이 `observe=1` 을 실어 핀 전부를 관측한다 (FR-GOB-8·10) — 그
// 밖에서는 캐시만 읽으므로 git 을 실행하지 않는다 (FR-GIT-24).
const GIT_REPOS_POLL_MS=3000;

// 배지를 "낡음" 으로 볼 관측 나이. Git 탭 안에서는 매 주기 관측이 도므로 이 값을
// 넘지 않는다 — 넘었다면 관측이 실제로 멎은 것이다 (FR-GOB-14). 주기에서
// 파생시키는 이유는 둘이 같은 사실의 앞뒤이기 때문이다.
//
// POLL_INTERVAL_SETTINGS_SRS FR-PIS-12 / D-7: 주기가 설정이 되면서 **계수만**
// 남는다. ms 로 굳혀 두면 주기를 바꿔도 이 기준만 옛 값에 남는다. 곱셈은
// `gitBadgeStaleMs()` 가 한다.
const GIT_BADGE_STALE_FACTOR=4;

// FR-GIT-12 · FR-FLW-5~10: 리포 추가. follow 행이 하던 일(핀하지 않은 리포로 가는
// 한 번의 클릭)을 이 다이얼로그가 대신하므로 **지금 터미널의 리포가 미리 채워진다.**
// FR-FLW-11: 핀이 하나도 없을 때. follow 행이 늘 한 줄을 채우고 있었으므로 이
// 섹션은 빈 적이 없었다 — 이제는 있고, 빈 자리는 고장처럼 보인다.
const GIT_REPOS_NONE='+ Add 로 리포를 추가하세요';
const GIT_ADD_REPO_TITLE='리포 추가';
const GIT_ADD_REPO_RUN='추가';
const GIT_ADD_REPO_PROMPT='리포 경로 (절대경로)';
const GIT_ADD_REPO_HERE='지금 터미널: %s';
const GIT_ADD_REPO_NO_TERM='지금 터미널은 저장소가 아닙니다 (%s) — 경로를 직접 넣으세요';
// FR-ETR-34: 위와 다른 경우다. 저쪽은 "터미널은 있는데 저장소가 아니다" 이고
// 이쪽은 "딛을 터미널이 없다" 이므로 사용자가 할 일이 다르다.
const GIT_ADD_REPO_NO_TOOL='지금 터미널의 경로를 얻지 못했습니다 — 경로를 직접 넣으세요';
// FR-ETR-31~33: `/api/cwd` 와 `/api/git/repo-at` 이 함께 쓰는 어휘. 서버의 상수와
// 짝이며(gitCwdSourceTool), 문자열을 여러 곳에 흩뿌리면 한쪽만 바뀐다.
const GIT_CWD_SOURCE_TOOL='tool';
const GIT_ADD_REPO_NEED_PATH='경로가 필요합니다';
const GIT_ADD_REPO_DUP='이미 목록에 있습니다';
const GIT_ADD_REPO_FAIL='리포를 추가하지 못했습니다';
const GIT_PIN_FAIL_LABEL='리포 추가 실패';
