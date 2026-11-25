/**
 * Remote Terminal — 탐색기·Repo 창·미리보기 탭·파일 조작·변경 표시 상수 (REFACTOR3_FE_REST5_SRS FR-FR5-20).
 *
 * `constants-editor.js` 의 뒤쪽 절들을 원래 순서 그대로 옮겼다 — 값과 이름은 그대로다. `editor` 묶음의 **맨 앞**에
 * 로드된다(PERF 3.4.7, D-32). 부팅 코드가 읽는 것은 `constants-editor.js` 끝으로 옮겼다 — 이 파일은 묶음이 실리기
 * 전에는 없다.
 */
// ── Editor 탐색기 (EDITOR_TAB_SRS 묶음 X · FR-EDT-57~78) ──

// 겹 스탬프(FR-FSL-5)·파일 표식(FR-ELR-6)·감시 등록(FR-ELR-51)의 상한은 서버가 보낸다
// (`serverMeta`, K-c). 서버가 넘긴 요청을 통째로 거절하므로 화면이 먼저 자른다.

// 트리 행의 들여쓰기는 Git 패널의 트리와 같은 값을 딛는다 (GIT_TREE_PAD0·
// GIT_TREE_INDENT) — 같은 앱 안의 두 트리가 다른 리듬으로 들여쓸 이유가 없다.

// 펼침 표시. 조회 중(`BUSY`)을 따로 두는 이유는 "비었다" 와 "아직 오지 않았다" 가
// 같은 화면이 되면 사용자가 지연을 고장으로 읽기 때문이다.
// UX_AUDIT_FIX_SRS FR-UXF-100 (D-36): 열림·닫힘은 `UIKit.caret` 의 아이콘이다(이전 `▾`·`▸` 글자). 열림은 `data-open` 이 말한다.
const EDITOR_TREE_TW_BUSY='·';
// FR-EDT-60: 링크는 펼치지도 열지도 않는다. 표시가 그 사실과 대상 종류를 알린다.
// FR-UXF-100: 아이콘 `link`(이전 `↗`). 폴더 링크는 뒤에 `/` 글자가 붙는다.
const EDITOR_TREE_LINK='link';
const EDITOR_TREE_LINK_DIR_SUFFIX='/';
// FR-EDT-64: 펼쳐져 있는 폴더만 다시 읽는다.
// FR-UXF-100: 머리 단추 셋은 스프라이트 아이콘이다 — 이전에는 16×16·1.3px 선으로 따로 그린 SVG 였다.
const EDITOR_TREE_REFRESH='refresh-cw';
const EDITOR_TREE_REFRESH_TITLE='Refresh the tree (re-reads expanded folders only)';
// FR-EDT-65: 상한을 넘긴 폴더. **조회는 실패하지 않는다** — 잘렸다는 사실만 알린다.
/**
 * FS_LIST_PAGING_SRS FR-FSP-11: 잘림 행은 **사실 둘**을 함께 말한다 — 보이는
 * 수와 전체 수. 종전에는 "%s개 이상 — 잘림" 이었고, 그것은 사용자가 이미 짐작한
 * 것이다. 알고 싶은 것은 **나머지를 어떻게 보는가**이며 이제 그 길이 있다.
 */
const EDITOR_TREE_TRUNCATED=t('editor.tree_truncated');
const EDITOR_TREE_MORE_BUSY=t('editor.tree_more_busy');
const EDITOR_TREE_MORE_FAIL=t('editor.tree_more_fail');
// FR-EDT-63: 조회 실패는 그 폴더 행에만 남고 트리를 깨뜨리지 않는다.
const EDITOR_TREE_ERR=t('editor.tree_err');

// FR-EDT-74 / D-5: 폴더 색의 우선순위. 삭제(D)가 표에 **없는 것이 규칙이다** —
// 지워진 파일은 애초에 탐색기에 없으므로 그 상태가 폴더 색을 정할 근거가 없다.
const EDITOR_TREE_ST_RANK={U:4,A:3,'?':3,M:2,R:1,C:1};

// ── 탐색기의 파일 조작 (EDITOR_TAB_SRS 묶음 F · FR-EDT-79~93) ──

// FR-EDT-109 의 조작 종단 셋. **이름 변경과 이동은 같은 연산**이라 종단이 하나다 —
// 둘을 가르면 "옮기면서 이름도 바꾸는" 경로가 어느 쪽에도 속하지 않는다.
const FS_CREATE_API='/api/fs/create';
const FS_RENAME_API='/api/fs/rename';
const FS_DELETE_API='/api/fs/delete';
// 그 답의 동작 ID (서버 `action.FS*` 와 같은 값).
const FS_ACTION_RENAME='fs.rename';
const FS_ACTION_MOVE='fs.move';
const FS_ACTION_COPY='fs.copy';
const FS_ACTION_DELETE='fs.delete';
// F-i·F-k: 만들기·이름 바꾸기의 이름 판정. 인라인 입력은 입력이 멈춘 뒤 묻는다.
const FS_VALIDATE_NAME_API='/api/fs/validate-name';
const FS_ACTION_NAME='fs.name';
const FS_NAME_ASK_DEBOUNCE_MS=200;
// FR-WBR-60: 복사·복제가 함께 쓰는 하나의 종단. 복제는 "원본의 형제 자리에
// 붙여넣기" 이므로 종단을 나눌 이유가 없다.
const FS_COPY_API='/api/fs/copy';
// FILE_TRANSFER_SRS FR-FTR-12·15 — 조회·조작과 같은 root 가드를 받는 전송 둘.
const FS_DOWNLOAD_API='/api/fs/download';
const FS_UPLOAD_API='/api/fs/upload';
// EXPLORER_TRANSFER_IGNORE_SRS FR-ETR-9 — 폴더는 zip 으로 온다 (D-4).
const FS_DOWNLOAD_DIR_API='/api/fs/download-dir';
// UX_BATCH12 FR-EXD-3·7 — 여러 경로를 zip 하나로 받는다.
const FS_DOWNLOAD_MANY_API='/api/fs/download-many';
// UX_BATCH12 FR-EXM-1 — 사각형 선택: 끌기로 보는 최소 거리, 자동 스크롤이 도는 끝 폭과 프레임당 양.
const EDITOR_MARQUEE_MIN_PX=4;
const EDITOR_MARQUEE_EDGE_PX=24;
const EDITOR_MARQUEE_SCROLL_PX=12;
// FR-ETR-1 — 한 겹에서 무시된 이름을 가른다. status 폴링과 별개다 (D-1).
const FS_IGNORED_API='/api/fs/ignored';
// 기본 단축키는 `SHORTCUT_DEFAULTS.softReload` 에 있다 — 설정에서 바꿀 수 있는
// 다른 동작들과 같은 자리다 (FR-SRL-9).

// FR-EDT-80: 진입점은 둘이다 — 상단 버튼과 행 우클릭. 라벨은 한 자리에 둔다.
//
// **아이콘이 문자에서 그림으로 바뀌었다.** 종전에는 `⊕`(원)과 `⊞`(사각)이었고
// 그 근거는 "둘 다 플러스를 품되 모양으로 갈린다" 였다 — 그러나 실제로는 어느
// 쪽이 파일이고 어느 쪽이 폴더인지 알 수 없었다. 원과 사각은 **파일·폴더를
// 뜻하지 않는다.** 이제 문서와 폴더를 그대로 그린다.
//
// 이모지가 아니라 인라인 SVG 인 이유는 둘이다 — 이모지는 상태 기호의 기존
// 규약이 배제하고(플랫폼마다 다른 그림이 온다), SVG 는 `currentColor` 로
const EDITOR_TREE_NEW_FILE='file-plus';
const EDITOR_TREE_NEW_FILE_TITLE='New file in the selected folder';
const EDITOR_TREE_NEW_DIR='folder-plus';
const EDITOR_TREE_NEW_DIR_TITLE='New folder in the selected folder';
const EDITOR_MENU_NEW_FILE=t('editor.menu_new_file');
const EDITOR_MENU_NEW_DIR=t('editor.menu_new_dir');
const EDITOR_MENU_RENAME=t('editor.menu_rename');
// FR-WBR-70: 복사·붙여넣기·복제. 붙여넣기는 복사한 것이 없으면 비활성이고 그
// 사유를 툴팁이 말한다 (다운로드의 링크 규약과 같다).
const EDITOR_MENU_COPY=t('editor.menu_copy');
const EDITOR_MENU_PASTE=t('editor.menu_paste');
const EDITOR_MENU_DUPLICATE=t('editor.menu_duplicate');
const EDITOR_PASTE_NONE=t('editor.paste_none');
/**
 * `12-func-ui.md FUI-11`: **잘라내기.**
 *
 *   이전 동작: 붙여넣기는 루트를 건널 수 있는데(FR-WBR-61) 드래그는 트리 안에서만
 *             성립했다. 그래서 `~/proj` 의 파일을 메모장 트리로 **복사는 되고
 *             옮기기는 되지 않았고**, "잘라내기" 항목도 없었다
 *   새  동작: 클립보드가 `move` 를 함께 든다. 붙여넣기가 그때 `rename` 으로 간다
 *   이유:     복사·붙여넣기가 이미 그 길을 다 냈다 — 없던 것은 **동사 하나**였다
 */
const EDITOR_MENU_CUT=t('editor.menu_cut');
// FR-FTR-13·18 / FR-ETR-16·23: 탐색기의 전송. 다운로드는 폴더에서도 활성이며
// 그때는 zip 으로 온다 (D-4). 링크는 여전히 비활성이다 — 링크 자신을 내려받는다는
// 뜻이 정해져 있지 않다.
const EDITOR_MENU_UPLOAD=t('editor.menu_upload');
const EDITOR_MENU_UPLOAD_DIR=t('editor.menu_upload_dir');
const EDITOR_MENU_DOWNLOAD=t('editor.menu_download');
/**
 * M9_SRS FR-M9-19 / D-M9-10: 탐색기의 **경로 복사** 둘.
 *
 * `EDITOR_MENU_COPY`(파일 클립보드)와 **다른 구획**에 선다. 둘은 같은 낱말을
 * 쓰지만 담는 것이 다르다 — 저쪽은 붙여넣기가 받는 파일이고 이쪽은 텍스트다.
 * 나란히 두면 사용자는 `복사` 를 눌러 놓고 경로가 들어온 줄 안다.
 */
const EDITOR_MENU_COPY_ABS_PATH=t('editor.menu_copy_abs_path');
const EDITOR_MENU_COPY_REL_PATH=t('editor.menu_copy_rel_path');
// 성공만 말한다 — 실패는 `TermClipboard` 의 수동 복사창이 그 자리에서 말한다.
const EDITOR_PATH_COPIED=t('editor.path_copied');
const EDITOR_DOWNLOAD_LINK_NO=t('editor.download_link_no');
const EDITOR_RENAME_MANY_NO=t('editor.rename_many_no');
const EDITOR_UPLOAD_FAIL=t('editor.upload_fail');

// FR-ETR-26~30: 전송이 한 항목에서 실패했을 때의 선택. 폴더 하나가 수백 개일 수
// 있으므로 "이후 모두 건너뛰기" 가 함께 있어야 한다 — 같은 사유로 이어 실패할 때
// 묻기를 되풀이하면 그 자체가 고장이다 (D-9).
const EDITOR_UPLOAD_FAIL_TITLE=t('editor.upload_fail_title');
const EDITOR_UPLOAD_FAIL_BODY=t('editor.upload_fail_body');
const EDITOR_UPLOAD_RETRY=t('editor.upload_retry');
const EDITOR_UPLOAD_SKIP=t('editor.upload_skip');
const EDITOR_UPLOAD_SKIP_ALL=t('editor.upload_skip_all');
const EDITOR_UPLOAD_ABORT=t('editor.upload_abort');
// FR-ETR-30: 조용히 끝나면 사용자는 전부 올라간 줄 안다.
const EDITOR_UPLOAD_SKIPPED=t('editor.upload_skipped');
const EDITOR_UPLOAD_ABORTED=t('editor.upload_aborted');
// FR-FTR-23: 드래그 중 접힌 폴더가 펼쳐지기까지의 체류 시간 (D-5).
const EDITOR_SPRING_MS=600;
// `revealPath` 가 거슬러 올라갈 겹의 상한. `_parent` 는 최상위에서 `'/'` 를
// 내므로 루트가 `'/'` 인 트리에서는 스스로 멈추지 않는다 — 경로 깊이에 상한을
// 두는 편이 종료 조건을 경로 모양에 맡기는 것보다 확실하다.
const EDITOR_TREE_REVEAL_MAX=64;
const EDITOR_MENU_DELETE=t('editor.menu_delete');

// `UX-25`: 추적 중이던 파일은 git 이 갖고 있다 — 지운 뒤에 그 길을 알린다.
// `%s` 는 저장소 기준 경로. 추적되지 않은 파일에는 이 길이 없으므로 띄우지 않는다.
const EDITOR_DEL_RECOVER_HINT=t('editor.del_recover_hint');

// REPO_FIX 04 §3A-2·3A-3·3A-5: 갱신 실패 표식 · 여러 건 실패 · 닫기 · 탭 충돌.
const EDITOR_TREE_STALE=t('editor.tree_stale');
const EDITOR_TREE_ERR_CLOSE=t('editor.tree_err_close');
const EDITOR_MOVE_TAB_CONFLICT=t('editor.move_tab_conflict');
// §3A-5 (T-7.4): 트리 드래그의 dataTransfer 타입 — 트리 밖 드롭은 이것이 있을 때만 트리 드래그다.
const FILE_TREE_DRAG_TYPE='application/x-otterminal-tree';

// FR-EDD-31·35: 팝업의 말. 조각의 종류마다 이전 쪽이 무엇이었는지가 다르다.
const ED_DD_PEEK_ADDED=t('editor.dd_peek_added');
const ED_DD_REVERT=t('editor.dd_revert');
const ED_DD_REVERT_TITLE=t('editor.dd_revert_title');
const ED_DD_STAGE=t('editor.dd_stage');
const ED_DD_STAGE_TITLE=t('editor.dd_stage_title');
const ED_DD_PEEK_CLOSE_TITLE=t('editor.dd_peek_close_title');
const ED_DD_STAGE_WIDE=t('editor.dd_stage_wide');
const ED_DD_STAGING=t('editor.dd_staging');
// 팝업이 한 번에 보이는 이전 줄의 상한. 넘으면 팝업 안에서 스크롤한다 —
// 조각 하나가 화면을 통째로 덮으면 그것은 팝업이 아니라 다른 화면이다.
const ED_DD_PEEK_MAX_LINES=12;

