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

// ── 경로 잇기 ──

/**
 * 디렉터리와 그 아래의 이름을 잇는다.
 *
 * **구분자는 그 경로가 이미 쓰고 있는 것을 따른다.** 서버가 주는 절대경로의
 * 모양은 OS 가 정한다 — Windows 에서는 `C:\Users\x` 다. 여기서 `/` 로 이으면
 * 한 문자열에 둘이 섞이고(`C:\Users\x/a.txt`), 그 값이 곧 화면의 `data-path`
 * 이자 서버로 되돌아가는 키가 된다. 서버는 `filepath.Clean` 으로 그것을 고쳐
 * 읽으므로 **동작은 하지만**, 화면이 든 문자열과 서버가 든 문자열이 갈린다 —
 * 그러면 그 둘을 견주는 자리(탐색기의 선택·git 색·검사)가 전부 어긋난다.
 *
 * `rel` 이 여러 겹(`a/b`)일 수 있다. 그것은 git 이 늘 `/` 로 주는 상대경로다.
 * **그 안쪽도 함께 맞춘다.** 잇는 자리 하나만 바꾸면 결과가 `D:\a\root\aa/bb/cc`
 * 처럼 **섞인 채로** 나오고, 그 값은 절대경로로 쓰이는 순간 전부 어긋난다 —
 * `pathSep` 은 섞인 문자열을 `/` 로 읽고, `pathUnder` 는 그래서 자기 루트조차
 * 아래로 보지 않으며, 화면의 `data-path`(서버가 준 순수한 OS 경로)와도 다르다.
 * 러너에서 실측한 자리다: 검색 결과로 연 파일이 어느 창에도 속하지 않는 것으로
 * 판정돼 홈 창으로 떨어졌고, 탐색기는 그 파일을 끝내 펼치지 못했다.
 *
 * git 이 준 값 자체는 바뀌지 않는다 — 바뀌는 것은 **이 함수가 만든 절대경로**뿐이고,
 * 그것이 이 함수의 목적이다.
 */
function pathJoin(dir,rel){
  const d=String(dir==null?'':dir);
  const r=String(rel==null?'':rel);
  if(!d) return r;
  if(!r) return d;
  if(d==='/') return '/'+r;
  const sep=(d.includes('\\')&&!d.includes('/'))?'\\':'/';
  const tail=sep==='\\'?r.replace(/\//g,'\\'):r;
  return d.replace(/[\\/]+$/,'')+sep+tail;
}

/** 그 경로가 쓰는 구분자. 서버가 준 절대경로의 모양이 곧 그 OS 의 모양이다. */
function pathSep(dir){
  const d=String(dir==null?'':dir);
  return (d.includes('\\')&&!d.includes('/'))?'\\':'/';
}

/**
 * 절대경로인가. POSIX 는 `/` 로 시작하고, Windows 는 `C:\\…` 또는 UNC(`\\\\srv\\…`)다.
 *
 * `startsWith('/')` 만으로 재면 **Windows 의 절대경로가 전부 상대로 읽힌다.**
 */
function isAbsPath(p){
  const s=String(p==null?'':p);
  return s.startsWith('/')||s.startsWith('\\\\')||/^[A-Za-z]:[\\/]/.test(s);
}

/**
 * `p` 가 `root` **아래**(또는 root 자신)인가.
 *
 * `startsWith(root)` 만으로는 `/a/bc` 가 `/a/b` 아래로 잡히므로 구분자까지
 * 본다. 그 구분자를 `/` 로 굳히면 **Windows 에서는 어떤 경로도 아래로 잡히지
 * 않는다** — `C:\\Users\\x` 아래의 어떤 것도 `C:\\Users\\x/` 로 시작하지
 * 않기 때문이다. 트리의 펼침·이동 금지·창 고르기가 전부 이 판정을 딛는다.
 */
function pathUnder(root,p){
  const raw=String(root==null?'':root);
  const s=String(p==null?'':p);
  if(!raw||!s) return false;
  if(s===raw) return true;
  // 구분자는 **자식 경로**에게 묻는다. 루트가 드라이브 뿌리(`C:\\`)이면 그
  // 문자열만으로는 구분자를 알 수 없다.
  const sep=pathSep(s);
  // 끝의 구분자는 있으나 없으나 같은 자리다 — 접두를 만들 때 한 번만 붙인다.
  const base=raw.endsWith(sep)?raw.slice(0,-sep.length):raw;
  if(s===base) return true;
  return s.startsWith(base+sep);
}

/**
 * 그 경로의 **마지막 조각**. 사람에게 보이는 이름이다.
 *
 * `split('/')` 로는 안 된다 — Windows 의 절대경로는 `C:\\Users\\x\\repo` 이고
 * 그 문자열에는 `/` 가 하나도 없어 **경로 전체가 이름으로 나온다** (러너 실측:
 * Changes 머리의 리포명 자리에 절대경로가 통째로 찍혔다). 구분자는 `pathSep` 이
 * 그 경로에게 묻는다.
 */
function pathBase(p){
  const s=String(p==null?'':p);
  if(!s) return '';
  const parts=s.split(/[\\/]+/).filter(Boolean);
  return parts.length?parts[parts.length-1]:s;
}

/**
 * `root` 아래의 절대경로를 **git 의 상대경로**로 옮긴다.
 *
 * git 은 어느 OS 에서도 `/` 로 답한다. 상태·색·접어 올림의 키가 그 값이므로,
 * 화면이 든 경로(그 OS 의 구분자)를 키로 쓰려면 여기서 한 번 맞춰야 한다 —
 * 맞추지 않으면 Windows 에서 **어느 행도 자기 상태를 찾지 못한다**.
 */
function pathRel(root,p){
  const r=String(root==null?'':root), s=String(p==null?'':p);
  if(!r||s===r) return '';
  const cut=r==='/'?1:r.length+1;
  return s.slice(cut).replace(/\\/g,'/');
}

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
  const ui=t.ui;
  // 주의 알림색은 팔레트 중 accent(포커스)와 가장 대비되는 색 — 포커스와 겹치지 않게 (FR-PAN-10)
  const attn=pickAttnColor(t);
  /**
   * BOOT_SCREEN_SRS FR-BTS-1 / D-4: 세우는 변수를 **맵으로 한 번에** 만든다.
   *
   * 첫 페인트 선주입(`index.html` 의 head 인라인)이 이 맵을 그대로 다시 세우기
   * 때문이다 — 파생값(`mixHex`·`pickAttnColor`)의 계산은 **여기 한 자리**에만
   * 남고, 선주입은 그것을 다시 계산하지 않는다.
   */
  const vars={
    '--bg':ui.bg,
    '--sidebar-bg':ui.sidebarBg,
    '--border':ui.border,
    '--accent':ui.accent,
    '--text':ui.text,
    '--text-muted':ui.textMuted,
    '--text-bright':ui.textBright,
    '--text-dim':ui.textDim,
    '--danger':ui.danger,
    '--accent-border':ui.accentBorder,
    '--border-strong':mixHex(ui.border,ui.text,BORDER_STRONG_MIX),
    '--slot-edge':mixHex(ui.border,ui.accent,SLOT_EDGE_MIX),
    '--accent-hover':hexToRgba(ui.accent,.1),
    '--accent-active':hexToRgba(ui.accent,.12),
    '--accent-subtle':hexToRgba(ui.accent,.08),
    '--attn':attn,
    '--attn-subtle':hexToRgba(attn,.16),
    '--attn-glow':hexToRgba(attn,.5),
  };
  const s=document.documentElement.style;
  for(const k in vars) s.setProperty(k,vars[k]);
  // FR-BTS-2: 기록 실패는 다음 부팅의 첫 페인트가 기본값이 된다는 뜻일 뿐이다.
  try{localStorage.setItem(THEME_VARS_KEY,JSON.stringify(vars))}catch{}
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
  sidebarToggle:'사이드바 접기/펼치기',
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
// POLL_INTERVAL_SETTINGS_SRS FR-PIS-11: 기본값은 상수로 세운다 — 값이 깨졌을 때
// 돌아갈 자리이며, 그 자리가 리터럴이면 `pollValue` 가 딛을 것이 없다.
const STATS_INTERVAL_DEFAULT=3000;
var statsInterval=STATS_INTERVAL_DEFAULT;
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
/**
 * UNFOCUSED_EDGE_SRS FR-UFE-10·12·13: 포커스를 잃은 창의 가장자리 표시 세기(0~10).
 *
 * `/api/settings` blob 에 실린다 — `confirmLeave` 와 같은 근거(D-7): 취향 스위치가
 * 기기마다 어긋나면 같은 사람이 기기를 옮길 때마다 다시 끈다.
 *
 * 기본이 0 이 아닌 것은 이 기능이 **모르는 사이 잘못 친 키**를 줄이기 위한 것이기
 * 때문이다 — 켜야만 보이는 안전장치는 그것이 필요한 사람에게 닿지 않는다.
 */
var focusEdgeLevel=UFE_LEVEL_DEFAULT;
// FR-AED-8·9: 알림 가장자리의 세기. 같은 blob 에 실리고 같은 규약을 쓴다 —
// 취향 스위치가 기기마다 어긋나면 같은 사람이 기기를 옮길 때마다 다시 끈다.
var attnEdgeLevel=ATTN_EDGE_LEVEL_DEFAULT;
/**
 * TAB_WIDTH_SRS FR-TBW-1·2: 탭 너비 고정과 그 폭.
 *
 * 기본은 **끔**이며 그때의 동작은 종전과 완전히 같다 (FR-TBW-9) — 이 기능은 켠
 * 사람에게만 보인다. 폭의 기본 160 은 VSCode 의 `tabSizingFixedMaxWidth` 기본과
 * 같은 값이다.
 */
var tabFixedWidth=false;
var tabWidthPx=TAB_WIDTH_DEFAULT;

/**
 * 폭을 **CSS 변수 하나**로 전달한다 (NFR-TBW-1) — 탭마다 인라인 스타일을 쓰면
 * 탭 수만큼 재계산이 늘고 규칙이 CSS 와 JS 두 곳에 갈린다.
 *
 * 켜고 끄는 것도 클래스 토글 하나다 (NFR-TBW-2) — 렌더러가 탭을 다시 만들지
 * 않으므로 스크롤 위치와 드래그 상태가 그대로 남는다.
 */
function applyTabWidth(){
  const px=clampTabWidth(tabWidthPx);
  document.documentElement.style.setProperty('--tab-w',px+'px');
  document.body.classList.toggle('tabfix',!!tabFixedWidth);
}

// FR-TBW-4: 범위 밖은 **자른다** — 거부하지 않는다. 숫자 입력은 타이핑 도중에
// 잠깐 범위 밖이 되며, 그때마다 오류를 내면 입력 자체가 불가능해진다.
function clampTabWidth(v){
  const n=Math.round(Number(v));
  if(!isFinite(n)) return TAB_WIDTH_DEFAULT;
  return Math.min(TAB_WIDTH_MAX,Math.max(TAB_WIDTH_MIN,n));
}
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
  return (Date.now()-at)>gitBadgeStaleMs();
}

/**
 * POLL_INTERVAL_SETTINGS_SRS FR-PIS-12 / D-7: 낡음의 기준은 **주기에서 파생한다.**
 *
 * 종전에는 `const GIT_BADGE_STALE_MS=GIT_REPOS_POLL_MS*4` 로 로드 시점에 굳었고,
 * 주기가 설정이 되면 그 상수만 옛 값에 남는다. 계수를 남기고 곱셈을 여기로
 * 옮기면 기준이 주기를 따라간다 — 둘은 같은 사실의 앞뒤이기 때문이다 (FR-GOB-14).
 */
function gitBadgeStaleMs(){ return gitReposInterval*GIT_BADGE_STALE_FACTOR }

// 같은 근거의 편집기 쪽 백오프 (FR-DIR-31). 소비 지점은 트리의 `_gitBack` 과
// dirty diff 의 `_back` 둘이다.
function editorGitBackoffMs(){ return gitReposInterval*EDITOR_GIT_BACKOFF_FACTOR }

/**
 * 화면이 보일 때만 도는 주기 실행 (REFACTOR_STABILIZATION_SRS FR-RST-23).
 *
 * 같은 일을 하는 `setInterval` 감싸기가 다섯 자리에 있었고 **정확도가 제각각이었다**:
 *
 *   app-statusbar  hidden 스킵 O · 복귀 시 갱신 O
 *   app-git        hidden 스킵 O · 복귀 시 갱신 O   (주석이 statusbar 를 선례로 인정)
 *   app-editor     hidden 스킵 O · 복귀 시 갱신 X
 *   git/console    hidden + isConnected + vis       · 복귀 시 갱신 X
 *   app-agents     **아무 방어 없음**
 *
 * `console.js` 가 가장 정확한 판정에 도달했다 — "`vis` 만 보면 떠난 탭에서도 계속
 * 받는다. 탭을 바꾸면 `_rLayout` 이 본문을 통째로 버리는데 클래스는 그대로 남기
 * 때문이다." 그 지식이 나머지 넷에 전파되지 않았다. 여기서 `when` 으로 받는다.
 *
 * 숨은 탭에서 멈추는 근거는 FR-STAT-17 이다 — 보이지 않는 화면을 위해 요청을 살
 * 이유가 없다. 복귀하면 즉시 한 번 돈다: 멈춰 있던 동안의 낡음을 그때 갚는다.
 *
 * @returns {{stop:Function}} 정지 손잡이. 리스너까지 함께 걷는다.
 */
function visiblePoll(ms, fn, opts){
  opts=opts||{};
  // POLL_INTERVAL_SETTINGS_SRS FR-PIS-13 / D-8: 첫 인자가 **함수면 그대로 넘긴다.**
  // `TimerHub` 는 `every` 를 매 재무장마다 재평가하므로(`_arm`), 그것이 곧 "주기가
  // 설정을 읽는다" 이다. 값을 주는 기존 호출 방식은 그대로 동작한다 — 계약이
  // 넓어질 뿐 깨지지 않는다.
  // EVENT_TIMER_HUB_SRS FR-HUB-6: **이 함수는 이제 `TimerHub` 위의 얇은
  // 래퍼다.** 호출부 다섯은 한 글자도 바뀌지 않는다.
  //
  // 위 주석이 적어 둔 다섯 축 중 이 함수가 흡수한 것은 visibility 하나였다.
  // 나머지 넷(낡은 응답 폐기·single-flight·백오프·시한)은 `TimerHub` 가 갖는다 —
  // `every` 로 등록하면 그것들이 함께 온다.
  //
  // `sched` 를 주입받는 이유는 격리 검사 때문이다. 앱 없이 이 함수만 얹고
  // 계약을 재는 자리가 있고(`event-timer-hub-contract.spec.ts`), 거기에는
  // `window.app` 이 없다.
  const sched=opts.sched||(typeof window!=='undefined'&&window.app&&window.app.timers);
  return sched.every({
    id:opts.id, owner:opts.owner||null,
    every:typeof ms==='function'?ms:()=>ms,
    when:opts.when||(()=>true),
    run:fn,
    immediate:!!opts.immediate,
  });
}

/**
 * PANEL_SURFACE_SRS FR-CMG-2 / D-7·D-8: **화면 그룹 하나의 항목들.**
 *
 * 서버 응답은 건드리지 않고(D-7) 여기서만 합친다. 합친 뒤의 순서는 **경로**다 —
 * 출신에 따라 뭉치면 같은 폴더의 파일이 목록의 두 자리로 갈린다.
 *
 * 판정이 한 자리인 것이 이 함수의 전부다: 그리는 쪽(`_paintGroup`)과 대상을 모으는
 * 쪽(`_group`)과 다이얼로그의 지문이 같은 묶음을 보아야 한다 (FR-CMG-13).
 */
function gitGroupEntries(status,key){
  if(!status) return [];
  const src=GIT_GROUP_SRC[key];
  if(!src) return status[key]||[];
  const out=[];
  for(const k of src) for(const e of status[k]||[]) out.push(e);
  return out.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
}

/**
 * 변경 항목의 **상태문자** (REFACTOR_STABILIZATION_SRS FR-RST-22).
 *
 * 그룹이 어느 축을 보는지가 곧 X/Y 선택이다 — staged 는 X, 나머지는 Y 이고,
 * untracked·conflicts 는 축이 아니라 그룹 자체가 답이다.
 *
 * **두 화면이 이 규칙을 따로 갖고 있었다** — Git 패널의 `_stateChar` 와 탐색기의
 * `_setStatus` 다. 둘 다 "같아야 한다" 고 주석이 밝히면서도 같은 자리에서 나오지
 * 않았고, 그래서 한쪽만 고쳐질 수 있었다. 색표(`GIT_ST_CLASS`)는 이미 공유하고
 * 있었으므로 문자를 뽑는 규칙도 여기로 모은다.
 */
function gitStateChar(group, entry){
  // PANEL_SURFACE_SRS FR-CMG-3: 출신은 **항목**이 안다 (`untracked`) — 워킹 그룹은
  // 두 출신을 함께 담으므로 그룹만으로는 답이 나오지 않는다. 그룹으로 묻는 자리
  // (항목 없이 부르는 탐색기)는 그대로 남는다.
  if(entry&&entry.untracked) return '?';
  if(group==='untracked') return '?';
  if(group==='conflicts') return 'U';
  const xy=(entry&&entry.xy)||'..';
  return group==='staged'?xy[0]:xy[1];
}

/**
 * SUBMODULE_DIRTY_NOTICE_SRS FR-SDN-1~4: porcelain v2 의 `sub` 필드를 두 성분으로
 * 가른다.
 *
 *   S<c><m><u>   c='C' 기록된 커밋(gitlink)이 바뀌었다
 *                m='M' 서브모듈 안에 추적 중인 변경이 있다
 *                u='U' 서브모듈 안에 추적되지 않는 파일이 있다
 *
 * 가르는 이유는 **부모 저장소가 커밋할 수 있는 것이 gitlink 하나**이기 때문이다.
 * `commit` 이 거짓인데 `inner` 만 참인 행은 여기서 스테이지·커밋해도 사라지지
 * 않는다 — `git add` 가 index 에 올릴 변화가 없다 (SRS §1.1 실측).
 *
 * FR-SDN-2: **판정은 이 함수 하나다.** 툴팁과 안내문이 각자 문자열을 뜯으면 두
 * 자리가 서로 다른 답을 낼 수 있고, 그 어긋남은 둘을 나란히 놓기 전까지 아무도
 * 모른다.
 *
 * FR-SDN-4: 자리 수가 모자란 문자열도 오류가 아니다 — 없는 자리는 `.` 로 읽는다.
 * git 이 형식을 늘려도 화면이 깨져서는 안 된다.
 */
function gitSubParts(sub){
  const s=typeof sub==='string'?sub:'';
  // FR-SDN-3: 서브모듈이 아닌 것에 서브모듈의 사정을 말하지 않는다.
  if(s.charAt(0)!==GIT_SUB_IS_SUB) return {commit:false,inner:false};
  return {
    commit:s.charAt(1)===GIT_SUB_COMMIT,
    inner:s.charAt(2)===GIT_SUB_MODIFIED||s.charAt(3)===GIT_SUB_UNTRACKED,
  };
}
