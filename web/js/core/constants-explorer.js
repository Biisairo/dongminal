/**
 * Remote Terminal — 탐색기·Repo 창·미리보기 탭·파일 조작·변경 표시 상수 (REFACTOR3_FE_REST5_SRS FR-FR5-20).
 *
 * `constants-editor.js` 의 뒤쪽 절들을 원래 순서 그대로 옮겼다 — 값과 이름은 그대로다. `constants-editor.js` **바로 뒤**에
 * 로드된다. `ED_DD_AXIS` 가 `constants-git-diff.js` 의 `GIT_AXIS` 를 참조한다.
 */
// ── Editor 탐색기 (EDITOR_TAB_SRS 묶음 X · FR-EDT-57~78) ──

// FR-EDT-108 의 조회 종단. 조작(create/rename/delete)은 M5 의 것이므로 여기 없다.
const FS_LIST_API='/api/fs/list';
// UI_POLISH_SRS FR-UIP-21: 저장소 추가 후보의 상한 — 목록 길이와 cwd 를 물을 터미널 수.
const PATH_SUGGEST_MAX=8;
const PATH_SUGGEST_TERM_MAX=8;
// NOTES_LIVE_EXPLORER_SRS FR-FSL-1 · EDITOR_LIVE_RELOAD_SRS FR-ELR-1 — "이 겹들과
// 열어 둔 이 파일들이 바뀌었나" 를 **한 요청**으로 묻는다 (OPTIMIZE_REFACTOR_SRS
// FR-OPT-4-2). 겹은 조회와 같은 루트 가드를 받는다. 옛 종단 둘(`/api/fs/stamp`·
// `/api/file/stamps`)은 서버에 남아 있다 — 옛 화면이 부른다.
const FS_STAMPS_API='/api/fs/stamps';
// 겹 스탬프(FR-FSL-5)·파일 표식(FR-ELR-6)·감시 등록(FR-ELR-51)의 상한은 서버가 보낸다
// (`serverMeta`, K-c). 서버가 넘긴 요청을 통째로 거절하므로 화면이 먼저 자른다.

// EDITOR_LIVE_RELOAD_SRS FR-ELR-51·65: 보이는 디렉터리의 감시 등록. 변화는 SSE `fs_changed` 로 온다.
const FS_WATCH_API='/api/fs/watch';
// FR-ELR-68: 탐색기는 첫 이벤트부터 이만큼 모아 한 번에 처리한다 (VS Code
// `explorerService.ts` `EXPLORER_FILE_CHANGES_REACT_DELAY`).
const EXPLORER_FS_CHANGES_DELAY_MS=500;
// FR-ELR-67: 문서 하나에 다시 읽기는 실행 중 하나 + 대기 하나까지다 (VS Code
// `textFileEditorModelManager.ts` `queueModelReload`).
const EDITOR_DOC_RELOAD_QUEUE=2;

// ── Repo 창의 사이드 (REPO_TAB_UNIFY_SRS 묶음 W) ──
//
// 좌측은 **탭 교체**다 (D-RTU-3). 세로로 쌓으면 파일 목록도 변경 목록도 절반
// 높이가 되어 어느 쪽도 한눈에 들어오지 않는다.
//
// 라벨이 영어인 것은 기존 관례다 (D-RTU-15) — 사이드바 탭(`Windows`)도 git 뷰
// 이름(`Changes`)도 영어이고, 한 화면에서 두 언어가 섞이지 않는다.
const REPO_SIDE_EXPLORER='explorer';
const REPO_SIDE_CHANGES='changes';
// UX_BATCH5_SRS FR-TIP-1·2: 툴팁은 정의 표가 든다 — 그리는 자리에 적으면 표가
// 두 벌이 된다 (FR-TIP-4).
// GIT_CHANGES_CONTROLS_SRS FR-GCC-13 (사용자 지시, 2026-09-06): **Changes 가 왼쪽**이다.
// 이 창을 여는 이유가 대개 변경을 보는 것이고, 왼쪽이 먼저 읽히는 자리다.
const REPO_SIDE_TABS=[
  {id:REPO_SIDE_CHANGES, label:t('editor.side_changes'), title:'Uncommitted changes in this repository'},
  {id:REPO_SIDE_EXPLORER,label:t('editor.side_explorer'),title:'Browse files in this repository'},
];
/**
 * UX_BATCH6_SRS FR-DSP-1: 기본 탭도 **Changes** 다.
 *
 *   이전 동작: Explorer
 *   새  동작: Changes
 *   이유:     순서를 Changes 로 옮긴 근거(FR-GCC-13)가 기본값에도 그대로 적용된다 —
 *             Repo 창을 여는 이유가 대개 변경을 보는 것이다. 두 물음을 갈라 둔
 *             동안 첫 화면과 탭 순서가 서로 다른 말을 했다
 *
 * FR-DSP-2: 이미 저장된 창의 선택은 바뀌지 않는다 — 이 값은 **키가 없을 때**의
 * 답이며 `edSideOf` 가 그렇게 읽는다.
 */
const REPO_SIDE_DEFAULT=REPO_SIDE_CHANGES;
// MOBILE_UX_OVERHAUL_SRS FR-MUX-77: 모바일 Repo 세그먼트의 셋째 칸 — 본문(편집기 칸)으로 간다.
// 앞의 두 칸은 `REPO_SIDE_TABS` 를 그대로 쓴다.
const REPO_SEG_EDITOR={id:'editor',label:t('editor.seg_editor'),title:'Files open in this repository'};

// REPO_SIDE_WIDTH_SRS FR-RSW-1 / D-3·D-4 (UX_BATCH10_SRS FR-UXB-7 이 저장 위치를
// 개정했다 — 워크스페이스가 아니라 **브라우저 창**이다): 사이드 폭은 한 자리에 산다
// (`ws.repoSideWidth`) — `sidebarWidth` 와 같은 규약이다. 창마다 두던 값이었고
// (`window.editor.explorerWidth`, FR-EDT-47) 그러면 창을 옮길 때마다 목록의 폭이
// 달라졌다. 이름이 `EXPLORER` 가 아닌 이유는 그 폭이 `Changes` 의 것이기도 하기
// 때문이다. 상·하한은 사이드바(`--sb-w`)의 규약을 그대로 따른다 — 같은 종류의 값이
// 서로 다른 한계를 가질 이유가 없다.
// FR-UXB-7: 탐색기 폭도 창의 것이다 (D-UXB-1) — 사이드바 폭과 같은 규약이며
// 저장소도 같다 (`sessionStorage`).
const REPO_SIDE_W_KEY='repoSideWidth';
const REPO_SIDE_W_DEFAULT=220;
const REPO_SIDE_W_MIN=100;
const REPO_SIDE_W_MAX=520;

// ── 미리보기 탭 (REPO_TAB_UNIFY_SRS 묶음 P · FR-RTU-40~45) ──
//
// 변경 목록을 훑는 일이 탭 20개가 되면, 목록을 보는 것 자체가 정리를 부른다
// (D-RTU-9). 한 번 클릭은 **한 탭을 재사용**하고 더블클릭이 그것을 고정한다 —
// VSCode 의 규약이며 사용자가 이미 아는 동작이다.
//
// 기울임이 곧 "이 탭은 곧 대체된다" 는 표시다 (FR-RTU-41).
const REPO_PREVIEW_CLASS='pn-tab-preview';
const REPO_PREVIEW_TITLE=t('editor.repo_preview_title');

// GIT_DIR_ENTRY_SRS FR-DIR-31 / D-DIR-7: **`_gitOff` 는 사유마다 수명이 다르다.**
//
// 404(`not_repo`)와 `rootMatch=false` 는 굳히지 않는다 — 그 자리에서 `git init` 이
// 일어나면 참이 거짓으로 바뀌는 사유이기 때문이다. 굳혀 두면 init 직후에도 색이
// 없고, 사용자는 init 이 실패했다고 읽는다. 대신 주기를 늦춰 계속 관측한다.
//
// 503(git 자체가 없다)만 굳는다 — 다시 물어도 답이 같다 (기존 관례).
// PERF_OPTIMIZATION_SRS 1.15: 예전 설정 `gitReposInterval` 기본값(3초) × 10. 사용자가 바꾸지 않는다.
const EDITOR_GIT_BACKOFF_MS=30000;

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
// SERVER_DRIVEN_ACTIONS_SRS F-a: 메뉴의 답과 삭제할 항목 수를 서버가 낸다.
const FS_ACTIONS_API='/api/fs/actions';
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

// FR-ETR-22: 폴더 드롭의 재귀 수집 상한. 홈 폴더를 잘못 놓았을 때 브라우저가
// 멎지 않게 하는 값이다.
const EDITOR_UPLOAD_MAX_ENTRIES=10000;
const EDITOR_UPLOAD_TOO_MANY=t('editor.upload_too_many');

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

// FR-EDT-83·84: 삭제 확인창. **영구 삭제**라는 사실, 폴더면 재귀와 항목 수,
// 그리고 저장되지 않은 탭이 함께 닫힌다는 사실을 한 자리에서 밝힌다.
const EDITOR_DEL_FILE=t('editor.del_file');
const EDITOR_DEL_DIR=t('editor.del_dir');
// FR-EMS-21: 여럿을 지울 때. **수가 먼저다** — 이름만 늘어놓으면 몇 개인지
// 사용자가 세어야 한다.
const EDITOR_DEL_MANY=t('editor.del_many');
const EDITOR_DEL_MANY_TREE=t('editor.del_many_tree');
const EDITOR_DEL_PERMANENT=t('editor.del_permanent');
// `UX-25`: 추적 중이던 파일은 git 이 갖고 있다 — 지운 뒤에 그 길을 알린다.
// `%s` 는 저장소 기준 경로. 추적되지 않은 파일에는 이 길이 없으므로 띄우지 않는다.
const EDITOR_DEL_RECOVER_HINT=t('editor.del_recover_hint');
const EDITOR_DEL_DIRTY=t('editor.del_dirty');
const EDITOR_DEL_OK=t('editor.del_ok');
const EDITOR_DEL_CANCEL=t('editor.del_cancel');

// FR-EDT-92: 실패는 그 자리에 사유를 표시한다. 서버의 코드(FR-EDT-117)를 사람의
// 말로 옮기는 자리는 여기 하나다.
const EDITOR_FS_ERR_MSG={
  bad_request:t('editor.fs_err_msg.bad_request'),
  outside_root:t('editor.fs_err_msg.outside_root'),
  permission_denied:t('editor.fs_err_msg.permission_denied'),
  not_found:t('editor.fs_err_msg.not_found'),
  exists:t('editor.fs_err_msg.exists'),
  io_failed:t('editor.fs_err_msg.io_failed'),
  too_large:t('editor.fs_err_msg.too_large'),
};
const EDITOR_FS_ERR_UNKNOWN=t('editor.fs_err_unknown');
// SERVER_DRIVEN_ACTIONS_SRS F-h: 표에 없는 코드는 서버 답의 사유 문구(`why.<코드>`)로
// 읽는다 — 답을 거치지 않은 거절도 메뉴와 같은 말로 보인다. 그 거절은 `message` 를
// 싣지 않는다 (D-SDA-5).
function edFsReason(d){
  const code=(d&&d.code)||'';
  if(EDITOR_FS_ERR_MSG[code]) return EDITOR_FS_ERR_MSG[code];
  if(code&&I18N.has('why.'+code)) return t('why.'+code,d.args);
  return (d&&d.message)||EDITOR_FS_ERR_UNKNOWN;
}
// REPO_FIX 04 §3A-2·3A-3·3A-5: 갱신 실패 표식 · 여러 건 실패 · 닫기 · 탭 충돌.
const EDITOR_TREE_STALE=t('editor.tree_stale');
const EDITOR_TREE_ERR_CLOSE=t('editor.tree_err_close');
const EDITOR_MOVE_TAB_CONFLICT=t('editor.move_tab_conflict');
// §3A-5 (T-7.4): 트리 드래그의 dataTransfer 타입 — 트리 밖 드롭은 이것이 있을 때만 트리 드래그다.
const FILE_TREE_DRAG_TYPE='application/x-otterminal-tree';
// WORKBENCH_REVIEW_SRS FR-WBR-41: 재조정이 지우려던 창을 미뤘다는 사실. 창 이름을
// 밝히는 이유는 FR-EDT-84 와 같다 — 개수만으로는 무엇을 정리해야 할지 모른다.
const EDITOR_HELD_DIRTY=t('editor.held_dirty');

// ── 편집기의 변경 표시 (EDITOR_DIRTY_DIFF_SRS) ──
//
// 기준은 **index** 다 (FR-EDD-1 / D-2). 서버의 부분 스테이징이 op 마다 축을
// 못박으므로(Go 기준선 `write/patch.go:105`) 화면과 서버가 같은 축을 봐야 조각의 경계가
// 어긋나지 않는다. VSCode 도 스테이지하면 이 표시가 사라지는 index 기준이다.
const ED_DD_AXIS=GIT_AXIS.UNSTAGED;

// FR-EDD-13: 계산의 상한. 줄 수는 파일의 크기, 편집 거리는 diff 의 크기다 —
// 둘 중 하나만 두면 나머지 한쪽이 커진 파일에서 계산이 끝나지 않는다.
const ED_DD_MAX_LINES=50000;
const ED_DD_MAX_EDITS=2000;

// FR-EDD-14: 모델 변경에서 재계산까지. 타이핑 한 글자마다 diff 를 돌리지 않는다.
const ED_DD_DEBOUNCE_MS=180;

// FR-EDD-11: 조각의 세 종류. CSS 클래스와 색 변수가 이 값에서 파생한다 —
// 문자열을 세 곳에 흩뿌리면 한쪽만 바뀐다.
const ED_DD_ADD='add';
const ED_DD_MOD='mod';
const ED_DD_DEL='del';
// FR-EDD-23: 색은 탐색기 트리의 규약 그대로다 (`style-editor.css` 의 탐색기 트리 변경 색 규칙) —
// 같은 창의 두 표면이 같은 사실에 다른 색을 쓰면 그중 하나는 거짓말이 된다.
const ED_DD_COLOR_VAR={
  [ED_DD_ADD]:'--git-st-add',
  [ED_DD_MOD]:'--accent',
  [ED_DD_DEL]:'--danger',
};

// FR-EDD-31·35: 팝업의 말. 조각의 종류마다 이전 쪽이 무엇이었는지가 다르다.
const ED_DD_PEEK_ADDED=t('editor.dd_peek_added');
const ED_DD_REVERT=t('editor.dd_revert');
const ED_DD_REVERT_TITLE=t('editor.dd_revert_title');
const ED_DD_STAGE=t('editor.dd_stage');
const ED_DD_STAGE_TITLE=t('editor.dd_stage_title');
const ED_DD_PEEK_CLOSE_TITLE=t('editor.dd_peek_close_title');
// FR-EDD-44·46·47: 스테이지가 못 선 사유. 침묵은 고장과 구별되지 않는다.
const ED_DD_SAVE_FAIL=t('editor.dd_save_fail');
const ED_DD_STAGE_FAIL=t('editor.dd_stage_fail');
const ED_DD_STAGE_STALE=t('editor.dd_stage_stale');
const ED_DD_STAGE_WIDE=t('editor.dd_stage_wide');
const ED_DD_STAGING=t('editor.dd_staging');
// 서버 DiffSide.kind 중 본문을 diff 할 수 있는 하나. `GIT_DIFF_DRAWABLE` 은
// `absent`(한쪽이 없다)까지 포함하는데, 그것은 여기서 "표시하지 않는다" 다
// (FR-EDD-6) — 두 판정이 다르므로 그 집합을 빌려 쓰지 않는다.
const ED_DD_KIND_TEXT='text';
// 팝업이 한 번에 보이는 이전 줄의 상한. 넘으면 팝업 안에서 스크롤한다 —
// 조각 하나가 화면을 통째로 덮으면 그것은 팝업이 아니라 다른 화면이다.
const ED_DD_PEEK_MAX_LINES=12;

// FUI-07: 모두 저장의 결말. 개별 실패는 `save()` 가 이미 알리므로 여기는
// **묶음의 결말**만 적는다 — 없으면 여러 파일 중 하나가 막힌 것을 모른다.
const ED_SAVE_ALL_NONE=t('editor.save_all_none');
const ED_SAVE_ALL_OK=t('editor.save_all_ok');
const ED_SAVE_ALL_PARTIAL=t('editor.save_all_partial');
