/**
 * Remote Terminal — 편집기·탐색기 상수 (constants.js 에서 분리)
 *
 * `constants-git.js` **뒤**에 로드된다 — `ED_DD_AXIS` 가 `GIT_AXIS` 를
 * 참조한다 (`const` 이므로 TDZ 에 걸린다).
 */
// 탭 서술자의 고정 값들. index.html 의 패널 래퍼가 같은 id 를 쓴다 (§2.1).
//
// REPO_TAB_UNIFY_SRS FR-RTU-1: `Git` 과 `Editor` 두 탭이 **하나**가 됐다. 목록이
// 이미 같은 집합이었으므로(§2.1) 화면만 둘로 그리고 있었던 셈이다.
const REPO_TAB_ID='repo';
const REPO_TAB_LABEL=t('editor.act.repo_tab_label');
const REPO_PANEL_ID='sb-panel-repo';
const REPO_LIST_ID='repo-entries';
const REPO_ROOT_ID='repo-root';
const REPO_ADD_ID='repo-add';
// D-RTU-18: 새로고침을 건너는 활성 Repo 창의 **루트**. id 는 재조정이 다시 만들
// 수 있으므로(FR-EDT-42) 그것만으로는 사용자가 보던 창을 되찾지 못한다.
const ACTIVE_EDITOR_ROOT_KEY='activeEditorRoot';
// FR-EDT-10·44: root 에디터의 표시 이름. 행과 창이 같은 이름을 써야 사용자가
// 둘을 같은 것으로 읽는다.
const EDITOR_ROOT_NAME='~';
// NOTES_LIVE_EXPLORER_SRS FR-NOT-9: 메모장 행·창의 이름. root 행이 `~` 하나로
// 서듯 이것도 한 자리에서만 정해진다 — 행과 창이 같은 이름을 써야 사용자가 둘을
// 같은 것으로 읽는다 (FR-EDT-10·44).
const EDITOR_NOTES_NAME=t('editor.notes_name');
// LSP_PLUGIN_SRS FR-EXT-9b: 언어 서버 플러그인의 선언들이 사는 자리. 메모장과 같은
// 규약으로 탐색기에 한 줄로 선다 — 선언은 사용자가 고치라고 만든 파일이므로
// (FR-EXT-9) 우리 편집기로 열 수 있어야 한다.
const EDITOR_PLUGINS_NAME=t('editor.plugins_name');
const REPO_ENTRIES_NONE=t('editor.repo_entries_none');

// FR-EDT-28: `+ Add`. 지금 터미널의 cwd 를 미리 채운다 — 경로를 타이핑하게 하면
// 리포 추가와 달리 딛을 자리가 없다.
const EDITOR_ADD_TITLE=t('editor.add_title');
const EDITOR_ADD_RUN=t('editor.add_run');
const EDITOR_ADD_PROMPT=t('editor.add_prompt');
const EDITOR_ADD_HERE=t('editor.add_here');
const EDITOR_ADD_NO_TERM=t('editor.add_no_term');
// SERVER_DRIVEN_ACTIONS_SRS F-m: 편집기 루트 추가 경로의 답 (서버 `action.EditorAdd`).
const EDITOR_ACTION_ADD='editor.add';
const EDITOR_ADD_FAIL=t('editor.add_fail');

// FR-EDT-55: pane 이 하나도 없는 창의 우측. 빈 pane 이 아니라 pane 이 **없는** 것이다.
const EDITOR_EMPTY_HINT=t('editor.empty_hint');

// EDITOR_GIT_UX_SRS 묶음 F·G — Editor 창의 찾기.
const ED_FIND_API='/api/fs/find';
const ED_GREP_API='/api/fs/grep';
// 입력마다 부르면 한 글자에 저장소 전체를 훑는 요청이 나간다.
const ED_SEARCH_DEBOUNCE_MS=150;
const ED_FIND_PLACEHOLDER=t('editor.find_placeholder');
const ED_GREP_PLACEHOLDER=t('editor.grep_placeholder');
const ED_FIND_HINT=t('editor.find_hint');
const ED_GREP_HINT=t('editor.grep_hint');
const ED_SEARCH_EMPTY=t('editor.search_empty');
const ED_SEARCH_FAIL=t('editor.search_fail');
const ED_SEARCH_COUNT_SUFFIX=t('editor.search_count_suffix');

// 패널 네 모드의 안내문. 한 표에 두는 이유는 모드를 더할 때 `_edPanel` 의 조건이
// 늘지 않게 하기 위해서다 — 종전에는 `mode==='find'?A:B` 라 셋째 모드를 넣을
// 자리가 없었다.
const ED_PANEL_PLACEHOLDER={
  find:ED_FIND_PLACEHOLDER,
  grep:ED_GREP_PLACEHOLDER,
  refs:t('editor.panel_placeholder.refs'),
  defs:t('editor.panel_placeholder.defs'),
};
const ED_PANEL_HINT={
  find:ED_FIND_HINT,
  grep:ED_GREP_HINT,
  refs:'',
  defs:'',
};

// ── 파일 내 찾기 패널 (EDITOR_FIND_PANEL_SRS 묶음 B·C·D) ──
//
// 엔진의 기본 찾기 위젯을 **쓰지 않는다** (FR-EFP-25 가 FR-EKB-3 을 개정했다). 옛 엔진의
// 위젯은 우리보다 먼저 열리고서 포커스를 우리에게 빼앗겨, 뜬 채로 글자를 못 받고 그 글자가
// 문서에 삽입됐다 — 검색하려고 누른 키가 파일을 편집했다 (그 SRS §2.4). CodeMirror 에는
// `@codemirror/search` 의 패널·keymap 을 넣지 않는다 (CODEMIRROR_MIGRATION_SRS §11.7).
//
// 일치 계산은 `cm-find.js` 의 `edFindHits` 다.

// 토글 셋의 라벨. 글자로 두는 이유는 셋이 나란히 서기 때문이다 — 하나만 그림이면
// 선 굵기가 달라 그 하나가 도리어 눈에 띈다 (EDITOR_TREE_REFRESH 의 근거와 같다).
const ED_FIND_OPT_CASE='Aa';
const ED_FIND_OPT_REGEX='.*';
const ED_FIND_OPT_WORD='ab';
const ED_FIND_OPT_CASE_TITLE=t('editor.find_opt_case_title');
const ED_FIND_OPT_REGEX_TITLE=t('editor.find_opt_regex_title');
const ED_FIND_OPT_WORD_TITLE=t('editor.find_opt_word_title');
const ED_FIND_PREV_TITLE=t('editor.find_prev_title');
const ED_FIND_NEXT_TITLE=t('editor.find_next_title');
const ED_FIND_CLOSE_TITLE=t('editor.find_close_title');
const ED_FIND_IN_PLACEHOLDER=t('editor.find_in_placeholder');
// EDITOR_REPLACE_AND_SEED_SRS 묶음 R — 바꾸기 줄의 문구.
const ED_FIND_REPLACE_PLACEHOLDER=t('editor.find_replace_placeholder');
const ED_FIND_REPLACE_ONE=t('editor.find_replace_one');
const ED_FIND_REPLACE_ALL=t('editor.find_replace_all');
const ED_FIND_REPLACE_TOGGLE_TITLE=t('editor.find_replace_toggle_title');
// 바꾸기 편집의 출처 이름. 트랜잭션의 `userEvent` 로 싣는다 (`cm-find.js`).
const ED_FIND_EDIT_SOURCE='fe-find-replace';
// FR-EFP-16: 질의가 비면 수를 말하지 않는다 — 아직 묻지 않은 것이다. 0건과
// 빈 질의를 같은 화면으로 두면 사용자가 "없다" 로 읽는다.
const ED_FIND_NONE=t('editor.find_none');
// FR-EFP-24: 조용히 0건으로 보이면 사용자가 없는 줄로 읽는다.
const ED_FIND_BAD_RE=t('editor.find_bad_re');
// FR-EFP-23 / D-4: 옵션은 기기별이다. 설정 블롭의 값들은 "이 서버가 무엇인가" 를
// 말하는데, 검색 옵션은 그런 값이 아니라 지금 이 손의 버릇이다.
const ED_FIND_OPTS_KEY='edFindOpts';
// 하이라이트의 CSS 이름. CodeMirror 장식(`Decoration.mark`)의 class 로 그대로 간다.
const ED_FIND_HIT_CLASS='fe-find-hit';
const ED_FIND_HIT_CUR_CLASS='fe-find-hit-cur';
// FR-EFP-20: 단어 단위의 경계. 옛 엔진의 기본 구분자와 같은 값이며, 켜지 않았을
// 때는 `null` 을 넘겨 경계를 보지 않게 한다.
const ED_FIND_WORD_SEPARATORS='`~!@#$%^&*()-=+[{]}\\|;:\'",.<>/?';
// 한 문서에서 셀 일치의 상한. 넘으면 거기서 끊는다 — 수십만 건을 세는
// 동안 화면이 멎는 것보다 낫다.
const ED_FIND_MAX_HITS=20000;

// CODEMIRROR_MIGRATION_SRS FR-CMR-74: 직접 그리는 세로 스크롤바. 폭·thumb 최소 높이는 옛 엔진의 기본값이다
// (`verticalScrollbarSize` 14 · 슬라이더 최소 20).
const ED_SCROLL_W=14;
const ED_SCROLL_MIN_THUMB=20;
// FR-CMR-70·72: overview ruler 표식의 최소 높이(px). 한 줄짜리 일치도 눈에 띄어야 한다.
const ED_RULER_MIN_H=2;
// 편집기 줄 높이의 배율. 줄 높이는 `round(글자 크기 × 이 값)` 의 정수 px 다 (옛 엔진과 같다).
const ED_LINE_HEIGHT_RATIO=1.5;
// FR-CMR-80: sticky scroll 에 고정하는 최대 줄 수 (옛 엔진의 `stickyScroll.maxLineCount` 기본값).
const ED_STICKY_MAX=5;
// FR-CMR-72: 찾기 일치의 ruler·미니맵 색. 옛 엔진 테마의 매핑(`editorOverviewRuler.findMatchForeground` 등)을 옮겼다.
const ED_FIND_MARK_COLOR='--accent';
const ED_FIND_MARK_COLOR_CUR='--text-bright';
// EDITOR_LINK_LSP_SRS FR-ELS-30~33: 선택·같은 낱말·진단·커서의 ruler·미니맵 색과 한도.
// `--text-dim` 은 경계용이라 많은 테마에서 `--border` 와 같다 — 표식에는 쓰지 않는다.
const ED_MARK_COLOR={sel:'--text',match:'--text-hint',error:'--danger',warning:'--term-yellow',cursor:'--text-bright'};
// 편집기 칸의 스크롤바 thumb · 미니맵 슬라이더 색 (FR-ELS-55) — 옛 엔진과 같은 중립 회색 반투명이다(`deriveScrollSlider`).
const ED_SCROLL_THUMB_BG='var(--ed-thumb)';
const ED_SCROLL_THUMB_BG_HOVER='var(--ed-thumb-hover)';
const ED_SCROLL_THUMB_BG_ACTIVE='var(--ed-thumb-active)';
const ED_RULER_MATCH_MAX=1000;
// FR-ELS-45: hover 미리보기의 최대 크기. 넘치면 안에서 스크롤한다.
const ED_HOVER_MAX_W='min(600px, 70vw)';
const ED_HOVER_MAX_H='min(320px, 45vh)';
const ED_RULER_CURSOR_H=2;
// FR-ELS-31: 같은 낱말을 세는 선택의 최대 길이 — 편집기 강조(`highlightSelectionMatches`)와 같다.
const ED_MATCH_SEL_MAX=200;

/**
 * FONT_SIZE_SETTING_SRS FR-FSS-9·10 — 편집기의 글자 크기.
 *
 * **기준 13 은 여기 한 자리에 있다.** 생성과 갱신이 같은 함수를 딛는다 — 두 자리에
 * 적으면 한쪽만 고쳐진다.
 *
 * 13 이 `--fs-*` 다섯에 없는 여섯 번째 크기인 것은 `FR-TOK-18` 의 수렴 대상이
 * 아니다: 이것은 CSS 토큰이 아니라 편집기 테마의 값이고(`cm-setup.js`), 게이트
 * (`check-font-size`)가 재는 자리 밖이다. 반올림하는 것은 줄 높이를 정수 px 로
 * 두기 위해서다 (`ED_LINE_HEIGHT_RATIO`).
 */
const EDITOR_FONT_SIZE_BASE=13;
function edFontSize(){
  return Math.round(EDITOR_FONT_SIZE_BASE*uiFontSizeNow()/UI_FONT_BASE_PX);
}

// 글꼴 차례. 편집기 테마의 값이므로 CSS 토큰이 아니다 — `edFontSize` 와 같은 범주다.
const ED_FONT_FAMILY="'Menlo','Consolas','Liberation Mono','Courier New',monospace";

// ── 코드 탐색: 언어 서버의 관측 (EDITOR_LSP_SRS 묶음 A · M1) ──
//
// 조회는 POST 로 남는다(옛 계약). 본문은 비어 있다 — 경로는 서버 표에서 온다
// (REPO_FIX 02 §3A-3, FR-LSP-4b 개정).
const LSP_STATUS_API='/api/lsp/status';
const LSP_INSTALL_API='/api/lsp/install';
// REPO_FIX 02 §3A-3: 서버가 보관하는 실행 파일 경로 표 (GET 조회 · PUT 전체 교체).
const LSP_PATHS_API='/api/lsp/paths';
// CODEMIRROR_MIGRATION_SRS FR-CMR-91·102: 언어 서버 통로와 그 close code (Go `handlers_lsp_ws.go` 와 같은 값).
const LSP_WS_API='/api/lsp/ws';
const LSP_WS_CLOSE_LIMIT=4001;
const LSP_WS_CLOSE_START=4002;
const LSP_WS_CLOSE_ENDED=4003;
// FR-CMR-102: 상한에 걸려 거절된 통로의 사람 말 (알림 줄·상태 패널).
const LSP_WS_LIMIT_NOTE=t('editor.lsp_ws_limit');
// 요청 timeout — 콜드 gopls 의 첫 요청은 라이브러리 기본값(3000ms)을 넘는다 (§11.6 L1).
const ED_LSP_TIMEOUT_MS=15000;
// 상한·기동 실패로 닫힌 뒤 다시 열지 않는 시간. 입력마다 오는 동기화가 연결을 거듭 열지 않게 한다.
const ED_LSP_RETRY_MS=5000;

// ── 인코딩 (REPO_FIX 03 §3A-2) ──
// 라벨은 서버의 인코딩 id 를 사람의 표기로 옮긴다. 다시 열기 목록은 서버가 보낸다
// (`serverMeta.encodings`, K-d).
const ENC_LABEL={'utf-8':'UTF-8','utf-16le':'UTF-16 LE','utf-16be':'UTF-16 BE',
  'cp949':'CP949','shift_jis':'Shift_JIS','windows-1252':'Windows-1252'};
const ENC_TITLE=t('editor.enc_title');
// REPO_FIX 05 §3A-3 (F-2.4): dirty 문서의 마지막 뷰가 다른 대상으로 옮겨 갈 때의 확인.
const DOC_LEAVE_MSG=t('editor.doc_leave_msg');
const DOC_LEAVE_SAVE=t('editor.doc_leave_save');
const DOC_LEAVE_DISCARD=t('editor.doc_leave_discard');
const ENC_READONLY=t('editor.enc_readonly');
const ENC_REOPEN=t('editor.enc_reopen');
const ENC_CONVERT=t('editor.enc_convert');
const ENC_REOPEN_DIRTY=t('editor.enc_reopen_dirty');
const ENC_CONVERT_CONFIRM=t('editor.enc_convert_confirm');
const ENC_OK=t('editor.enc_ok');
const ENC_CANCEL=t('editor.enc_cancel');
const ENC_UNDECODABLE=t('editor.enc_undecodable');
const ENC_UNMAPPABLE=t('editor.enc_unmappable');
const ENC_DD_STAGE_UTF16=t('editor.enc_dd_stage_utf16');
const LSP_PATH_PH=t('editor.lsp_path_ph');
const LSP_PATH_SAVE=t('editor.lsp_path_save');
const LSP_PATH_CLEAR=t('editor.lsp_path_clear');
// FR-LSP-5: 어디서 찾았는지를 사람의 말로 옮기는 자리는 여기 하나다.
const LSP_ORIGIN_LABEL={
  config:t('editor.lsp_origin_label.config'),
  path:'PATH',
  managed:t('editor.lsp_origin_label.managed'),
};
const LSP_FOUND=t('editor.lsp_found');
const LSP_MISSING=t('editor.lsp_missing');
// FR-EXT-28: PATH 의 것을 쓰는 것은 정당하지만, 그것이 우리 격리의 **예외**라는
// 사실까지 조용하면 "격리했다" 는 말이 거짓이 된다.
const LSP_NOT_ISOLATED=t('editor.lsp_not_isolated');
// 팩이 내는 서버 중 일부만 선 상태. 전부 없는 것과 다른 말이어야 사용자가 다시
// 받아야 할지 판단할 수 있다.
const LSP_PARTIAL=t('editor.lsp_partial');
// FR-EXT-8: 읽지 못한 선언이 있으면 알린다 — 조용히 빠지면 사용자는 자기가 고친
// 파일이 무시된 이유를 알 수 없다.
const LSP_DECL_PROBLEM=t('editor.lsp_decl_problem');
const LSP_INSTALL=t('editor.lsp_install');
// FR-TIP-1: 라벨은 한 낱말이라 무엇을 받는지 말하지 않는다. 라벨 자체는
// 그대로다 (FR-TIP-3) — 툴팁만 더한다.
const LSP_INSTALL_TITLE='Download and install this language server';
// 경로 행 버튼의 툴팁 (FR-TIP-1·2 — 영어). 02 에서 빠졌다(CI 의 V-TIP-2 실측).
const LSP_PATH_SAVE_TITLE='Save this executable path on the server';
const LSP_PATH_CLEAR_TITLE='Clear the saved path and use the discovered executable';
const LSP_INSTALLING=t('editor.lsp_installing');
const LSP_STATUS_FAIL=t('editor.lsp_status_fail');
const LSP_UNAVAILABLE=t('editor.lsp_unavailable');
// FR-LSP-10: 결과는 사유와 함께 그 자리에 남는다.
const LSP_INSTALL_OK=t('editor.lsp_install_ok');
const LSP_PANEL_HINT=t('editor.lsp_panel_hint');

// ── 코드 탐색: 정의·참조 이동 (EDITOR_LSP_SRS 묶음 C·F · M2) ──
// FR-LSP-28: 언어 서버에 닿지 못했다. 결과가 빈 것은 알리지 않는다 (CODEMIRROR_MIGRATION_SRS §3.16).
const LSP_ASK_FAIL=t('editor.lsp_ask_fail');
// 알림 줄이 스스로 사라지기까지. 닫는 조작을 배워야 하는 알림은 알림이 아니라 창이다.
const FE_NOTE_MS=4000;
// REPO_FIX 03 §3A-2: 버튼이 있는 알림(UTF-8 로 변환해 저장)은 눌러야 하므로 더 오래 남는다.
const FE_NOTE_ACTION_MS=15000;

// ── 코드 탐색: 진단 (묶음 E · M4) ──
// FR-LSP-36: 진단을 켜고 끈다. 큰 저장소에서 저장하지 않은 파일마다 경고가 서는
// 것을 원하지 않는 사용자가 있다. **기기별**이다 — 화면의 시끄러움에 대한 취향이다.
const LSP_DIAG_KEY='lspDiagnostics';
const LSP_DIAG_LABEL=t('editor.lsp_diag_label');
const LSP_DIAG_HINT=t('editor.lsp_diag_hint');

// ── 코드 탐색: 설치 제안 (묶음 G · M5) ──
//
// FR-LSP-44·45: 서버가 없는 언어의 파일을 **처음 열 때** 제안한다. 파일마다 뜨면
// 그것이 곧 고장이므로, 닫으면 그 언어에 다시 뜨지 않는다 — 그 기억은 기기별이다.
const LSP_OFFER_KEY='lspOfferDismissed';
const LSP_OFFER_BODY=t('editor.lsp_offer_body');
// FR-EXT-29: 받을 수 없는 사유는 **서버가 사람의 말로 적어 보낸다**(`note`).
// 이것은 그 값이 비었을 때만 쓰는 안전망이다.
const LSP_OFFER_BLOCKED=t('editor.lsp_offer_blocked');
const LSP_OFFER_INSTALL=t('editor.lsp_offer_install');
const LSP_OFFER_DISMISS=t('editor.lsp_offer_dismiss');
const LSP_OFFER_SETTINGS=t('editor.lsp_offer_settings');

// ── Editor 탐색기 (EDITOR_TAB_SRS 묶음 X · FR-EDT-57~78) ──

// FR-EDT-108 의 조회 종단. 조작(create/rename/delete)은 M5 의 것이므로 여기 없다.
const FS_LIST_API='/api/fs/list';
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

// FR-EDT-77: 활성 Editor 창의 색 갱신 주기. `GIT_REPOS_POLL_MS` 를 **값으로 딛는다**
// — 같은 사실을 보는 두 화면이 다른 속도로 갱신될 이유가 없고, 두 벌로 적으면
// 한쪽만 고쳐진다.
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
  {id:REPO_SIDE_CHANGES, label:'Changes', title:'Uncommitted changes in this repository'},
  {id:REPO_SIDE_EXPLORER,label:'Explorer',title:'Browse files in this repository'},
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

// POLL_INTERVAL_SETTINGS_SRS FR-PIS-12: **별칭이 사라졌다.** `EDITOR_GIT_POLL_MS`
// 는 `GIT_REPOS_POLL_MS` 의 다른 이름일 뿐이었고, 주기가 설정이 되면 그 별칭만
// 로드 시점 값에 굳는다. 소비 지점(`_edStartGitPoll`)이 `gitReposInterval` 을
// 직접 읽으므로 "둘이 같아야 한다"(FR-EDT-77)는 요구가 **한 이름**으로 지켜진다.

// GIT_DIR_ENTRY_SRS FR-DIR-31 / D-DIR-7: **`_gitOff` 는 사유마다 수명이 다르다.**
//
// 404(`not_repo`)와 `rootMatch=false` 는 굳히지 않는다 — 그 자리에서 `git init` 이
// 일어나면 참이 거짓으로 바뀌는 사유이기 때문이다. 굳혀 두면 init 직후에도 색이
// 없고, 사용자는 init 이 실패했다고 읽는다. 대신 주기를 늦춰 계속 관측한다.
//
// 503(git 자체가 없다)만 굳는다 — 다시 물어도 답이 같다 (기존 관례).
// FR-PIS-12 / D-7: 계수만 남고 곱셈은 `editorGitBackoffMs()` 가 한다.
const EDITOR_GIT_BACKOFF_FACTOR=10;

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
const EDITOR_TREE_NEW_FILE_TITLE='New file in the selected folder';
const EDITOR_TREE_NEW_DIR=
  '<svg viewBox="0 0 16 16" aria-hidden="true">'+
  '<path d="M1.8 12.6V3.6a1.1 1.1 0 0 1 1.1-1.1h2.7l1.4 1.8h6.2a1.1 1.1 0 0 1 1.1 1.1V8"/>'+
  '<path d="M1.8 12.6a1.1 1.1 0 0 0 1.1 1.1H8"/>'+
  '<path d="M11.6 10.2v4.4M9.4 12.4h4.4"/>'+
  '</svg>';
const EDITOR_TREE_NEW_DIR_TITLE='New folder in the selected folder';
// 머리 버튼이 그림으로 넣어도 되는 값의 **전부**다. 화이트리스트로 두는 이유는
// "우리가 쓴 상수뿐" 이라는 사실을 주석이 아니라 코드가 보장하게 하기 위해서다 —
// 나중에 사용자 입력이 그 자리에 닿아도 그림이 되지 않는다.
const EDITOR_HEAD_ICONS=new Set([EDITOR_TREE_NEW_FILE,EDITOR_TREE_NEW_DIR,EDITOR_TREE_REFRESH]);
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
const FILE_TREE_DRAG_TYPE='application/x-dongminal-tree';
// WORKBENCH_REVIEW_SRS FR-WBR-41: 재조정이 지우려던 창을 미뤘다는 사실. 창 이름을
// 밝히는 이유는 FR-EDT-84 와 같다 — 개수만으로는 무엇을 정리해야 할지 모른다.
const EDITOR_HELD_DIRTY=t('editor.held_dirty');

// ── 편집기의 변경 표시 (EDITOR_DIRTY_DIFF_SRS) ──
//
// 기준은 **index** 다 (FR-EDD-1 / D-2). 서버의 부분 스테이징이 op 마다 축을
// 못박으므로(`write/patch.go:105`) 화면과 서버가 같은 축을 봐야 조각의 경계가
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
// FR-EDD-23: 색은 탐색기 트리의 규약 그대로다 (`style-editor.css:175~177`) —
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
