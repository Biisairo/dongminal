/**
 * Remote Terminal — 단축키 파싱·기본표·라벨
 *
 * OPTIMIZE_REFACTOR_SRS FR-OPT-11-6 (FEC-24): 옛 helpers.js 에서 주제별로 갈라 왔다. 본문은
 * 바꾸지 않았다. index.html 이 옛 helpers.js 자리에 같은 순서로 싣는다 `SHORTCUT_DEFAULTS`·`SHORTCUT_LABELS` 는
 * `scripts/check-shortcuts-docs.mjs` 가 이 파일에서 읽는다.
 */

// ── Shortcut parsing ──

// `Mod` 는 Ctrl 과 Cmd 중 **그 호스트가 쓰는 쪽**을 뜻한다.
//
// 왜 필요한가: 단축키 설정은 서버에 한 벌로 산다(app-settings). 기본값을 `Ctrl`
// 이나 `Meta` 중 하나로 적으면 다른 OS 의 관용을 버려야 한다 — macOS 에서
// `cmd+p`, Windows 에서 `ctrl+p` 가 둘 다 파일 검색이어야 하는데 그 둘은 다른
// 조합이다. 종전에는 그래서 이 키들이 코드에 박혀 있었고(`e.metaKey||e.ctrlKey`),
// 박혀 있었기 때문에 바꿀 수 없었다.
//
// 사용자가 직접 녹음한 키에는 이 수식자가 없다 — `fmtShortcut` 은 실제로 누른
// 조합을 그대로 굳힌다. 관용은 기본값의 성질이지 기록의 성질이 아니다.
function parseShortcut(s){const p=s.split('+');const k=p.pop();return{mod:p.includes('Mod'),ctrl:p.includes('Ctrl'),alt:p.includes('Alt'),meta:p.includes('Meta'),shift:p.includes('Shift'),code:k}}
function matchShortcut(e,s){
  if(!s)return false;
  const p=parseShortcut(s);
  if(e.altKey!==p.alt||e.shiftKey!==p.shift||e.code!==p.code)return false;
  // Mod 는 Ctrl 또는 Meta 중 **정확히 하나**다. 둘 다 누른 조합까지 받으면
  // `Ctrl+Cmd+F` 를 따로 배정한 사용자의 키를 가로챈다.
  if(p.mod)return e.ctrlKey!==e.metaKey;
  return e.ctrlKey===p.ctrl&&e.metaKey===p.meta;
}
function fmtShortcut(e){const p=[];if(e.ctrlKey)p.push('Ctrl');if(e.altKey)p.push('Alt');if(e.metaKey)p.push('Meta');if(e.shiftKey)p.push('Shift');p.push(e.code);return p.join('+')}
function displayKey(s){return s.replace(/Key/g,'').replace(/BracketLeft/g,'[').replace(/BracketRight/g,']').replace(/Slash/g,'/').replace(/Mod/g,'⌘/⌃').replace(/Meta/g,'⌘').replace(/Ctrl/g,'⌃').replace(/Alt/g,'⌥').replace(/Shift/g,'⇧').replace(/Arrow/g,'')}

// ── Shortcut state ──

// 사이드바 탭의 직행 키(`sidebarTab1`~)는 **여기 없다.** 서술자 배열에서 파생되며
// sidebar-tabs.js 가 이 맵과 SHORTCUT_LABELS·shortcuts 를 함께 늘린다 (FR-SBT-30).
const SHORTCUT_DEFAULTS={
  windowNext:'Ctrl+Shift+BracketRight',windowPrev:'Ctrl+Shift+BracketLeft',
  tabNext:'Ctrl+Tab',tabPrev:'Ctrl+Shift+Tab',
  paneUp:'Ctrl+Shift+ArrowUp',paneDown:'Ctrl+Shift+ArrowDown',paneLeft:'Ctrl+Shift+ArrowLeft',paneRight:'Ctrl+Shift+ArrowRight',
  splitH:'Ctrl+Shift+KeyH',splitV:'Ctrl+Shift+KeyV',
  newWindow:'Ctrl+Shift+KeyN',newTab:'Ctrl+Shift+KeyT',
  closeWindow:'Ctrl+Shift+KeyW',closeTab:'Ctrl+Shift+KeyD',
  agentsToggle:'Ctrl+Shift+KeyA',
  // WINDOW_SLOTS_SRS FR-WSL-51: 칸 더하기·빼기. `S`(Slot)·`X`(빼기) 둘 다 비어
  // 있던 자리다.
  slotAdd:'Ctrl+Shift+KeyS',
  slotRemove:'Ctrl+Shift+KeyX',
  // FR-WSL-56 (2026-09-08 접수): 칸 **사이의 이동**. 종전에는 키를 두지 않고
  // pane 이동이 창의 끝에서 넘어가는 데 맡겼다 (D-5) — 그 결정을 뒤집는다.
  // 대괄호인 것은 `windowPrev`·`windowNext` 와 **같은 관용**이기 때문이고,
  // 모디파이어가 `Alt` 인 것은 `Ctrl+Shift+[`·`]` 가 그쪽 것이기 때문이다.
  slotPrev:'Ctrl+Alt+BracketLeft',
  slotNext:'Ctrl+Alt+BracketRight',
  // PANEL_SHORTCUTS_SRS FR-PSC-1/2: 상단 툴바의 나머지 두 진입점. `Runs` 가 `O`
  // 인 이유는 `R` 을 쓸 수 없기 때문이다 — 아래 D-6 과 같은 근거다.
  bgToggle:'Ctrl+Shift+KeyB',
  runsToggle:'Ctrl+Shift+KeyO',
  // SIDEBAR_COLLAPSE_SRS FR-SBC-7a: 사이드바 접기/펼치기. 손잡이 드래그와 **같은
  // 함수**를 부른다 — 마우스가 유일한 길이면 키보드만 쓰는 사람에게는 길이 없다.
  // `E`(Explorer)는 이 목록에서 비어 있던 자리다.
  sidebarToggle:'Ctrl+Shift+KeyE',
  // SOFT_RELOAD_SRS FR-SRL-9: `R` 계열은 브라우저가 가져가므로 쓸 수 없다 (D-6).
  softReload:'Ctrl+Shift+KeyK',
  // EDITOR_GIT_UX_SRS FR-EKB-5: Editor 창의 검색 셋. 종전에는 키가 코드에 박혀
  // 있어 바꿀 수 없었다. `Mod` 인 이유는 두 OS 의 관용이 다르기 때문이다.
  edFindInFile:'Mod+KeyF',
  edQuickOpen:'Mod+KeyP',
  edGrep:'Mod+Shift+KeyF',
  // EDITOR_LSP_SRS FR-LSP-40 / D-10: 코드 탐색 셋. 기본이 `F12` 인 것은 그것이
  // 이 동작의 관용이기 때문이며, 대가는 **편집기 안에서 그 키로 개발자 도구가
  // 열리지 않는 것**이다 (`KEY_BLOCK_EXEMPT_BARE` 에 F12 가 있으나 우리가 먼저
  // 잡는다). 관용을 버리면 사용자가 그 기능이 있는지 알 방법이 없다.
  edGotoDef:'F12',
  edFindRefs:'Shift+F12',
  edNavBack:'Mod+Alt+Minus',
  // UX_BATCH9_SRS FR-ESV-3: 편집기 저장. 종전에는 Monaco 의 `addCommand` 로 코드에
  // 박혀 있었고(FR-EKB-5 가 금한 그 방식), 그 등록이 **인스턴스가 아니라 전역**이라
  // 편집기를 둘 열면 `Cmd+S` 가 마지막에 만든 편집기로 갔다 — 그쪽이 dirty 가
  // 아니면 아무 일도 일어나지 않는다 (SRS §2.1).
  edSave:'Mod+KeyS',
  /**
   * `12-func-ui.md FUI-07`: **모두 저장.**
   *
   *   이전 동작: `_edWinSaveDirty` 는 **창 닫기 확인창에서만** 불렸다. 여러
   *             파일을 고치면 탭마다 `Cmd+S` 이고, 그 일을 한 번에 하는 길은
   *             "창을 닫으려 해 보는 것" 뿐이었다
   *   새  동작: 액션 하나가 그 함수를 부른다
   *   이유:     있던 동작에 진입점이 없던 것이다 — 없던 기능이 아니다
   *
   * `Mod+Alt+KeyS` 인 것은 `Mod+Shift+KeyS` 가 브라우저·OS 에서 자주 잡혀 있기
   * 때문이다 (`edNavBack` 이 같은 이유로 `Mod+Alt` 를 쓴다).
   */
  edSaveAll:'Mod+Alt+KeyS',
  // 로드맵 M7 `UX-22`: 단축키 **목록으로 가는 키.** 목록은 설정 안에 있었지만
  // 거기 닿는 키가 없었다 — 키를 모르는 사람이 키 목록을 찾는 길이 마우스뿐이면
  // 목록은 이미 아는 사람만 본다. `?` 의 관용이며 `Ctrl+Shift` 는 이 앱의 관용이다.
  /**
   * M9_SRS FR-M9-25: **보던 자리 오가기.**
   *
   * `Ctrl+Shift` 는 이 앱의 관용이고 `,`·`.` 는 `<`·`>` 의 자리라 방향을 그대로
   * 말한다. 화살표를 쓰지 않는 것은 `Ctrl+Shift+화살표` 가 pane 이동의 것이기
   * 때문이고, `Mod+Alt+화살표` 를 쓰지 않는 것은 macOS 의 Chrome 이 그것을
   * **브라우저 탭 전환**으로 이미 쓰기 때문이다 (사용자 결정 2026-09-14).
   */
  focusBack:'Ctrl+Shift+Comma',
  focusForward:'Ctrl+Shift+Period',
  shortcutsHelp:'Ctrl+Shift+Slash',
  // BROWSER_TAB_SRS FR-BRT-56: 브라우저 탭 UI 단축키. **그 탭에 포커스가 있을 때만**
  // 돈다 — 전역 배선은 이 이름들을 건너뛴다(`BRV_ACTIONS`). `Mod` 인 것은 두 OS 의
  // 브라우저 관용이 다르기 때문이다. `F5`·`Alt+←/→` 는 고정 보조 키다(app-browser.js).
  brvAddress:'Mod+KeyL',
  brvReload:'Mod+KeyR',
  brvHardReload:'Mod+Shift+KeyR',
  brvBack:'Mod+BracketLeft',
  brvForward:'Mod+BracketRight',
  brvZoomIn:'Mod+Equal',
  brvZoomOut:'Mod+Minus',
  brvZoomReset:'Mod+Digit0',
  // 3단계: DevTools (`F12` 는 고정 보조 키 — 표의 `edGotoDef` 와 같은 조합이다). 찾기(`Mod+F`)는
  // 터미널 검색처럼 고정 키다 — 표의 `edFindInFile` 과 같은 조합이다.
  brvDevtools:'Mod+Alt+KeyI',
};
const SHORTCUT_LABELS={
  // GIT_SIDEBAR_TABS_SRS FR-SBT-31·33: 이 키는 **활성 사이드바 탭의 목록**을 순회한다
  // (Windows 탭이면 창, Git 탭이면 리포). 모드 의존이 되었으므로 설명이 따라간다.
  focusBack:t('shortcut.focus_back'),focusForward:t('shortcut.focus_forward'),
  windowNext:t('shortcut.window_next'),windowPrev:t('shortcut.window_prev'),
  tabNext:t('shortcut.tab_next'),tabPrev:t('shortcut.tab_prev'),
  paneUp:t('shortcut.pane_up'),paneDown:t('shortcut.pane_down'),
  paneLeft:t('shortcut.pane_left'),paneRight:t('shortcut.pane_right'),
  splitH:t('shortcut.split_h'),splitV:t('shortcut.split_v'),
  newWindow:t('shortcut.new_window'),newTab:t('shortcut.new_tab'),
  closeWindow:t('shortcut.close_window'),closeTab:t('shortcut.close_tab'),
  agentsToggle:t('shortcut.agents_toggle'),
  slotAdd:t('shortcut.slot_add'),
  slotRemove:t('shortcut.slot_remove'),
  slotPrev:t('shortcut.slot_prev'),
  slotNext:t('shortcut.slot_next'),
  bgToggle:t('shortcut.bg_toggle'),
  sidebarToggle:t('shortcut.sidebar_toggle'),
  runsToggle:t('shortcut.runs_toggle'),
  softReload:t('shortcut.soft_reload'),
  edGotoDef:t('shortcut.ed_goto_def'),
  edFindRefs:t('shortcut.ed_find_refs'),
  edNavBack:t('shortcut.ed_nav_back'),
  edFindInFile:t('shortcut.ed_find_in_file'),
  edQuickOpen:t('shortcut.ed_quick_open'),
  edGrep:t('shortcut.ed_grep'),
  edSave:t('shortcut.ed_save'),
  edSaveAll:t('shortcut.ed_save_all'),
  shortcutsHelp:t('shortcut.shortcuts_help'),
  brvAddress:t('shortcut.brv_address'),
  brvReload:t('shortcut.brv_reload'),
  brvHardReload:t('shortcut.brv_hard_reload'),
  brvBack:t('shortcut.brv_back'),
  brvForward:t('shortcut.brv_forward'),
  brvZoomIn:t('shortcut.brv_zoom_in'),
  brvZoomOut:t('shortcut.brv_zoom_out'),
  brvZoomReset:t('shortcut.brv_zoom_reset'),
  brvDevtools:t('shortcut.brv_devtools'),
  // `DOC-3` (M5): 기본값은 있는데 **라벨이 없었다.** 라벨이 없으면 Settings ▸
  // Shortcuts 의 목록에 뜨지 않고, 뜨지 않으면 사용자가 바꿀 수 없다 — 바꿀 수
  // 있다고 적힌 문서가 그 순간 거짓이 된다.
};

// 이 셋은 **Editor 창에서만** 뜻이 있다 (FR-EKB-4). 다른 창에서 같은 키를 눌렀을
// 때 삼키지 않고 다음 배선으로 넘기려면, 그 사실을 아는 자리가 이름 하나로
// 있어야 한다 — 터미널 창의 `Mod+F` 는 종전대로 터미널 검색이다.
const ED_SEARCH_ACTIONS={
  edFindInFile:'_edFindInFile',
  edQuickOpen:'_edQuickOpen',
  edGrep:'_edSearchOpen',
  // FUI-07: **창**이 수행한다 — `ED_VIEW_ACTIONS`(편집기 인스턴스의 것)가 아니라
  // 이쪽이다. "어느 편집기가" 가 답의 일부가 아니고, 답은 "이 창의 전부" 다.
  edSaveAll:'_edSaveAll',
};

// EDITOR_LSP_SRS 묶음 F — 코드 탐색 셋. 검색 셋과 나눠 두는 이유는 **게이트가
// 다르기** 때문이다: 검색은 루트만 있으면 되고, 이쪽은 편집기가 실제로 서 있어야
// 한다 (FR-LSP-40b).
const ED_LSP_ACTIONS={
  edGotoDef:'_lspGotoDef',
  edFindRefs:'_lspFindRefs',
  edNavBack:'_lspNavBack',
};

// UX_BATCH9_SRS FR-ESV-2: 편집기 **인스턴스**가 수행하는 액션.
//
// 위의 여섯과 수행 주체가 다르다 — 그쪽은 app 의 메서드이고 이쪽은 `FileEditor`
// 의 메서드다. "어느 편집기가" 가 답의 일부이므로 app 이 대신 고를 수 없다.
const ED_VIEW_ACTIONS={
  edSave:'save',
};

// 편집기 안에서 **우리가 먼저 잡는** 액션 전부다.
//
// 한 이름으로 두는 이유는 이 표를 읽는 자리가 둘이기 때문이다 — 편집기 안팎의
// 판정(`edTrySearchKey`)과, 전역 배선이 그 셋을 건너뛰는 자리
// (`input-binding.js`). 두 벌로 적으면 새 액션을 더할 때 한쪽만 고쳐지고, 그러면
// 그 키가 Editor 창이 아닐 때 삼켜져 죽은 키가 된다 (FR-EKB-4).
// app 이 수행하는 것 — `edTrySearchKey` 가 이 표를 돈다.
const ED_APP_ACTIONS={...ED_SEARCH_ACTIONS,...ED_LSP_ACTIONS};
// 전역 배선이 건너뛰어야 하는 것 전부 — 수행 주체와 무관하다 (input-binding.js).
const ED_CAPTURE_ACTIONS={...ED_APP_ACTIONS,...ED_VIEW_ACTIONS};
var shortcuts={...SHORTCUT_DEFAULTS};
