/**
 * Remote Terminal — helper functions and shared state
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
function displayKey(s){return s.replace(/Key/g,'').replace(/BracketLeft/g,'[').replace(/BracketRight/g,']').replace(/Mod/g,'⌘/⌃').replace(/Meta/g,'⌘').replace(/Ctrl/g,'⌃').replace(/Alt/g,'⌥').replace(/Shift/g,'⇧').replace(/Arrow/g,'')}

// ── HTML escaping ──

// escHtml 은 문자열을 HTML 에 넣기 전에 무해하게 만든다 (FR-CAF-17).
//
// **한 벌인 것이 요점이다.** 종전에는 두 벌이 따로 있었고(file-editor 의 `_esc`,
// app-edsearch 의 지역 `esc`), 이미 조용히 갈라져 있었다 — 한쪽은 홑따옴표를
// 막고 다른 쪽은 막지 않았다. 이스케이프가 갈라지는 것은 그 자체로 결함이다:
// 어느 자리가 무엇을 막는지 말할 수 없게 된다.
//
// 홑따옴표까지 막는 쪽으로 통일한다. 값이 `alt="..."` 같은 속성에 들어가는
// 자리가 실재하고(file-editor 의 이미지 뷰어), 속성 따옴표는 어느 쪽이든 될 수
// 있다.
function escHtml(s){
  return String(s==null?'':s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ── Theme helpers ──

const UI_LABELS={bg:'Background',sidebarBg:'Sidebar',border:'Border',accent:'Accent',text:'Text',textMuted:'Muted',textBright:'Bright',textDim:'Dim',danger:'Danger',accentBorder:'Accent Bd'};
const TERM_LABELS={background:'BG',foreground:'FG',cursor:'Cursor',selectionBackground:'Select',black:'Black',red:'Red',green:'Green',yellow:'Yellow',blue:'Blue',magenta:'Magenta',cyan:'Cyan',white:'White',brightBlack:'BrBlk',brightRed:'BrRed',brightGreen:'BrGrn',brightYellow:'BrYlw',brightBlue:'BrBlu',brightMagenta:'BrMag',brightCyan:'BrCyn',brightWhite:'BrWht'};

function hexToRgba(hex,a){const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);return`rgba(${r},${g},${b},${a})`}
function hexRgb(hex){if(typeof hex!=='string'||hex[0]!=='#'||hex.length<7)return null;return{r:parseInt(hex.slice(1,3),16),g:parseInt(hex.slice(3,5),16),b:parseInt(hex.slice(5,7),16)}}
// 알림 강조색: 팔레트(테마 terminal 색) 중 accent(포커스)와 가장 대비되는 색을 고른다.
// 색을 하드코딩하지 않고, accent 가 노랑/주황인 테마에서도 포커스와 겹치지 않게 한다(FR-PAN-10).
function pickAttnColor(t){
  const T=t.terminal||{};
  const fallback=T.brightYellow||T.yellow||'#e0af68';
  const acc=hexRgb(t.ui&&t.ui.accent);
  const cands=[T.brightYellow||T.yellow,T.brightMagenta||T.magenta,T.brightCyan||T.cyan,T.brightGreen||T.green].filter(Boolean);
  if(!acc||!cands.length) return fallback;
  let best=cands[0],bestD=-1;
  for(const c of cands){const rgb=hexRgb(c);if(!rgb)continue;const d=(rgb.r-acc.r)**2+(rgb.g-acc.g)**2+(rgb.b-acc.b)**2;if(d>bestD){bestD=d;best=c}}
  return best;
}

// 섹션 경계선은 행 구분선보다 진해야 구분이 된다 (FR-GIT-216). 팔레트에 그런 색이
// 없고, `--text-dim` 같은 기존 토큰을 빌리면 테마마다 밝기 관계가 달라 어떤 테마
// 에서는 오히려 흐려진다 — border 를 text 쪽으로 섞으면 밝은 테마·어두운 테마 모두
// 에서 바탕과의 대비가 반드시 커진다.
function mixHex(a,b,t){
  const x=hexRgb(a),y=hexRgb(b);
  if(!x||!y) return a;
  const c=k=>Math.round(x[k]+(y[k]-x[k])*t).toString(16).padStart(2,'0');
  return '#'+c('r')+c('g')+c('b');
}
const BORDER_STRONG_MIX=.35;
// SLOT_TITLE_BOUNDARY_SRS FR-STB-21·22: 슬롯 경계색. `--border-strong` 과 같은
// 방식이되 섞는 상대가 accent 다 — border 쪽은 "이것은 경계다", accent 쪽은 "이
// 경계는 주목을 요구한다" 는 뜻이다. terminal(ANSI) 팔레트에서 뽑지 않는 이유는
// 그 색들이 터미널 텍스트를 위해 고른 것이지 UI 조화를 위해 고른 것이 아니어서다.
// 값을 바꿀 때는 border·accent·bg 세 축의 거리를 함께 확인한다 (FR-STB-23).
const SLOT_EDGE_MIX=.55;

function applyThemeObj(t){
  const s=document.documentElement.style;
  const ui=t.ui;
  s.setProperty('--bg',ui.bg);
  s.setProperty('--sidebar-bg',ui.sidebarBg);
  s.setProperty('--border',ui.border);
  s.setProperty('--accent',ui.accent);
  s.setProperty('--text',ui.text);
  s.setProperty('--text-muted',ui.textMuted);
  s.setProperty('--text-bright',ui.textBright);
  s.setProperty('--text-dim',ui.textDim);
  s.setProperty('--danger',ui.danger);
  s.setProperty('--accent-border',ui.accentBorder);
  s.setProperty('--border-strong',mixHex(ui.border,ui.text,BORDER_STRONG_MIX));
  s.setProperty('--slot-edge',mixHex(ui.border,ui.accent,SLOT_EDGE_MIX));
  s.setProperty('--accent-hover',hexToRgba(ui.accent,.1));
  s.setProperty('--accent-active',hexToRgba(ui.accent,.12));
  s.setProperty('--accent-subtle',hexToRgba(ui.accent,.08));
  // 주의 알림색은 팔레트 중 accent(포커스)와 가장 대비되는 색 — 포커스와 겹치지 않게 (FR-PAN-10)
  const attn=pickAttnColor(t);
  s.setProperty('--attn',attn);
  s.setProperty('--attn-subtle',hexToRgba(attn,.16));
  s.setProperty('--attn-glow',hexToRgba(attn,.5));
  TOPTS.theme=t.terminal;
  document.getElementById('area').style.background=ui.bg;
  for(const p of app.tools.values()){if(p.term)p.term.options.theme=t.terminal}
  if(typeof FileEditor!=='undefined'&&FileEditor.applyTheme) FileEditor.applyTheme();
  // FR-GIT-119: 레인 색은 테마 팔레트에서 파생한다 — 테마를 바꾸면 그래프도
  // 따라 바뀐다 (V47).
  if(typeof GitHistory!=='undefined'&&GitHistory.applyTheme) GitHistory.applyTheme();
}

function getCurrentTheme(){return customTheme||THEMES[currentThemeName]}

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
  // 있던 자리다. 칸 **사이의 이동**에는 키를 만들지 않는다 — pane 이동이 창의
  // 끝에서 넘어간다 (FR-WSL-40, D-5).
  slotAdd:'Ctrl+Shift+KeyS',
  slotRemove:'Ctrl+Shift+KeyX',
  // PANEL_SHORTCUTS_SRS FR-PSC-1/2: 상단 툴바의 나머지 두 진입점. `Runs` 가 `O`
  // 인 이유는 `R` 을 쓸 수 없기 때문이다 — 아래 D-6 과 같은 근거다.
  bgToggle:'Ctrl+Shift+KeyB',
  runsToggle:'Ctrl+Shift+KeyO',
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
};
const SHORTCUT_LABELS={
  // GIT_SIDEBAR_TABS_SRS FR-SBT-31·33: 이 키는 **활성 사이드바 탭의 목록**을 순회한다
  // (Windows 탭이면 창, Git 탭이면 리포). 모드 의존이 되었으므로 설명이 따라간다.
  windowNext:'다음 항목 (활성 탭 기준)',windowPrev:'이전 항목 (활성 탭 기준)',
  tabNext:'다음 탭',tabPrev:'이전 탭',
  paneUp:'Pane ↑',paneDown:'Pane ↓',paneLeft:'Pane ←',paneRight:'Pane →',
  splitH:'가로 분할',splitV:'세로 분할',
  newWindow:'새 창',newTab:'새 탭',
  closeWindow:'창 닫기',closeTab:'탭 닫기',
  agentsToggle:'에이전트 패널',
  slotAdd:'창 슬롯 더하기',
  slotRemove:'창 슬롯 빼기',
  bgToggle:'백그라운드 도구',
  runsToggle:'Run 오케스트레이션',
  softReload:'내부 새로고침',
  edGotoDef:'정의로 이동 (Editor)',
  edFindRefs:'참조 찾기 (Editor)',
  edNavBack:'이동 뒤로 (Editor)',
  edFindInFile:'파일 내에서 검색 (Editor)',
  edQuickOpen:'파일 검색 (Editor)',
  edGrep:'파일 전체에서 검색 (Editor)',
};

// 이 셋은 **Editor 창에서만** 뜻이 있다 (FR-EKB-4). 다른 창에서 같은 키를 눌렀을
// 때 삼키지 않고 다음 배선으로 넘기려면, 그 사실을 아는 자리가 이름 하나로
// 있어야 한다 — 터미널 창의 `Mod+F` 는 종전대로 터미널 검색이다.
const ED_SEARCH_ACTIONS={
  edFindInFile:'_edFindInFile',
  edQuickOpen:'_edQuickOpen',
  edGrep:'_edSearchOpen',
};

// EDITOR_LSP_SRS 묶음 F — 코드 탐색 셋. 검색 셋과 나눠 두는 이유는 **게이트가
// 다르기** 때문이다: 검색은 루트만 있으면 되고, 이쪽은 편집기가 실제로 서 있어야
// 한다 (FR-LSP-40b).
const ED_LSP_ACTIONS={
  edGotoDef:'_lspGotoDef',
  edFindRefs:'_lspFindRefs',
  edNavBack:'_lspNavBack',
};

// 편집기 안에서 **우리가 먼저 잡는** 액션 전부다.
//
// 한 이름으로 두는 이유는 이 표를 읽는 자리가 둘이기 때문이다 — 편집기 안팎의
// 판정(`_edTrySearchKey`)과, 전역 배선이 그 셋을 건너뛰는 자리
// (`input-binding.js`). 두 벌로 적으면 새 액션을 더할 때 한쪽만 고쳐지고, 그러면
// 그 키가 Editor 창이 아닐 때 삼켜져 죽은 키가 된다 (FR-EKB-4).
const ED_CAPTURE_ACTIONS={...ED_SEARCH_ACTIONS,...ED_LSP_ACTIONS};
var shortcuts={...SHORTCUT_DEFAULTS};

// ── Status bar state ──

const STATUS_ITEMS={
  connection:{label:'연결 상태',def:true},
  latency:{label:'레이턴시',def:true},
  location:{label:'현재 위치 (dmctl 대상)',def:true},
  cwd:{label:'현재 디렉토리',def:true},
  git:{label:'Git 원격 작업 진행',def:true},
  memory:{label:'메모리',def:true},
  hostname:{label:'호스트명',def:false},
  cpu:{label:'CPU',def:false},
  disk:{label:'디스크',def:false},
  termsize:{label:'터미널 크기',def:false},
  uptime:{label:'업타임',def:false},
};
var statusBar={}; // {itemKey: true/false}
for(const[k,v]of Object.entries(STATUS_ITEMS))statusBar[k]=v.def;
var statsInterval=3000;
var layoutPresets=[]; // [{name, layout}] — layout = stripped layout tree
var defaultPreset=-1; // index into layoutPresets, -1 = none
// CONVENIENCE_SRS FR-TAN-19: 전경 프로세스 이름을 탭 이름으로 쓸지. 기본은 켬.
// /api/settings blob 에 실린다 — 브라우저 탭별이 아니라 서버의 값이어야
// `dmctl list-workspace` 가 화면과 같은 이름을 낼 수 있다 (FR-TAN-18).
var fgTabNames=true;
// UX_REVISION_SRS FR-KEY-6: 브라우저 기본 단축키 차단. 기본은 켬 — 이 앱은
// 터미널이고, Ctrl 조합은 브라우저보다 터미널의 것이다.
var blockBrowserKeys=true;
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
// EDITOR_LSP_SRS FR-LSP-3·4b: 언어 서버의 절대경로를 사용자가 직접 적은 표
// (서술자 id → 경로). **기기별이다** — 서버 실행 파일의 자리는 그 기계의 사실이고,
// 서버 설정에 두면 다른 기계의 경로가 따라와 없는 파일을 가리킨다.
//
// M1 에서는 비어 있다. 이것을 편집하는 자리는 M5 의 것이며, 지금 있는 이유는
// 탐색의 첫째 순위가 **요청에 실려야** 하기 때문이다 (설정 블롭은 서버가 해석하지
// 않는다).
var lspServerPaths={};
// EDITOR_LSP_SRS FR-LSP-36: 진단(에러·경고 밑줄)을 켤지. 기본은 켬 — 언어 서버를
// 세웠다면 그것이 찾은 문제를 보는 것이 기본값으로 옳다. **기기별**인 이유는
// 화면의 시끄러움에 대한 취향이기 때문이다.
var lspDiagOn=true;
try{
  const raw=localStorage.getItem('lspDiagnostics');
  if(raw!==null) lspDiagOn=raw!=='0';
}catch{}
try{
  const raw=localStorage.getItem('lspServerPaths');
  if(raw){const o=JSON.parse(raw); if(o&&typeof o==='object') lspServerPaths=o}
}catch{}
function effectiveTitle(){return (pageTitle||'').trim()||DEFAULT_PAGE_TITLE}

// ── Layout helpers ──

function normalizeTab(t) {
  if (!t.type) t.type = t.toolId ? 'terminal' : 'editor';
  return t;
}

// FR-EM-13: 도구 타입별 능력. 백그라운드로 보낼 수 있는 도구는 서버(데몬)가
// 소유하는 실행 실체가 있는 것뿐이다 — editor 는 브라우저 메모리에만
// 존재하므로 탭에서 떼어낼 실체가 없다. git 탭도 같다 — PTY 가 없고, 애초에
// 닫히지도 않는 고정 탭이다 (FR-GIT-28).
const TOOL_CAPABILITIES = {
  terminal: { backgroundCapable: true },
  editor:   { backgroundCapable: false },
  git:      { backgroundCapable: false },
};
function toolBackgroundCapable(type) {
  const cap = TOOL_CAPABILITIES[type || 'terminal'];
  return !!(cap && cap.backgroundCapable);
}
function normalizeLayout(n) {
  if (!n) return n;
  if (n.type === 'pane' && n.tabs) n.tabs.forEach(normalizeTab);
  if (n.type === 'split' && n.children) n.children.forEach(normalizeLayout);
  return n;
}

/**
 * FR-GIT-186: Git 창은 **닫힌 창**이다 (FR-GIT-179) — GIT_VIEWS 의 고정 탭뿐이고 분할이
 * 없다. 개정 이전 워크스페이스는 그 안에 터미널·편집기 탭과 분할 칸을 가질 수
 * 있으므로, 로드 시 **일반 창으로 옮긴다.** 조용히 버리지 않는다 — 사용자의
 * 작업 상태다.
 *
 * `mkWindow()` 는 받을 일반 창이 하나도 없을 때 부르는 콜백이고 새 창을 반환해야
 * 한다 (O19). 반환값은 옮긴 탭 수다.
 */
/**
 * REPO_TAB_UNIFY_SRS FR-RTU-70·75: **Git 창을 걷어낸다.**
 *
 * 종전에는 Git 창 안의 남의 탭(터미널·편집기)을 일반 창으로 옮기고 창은 남겼다
 * (FR-GIT-186). 이제 창 자체가 사라진다 — 저장소마다 Repo 창이 있고 git 뷰는
 * 그 본문의 탭이므로(FR-RTU-30) 이 창에는 갈 곳도 올 곳도 없다.
 *
 * **고정 뷰 탭은 버린다** (D-RTU-14). 전부 재현 가능하고 옮길 자리도 없다.
 * 남의 탭만 일반 창으로 건져 낸다 — 그쪽은 사용자가 만든 것이라 사라지면 안 된다.
 *
 * 돌려주는 값은 **옮긴 탭 수**다 (호출자가 "바뀐 것이 있나" 로 쓴다). 창을
 * 지운 것도 변화이므로 그것도 센다.
 */
function migrateGitWindows(windows,mkWindow){
  if(!Array.isArray(windows)) return 0;
  const panesOf=n=>!n?[]:(n.type==='pane'?[n]:(n.children||[]).flatMap(panesOf));
  let changed=0;
  for(let i=windows.length-1;i>=0;i--){
    const s=windows[i];
    if(!s||s.type!==WINDOW_TYPE_GIT) continue;
    const out=[];
    for(const p of panesOf(s.layout))
      for(const t of (p.tabs||[])) if(t&&t.type!==TAB_TYPE_GIT) out.push(t);
    if(out.length){
      // 받는 곳은 **일반 창**이다 — Repo 창에는 터미널 탭이 들어갈 수 없다
      // (FR-RTU-16).
      let dst=windows.find(w=>w&&w.type!==WINDOW_TYPE_GIT&&w.type!==WINDOW_TYPE_EDITOR&&w.layout);
      if(!dst) dst=mkWindow&&mkWindow();
      const dp=dst&&firstPane(dst.layout);
      if(dp){
        if(!Array.isArray(dp.tabs)) dp.tabs=[];
        for(const t of out){dp.tabs.push(t);changed++}
        if(!dp.activeTab&&dp.tabs.length) dp.activeTab=dp.tabs[0].id;
      }
    }
    windows.splice(i,1);
    changed++;
  }
  return changed;
}

function doSplit(n,rid,nrs,dir){
  // nrs: 단일 pane 또는 pane 배열
  const list=Array.isArray(nrs)?nrs:[nrs];
  if(n.type==='pane') return n.id===rid?{type:'split',direction:dir,children:[n,...list]}:n;
  if(n.children) n.children=n.children.map(c=>doSplit(c,rid,nrs,dir));
  return n;
}
function doRemove(n,rid){
  if(!n) return null;
  if(n.type==='pane') return n.id===rid?null:n;
  if(!n.children) return null;
  n.children=n.children.map(c=>doRemove(c,rid)).filter(Boolean);
  if(!n.children.length) return null;
  if(n.children.length===1) return n.children[0];
  return n;
}
// uuid 생성 단일 진입점 (WORKSPACE_IDENTITY_SRS FR-UNI-3/4/5).
//
// crypto.randomUUID() 는 **보안 컨텍스트 전용**이다. `start.sh --expose` /
// DONGMINAL_HOST=0.0.0.0 은 평문 HTTP 로 LAN 에 노출하므로 그 주소로 접속한
// 브라우저에서는 undefined 이고, 직접 호출하면 엔터티 생성이 TypeError 로 죽는다
// (SRS §2.7 (1)). crypto.getRandomValues() 는 비보안 컨텍스트에서도 쓸 수 있어
// 폴백 수단이 된다.
//
// Math.random() 으로 내려가지 않는다 — 조용히 비uuid·저엔트로피 id 를 발급하면
// SRS §2.2 가 닫은 충돌이 다시 열린다 (FR-UNI-4).
function newUUID(){
  if(typeof crypto==='undefined'||!crypto) throw new Error('newUUID: crypto 를 쓸 수 없다');
  if(typeof crypto.randomUUID==='function') return crypto.randomUUID();
  if(typeof crypto.getRandomValues!=='function') throw new Error('newUUID: crypto.getRandomValues 를 쓸 수 없다');
  const b=new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6]=(b[6]&0x0f)|0x40;  // version 4
  b[8]=(b[8]&0x3f)|0x80;  // variant 10
  const h=[];
  for(let i=0;i<256;i++) h.push((i+0x100).toString(16).slice(1));
  return h[b[0]]+h[b[1]]+h[b[2]]+h[b[3]]+'-'+h[b[4]]+h[b[5]]+'-'+h[b[6]]+h[b[7]]+'-'+
         h[b[8]]+h[b[9]]+'-'+h[b[10]]+h[b[11]]+h[b[12]]+h[b[13]]+h[b[14]]+h[b[15]];
}

// 엔터티 id 생성 (WORKSPACE_IDENTITY_SRS FR-WID-1).
//
// 카운터(`t${++this._t}`)는 로드된 워크스페이스의 최댓값에서 seeding 되므로 같은
// 상태를 본 두 클라이언트가 반드시 같은 다음 값을 냈다 — 충돌은 우연이 아니라
// 필연이었다. id 는 전 계층에서 opaque 문자열이라(SRS §2.5) 구 id 와 섞여도 무해하고
// 마이그레이션이 필요 없다.
function newEntityId(){return newUUID()}

// 도구 표시명 (FR-UNI-8). id 파생이 아니다 — 구분은 좌표와 cwd 가 담당한다.
const DEFAULT_TOOL_NAME='Shell';

function findPane(n,rid){
  if(!n) return null;
  if(n.type==='pane') return n.id===rid?n:null;
  if(n.children) for(const c of n.children){const f=findPane(c,rid);if(f)return f}
  return null;
}
function firstPane(n){
  if(!n) return null;
  if(n.type==='pane') return n;
  if(n.children) for(const c of n.children){const f=firstPane(c);if(f)return f}
  return null;
}
function allPids(n){
  if(!n) return [];
  if(n.type==='pane') return (n.tabs||[]).filter(t=>t.type==='terminal').map(t=>t.toolId);
  if(n.children) return n.children.flatMap(c=>allPids(c));
  return [];
}
function findPath(n,rid){
  if(!n) return null;
  if(n.type==='pane') return n.id===rid?[n]:null;
  if(n.children) for(const c of n.children){const p=findPath(c,rid);if(p)return[n,...p]}
  return null;
}
function clean(n,ok){
  if(!n) return null;
  if(n.type==='pane'){
    if(n.tabs) n.tabs=n.tabs.filter(t=>{
      // 서버 도구에 매인 탭만 검사한다. editor·git·run 탭은 toolId 가 없어
      // 그대로 두지 않으면 로드마다 사라진다 (FR-GIT-25, FR-RVZ-9).
      //
      // `!t.toolId` 로 일반화하지 않는 이유는 toolId 없는 terminal 탭
      // (저장 중 끊긴 손상 워크스페이스)이 그때 영원히 남기 때문이다 —
      // 클릭해도 아무것도 열리지 않는 그 유령 탭을 버리는 것이 clean() 의 목적이다.
      if(t.type==='editor'||t.type==='run'||t.type===TAB_TYPE_GIT) return true;
      return ok.has(t.toolId);
    });
    if(!n.tabs||!n.tabs.length) return null;
    if(!n.tabs.find(t=>t.id===n.activeTab)) n.activeTab=n.tabs[0].id;
    return n;
  }
  if(!n.children) return null;
  n.children=n.children.map(c=>clean(c,ok)).filter(Boolean);
  if(!n.children.length) return null;
  if(n.children.length===1) return n.children[0];
  return n;
}

// ── 탭 이름의 출처 (CONVENIENCE_SRS 묶음 N) ──

const TAB_NAME_DEFAULT='Shell';
const NAME_SOURCE_AUTO='auto';
const NAME_SOURCE_MANUAL='manual';

/**
 * 탭 이름의 출처 (FR-TAN-1). `auto` 인 탭만 전경 프로세스에서 파생한 이름을
 * 받는다.
 *
 * 저장된 값이 없으면 **읽는 자리에서** 정한다 (FR-TAN-4). 마이그레이션을
 * 워크스페이스에 써 넣지 않는 이유는 FR-TAN-16 과 같다 — `nameSource` 는
 * 사용자가 실제로 이름을 준 순간에만 생겨야 하고, 로드가 그것을 지어내면
 * 지어낸 값이 영속된다.
 *
 * 이 규칙은 완전하지 않다 — 예전에 사용자가 탭 이름을 직접 `Shell` 로
 * 지정했다면 auto 로 강등된다. SRS 가 그 손실을 회복 가능한 것으로 보고
 * 수용했다. 더 정교하게 만들지 않는다.
 */
function tabNameSource(tab){
  if(!tab) return NAME_SOURCE_AUTO;
  // FR-TAN-3: editor·run·git 탭의 이름은 콘텐츠에서 파생된다 — 본 묶음의
  // 대상이 아니므로 manual 로 고정한다.
  if(tab.type==='editor'||tab.type==='run'||tab.type===TAB_TYPE_GIT) return NAME_SOURCE_MANUAL;
  if(tab.nameSource===NAME_SOURCE_MANUAL||tab.nameSource===NAME_SOURCE_AUTO) return tab.nameSource;
  return tab.name===TAB_NAME_DEFAULT?NAME_SOURCE_AUTO:NAME_SOURCE_MANUAL;
}

/**
 * 탭이 화면에 내는 이름 (FR-TAN-15). 파생 이름을 받을 수 있는 것은
 * `nameSource==='auto'` 인 탭뿐이며, `manual` 은 어떤 경우에도 덮이지 않는다.
 * 설정이 꺼져 있으면 아무도 파생을 받지 않는다 (FR-TAN-20).
 *
 * `fgNames` 는 toolId → 파생 이름의 런타임 Map 이다. 워크스페이스에 들어가지
 * 않는다 — 파생 이름은 현재 상태의 표시이지 이력이 아니다 (FR-TAN-16).
 */
function tabName(tab,fgNames){
  if(!tab) return '';
  return toolDisplayName(tab.toolId,fgNames,tab,tab.name);
}

/**
 * 도구 하나의 표시 이름 (UX_REVISION_SRS FR-NAM-1~4).
 *
 * 지금까지 파생 이름을 아는 자리는 탭 하나뿐이었다 — 백그라운드 모달과 주의
 * 알림은 `Shell` 이라고만 말했다 (FR-NAM-5·6). 탭은 **있을 수도 없을 수도**
 * 있으므로(백그라운드 도구에는 탭이 없다) 탭을 선택 인자로 받는다.
 *
 * 우선순위: 탭이 manual 이면 그 이름 → 파생 이름 → fallback → `Shell`.
 * manual 을 앞에 두는 것이 FR-TAN-15 다 — 사람이 준 이름은 덮이지 않는다.
 */
function toolDisplayName(toolId,fgNames,tab,fallback){
  if(tab&&(!fgTabNames||tabNameSource(tab)!==NAME_SOURCE_AUTO)) return tab.name;
  const fg=(fgTabNames&&fgNames&&toolId)?fgNames.get(toolId):'';
  return fg||(tab&&tab.name)||fallback||DEFAULT_TOOL_NAME;
}

/**
 * 배지가 낡았는가 (FR-GOB-14).
 *
 * 관측 시각만 본다. 옛 규칙은 "활성 리포가 아니면 낡음" 이었는데, 그때는 관측을
 * 활성 리포만 만들었으므로 그 둘이 같은 말이었다. 이제 Git 탭 안에서는 핀 전부가
 * 매 주기 관측되므로(FR-GOB-10) 활성 여부는 낡음과 무관하다.
 */
function gitBadgeStale(badge){
  const at=badge&&badge.observedAtUnixMs;
  if(!at) return true;
  return (Date.now()-at)>GIT_BADGE_STALE_MS;
}
