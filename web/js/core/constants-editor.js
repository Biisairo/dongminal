/**
 * Remote Terminal — 편집기 상수 (constants.js 에서 분리)
 *
 * 탐색기·Repo 창·미리보기 탭·파일 조작·변경 표시는 바로 뒤의 `constants-explorer.js` 다
 * (REFACTOR3_FE_REST5_SRS FR-FR5-20). 그쪽의 `ED_DD_AXIS` 가 `GIT_AXIS` 를 참조하므로 둘 다
 * `constants-git*.js` **뒤**에 로드된다 (`const` 이므로 TDZ 에 걸린다).
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
// UI_POLISH_SRS FR-UIP-19: 안내는 지금 사이드 탭을 따르고, 다음 손짓(빠른 열기)을 알린다.
const EDITOR_EMPTY_HINT_CHANGES=t('editor.empty_hint_changes');
const EDITOR_EMPTY_QUICK_OPEN=t('editor.empty_quick_open');

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
// PERF_OPTIMIZATION_SRS FR-SPA-5 (이슈 3.3): 큰 문서의 찾기는 나눠 센다. 묶음 하나(줄 수)로 끝나는 문서는
// 입력 즉시 센다. 그보다 크면 입력이 멎은 뒤(디바운스) 한 조각이 예산(ms)을 넘지 않게 묶음을 이어 센다.
const ED_FIND_CHUNK_LINES=1000;
const ED_FIND_SLICE_MS=8;
const ED_FIND_DEBOUNCE_MS=100;
// 다 세기 전에 수 칸에 보이는 표시.
const ED_FIND_BUSY='…';

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

/**
 * MOBILE_UX_OVERHAUL_SRS FR-MUX-43: 지금 줄을 바꿔 보이는가. 모바일에서는 설정과 무관하게
 * 바꾼다 — 좁은 화면에서 줄마다 가로로 미는 것은 읽을 수 없다. 설정 값은 그대로 둔다.
 */
function edWrapOn(){
  return editorWordWrap||document.body.classList.contains('mobile');
}

// 글꼴 차례. 편집기 테마의 값이므로 CSS 토큰이 아니다 — `edFontSize` 와 같은 범주다.
const ED_FONT_FAMILY="'Menlo','Consolas','Liberation Mono','Courier New',monospace";

// ── 코드 탐색: 언어 서버의 관측 (EDITOR_LSP_SRS 묶음 A · M1) ──
//
// 조회는 POST 로 남는다(옛 계약). 본문은 비어 있다 — 경로는 서버 표에서 온다
// (REPO_FIX 02 §3A-3, FR-LSP-4b 개정).
const LSP_STATUS_API='/api/lsp/status';
// UX_BATCH12 FR-LIV-10 — LSP 상태 캐시가 낡은 것으로 보이기까지의 시간.
const LSP_STATUS_TTL_MS=60000;
const LSP_INSTALL_API='/api/lsp/install';
// REPO_FIX 02 §3A-3: 서버가 보관하는 실행 파일 경로 표 (GET 조회 · PUT 전체 교체).
const LSP_PATHS_API='/api/lsp/paths';
// CODEMIRROR_MIGRATION_SRS FR-CMR-91·102: 언어 서버 통로와 그 close code (Go Go 기준선 `handlers_lsp_ws.go` 와 같은 값).
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
// UX_AUDIT_FIX_SRS FR-UXF-83: 제안한 언어의 서버가 없을 때 상태바에 서는 표식.
const LSP_OFFER_MARK='LSP';
const LSP_OFFER_MARK_TITLE='Language server for %s is not installed — click to set up';
