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
  location:{label:'현재 위치 (MCP id)',def:true},
  cwd:{label:'현재 디렉토리',def:true},
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
// 존재하므로 탭에서 떼어낼 실체가 없다.
const TOOL_CAPABILITIES = {
  terminal: { backgroundCapable: true },
  editor:   { backgroundCapable: false },
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
      if(t.type==='editor') return true;
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
