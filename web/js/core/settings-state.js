/**
 * Remote Terminal — 설정 전역 상태(상태바·프리셋·표시 설정·글자 크기)
 *
 * OPTIMIZE_REFACTOR_SRS FR-OPT-11-6 (FEC-24): 옛 helpers.js 에서 주제별로 갈라 왔다. 본문은
 * 바꾸지 않았다. index.html 이 옛 helpers.js 자리에 같은 순서로 싣는다.
 */

// ── Status bar state ──

const STATUS_ITEMS={
  connection:{label:t('statusbar.connection'),def:true},
  latency:{label:t('statusbar.latency'),def:true},
  location:{label:t('statusbar.location'),def:true},
  cwd:{label:t('statusbar.cwd'),def:true},
  // U-19 ① (2026-09-11 사용자 판정): **`git` 항목은 제거됐다.**
  // 몇 초 동안만 뜨는 것을 켜고 끄는 스위치는 켜 두어도 늘 안 보이므로 설정으로서
  // 뜻이 없었다. FR-GIT-112(상태바 표시)가 철회됐다 — 작업 목록 폴링 자체는
  // 남는다(FR-GIT-101a). 저장된 설정에 옛 키가 있어도 이 표를 딛는 화면은 그것을
  // 보지 않는다.
  memory:{label:t('statusbar.memory'),def:true},
  hostname:{label:t('statusbar.hostname'),def:false},
  cpu:{label:t('statusbar.cpu'),def:false},
  disk:{label:t('statusbar.disk'),def:false},
  termsize:{label:t('statusbar.termsize'),def:false},
  // REPO_FIX 03 §3A-2: 포커스 편집기 문서의 인코딩.
  encoding:{label:t('statusbar.encoding'),def:true},
  uptime:{label:t('statusbar.uptime'),def:false},
};
var statusBar={}; // {itemKey: true/false}
for(const[k,v]of Object.entries(STATUS_ITEMS))statusBar[k]=v.def;
// `statsInterval` 과 그 기본값은 settings-defaults.js 에 있다 (FR-OPT-11-4).
var layoutPresets=[]; // [{name, layout}] — layout = stripped layout tree
var defaultPreset=-1; // index into layoutPresets, -1 = none
// CONVENIENCE_SRS FR-TAN-19: 전경 프로세스 이름을 탭 이름으로 쓸지. 기본은 켬.
// /api/settings blob 에 실린다 — 브라우저 탭별이 아니라 서버의 값이어야
// `dmctl list-workspace` 가 화면과 같은 이름을 낼 수 있다 (FR-TAN-18).
var fgTabNames=true;
// WORKBENCH_REVIEW_SRS FR-WBR-10·12: 편집기의 줄바꿈. 기본은 **끔**(한 줄 보기) —
// 지금 동작이고, 코드에서 가로 스크롤은 "이 줄이 길다" 를 말한다.
// /api/settings blob 에 실린다 — 취향이지 기기의 치수가 아니다 (D-WBR-7).
var editorWordWrap=false;
// EDITOR_MINIMAP_TOGGLE_SRS FR-MMT-2: 편집기의 미니맵. 기본은 **켬** — 종전
// 동작이다. 설정을 더하는 일이 동작을 바꾸는 일이 되어서는 안 된다 (§2.2).
var editorMinimap=true;
// UX_BATCH10_SRS FR-UXB-42: **diff 의 미니맵.** 기본은 끔 — M9_SRS D-M9-5 가
// 좁은 칸의 폭을 지키려 아예 끈 자리이고, 이 설정은 그 결정을 폐기하는 것이
// 아니라 기본값으로 강등한다 (D-UXB-7). 켜도 뜨는 것은 **수정 쪽 하나**다.
var diffMinimap=false;
// UX_REVISION_SRS FR-KEY-6 철회 (D-K2): **`blockBrowserKeys` 가 없어졌다.**
// 차단은 늘 돈다 — 기본값이 이미 켬이었고, 끄는 유일한 근거였던 *"입력란에서
// 편집 키가 막힌다"* 는 면제표의 결함이었다 (FR-KEY-8 이 닫았다).
/**
 * AGENT_RENDER_ENV_SRS FR-ARE-1·3: 새 터미널의 Claude Code 를 fullscreen 으로
 * 띄울 것인가 (Settings ▸ Terminal). 기본은 **켬**이다.
 *
 * 값을 쓰는 것은 **서버**다 — 도구를 띄울 때 환경에 넣는다. 여기 사는 이유는
 * 정하는 자리가 설정 화면이기 때문이며, `claudeScrollSpeed` 와 같은 방향이다.
 */
var claudeFullscreen=true;
// PAGE_TITLE_SRS FR-PGT-4: 브라우저 탭에 뜨는 이름. /api/settings blob 에 실린다 —
// "이 서버가 무엇인가" 를 말하는 값이라 기기를 옮겨도 같아야 한다 (D-1).
// 기본값이 빈 문자열인 이유는 D-2 다: 비어 있음이 곧 기본 이름을 쓴다는 뜻이다.
var pageTitle='';
// LEAVE_CONFIRM_TOGGLE_SRS FR-LVC-4·6: 떠날 때 되물을지. /api/settings blob 에
// 실린다 — 기기를 옮겨도 같은 판단이 서야 한다 (D-2).
//
// **기본값이 거짓인 것이 규칙이다** (D-1). 접수한 요구가 "묻지 않기" 이므로,
// 켬을 기본으로 두면 요구는 이뤄지지 않은 채 설정 항목만 하나 늘어난다.
var confirmLeave=false;
// M8_UNIFIED_SRS FR-B-1·4: UI 언어. /api/settings blob 에 실린다 — 기기를 옮겨도
// 같은 언어여야 한다. **활성 로케일은 `I18N.locale` 이고 이 값은 저장할 값이다** —
// 둘이 다른 순간은 사용자가 고르고 페이지가 다시 열리기 전뿐이다 (D-B-1).
var uiLocale=I18N.locale;
/**
 * BROWSER_TAB_SRS FR-BRT-14·32·68·90: 브라우저 탭 설정. 값을 쓰는 것은 셋이다 —
 * 서버(여는 위치·새 탭의 프로필·소리는 `settings.json` 에서 읽는다)와 이 화면(링크).
 * 기기를 옮겨도 같은 판단이 서야 하므로 /api/settings blob 에 실린다.
 */
var browserOpenPlacement='split';
var browserLinkTarget='internal';
var browserDefaultProfile='default';
var browserAudio='off';
// FR-BRT-80: 비면 서버 사용자의 ~/Downloads 다. 브라우저를 다음에 띄울 때 적용된다.
var browserDownloadDir='';
// `focusEdgeLevel`·`attnEdgeLevel` 은 settings-defaults.js 에 있다 (FR-OPT-11-4).
/**
 * TAB_WIDTH_SRS FR-TBW-1·2: 탭 너비 고정과 그 폭.
 *
 * 기본은 **끔**이며 그때의 동작은 종전과 완전히 같다 (FR-TBW-9) — 이 기능은 켠
 * 사람에게만 보인다. 폭의 기본 160 은 VSCode 의 `tabSizingFixedMaxWidth` 기본과
 * 같은 값이다.
 */
var tabFixedWidth=false;

/**
 * 폭을 **CSS 변수 하나**로 전달한다 (NFR-TBW-1) — 탭마다 인라인 스타일을 쓰면
 * 탭 수만큼 재계산이 늘고 규칙이 CSS 와 JS 두 곳에 갈린다.
 *
 * 켜고 끄는 것도 클래스 토글 하나다 (NFR-TBW-2) — 렌더러가 탭을 다시 만들지
 * 않으므로 스크롤 위치와 드래그 상태가 그대로 남는다.
 */
function applyTabWidth(){
  const px=clampSetting('tabWidthPx',tabWidthPx);
  document.documentElement.style.setProperty('--tab-w',px+'px');
  document.body.classList.toggle('tabfix',!!tabFixedWidth);
}

/**
 * FONT_SIZE_SETTING_SRS FR-FSS-3·12 — 글자 크기 둘.
 *
 * **초기값을 여기 적지 않는다.** 기본값은 서술자 표가 갖고(FR-CFG-1), 설정이
 * 오기 전의 화면은 CSS 의 `--fs-scale:1` 이 낸다 — 여기에 `100` 을 적으면 같은
 * 값이 세 자리(표·CSS·여기)에 서고, 그 중 하나만 고쳐지는 날이 온다.
 */
var uiFontSize;
var termFontSize;
// AGENT_RENDER_ENV_SRS FR-ARE-8: 값을 들고 저장할 뿐, 얹을 화면이 없다 —
// 서버가 도구를 띄울 때 환경변수로 넣는다.
var claudeScrollSpeed;

/** 지금 쓸 값. 설정이 아직 오지 않았으면 표의 기본값이다. */
function uiFontSizeNow(){ return uiFontSize??SETTINGS_BY_KEY.uiFontSize.def }
function termFontSizeNow(){ return termFontSize??SETTINGS_BY_KEY.termFontSize.def }

/**
 * FR-FSS-3: 배율을 **CSS 변수 하나**로 전달한다.
 *
 * 자리마다 인라인 스타일을 쓰지 않는 근거는 `applyTabWidth` 와 같다
 * (TAB_WIDTH_SRS NFR-TBW-1) — 토큰 정의부 한 곳이 움직이면 그것을 가리키는
 * 374곳이 따라온다.
 */
function applyUiFontScale(){
  document.documentElement.style.setProperty('--fs-scale',String(uiFontSizeNow()/UI_FONT_BASE_PX));
}

/**
 * FR-FSS-2c: 옛 키 `uiFontScale`(%) 을 **한 번** `uiFontSize`(px) 로 옮긴다.
 *
 * 서버의 `Validate` 는 모르는 키를 거부하지 않고 `unknown` 으로 돌려주므로
 * (`settingsschema/schema.go:166`) 이관 전에도 저장은 막히지 않는다 — 그래서
 * 이 함수는 **값을 잃지 않기 위한 것**이지 오류를 피하기 위한 것이 아니다.
 *
 * 옛 키는 받은 블롭에서 지운다. **서버에서 사라지는 것은 다음 저장 때**다 —
 * PUT 본문은 `SETTINGS_ACCESS` 의 `get()` 으로 조립되므로 표에 없는 키는 실리지
 * 않는다 (FR-CFG-6). 강제로 한 번 더 저장하지 않는 이유가 그것이다.
 */
function migrateUiFontScale(blob){
  if(!blob||typeof blob!=='object') return blob;
  if(!('uiFontScale' in blob)) return blob;
  if(blob.uiFontSize===undefined||blob.uiFontSize===null){
    const pct=Number(blob.uiFontScale);
    if(isFinite(pct)) blob.uiFontSize=clampSetting('uiFontSize',Math.round(UI_FONT_BASE_PX*pct/100));
  }
  delete blob.uiFontScale;
  return blob;
}

// `lspDiagOn` 은 lsp-paths.js 에 있다 — 저장소(PrefStore)를 딛는 초기값이라서다.
function effectiveTitle(){return (pageTitle||'').trim()||DEFAULT_PAGE_TITLE}
