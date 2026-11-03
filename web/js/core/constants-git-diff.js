/**
 * Dongminal — **Diff 탭과 Console 탭**의 상수 (FE_MODULE_BOUNDARY_SRS FR-FMB-1).
 *
 * 축·편집기 설정·hunk 표면, 그리고 명령 기록. 둘이 한 파일인 이유는 Console 이
 * 열 줄 남짓이고 **둘 다 "방금 무슨 일이 있었나" 를 보여주는 표면**이기 때문이다.
 *
 * 절과 그 앵커: Diff(GIT_SRS §3.6 / FR-GIT-43~56) · Console(GIT_UI_REVISION_SRS
 * FR-GIT-218).
 */
// CODEMIRROR_MIGRATION_SRS FR-CMR-57: Diff ruler 의 두 칸 색 — 지운 것(왼쪽)·더한 것(오른쪽).
const GIT_DIFF_RULER_DEL='--diff-del';
const GIT_DIFF_RULER_ADD='--diff-add';
// FR-CMR-52: 변경 없는 구간을 접을 때 남기는 줄 수와 접는 최소 줄 수 (옛 엔진 hideUnchangedRegions 의 기본과 같다).
const GIT_DIFF_COLLAPSE={margin:3,minSize:4};

// FR-CMR-50·51: Diff 칸의 폭이 이 값 이상이면 나란히 보기, 미만이면 인라인 보기다.
const GIT_DIFF_INLINE_BREAKPOINT=900;
// FR-DOR-6: 눈금의 색은 `GIT_DIFF_RULER_ADD`·`_DEL` 이 가리키는 테마 변수다 (`--diff-add`·`--diff-del`).
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
/**
 * M9_SRS FR-M9-20·21 — **그림으로 볼 수 있는 diff.**
 *
 * 서버가 `imageMime` 을 채우면 그 diff 는 그림으로 볼 수 있다. 판정은 서버의
 * 내용 판정 하나이며(D-M9-13 · `mimeprobe`) 여기서 확장자를 다시 보지 않는다 —
 * 두 판정이 갈리면 화면과 종단이 서로 다른 답을 준다.
 *
 * 바이트는 `diff-content` 에 실려 오지 않는다 (D-M9-14). `<img src>` 가 이
 * 종단을 그대로 걸고, 브라우저의 이미지 캐시와 조건부 요청이 그 위에서 공짜로
 * 돈다.
 */
const GIT_BLOB_API=GIT_API.blob;
const GIT_IMG_SIDE_ORIGINAL='original';
const GIT_IMG_SIDE_MODIFIED='modified';
// D-M9-12: 나란히가 기본이고 겹쳐 보기는 전환이다. 좌우는 "이게 무엇인가" 에,
// 겹쳐 보기는 "어디가 달라졌는가" 에 답한다 — 물음이 둘이라 하나를 고를 수 없다.
const GIT_IMG_MODE_SIDE='side';
const GIT_IMG_MODE_OVER='over';
const GIT_IMG_MODE_LABEL={side:t('git.img_mode_side'),over:t('git.img_mode_over')};
const GIT_IMG_SIDE_LABEL={original:t('git.img_before'),modified:t('git.img_after')};
const GIT_IMG_ABSENT=t('git.img_absent');
const GIT_IMG_FAIL=t('git.img_fail');
// SVG 는 이미지이면서 문서다 — 텍스트 diff 와 그림 보기를 둘 다 갖는다 (D-M9-12).
const GIT_IMG_AS_TEXT=t('git.img_as_text');
const GIT_IMG_AS_IMAGE=t('git.img_as_image');
// 보기 모드와 공백무시는 기기별 취향이다 (§3.3).
const GIT_DIFF_SIDE_KEY='gitDiffSideBySide';
const GIT_DIFF_WS_KEY='gitDiffIgnoreWs';
// EDITOR_GIT_UX_SRS FR-DOR-3·4: 변경 없는 구간의 접기. 기본은 **꺼짐**이다
// (FR-DOR-2) — 접으면 개요 눈금의 위치가 실제 파일의 줄 위치와 어긋난다.
const GIT_DIFF_FOLD_KEY='gitDiffHideUnchanged';
const GIT_DIFF_FOLD_LABEL=t('git.act.diff_fold_label');
const GIT_DIFF_MODE_LABEL={side:'side-by-side',inline:'unified'};
// FR-TIP-1: 라벨이 지금 **무엇인지**를 말하므로, 누르면 무엇이 되는지는 툴팁이
// 말한다 — 라벨만으로는 그것이 상태인지 동작인지 알 수 없다.
const GIT_DIFF_MODE_TITLE='Switch between side-by-side and unified diff';
// 파일 사이를 오가는 화살표. `\u2039`·`\u203a` 만으로는 무엇의 이전·다음인지
// 보이지 않는다.
const GIT_DIFF_NAV_TITLE={prev:'Previous changed file',next:'Next changed file'};
const GIT_DIFF_WS_LABEL=t('git.act.diff_ws_label');
// FR-GIT-55: 편집기 로드 실패는 Git 창의 나머지를 멈추지 않는다 — diff 자리에만
// 사유를 보인다.
//
// **네트워크를 말하지 않는다** (FR-MVN-3). 편집기는 이제
// 바이너리 안에서 오므로 이 실패에 네트워크가 끼어들 자리가 없다 — 종전 문구는
// 사용자를 없는 원인으로 보냈다. 새로고침이 실제로 듣는 유일한 조치다.
const GIT_DIFF_EDITOR_FAIL=t('git.diff_editor_fail');
const GIT_DIFF_LOAD_FAIL=t('git.diff_load_fail');
// 커밋·discard 로 대상이 목록에서 사라진 경우 (§3.3). 아무 파일이나 임의로
// 보이지 않고 사실만 알린다.
const GIT_DIFF_GONE_NOTE=t('git.diff_gone_note');
// FR-GIT-46·47·48: 본문을 못 주는 쪽은 안내만으로 끝나지 않는다 — 서버가 실은
// 메타(oid·크기)를 안내 아래 줄로 보인다. 서버가 준 값만 쓴다.
const GIT_META_SIZED=new Set(['binary','too_large']);
const GIT_LFS_KIND='lfs';
// oid 는 sha256 64자다. 그대로 두면 안내 줄을 넘기므로 앞자리만 보인다 —
// git 이 해시를 축약해 보이는 것과 같은 관례다.
const GIT_LFS_OID_PREFIX='sha256:';
const GIT_LFS_OID_ABBREV=12;
// REPO_FIX 01 §7.6: gitlink 쪽은 가리키는 커밋 oid 를 메타로 보인다.
const GIT_SUBMODULE_KIND='submodule';
const GIT_COMMIT_ABBREV=10;
const GIT_META_SEP=' · ';
// 양쪽 메타가 다를 때만 쪽을 밝힌다. diff 에디터의 좌·우가 곧 이전·이후다.
const GIT_META_SIDE={orig:t('git.meta_side.orig'),mod:t('git.meta_side.mod')};
const GIT_META_LABEL_SEP=': ';
const GIT_DIFF_ERR={
  bad_request:t('git.diff_err.bad_request'),
  not_found:t('git.diff_err.not_found'),
  not_a_git_repo:GIT_ERR_NOT_REPO,
  git_missing:GIT_ERR_GIT_MISSING,
};

// Console 은 터미널이 아니다. dongminal 이 사용자를 대신해 실행한 git 명령의
// 기록이며, 그 명령들은 서버 프로세스 안에서 돌아 사용자의 터미널에는 남지 않는다.
//
// 폴링(FR-GIT-18~24)은 1초에 한 번 기록되므로 거르지 않으면 목록이 그것으로만
// 찬다. 기본은 쓰기와 실패만 보이고, 토글이 읽기까지 연다.
const GIT_CON_READS_LABEL=t('git.act.con_reads_label');
const GIT_CON_REFRESH='Refresh';
// FR-TIP-1: 무엇을 다시 받는지가 라벨에 없다 — 머리의 `⟳` 와 대상이 다르다.
const GIT_CON_REFRESH_TITLE='Reload the list of git commands this app has run';
const GIT_CON_EMPTY=t('git.con_empty');
const GIT_CON_EMPTY_READS=t('git.con_empty_reads');
const GIT_CON_FAIL=t('git.con_fail');
const GIT_CON_DESTRUCTIVE=t('git.con_destructive');
const GIT_CON_CWD='cwd';
// 읽기까지 열었을 때만 큰 목록이 된다. 그 전에는 쓰기만 남아 훨씬 짧다.
const GIT_CON_LIMIT=500;
// 쓰기가 끝나면 곧바로 다시 읽는다 — 방금 한 일이 이력의 맨 위에 있어야 한다.
// 그 밖에는 탭이 활성일 때만 받는다 (History·Branches·Stash 와 같은 규약).
// 주기의 기본값 `GIT_CON_POLL_MS` 와 설정 변수 `gitConsoleInterval` 은
// settings-defaults.js 에 있다 (FR-PIS-6·11 · FR-OPT-11-4).
