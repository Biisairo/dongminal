/**
 * Dongminal — **History 탭**의 상수 (FE_MODULE_BOUNDARY_SRS FR-FMB-1).
 *
 * 가상 목록·레인·refs 바·커밋 상세, 그리고 컨텍스트 메뉴 프레임워크. 메뉴가
 * 여기 있는 이유는 History 가 그것을 세운 첫 자리이고 Branches·Stash 가 그
 * 골격을 이어 쓰기 때문이다 (FR-GIT-146).
 *
 * 절과 그 앵커: History(GIT_SRS §3C / FR-GIT-113~134) · 커밋 상세(§3C.2 /
 * FR-GIT-135~145) · 컨텍스트 메뉴 프레임워크(§3C.2 / FR-GIT-146).
 */
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
// FR-TIP-1: `Apply`·`Go` 만으로는 무엇에 적용하고 어디로 가는지 보이지 않는다.
const GIT_HIST_APPLY_TITLE='Apply these filters to the history list';
// HISTORY_BRANCH_BUTTON_SRS FR-HBB-3: 같은 바의 라벨은 같은 자리에 모인다.
const GIT_HIST_BRANCH='+ Branch';
const GIT_HIST_BRANCH_TITLE='Create a branch at the current HEAD (right-click a commit to branch from it instead)';

// reflog 포함 (FR-GIT-280). 어떤 ref 도 가리키지 않게 된 커밋 — reset 으로 되돌린
// 것, 지운 브랜치의 끝 — 은 이 토글로만 목록에 들어온다.
const GIT_HIST_REFLOG='reflog';
const GIT_HIST_REFLOG_TITLE='어떤 ref 도 가리키지 않는 커밋을 reflog 에서 찾아 함께 보인다';

/**
 * 검색 (PANEL_SURFACE_SRS §3.4 / 요구 ⑨).
 *
 *   이전 동작: 입력이 **둘**이었다 — 왼쪽은 모드 버튼을 가진 검색(로드 범위 ↔
 *              저장소 전체), 오른쪽은 리비전 이동(`Go`)
 *   새  동작: 입력 **하나**다. 치는 동안 불러온 것을 즉시 거르고(FR-HSU-3), 손이
 *             멎으면 저장소 전체로 자동 확장한다(FR-HSU-4). 실재하는 리비전이면
 *             결과 위에 그 줄이 뜬다 (FR-HSU-6)
 *   이유:     "찾는다" 는 하나의 일이다 (D-5·D-6) — 범위를 고르는 것은 사용자의
 *             일이 아니고, `Go` 가 하던 일은 결과의 한 줄로 옮길 수 있다
 */
const GIT_SEARCH_PLACEHOLDER='검색 — 메시지 · 작성자 · 해시 · ref';
// FR-HSU-14: 손이 멎은 뒤 한 번이다. 글자마다 저장소 전체를 훑지 않는다.
const GIT_SEARCH_DEBOUNCE_MS=400;
// FR-HSU-8: 지금 보고 있는 범위. 사용자가 "없다" 와 "아직 안 받았다" 를 가른다.
const GIT_SEARCH_SCOPE_LOADED='로드된 %n개 중 %m개';
const GIT_SEARCH_SCOPE_REPO='저장소 전체에서 %m개';
const GIT_SEARCH_SCOPE_WIDENING='저장소 전체로 넓히는 중…';
// FR-HSU-6: 입력이 실재하는 리비전일 때 결과 위에 서는 줄.
const GIT_SEARCH_REV_MARK='이 리비전';
const GIT_SEARCH_REV_TITLE='Jump to this commit in the history list';
// FR-HSU-9·10: 정렬·필터·reflog 를 담는 드롭다운.
const GIT_HIST_OPTS='옵션';
const GIT_HIST_OPTS_TITLE='Sorting, filters and reflog';
const GIT_HIST_OPTS_ORDER='정렬';

// jump (FR-GIT-131). 상한을 넘으면 찾지 못했다고 알린다 — 무한히 받아 오지 않는다.
const GIT_JUMP_MAX_PAGES=20;
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
// GIT_DETECT_TIER_SRS FR-GDT-21 (`11 GP-17`): **빈 저장소는 실패가 아니다.**
// 필터에 걸리는 것이 없는 것(`GIT_HIST_EMPTY`)과도 다른 사실이다 — 뭉개면
// 사용자는 필터를 지워 보고 나서야 저장소가 비었음을 안다.
const GIT_HIST_NO_COMMITS='커밋이 아직 없습니다';
const GIT_HIST_LOADING='불러오는 중…';
const GIT_HIST_END='마지막입니다';
const GIT_HIST_LOADED_N='%n개 로드';
// FR-GIT-120: 상한을 넘어 접힌 행. 표식 없이 접으면 그래프가 조용히 틀려 보인다.
const GIT_HIST_COMPRESSED='레인 상한을 넘어 압축됐습니다';

// DRIFT_RECLAIM_SRS FR-DRC-14: 목록 높이가 서기를 기다리는 프레임 상한.
//
// 보통 한두 프레임이면 선다 — 탭이 보이게 되고 레이아웃이 한 번 도는 것이 전부다.
// 60 은 넉넉한 상한(≈1초)이며, 이 값이 하는 일은 **높이가 영영 오지 않는 화면**
// (접혀서 0px 인 칸)에서 사슬이 끝나게 하는 것뿐이다.
const GIT_HIST_LAYOUT_FRAMES=60;

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

// FR-GIT-144: detached 가 됨을 사전 경고한다. 파괴적이 아니므로 1단계 확인이다 —
// dirty 면 그 뒤에 묶음 N 의 3선택이 이어진다 (FR-GIT-157, O14).
const GIT_CHECKOUT_DETACHED_ACT='checkout_detached';
const GIT_CHECKOUT_DETACHED_TITLE='HEAD 가 브랜치를 떠납니다 (detached)';
