/**
 * Otterminal — Editor 창·파일 상수 (REFACTOR3_FE_REST5_SRS FR-FR5-20).
 *
 * Editor 창 타입 · 파일 API·형식·저장 실패·경합·크기 상한 · 도구 생성. `constants.js` 의 절(EDITOR_TAB_SRS 묶음 T·W)을
 * 그대로 옮겼다 — 값과 이름은 그대로다. `constants-tips.js` 뒤에 로드된다.
 */
// ── Editor 탭 · Editor 창 (EDITOR_TAB_SRS 묶음 T·W) ──

// FR-EDT-40: 세 번째 창 타입. Git 창과 마찬가지로 판정은 이 값과의 비교 하나다.
const WINDOW_TYPE_EDITOR='editor';

// EDITOR_GIT_UX_SRS 묶음 V — 열 수 있는 형식인가.
const FILE_PROBE_API='/api/file/probe';
const FILE_RAW_API='/api/file/raw';
// BARE_DOMAIN_LINK_SRS FR-BDL-2·3: 맨 도메인이 기준 폴더의 파일인지 묻는 자리와 그 답의 수명.
const FILE_STAMPS_API='/api/file/stamps';
const BARE_LINK_CACHE_MS=5000;
const BARE_LINK_CACHE_MAX=500;
// M9_SRS FR-M9-24: 보던 자리의 기록 상한 (사용자 결정 2026-09-14). 넘으면 오래된
// 쪽부터 버린다 — 무한히 쌓으면 그 자체가 새는 자리다.
const FOCUS_NAV_MAX=100;
// UX_BATCH12_SRS FR-RTR-2: 닫은 탭 목록의 길이. 넘으면 오래된 쪽부터 버린다.
const TAB_REOPEN_MAX=50;
const FILE_KIND_TEXT='text';
const FILE_KIND_IMAGE='image';
const FILE_KIND_BINARY='binary';
const FILE_UNSUPPORTED_TITLE=t('core.file_unsupported_title');
const FILE_UNSUPPORTED_HINT=t('core.file_unsupported_hint');
const FILE_IMAGE_FAIL=t('core.file_image_fail');

// EDITOR_EXTERNAL_CHANGE_SRS FR-EXC-9 — 저장하려는데 그 파일이 밖에서 바뀌었다.
//
// 선택지가 둘뿐인 것은 뜻이 있다. `디스크 것으로 덮기` 는 **편집본을 확인 없이
// 버리는 쪽**이라 `FR-RTU-103`(U-10)과 정면으로 걸리고, 그것을 안전하게 주려면
// 확인을 한 번 더 물어야 하는데 그러면 확인이 두 걸음이 된다 (FR-COS-1).
// 취소하면 편집본은 화면에 그대로 남으므로 사용자가 스스로 처리할 수 있다.
// FR-EXC-11: 표식이 실려 오는 자리. 값은 **불투명**하며 클라이언트는 이름만 안다.
// RELOAD_CONTINUITY_SRS D-2 개정 — 새 판이 있으나 저장하지 않은 편집 때문에
// 자동 새로고침을 미뤘다는 알림. 누르면 사용자가 직접 고른 것이다.
const VER_HELD_MSG=t('core.ver_held_msg');
const VER_HELD_GO=t('core.ver_held_go');

// 로드맵 `FUI-05`: 저장 실패는 사유와 함께 알린다 — 테두리만으로는 무엇이
// 잘못됐는지 말하지 못한다.
const FILE_SAVE_FAIL=t('core.file_save_fail');
// 저장 실패의 붉은 테두리(`.fe-save-failed`)가 머무는 시간.
const FILE_SAVE_FAIL_FLASH_MS=500;
// REPO_FIX 03 §3A-1: 어느 인코딩으로도 풀리지 않아 읽기 전용으로 연 문서.
const FILE_UNDECODABLE_NOTE=t('core.file_undecodable');

// `FE-7`: 설정 저장 실패는 조용히 지나가지 않는다 — 사용자는 바뀐 줄 알고
// 다음 기동에서 옛 값을 만난다.
const SETTINGS_SAVE_FAIL=t('core.settings_save_fail');

const FILE_STAMP_HEADER='X-File-Stamp';
const FILE_CONFLICT_TITLE=t('core.file_conflict_title');
const FILE_CONFLICT_MSG=t('core.file_conflict_msg');
const FILE_CONFLICT_GO=t('core.file_conflict_go');
const FILE_CONFLICT_CANCEL=t('core.file_conflict_cancel');

// FILE_API_BOUNDARY_SRS FR-FAB-9 (`FUI-06`) — 상한을 넘는 파일은 올리지 않는다.
// 상한 **값**은 여기 없다. 서버가 `probe.maxBytes` 로 준다 — 두 벌이면 한쪽만
// 고쳐지고, 그때 사용자는 "열린다고 했는데 안 열린다" 를 만난다.
const FILE_TOO_LARGE_TITLE=t('core.file_too_large_title');
const FILE_TOO_LARGE_HINT=t('core.file_too_large_hint');
const FILE_TOO_LARGE_DOWNLOAD=t('core.file_too_large_download');
const FILE_DOWNLOAD_API='/api/download';

// FR-EDT-110 의 종단. M2 는 목록 조회·추가·제거·재정렬만 쓴다.
const EDITORS_API='/api/editors';
// 도구 생성 (FR-OPT-11-7 · FEC-31). 첫 크기는 서버가 PTY 를 여는 크기이고, 붙은 뒤
// 화면에 맞춰 다시 잰다.
const TOOLS_API='/api/tools';
const TOOL_COLS_DEFAULT=120;
const TOOL_ROWS_DEFAULT=40;
