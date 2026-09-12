/**
 * Dongminal — **Diff 탭과 Console 탭**의 상수 (FE_MODULE_BOUNDARY_SRS FR-FMB-1).
 *
 * 축·Monaco 옵션·hunk 표면, 그리고 명령 기록. 둘이 한 파일인 이유는 Console 이
 * 열 줄 남짓이고 **둘 다 "방금 무슨 일이 있었나" 를 보여주는 표면**이기 때문이다.
 *
 * 절과 그 앵커: Diff(GIT_SRS §3.6 / FR-GIT-43~56) · Console(GIT_UI_REVISION_SRS
 * FR-GIT-218).
 */
// DiffEditor 옵션. ignoreTrimWhitespace 는 Monaco 기본값(true)을 뒤집는다 —
// git 은 공백 변경을 변경으로 취급하기 때문이다 (FR-GIT-50).
const GIT_DIFF_OPTIONS={
  renderSideBySide:true,
  useInlineViewWhenSpaceIsLimited:true,
  renderSideBySideInlineBreakpoint:900,
  // FR-DOR-2: 기본은 접지 않는다. 접힌 문서의 눈금은 접힌 좌표계 위에 서므로
  // 실제 파일의 줄 위치와 어긋난다 — 사용자가 요구한 "실제 파일에 동기화"가
  // 그것이다. 필요하면 머리의 토글로 켠다 (FR-DOR-3).
  hideUnchangedRegions:{enabled:false},
  ignoreTrimWhitespace:false,
  readOnly:true,
  originalEditable:false,
  automaticLayout:true,
  scrollBeyondLastLine:false,
  // FR-DOR-1: 문서 전체를 스크롤바 높이에 사상해 변경 위치를 색으로 찍는다.
  // 직접 그리지 않는 이유는 D-1 이다 — 접기·줄바꿈·side-by-side 의 좌표계를
  // 다시 계산하는 일을 Monaco 가 이미 한다.
  renderOverviewRuler:true,
  // UX_BATCH8_SRS FR-MMP-2: 미리보기도 **같은 좌표계**에 선다. 기본값
  // `'proportional'` 은 파일이 길면 미리보기 자신이 함께 스크롤해, 미리보기의
  // 슬라이더가 스크롤바·개요 눈금과 다른 자리에 선다 — 세 표시가 한 문서의 같은
  // 자리를 가리켜야 한다는 것이 FR-DOR-1 의 뜻이기도 하다.
  //
  // `'fit'` 이 아니라 `'fill'` 인 것은 그것이 **줄이기만 하기** 때문이다 — diff 는
  // 짧은 것이 흔하고(한 파일의 몇 줄), 그때 `'fit'` 은 아무것도 하지 않아 세
  // 표시가 다시 갈라진다. 편집기와 같은 근거다 (`file-editor.js`).
  minimap:{size:'fill'},
};
// FR-DOR-6: 눈금의 색은 `monacoTheme()` 의 diffEditorOverview.* 매핑에서 온다.
// 그 매핑은 이미 있다 — 여기서 색을 다시 정하면 두 자리가 갈린다.
// Changes 탭의 미리보기는 좁다. 접기와 inline 전환을 더 이르게 건다.
const GIT_PREVIEW_INLINE_BREAKPOINT=560;

// EDITOR_GIT_UX_SRS 묶음 D — Changes 탭 두 칸의 경계.
//
// EDITOR_GIT_UX_SRS 묶음 D(FR-CSZ-1~8)의 상수 여섯이 여기 있었다 —
// `GIT_FILES_W_KEY`·`GIT_FILES_H_KEY`·`GIT_FILES_SIZE_DEFAULT`·`_MIN`·`_MAX`.
// REPO_TAB_UNIFY_SRS FR-RTU-20 이 Changes 사이드의 두 칸을 하나로 만들면서
// 폐기됐다 (§7 D-RTU-22).
// 서버의 DiffSide.kind (FR-GIT-45~48). text 와 absent 만 본문을 그린다 —
// absent 는 빈 내용으로 다뤄야 추가·삭제 파일의 diff 가 성립한다.
const GIT_DIFF_DRAWABLE=new Set(['text','absent']);
// 보기 모드와 공백무시는 기기별 취향이다 (§3.3).
const GIT_DIFF_SIDE_KEY='gitDiffSideBySide';
const GIT_DIFF_WS_KEY='gitDiffIgnoreWs';
// EDITOR_GIT_UX_SRS FR-DOR-3·4: 변경 없는 구간의 접기. 기본은 **꺼짐**이다
// (FR-DOR-2) — 접으면 개요 눈금의 위치가 실제 파일의 줄 위치와 어긋난다.
const GIT_DIFF_FOLD_KEY='gitDiffHideUnchanged';
const GIT_DIFF_FOLD_LABEL='Fold Unchanged';
const GIT_DIFF_MODE_LABEL={side:'side-by-side',inline:'unified'};
// FR-TIP-1: 라벨이 지금 **무엇인지**를 말하므로, 누르면 무엇이 되는지는 툴팁이
// 말한다 — 라벨만으로는 그것이 상태인지 동작인지 알 수 없다.
const GIT_DIFF_MODE_TITLE='Switch between side-by-side and unified diff';
// 파일 사이를 오가는 화살표. `\u2039`·`\u203a` 만으로는 무엇의 이전·다음인지
// 보이지 않는다.
const GIT_DIFF_NAV_TITLE={prev:'Previous changed file',next:'Next changed file'};
const GIT_DIFF_WS_LABEL='Ignore Whitespace';
// FR-GIT-55: Monaco 로드 실패는 Git 창의 나머지를 멈추지 않는다 — diff 자리에만
// 사유를 보인다.
//
// **네트워크를 말하지 않는다** (MONACO_VENDORING_SRS FR-MVN-3). 편집기는 이제
// 바이너리 안에서 오므로 이 실패에 네트워크가 끼어들 자리가 없다 — 종전 문구는
// 사용자를 없는 원인으로 보냈다. 새로고침이 실제로 듣는 유일한 조치다.
const GIT_DIFF_MONACO_FAIL='에디터를 불러오지 못했습니다 — 새로고침해 보세요';
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

// Console 은 터미널이 아니다. dongminal 이 사용자를 대신해 실행한 git 명령의
// 기록이며, 그 명령들은 서버 프로세스 안에서 돌아 사용자의 터미널에는 남지 않는다.
//
// 폴링(FR-GIT-18~24)은 1초에 한 번 기록되므로 거르지 않으면 목록이 그것으로만
// 찬다. 기본은 쓰기와 실패만 보이고, 토글이 읽기까지 연다.
const GIT_CON_READS_LABEL='Show Reads';
const GIT_CON_REFRESH='Refresh';
// FR-TIP-1: 무엇을 다시 받는지가 라벨에 없다 — 머리의 `⟳` 와 대상이 다르다.
const GIT_CON_REFRESH_TITLE='Reload the list of git commands this app has run';
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
// FR-PIS-6·11: 콘솔 주기도 설정이 든다. 자리가 여기인 이유는 위 주석과 같다.
var gitConsoleInterval=GIT_CON_POLL_MS;
