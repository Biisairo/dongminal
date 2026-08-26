/**
 * Remote Terminal — helper functions and shared state
 */

// ── Shortcut parsing ──

function parseShortcut(s){const p=s.split('+');const k=p.pop();return{ctrl:p.includes('Ctrl'),alt:p.includes('Alt'),meta:p.includes('Meta'),shift:p.includes('Shift'),code:k}}
function matchShortcut(e,s){if(!s)return false;const p=parseShortcut(s);return e.ctrlKey===p.ctrl&&e.altKey===p.alt&&e.metaKey===p.meta&&e.shiftKey===p.shift&&e.code===p.code}
function fmtShortcut(e){const p=[];if(e.ctrlKey)p.push('Ctrl');if(e.altKey)p.push('Alt');if(e.metaKey)p.push('Meta');if(e.shiftKey)p.push('Shift');p.push(e.code);return p.join('+')}
function displayKey(s){return s.replace(/Key/g,'').replace(/BracketLeft/g,'[').replace(/BracketRight/g,']').replace(/Meta/g,'⌘').replace(/Ctrl/g,'⌃').replace(/Alt/g,'⌥').replace(/Shift/g,'⇧').replace(/Arrow/g,'')}

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

const SHORTCUT_DEFAULTS={
  windowNext:'Ctrl+Shift+BracketRight',windowPrev:'Ctrl+Shift+BracketLeft',
  tabNext:'Ctrl+Tab',tabPrev:'Ctrl+Shift+Tab',
  paneUp:'Ctrl+Shift+ArrowUp',paneDown:'Ctrl+Shift+ArrowDown',paneLeft:'Ctrl+Shift+ArrowLeft',paneRight:'Ctrl+Shift+ArrowRight',
  splitH:'Ctrl+Shift+KeyH',splitV:'Ctrl+Shift+KeyV',
  newWindow:'Ctrl+Shift+KeyN',newTab:'Ctrl+Shift+KeyT',
  closeWindow:'Ctrl+Shift+KeyW',closeTab:'Ctrl+Shift+KeyD',
  agentsToggle:'Ctrl+Shift+KeyA',
};
const SHORTCUT_LABELS={
  windowNext:'다음 창',windowPrev:'이전 창',
  tabNext:'다음 탭',tabPrev:'이전 탭',
  paneUp:'Pane ↑',paneDown:'Pane ↓',paneLeft:'Pane ←',paneRight:'Pane →',
  splitH:'가로 분할',splitV:'세로 분할',
  newWindow:'새 창',newTab:'새 탭',
  closeWindow:'창 닫기',closeTab:'탭 닫기',
  agentsToggle:'에이전트 패널',
};
var shortcuts={...SHORTCUT_DEFAULTS};

// ── Status bar state ──

const STATUS_ITEMS={
  connection:{label:'연결 상태',def:true},
  latency:{label:'레이턴시',def:true},
  location:{label:'현재 위치 (dmctl 대상)',def:true},
  cwd:{label:'현재 디렉토리',def:true},
  git:{label:'Git (브랜치·변경 수)',def:true},
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
 * FR-GIT-186: Git 창은 **닫힌 창**이다 (FR-GIT-179) — 고정 탭 6개뿐이고 분할이
 * 없다. 개정 이전 워크스페이스는 그 안에 터미널·편집기 탭과 분할 칸을 가질 수
 * 있으므로, 로드 시 **일반 창으로 옮긴다.** 조용히 버리지 않는다 — 사용자의
 * 작업 상태다.
 *
 * `mkWindow()` 는 받을 일반 창이 하나도 없을 때 부르는 콜백이고 새 창을 반환해야
 * 한다 (O19). 반환값은 옮긴 탭 수다.
 */
function migrateGitWindows(windows,mkWindow){
  if(!Array.isArray(windows)) return 0;
  const panesOf=n=>!n?[]:(n.type==='pane'?[n]:(n.children||[]).flatMap(panesOf));
  let moved=0;
  for(const s of windows){
    if(!s||s.type!==WINDOW_TYPE_GIT||!s.layout) continue;
    const panes=panesOf(s.layout);
    const keep=[],out=[];
    for(const p of panes)
      for(const t of (p.tabs||[])) (t&&t.type===TAB_TYPE_GIT?keep:out).push(t);
    // 이미 규격대로면 건드리지 않는다 — 단일 칸 + 고정 탭만.
    if(!out.length&&panes.length<2) continue;
    const wasActive=panes.map(p=>p.activeTab).find(id=>keep.some(t=>t.id===id));
    s.layout={type:'pane',id:panes[0]?panes[0].id:newEntityId(),
      tabs:keep,activeTab:wasActive||(keep[0]&&keep[0].id)||null};
    delete s.focusedPane;
    if(!out.length) continue;
    let dst=windows.find(w=>w&&w.type!==WINDOW_TYPE_GIT&&w.layout);
    if(!dst) dst=mkWindow&&mkWindow();
    const dp=dst&&firstPane(dst.layout);
    if(!dp) continue;
    if(!Array.isArray(dp.tabs)) dp.tabs=[];
    for(const t of out){dp.tabs.push(t);moved++}
    if(!dp.activeTab&&dp.tabs.length) dp.activeTab=dp.tabs[0].id;
  }
  return moved;
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
      // 서버 도구에 매인 탭만 검사한다. editor·git 탭은 toolId 가 없어
      // 그대로 두지 않으면 로드마다 사라진다 (FR-GIT-25).
      if(t.type==='editor'||t.type===TAB_TYPE_GIT) return true;
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
