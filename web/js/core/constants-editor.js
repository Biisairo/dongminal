/**
 * Remote Terminal — 편집기·탐색기 상수 (constants.js 에서 분리)
 *
 * `constants-git.js` **뒤**에 로드된다 — `EDITOR_GIT_POLL_MS` 가
 * `GIT_REPOS_POLL_MS` 를 참조한다.
 */
// 탭 서술자의 고정 값들. index.html 의 패널 래퍼가 같은 id 를 쓴다 (§2.1).
const EDITOR_TAB_ID='editor';
const EDITOR_TAB_LABEL='Editor';
const EDITOR_PANEL_ID='sb-panel-editor';
const EDITOR_LIST_ID='editor-entries';
const EDITOR_ROOT_ID='editor-root';
// FR-EDT-10·44: root 에디터의 표시 이름. 행과 창이 같은 이름을 써야 사용자가
// 둘을 같은 것으로 읽는다.
const EDITOR_ROOT_NAME='~';
// NOTES_LIVE_EXPLORER_SRS FR-NOT-9: 메모장 행·창의 이름. root 행이 `~` 하나로
// 서듯 이것도 한 자리에서만 정해진다 — 행과 창이 같은 이름을 써야 사용자가 둘을
// 같은 것으로 읽는다 (FR-EDT-10·44).
const EDITOR_NOTES_NAME='메모장';
const EDITOR_ENTRIES_NONE='+ Add 로 경로를 추가하세요';

// FR-EDT-28: `+ Add`. 지금 터미널의 cwd 를 미리 채운다 — 경로를 타이핑하게 하면
// 리포 추가와 달리 딛을 자리가 없다.
const EDITOR_ADD_TITLE='Editor 추가';
const EDITOR_ADD_RUN='추가';
const EDITOR_ADD_PROMPT='디렉터리 경로 (절대경로)';
const EDITOR_ADD_HERE='지금 터미널: %s';
const EDITOR_ADD_NO_TERM='지금 터미널의 경로를 얻지 못했습니다 — 경로를 직접 넣으세요';
const EDITOR_ADD_NEED_PATH='경로가 필요합니다';
const EDITOR_ADD_FAIL='Editor 를 추가하지 못했습니다';

// FR-EDT-55: pane 이 하나도 없는 창의 우측. 빈 pane 이 아니라 pane 이 **없는** 것이다.
const EDITOR_EMPTY_HINT='탐색기에서 파일을 열면 여기에 나타납니다';

// EDITOR_GIT_UX_SRS 묶음 F·G — Editor 창의 찾기.
const ED_FIND_API='/api/fs/find';
const ED_GREP_API='/api/fs/grep';
// 입력마다 부르면 한 글자에 저장소 전체를 훑는 요청이 나간다.
const ED_SEARCH_DEBOUNCE_MS=150;
const ED_FIND_PLACEHOLDER='파일 이름으로 찾기';
const ED_GREP_PLACEHOLDER='모든 파일에서 내용 찾기';
const ED_FIND_HINT='이름의 일부를 입력하세요 (경로도 됩니다)';
const ED_GREP_HINT='찾을 내용을 입력하세요';
const ED_SEARCH_EMPTY='결과 없음';
const ED_SEARCH_FAIL='찾지 못했습니다';
const ED_SEARCH_COUNT_SUFFIX='건';

// FR-EDT-47 / D-18: 탐색기 폭은 워크스페이스에 산다 (`window.editor.explorerWidth`).
// 상·하한은 사이드바(`--sb-w`)의 규약을 그대로 따른다 — 같은 종류의 값이 서로 다른
// 한계를 가질 이유가 없다.
const EDITOR_EXPLORER_W_DEFAULT=220;
const EDITOR_EXPLORER_W_MIN=100;
const EDITOR_EXPLORER_W_MAX=520;

// ── Editor 탐색기 (EDITOR_TAB_SRS 묶음 X · FR-EDT-57~78) ──

// FR-EDT-108 의 조회 종단. 조작(create/rename/delete)은 M5 의 것이므로 여기 없다.
const FS_LIST_API='/api/fs/list';
// NOTES_LIVE_EXPLORER_SRS FR-FSL-1 — "이 겹들이 바뀌었나". 조회와 짝이며 같은
// 루트 가드를 받는다.
const FS_STAMP_API='/api/fs/stamp';
// FR-FSL-5 와 같은 값이어야 한다 — 서버가 상한을 넘긴 요청을 거절하므로,
// 클라이언트가 먼저 잘라 보내지 않으면 겹을 아주 많이 펼친 사용자에게서 관측이
// 통째로 멎는다.
const FS_STAMP_MAX=512;

// FR-EDT-77: 활성 Editor 창의 색 갱신 주기. `GIT_REPOS_POLL_MS` 를 **값으로 딛는다**
// — 같은 사실을 보는 두 화면이 다른 속도로 갱신될 이유가 없고, 두 벌로 적으면
// 한쪽만 고쳐진다.
const EDITOR_GIT_POLL_MS=GIT_REPOS_POLL_MS;

// 트리 행의 들여쓰기는 Git 패널의 트리와 같은 값을 딛는다 (GIT_TREE_PAD0·
// GIT_TREE_INDENT) — 같은 앱 안의 두 트리가 다른 리듬으로 들여쓸 이유가 없다.

// 펼침 표시. 조회 중(`BUSY`)을 따로 두는 이유는 "비었다" 와 "아직 오지 않았다" 가
// 같은 화면이 되면 사용자가 지연을 고장으로 읽기 때문이다.
const EDITOR_TREE_TW_OPEN='▾';
const EDITOR_TREE_TW_CLOSED='▸';
const EDITOR_TREE_TW_BUSY='·';
// FR-EDT-60: 링크는 펼치지도 열지도 않는다. 표시가 그 사실과 대상 종류를 알린다.
const EDITOR_TREE_LINK='↗';
const EDITOR_TREE_LINK_DIR='↗/';
// FR-EDT-64: 펼쳐져 있는 폴더만 다시 읽는다.
// 새 파일·새 폴더와 **같은 줄에 서므로** 같은 형식이어야 한다 (아래
// EDITOR_TREE_NEW_FILE 의 근거 참조). 하나만 글자로 두면 선 굵기와 크기가 달라
// 그 하나가 도리어 눈에 띈다.
const EDITOR_TREE_REFRESH=
  '<svg viewBox="0 0 16 16" aria-hidden="true">'+
  '<path d="M13.6 8A5.6 5.6 0 1 1 11.9 4"/>'+
  '<path d="M13.8 1.9v3.3h-3.3"/>'+
  '</svg>';
const EDITOR_TREE_REFRESH_TITLE='새로고침 (펼친 폴더만 다시 읽습니다)';
// FR-EDT-65: 상한을 넘긴 폴더. **조회는 실패하지 않는다** — 잘렸다는 사실만 알린다.
const EDITOR_TREE_TRUNCATED='%s개 이상 — 잘림';
// FR-EDT-63: 조회 실패는 그 폴더 행에만 남고 트리를 깨뜨리지 않는다.
const EDITOR_TREE_ERR='읽지 못했습니다';

// FR-EDT-74 / D-5: 폴더 색의 우선순위. 삭제(D)가 표에 **없는 것이 규칙이다** —
// 지워진 파일은 애초에 탐색기에 없으므로 그 상태가 폴더 색을 정할 근거가 없다.
const EDITOR_TREE_ST_RANK={U:4,A:3,'?':3,M:2,R:1,C:1};

// ── 탐색기의 파일 조작 (EDITOR_TAB_SRS 묶음 F · FR-EDT-79~93) ──

// FR-EDT-109 의 조작 종단 셋. **이름 변경과 이동은 같은 연산**이라 종단이 하나다 —
// 둘을 가르면 "옮기면서 이름도 바꾸는" 경로가 어느 쪽에도 속하지 않는다.
const FS_CREATE_API='/api/fs/create';
const FS_RENAME_API='/api/fs/rename';
const FS_DELETE_API='/api/fs/delete';
// FILE_TRANSFER_SRS FR-FTR-12·15 — 조회·조작과 같은 root 가드를 받는 전송 둘.
const FS_DOWNLOAD_API='/api/fs/download';
const FS_UPLOAD_API='/api/fs/upload';
// EXPLORER_TRANSFER_IGNORE_SRS FR-ETR-9 — 폴더는 zip 으로 온다 (D-4).
const FS_DOWNLOAD_DIR_API='/api/fs/download-dir';
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
// 테마색을 그대로 따른다.
//
// 플러스는 둘 다 **오른쪽 아래 같은 자리**다. 다른 것은 왼쪽 위의 모양뿐이며,
// 그것이 곧 "무엇을 새로 만드는가" 다.
const EDITOR_TREE_NEW_FILE=
  '<svg viewBox="0 0 16 16" aria-hidden="true">'+
  '<path d="M9 1.6H4.3A1.3 1.3 0 0 0 3 2.9v10.2a1.3 1.3 0 0 0 1.3 1.3H8"/>'+
  '<path d="M9 1.6 12.6 5.2V8"/>'+
  '<path d="M9 1.6V5.2h3.6"/>'+
  '<path d="M11.6 10.2v4.4M9.4 12.4h4.4"/>'+
  '</svg>';
const EDITOR_TREE_NEW_FILE_TITLE='새 파일 (선택한 폴더 아래)';
const EDITOR_TREE_NEW_DIR=
  '<svg viewBox="0 0 16 16" aria-hidden="true">'+
  '<path d="M1.8 12.6V3.6a1.1 1.1 0 0 1 1.1-1.1h2.7l1.4 1.8h6.2a1.1 1.1 0 0 1 1.1 1.1V8"/>'+
  '<path d="M1.8 12.6a1.1 1.1 0 0 0 1.1 1.1H8"/>'+
  '<path d="M11.6 10.2v4.4M9.4 12.4h4.4"/>'+
  '</svg>';
const EDITOR_TREE_NEW_DIR_TITLE='새 폴더 (선택한 폴더 아래)';
// 머리 버튼이 그림으로 넣어도 되는 값의 **전부**다. 화이트리스트로 두는 이유는
// "우리가 쓴 상수뿐" 이라는 사실을 주석이 아니라 코드가 보장하게 하기 위해서다 —
// 나중에 사용자 입력이 그 자리에 닿아도 그림이 되지 않는다.
const EDITOR_HEAD_ICONS=new Set([EDITOR_TREE_NEW_FILE,EDITOR_TREE_NEW_DIR,EDITOR_TREE_REFRESH]);
const EDITOR_MENU_NEW_FILE='새 파일';
const EDITOR_MENU_NEW_DIR='새 폴더';
const EDITOR_MENU_RENAME='이름 변경';
// FR-FTR-13·18 / FR-ETR-16·23: 탐색기의 전송. 다운로드는 폴더에서도 활성이며
// 그때는 zip 으로 온다 (D-4). 링크는 여전히 비활성이다 — 링크 자신을 내려받는다는
// 뜻이 정해져 있지 않다.
const EDITOR_MENU_UPLOAD='업로드';
const EDITOR_MENU_UPLOAD_DIR='폴더 업로드';
const EDITOR_MENU_DOWNLOAD='다운로드';
const EDITOR_DOWNLOAD_LINK_NO='링크는 내려받을 수 없습니다';
const EDITOR_UPLOAD_FAIL='%s 을(를) 올리지 못했습니다';

// FR-ETR-22: 폴더 드롭의 재귀 수집 상한. 홈 폴더를 잘못 놓았을 때 브라우저가
// 멎지 않게 하는 값이다.
const EDITOR_UPLOAD_MAX_ENTRIES=10000;
const EDITOR_UPLOAD_TOO_MANY='항목이 %n개를 넘어 올리지 않았습니다 — 더 작은 폴더를 고르세요';

// FR-ETR-26~30: 전송이 한 항목에서 실패했을 때의 선택. 폴더 하나가 수백 개일 수
// 있으므로 "이후 모두 건너뛰기" 가 함께 있어야 한다 — 같은 사유로 이어 실패할 때
// 묻기를 되풀이하면 그 자체가 고장이다 (D-9).
const EDITOR_UPLOAD_FAIL_TITLE='업로드 실패';
const EDITOR_UPLOAD_FAIL_BODY='%s 을(를) 올리지 못했습니다 — %r';
const EDITOR_UPLOAD_RETRY='재시도';
const EDITOR_UPLOAD_SKIP='건너뛰기';
const EDITOR_UPLOAD_SKIP_ALL='이후 모두 건너뛰기';
const EDITOR_UPLOAD_ABORT='중단';
// FR-ETR-30: 조용히 끝나면 사용자는 전부 올라간 줄 안다.
const EDITOR_UPLOAD_SKIPPED='%n개를 건너뛰었습니다';
const EDITOR_UPLOAD_ABORTED='%n개를 남기고 중단했습니다';
// FR-FTR-23: 드래그 중 접힌 폴더가 펼쳐지기까지의 체류 시간 (D-5).
const EDITOR_SPRING_MS=600;
// `revealPath` 가 거슬러 올라갈 겹의 상한. `_parent` 는 최상위에서 `'/'` 를
// 내므로 루트가 `'/'` 인 트리에서는 스스로 멈추지 않는다 — 경로 깊이에 상한을
// 두는 편이 종료 조건을 경로 모양에 맡기는 것보다 확실하다.
const EDITOR_TREE_REVEAL_MAX=64;
const EDITOR_MENU_DELETE='삭제';

// FR-EDT-83·84: 삭제 확인창. **영구 삭제**라는 사실, 폴더면 재귀와 항목 수,
// 그리고 저장되지 않은 탭이 함께 닫힌다는 사실을 한 자리에서 밝힌다.
const EDITOR_DEL_FILE='%s 을(를) 삭제합니다.';
const EDITOR_DEL_DIR='%s 폴더를 재귀적으로 삭제합니다 — 그 안의 항목 %n개가 함께 사라집니다.';
const EDITOR_DEL_PERMANENT='영구 삭제입니다. 휴지통으로 가지 않으며 되돌릴 수 없습니다.';
const EDITOR_DEL_DIRTY='저장되지 않은 탭 %n개가 함께 닫힙니다 — %s';
const EDITOR_DEL_COUNT_MORE='%n개 이상';
const EDITOR_DEL_OK='영구 삭제';
const EDITOR_DEL_CANCEL='취소';
// 확인창의 항목 수는 클라이언트가 `list` 로 센다 — 서버에 세는 종단이 없다.
// 상한을 두는 이유는 큰 트리에서 확인창이 열리기까지 조회가 무한정 붙기 때문이다.
// 넘으면 "N개 이상" 으로 알린다 — 확인창이 늦게 뜨는 것보다 낫다.
const EDITOR_DEL_COUNT_MAX=2000;

// FR-EDT-92: 실패는 그 자리에 사유를 표시한다. 서버의 코드(FR-EDT-117)를 사람의
// 말로 옮기는 자리는 여기 하나다.
const EDITOR_FS_ERR_MSG={
  bad_request:'요청이 올바르지 않습니다',
  outside_root:'Editor 루트 밖은 조작할 수 없습니다',
  permission_denied:'권한이 없습니다',
  not_found:'대상이 없습니다',
  exists:'같은 이름이 이미 있습니다',
  io_failed:'파일시스템 조작에 실패했습니다',
  too_large:'파일이 너무 큽니다',
};
const EDITOR_FS_ERR_UNKNOWN='조작하지 못했습니다';
// FR-EDT-85: 서버에 묻기 전에 클라이언트가 막는 유일한 경우다 — os.Rename 은 이
// 이동을 성공시키고 트리를 잃어버린다.
const EDITOR_MOVE_INTO_SELF='자기 자신이나 자기 하위로는 옮길 수 없습니다';
const EDITOR_NAME_INVALID='이름에 / 를 쓸 수 없습니다';
