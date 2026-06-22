/**
 * Remote Terminal — cmux style
 * Session → LayoutTree(Region|Split), Region has own tab bar + terminal
 */

const OP={INPUT:0,RESIZE:1,OUTPUT:0,ERROR:1,EXIT:2,SID:3};
const enc=new TextEncoder(), dec=new TextDecoder();

// 활동 패널 자동 새로고침 주기 기본값(ms). 설정에서 변경(per-device localStorage).
// 비정상 종료·hook 누락으로 SSE 가 안 와도 주기적으로 서버와 동기화 (FR-AAP-19).
const AGENTS_POLL_DEFAULT=5000;
// 상태별 글꼴 기호(이모지 아님) — 색(.ag-state.<state>)과 함께 상태를 구분.
const AGENT_STATE_ICON={working:'●',done:'✓',waiting:'…',idle:'○'};

// ═══ code-server 인스턴스 추적 ═══
// code-server 창 자체의 close 가 권위. 터미널 탭이 새로고침되어도 다른 창의
// 인스턴스는 살아있어야 한다(FR-B1: beforeunload 일괄 stop 제거).
const codeServerWatchers=new Map(); // id -> {win, hbTimer, pollTimer}
const codeServerPending=new Map();  // url -> id (팝업차단 폴백)
function codeServerHb(id){
  fetch('/api/code-server/heartbeat?id='+encodeURIComponent(id),{method:'POST'}).catch(()=>{});
}
function codeServerTrack(id,win){
  // FR-E1: 동일 id 재호출 시 살아있는 이전 win 을 닫지 않는다.
  const prev=codeServerWatchers.get(id);
  if(prev){
    if(prev.win===win) return;                       // 같은 창 → 멱등
    if(prev.win && !prev.win.closed){
      // 기존 창이 살아있으면 새로 띄운 중복 창을 닫고 추적은 그대로 유지.
      try{win&&!win.closed&&win.close()}catch{}
      return;
    }
    // 기존 창이 이미 닫힌 상태에서만 교체.
    clearInterval(prev.hbTimer);clearInterval(prev.pollTimer);
    codeServerWatchers.delete(id);
  }
  codeServerHb(id);
  const hbTimer=setInterval(()=>codeServerHb(id),10000);
  const pollTimer=setInterval(()=>{
    if(!win||win.closed){
      clearInterval(hbTimer);clearInterval(pollTimer);
      codeServerWatchers.delete(id);
      fetch('/api/code-server/stop?id='+encodeURIComponent(id),{method:'POST'}).catch(()=>{});
    }
  },1000);
  codeServerWatchers.set(id,{win,hbTimer,pollTimer});
}
// FR-D1: 백그라운드 탭에서 setInterval 이 throttle 되어 90s watchdog 안에
// 하트비트가 도달 못하는 경우를 막기 위해, 가시 상태로 전환되는 순간 즉시
// 모든 활성 인스턴스에 hb 1회 송신.
document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState!=='visible') return;
  for(const [id] of codeServerWatchers) codeServerHb(id);
});

// ═══ Theme System ═══

const UI_LABELS={bg:'Background',sidebarBg:'Sidebar',border:'Border',accent:'Accent',text:'Text',textMuted:'Muted',textBright:'Bright',textDim:'Dim',danger:'Danger',accentBorder:'Accent Bd'};
const TERM_LABELS={background:'BG',foreground:'FG',cursor:'Cursor',selectionBackground:'Select',black:'Black',red:'Red',green:'Green',yellow:'Yellow',blue:'Blue',magenta:'Magenta',cyan:'Cyan',white:'White',brightBlack:'BrBlk',brightRed:'BrRed',brightGreen:'BrGrn',brightYellow:'BrYlw',brightBlue:'BrBlu',brightMagenta:'BrMag',brightCyan:'BrCyn',brightWhite:'BrWht'};

const SHORTCUT_DEFAULTS={
  sessionNext:'Ctrl+Shift+BracketRight',sessionPrev:'Ctrl+Shift+BracketLeft',
  tabNext:'Ctrl+Tab',tabPrev:'Ctrl+Shift+Tab',
  paneUp:'Ctrl+Shift+ArrowUp',paneDown:'Ctrl+Shift+ArrowDown',paneLeft:'Ctrl+Shift+ArrowLeft',paneRight:'Ctrl+Shift+ArrowRight',
  splitH:'Ctrl+Shift+KeyH',splitV:'Ctrl+Shift+KeyV',
  newSession:'Ctrl+Shift+KeyN',newTab:'Ctrl+Shift+KeyT',
  closeSession:'Ctrl+Shift+KeyW',closeTab:'Ctrl+Shift+KeyD',
  agentsToggle:'Ctrl+Shift+KeyA',
};
const SHORTCUT_LABELS={
  sessionNext:'다음 세션',sessionPrev:'이전 세션',
  tabNext:'다음 탭',tabPrev:'이전 탭',
  paneUp:'Pane ↑',paneDown:'Pane ↓',paneLeft:'Pane ←',paneRight:'Pane →',
  splitH:'가로 분할',splitV:'세로 분할',
  newSession:'새 세션',newTab:'새 탭',
  closeSession:'세션 닫기',closeTab:'탭 닫기',
  agentsToggle:'에이전트 패널',
};
let shortcuts={...SHORTCUT_DEFAULTS};

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
let statusBar={}; // {itemKey: true/false}
for(const[k,v]of Object.entries(STATUS_ITEMS))statusBar[k]=v.def;
let statsInterval=3000;
let layoutPresets=[]; // [{name, layout}] — layout = stripped layout tree
let defaultPreset=-1; // index into layoutPresets, -1 = none

const MOD_CODES=new Set(['ControlLeft','ControlRight','AltLeft','AltRight','MetaLeft','MetaRight','ShiftLeft','ShiftRight']);
function parseShortcut(s){const p=s.split('+');const k=p.pop();return{ctrl:p.includes('Ctrl'),alt:p.includes('Alt'),meta:p.includes('Meta'),shift:p.includes('Shift'),code:k}}
function matchShortcut(e,s){if(!s)return false;const p=parseShortcut(s);return e.ctrlKey===p.ctrl&&e.altKey===p.alt&&e.metaKey===p.meta&&e.shiftKey===p.shift&&e.code===p.code}
function fmtShortcut(e){const p=[];if(e.ctrlKey)p.push('Ctrl');if(e.altKey)p.push('Alt');if(e.metaKey)p.push('Meta');if(e.shiftKey)p.push('Shift');p.push(e.code);return p.join('+')}
function displayKey(s){return s.replace(/Key/g,'').replace(/BracketLeft/g,'[').replace(/BracketRight/g,']').replace(/Meta/g,'⌘').replace(/Ctrl/g,'⌃').replace(/Alt/g,'⌥').replace(/Shift/g,'⇧').replace(/Arrow/g,'')}

const THEMES={
  'Tokyo Night':{
    mode:'dark',
    ui:{bg:'#1a1b26',sidebarBg:'#16161e',border:'#292e42',accent:'#7aa2f7',text:'#a9b1d6',textMuted:'#565f89',textBright:'#c0caf5',textDim:'#414868',danger:'#f7768e',accentBorder:'#3d59a1'},
    terminal:{background:'#1a1b26',foreground:'#a9b1d6',cursor:'#c0caf5',cursorAccent:'#1a1b26',selectionBackground:'#33467c',selectionForeground:'#c0caf5',black:'#15161e',red:'#f7768e',green:'#9ece6a',yellow:'#e0af68',blue:'#7aa2f7',magenta:'#bb9af7',cyan:'#7dcfff',white:'#a9b1d6',brightBlack:'#414868',brightRed:'#f7768e',brightGreen:'#9ece6a',brightYellow:'#e0af68',brightBlue:'#7aa2f7',brightMagenta:'#bb9af7',brightCyan:'#7dcfff',brightWhite:'#c0caf5'},
  },
  'Dracula':{
    mode:'dark',
    ui:{bg:'#282a36',sidebarBg:'#21222c',border:'#44475a',accent:'#bd93f9',text:'#f8f8f2',textMuted:'#6272a4',textBright:'#f8f8f2',textDim:'#44475a',danger:'#ff5555',accentBorder:'#6272a4'},
    terminal:{background:'#282a36',foreground:'#f8f8f2',cursor:'#f8f8f2',cursorAccent:'#282a36',selectionBackground:'#44475a',selectionForeground:'#f8f8f2',black:'#21222c',red:'#ff5555',green:'#50fa7b',yellow:'#f1fa8c',blue:'#bd93f9',magenta:'#ff79c6',cyan:'#8be9fd',white:'#f8f8f2',brightBlack:'#6272a4',brightRed:'#ff5555',brightGreen:'#50fa7b',brightYellow:'#f1fa8c',brightBlue:'#bd93f9',brightMagenta:'#ff79c6',brightCyan:'#8be9fd',brightWhite:'#f8f8f2'},
  },
  'One Dark':{
    mode:'dark',
    ui:{bg:'#282c34',sidebarBg:'#21252b',border:'#3e4451',accent:'#61afef',text:'#abb2bf',textMuted:'#5c6370',textBright:'#e5c07b',textDim:'#3e4451',danger:'#e06c75',accentBorder:'#4b5263'},
    terminal:{background:'#282c34',foreground:'#abb2bf',cursor:'#528bff',cursorAccent:'#282c34',selectionBackground:'#3e4451',selectionForeground:'#abb2bf',black:'#282c34',red:'#e06c75',green:'#98c379',yellow:'#e5c07b',blue:'#61afef',magenta:'#c678dd',cyan:'#56b6c2',white:'#abb2bf',brightBlack:'#5c6370',brightRed:'#e06c75',brightGreen:'#98c379',brightYellow:'#e5c07b',brightBlue:'#61afef',brightMagenta:'#c678dd',brightCyan:'#56b6c2',brightWhite:'#ffffff'},
  },
  'Nord':{
    mode:'dark',
    ui:{bg:'#2e3440',sidebarBg:'#272c36',border:'#3b4252',accent:'#88c0d0',text:'#d8dee9',textMuted:'#4c566a',textBright:'#eceff4',textDim:'#3b4252',danger:'#bf616a',accentBorder:'#4c566a'},
    terminal:{background:'#2e3440',foreground:'#d8dee9',cursor:'#d8dee9',cursorAccent:'#2e3440',selectionBackground:'#434c5e',selectionForeground:'#d8dee9',black:'#3b4252',red:'#bf616a',green:'#a3be8c',yellow:'#ebcb8b',blue:'#81a1c1',magenta:'#b48ead',cyan:'#88c0d0',white:'#e5e9f0',brightBlack:'#4c566a',brightRed:'#bf616a',brightGreen:'#a3be8c',brightYellow:'#ebcb8b',brightBlue:'#81a1c1',brightMagenta:'#b48ead',brightCyan:'#88c0d0',brightWhite:'#eceff4'},
  },
  'Catppuccin':{
    mode:'dark',
    ui:{bg:'#1e1e2e',sidebarBg:'#181825',border:'#313244',accent:'#89b4fa',text:'#cdd6f4',textMuted:'#585b70',textBright:'#f5e0dc',textDim:'#313244',danger:'#f38ba8',accentBorder:'#45475a'},
    terminal:{background:'#1e1e2e',foreground:'#cdd6f4',cursor:'#f5e0dc',cursorAccent:'#1e1e2e',selectionBackground:'#585b70',selectionForeground:'#cdd6f4',black:'#45475a',red:'#f38ba8',green:'#a6e3a1',yellow:'#f9e2af',blue:'#89b4fa',magenta:'#f5c2e7',cyan:'#94e2d5',white:'#bac2de',brightBlack:'#585b70',brightRed:'#f38ba8',brightGreen:'#a6e3a1',brightYellow:'#f9e2af',brightBlue:'#89b4fa',brightMagenta:'#f5c2e7',brightCyan:'#94e2d5',brightWhite:'#a6adc8'},
  },
  'Solarized Dark':{
    mode:'dark',
    ui:{bg:'#002b36',sidebarBg:'#073642',border:'#073642',accent:'#268bd2',text:'#839496',textMuted:'#586e75',textBright:'#93a1a1',textDim:'#073642',danger:'#dc322f',accentBorder:'#586e75'},
    terminal:{background:'#002b36',foreground:'#839496',cursor:'#93a1a1',cursorAccent:'#002b36',selectionBackground:'#073642',selectionForeground:'#93a1a1',black:'#073642',red:'#dc322f',green:'#859900',yellow:'#b58900',blue:'#268bd2',magenta:'#d33682',cyan:'#2aa198',white:'#eee8d5',brightBlack:'#586e75',brightRed:'#cb4b16',brightGreen:'#586e75',brightYellow:'#657b83',brightBlue:'#839496',brightMagenta:'#6c71c4',brightCyan:'#93a1a1',brightWhite:'#fdf6e3'},
  },
  'Monokai':{
    mode:'dark',
    ui:{bg:'#272822',sidebarBg:'#1e1f1c',border:'#3e3d32',accent:'#a6e22e',text:'#f8f8f2',textMuted:'#75715e',textBright:'#f8f8f0',textDim:'#49483e',danger:'#f92672',accentBorder:'#49483e'},
    terminal:{background:'#272822',foreground:'#f8f8f2',cursor:'#f8f8f0',cursorAccent:'#272822',selectionBackground:'#49483e',selectionForeground:'#f8f8f2',black:'#272822',red:'#f92672',green:'#a6e22e',yellow:'#f4bf75',blue:'#66d9ef',magenta:'#ae81ff',cyan:'#a1efe4',white:'#f8f8f2',brightBlack:'#75715e',brightRed:'#fd971f',brightGreen:'#a6e22e',brightYellow:'#e6db74',brightBlue:'#66d9ef',brightMagenta:'#ae81ff',brightCyan:'#a1efe4',brightWhite:'#ffffff'},
  },
  'GitHub Dark':{
    mode:'dark',
    ui:{bg:'#0d1117',sidebarBg:'#010409',border:'#30363d',accent:'#58a6ff',text:'#c9d1d9',textMuted:'#8b949e',textBright:'#f0f6fc',textDim:'#21262d',danger:'#f85149',accentBorder:'#388bfd'},
    terminal:{background:'#0d1117',foreground:'#c9d1d9',cursor:'#58a6ff',cursorAccent:'#0d1117',selectionBackground:'#264f78',selectionForeground:'#c9d1d9',black:'#484f58',red:'#ff7b72',green:'#3fb950',yellow:'#d29922',blue:'#58a6ff',magenta:'#bc8cff',cyan:'#39c5cf',white:'#b1bac4',brightBlack:'#6e7681',brightRed:'#ffa198',brightGreen:'#56d364',brightYellow:'#e3b341',brightBlue:'#79c0ff',brightMagenta:'#d2a8ff',brightCyan:'#56d4dd',brightWhite:'#ffffff'},
  },
  'Material Ocean':{
    mode:'dark',
    ui:{bg:'#0f111a',sidebarBg:'#0a0c12',border:'#1a1c25',accent:'#84ffff',text:'#8f93a2',textMuted:'#676e95',textBright:'#eeffff',textDim:'#1a1c25',danger:'#ff5370',accentBorder:'#2b2f3b'},
    terminal:{background:'#0f111a',foreground:'#8f93a2',cursor:'#ffcc00',cursorAccent:'#0f111a',selectionBackground:'#80cbc420',selectionForeground:'#eeffff',black:'#546e7a',red:'#ff5370',green:'#c3e88d',yellow:'#ffcb6b',blue:'#82aaff',magenta:'#c792ea',cyan:'#89ddff',white:'#eeffff',brightBlack:'#546e7a',brightRed:'#f07178',brightGreen:'#c3e88d',brightYellow:'#ffcb6b',brightBlue:'#82aaff',brightMagenta:'#c792ea',brightCyan:'#89ddff',brightWhite:'#ffffff'},
  },
  'Material Palenight':{
    mode:'dark',
    ui:{bg:'#292d3e',sidebarBg:'#1e2030',border:'#3a3f5c',accent:'#c792ea',text:'#a6accd',textMuted:'#676e95',textBright:'#eeffff',textDim:'#3a3f5c',danger:'#ff5370',accentBorder:'#4a4e6a'},
    terminal:{background:'#292d3e',foreground:'#a6accd',cursor:'#ffcc00',cursorAccent:'#292d3e',selectionBackground:'#676e9536',selectionForeground:'#eeffff',black:'#546e7a',red:'#ff5370',green:'#c3e88d',yellow:'#ffcb6b',blue:'#82aaff',magenta:'#c792ea',cyan:'#89ddff',white:'#eeffff',brightBlack:'#546e7a',brightRed:'#f07178',brightGreen:'#c3e88d',brightYellow:'#ffcb6b',brightBlue:'#82aaff',brightMagenta:'#c792ea',brightCyan:'#89ddff',brightWhite:'#ffffff'},
  },
  'Ayu Dark':{
    mode:'dark',
    ui:{bg:'#0a0e14',sidebarBg:'#010409',border:'#1a1f29',accent:'#39bae6',text:'#b3b1ad',textMuted:'#626a73',textBright:'#e6e1cf',textDim:'#1a1f29',danger:'#d95757',accentBorder:'#2a3040'},
    terminal:{background:'#0a0e14',foreground:'#b3b1ad',cursor:'#f29e74',cursorAccent:'#0a0e14',selectionBackground:'#1a1f29',selectionForeground:'#e6e1cf',black:'#1a1f29',red:'#d95757',green:'#7fd962',yellow:'#f29e74',blue:'#39bae6',magenta:'#d2a6ff',cyan:'#95e6cb',white:'#c7c7c7',brightBlack:'#1a1f29',brightRed:'#d95757',brightGreen:'#7fd962',brightYellow:'#f29e74',brightBlue:'#39bae6',brightMagenta:'#d2a6ff',brightCyan:'#95e6cb',brightWhite:'#ffffff'},
  },
  'Gruvbox Dark':{
    mode:'dark',
    ui:{bg:'#282828',sidebarBg:'#1d2021',border:'#3c3836',accent:'#fe8019',text:'#ebdbb2',textMuted:'#928374',textBright:'#fbf1c7',textDim:'#3c3836',danger:'#fb4934',accentBorder:'#504945'},
    terminal:{background:'#282828',foreground:'#ebdbb2',cursor:'#ebdbb2',cursorAccent:'#282828',selectionBackground:'#504945',selectionForeground:'#ebdbb2',black:'#282828',red:'#cc241d',green:'#98971a',yellow:'#d79921',blue:'#458588',magenta:'#b16286',cyan:'#689d6a',white:'#a89984',brightBlack:'#928374',brightRed:'#fb4934',brightGreen:'#b8bb26',brightYellow:'#fabd2f',brightBlue:'#83a598',brightMagenta:'#d3869b',brightCyan:'#8ec07c',brightWhite:'#ebdbb2'},
  },
  'Ros\u00e9 Pine':{
    mode:'dark',
    ui:{bg:'#191724',sidebarBg:'#1f1d2e',border:'#26233a',accent:'#c4a7e7',text:'#e0def4',textMuted:'#6e6a86',textBright:'#e0def4',textDim:'#26233a',danger:'#eb6f92',accentBorder:'#403d52'},
    terminal:{background:'#191724',foreground:'#e0def4',cursor:'#e0def4',cursorAccent:'#191724',selectionBackground:'#403d52',selectionForeground:'#e0def4',black:'#26233a',red:'#eb6f92',green:'#31748f',yellow:'#f6c177',blue:'#9ccfd8',magenta:'#c4a7e7',cyan:'#ebbcba',white:'#e0def4',brightBlack:'#6e6a86',brightRed:'#eb6f92',brightGreen:'#31748f',brightYellow:'#f6c177',brightBlue:'#9ccfd8',brightMagenta:'#c4a7e7',brightCyan:'#ebbcba',brightWhite:'#e0def4'},
  },
  'Night Owl':{
    mode:'dark',
    ui:{bg:'#011627',sidebarBg:'#001122',border:'#1d3449',accent:'#82aaff',text:'#d6deeb',textMuted:'#5f7e97',textBright:'#ffffff',textDim:'#1d3449',danger:'#ef5350',accentBorder:'#2a4560'},
    terminal:{background:'#011627',foreground:'#d6deeb',cursor:'#80a4c2',cursorAccent:'#011627',selectionBackground:'#1d3b53',selectionForeground:'#ffffff',black:'#011627',red:'#ef5350',green:'#22da6e',yellow:'#c5e478',blue:'#82aaff',magenta:'#c792ea',cyan:'#21c7a8',white:'#ffffff',brightBlack:'#575656',brightRed:'#ef5350',brightGreen:'#22da6e',brightYellow:'#ffeb95',brightBlue:'#82aaff',brightMagenta:'#c792ea',brightCyan:'#7fdbca',brightWhite:'#ffffff'},
  },
  'Cobalt\u00b2':{
    mode:'dark',
    ui:{bg:'#193549',sidebarBg:'#15232f',border:'#2a4a63',accent:'#ffc600',text:'#ffffff',textMuted:'#0088ff',textBright:'#ffffff',textDim:'#1f4662',danger:'#ff628c',accentBorder:'#3a6a8a'},
    terminal:{background:'#193549',foreground:'#ffffff',cursor:'#ffc600',cursorAccent:'#193549',selectionBackground:'#003c8f',selectionForeground:'#ffffff',black:'#000000',red:'#ff628c',green:'#08ff00',yellow:'#ff9f00',blue:'#0088ff',magenta:'#ff00ff',cyan:'#00fdf8',white:'#bbbbbb',brightBlack:'#555555',brightRed:'#ff628c',brightGreen:'#08ff00',brightYellow:'#ffcc00',brightBlue:'#0099ff',brightMagenta:'#ff77ff',brightCyan:'#00fdf8',brightWhite:'#ffffff'},
  },
  'Shades of Purple':{
    mode:'dark',
    ui:{bg:'#2d2b55',sidebarBg:'#242240',border:'#3c3a6e',accent:'#a78bfa',text:'#a5b3ce',textMuted:'#5c5a8c',textBright:'#ffffff',textDim:'#3c3a6e',danger:'#ff6b8a',accentBorder:'#4a4880'},
    terminal:{background:'#2d2b55',foreground:'#a5b3ce',cursor:'#a78bfa',cursorAccent:'#2d2b55',selectionBackground:'#3c3a6e',selectionForeground:'#ffffff',black:'#242240',red:'#ff6b8a',green:'#7addff',yellow:'#ffb8d1',blue:'#a78bfa',magenta:'#ff9ef5',cyan:'#36f9f6',white:'#ffffff',brightBlack:'#5c5a8c',brightRed:'#ff6b8a',brightGreen:'#7addff',brightYellow:'#ffb8d1',brightBlue:'#a78bfa',brightMagenta:'#ff9ef5',brightCyan:'#36f9f6',brightWhite:'#ffffff'},
  },
  'Horizon':{
    mode:'dark',
    ui:{bg:'#1c1e26',sidebarBg:'#16161c',border:'#232530',accent:'#e95678',text:'#cbced0',textMuted:'#6c6f93',textBright:'#d5d8da',textDim:'#232530',danger:'#e95678',accentBorder:'#2e303e'},
    terminal:{background:'#1c1e26',foreground:'#cbced0',cursor:'#e95678',cursorAccent:'#1c1e26',selectionBackground:'#2e303e',selectionForeground:'#cbced0',black:'#1c1e26',red:'#e95678',green:'#09f7a0',yellow:'#f7c67f',blue:'#21bfc2',magenta:'#b877db',cyan:'#53dce0',white:'#cbced0',brightBlack:'#6c6f93',brightRed:'#e95678',brightGreen:'#09f7a0',brightYellow:'#f7c67f',brightBlue:'#21bfc2',brightMagenta:'#b877db',brightCyan:'#53dce0',brightWhite:'#ffffff'},
  },
  'Doom One':{
    mode:'dark',
    ui:{bg:'#282c34',sidebarBg:'#21252b',border:'#3e4451',accent:'#51afef',text:'#bbc2cf',textMuted:'#5b6268',textBright:'#ffffff',textDim:'#3e4451',danger:'#ff6c6b',accentBorder:'#4a5060'},
    terminal:{background:'#282c34',foreground:'#bbc2cf',cursor:'#51afef',cursorAccent:'#282c34',selectionBackground:'#3e4451',selectionForeground:'#bbc2cf',black:'#282c34',red:'#ff6c6b',green:'#98be65',yellow:'#ecbe7a',blue:'#51afef',magenta:'#c678dd',cyan:'#46d9ff',white:'#bbc2cf',brightBlack:'#5b6268',brightRed:'#ff6c6b',brightGreen:'#98be65',brightYellow:'#ecbe7a',brightBlue:'#51afef',brightMagenta:'#c678dd',brightCyan:'#46d9ff',brightWhite:'#ffffff'},
  },
  'Everforest':{
    mode:'dark',
    ui:{bg:'#2b3339',sidebarBg:'#22272e',border:'#3a4249',accent:'#a7c080',text:'#d3c6aa',textMuted:'#859289',textBright:'#d3c6aa',textDim:'#3a4249',danger:'#e67e80',accentBorder:'#4a555b'},
    terminal:{background:'#2b3339',foreground:'#d3c6aa',cursor:'#d3c6aa',cursorAccent:'#2b3339',selectionBackground:'#4a555b',selectionForeground:'#d3c6aa',black:'#3a4249',red:'#e67e80',green:'#a7c080',yellow:'#dbbc7f',blue:'#7fbbb3',magenta:'#d699b6',cyan:'#7fbbb3',white:'#d3c6aa',brightBlack:'#5c6a72',brightRed:'#e67e80',brightGreen:'#a7c080',brightYellow:'#dbbc7f',brightBlue:'#7fbbb3',brightMagenta:'#d699b6',brightCyan:'#7fbbb3',brightWhite:'#d3c6aa'},
  },
  'Kanagawa':{
    mode:'dark',
    ui:{bg:'#1f1f28',sidebarBg:'#181820',border:'#2a2a37',accent:'#7e9cd8',text:'#dcd7ba',textMuted:'#54546d',textBright:'#dcd7ba',textDim:'#2a2a37',danger:'#c34043',accentBorder:'#363646'},
    terminal:{background:'#1f1f28',foreground:'#dcd7ba',cursor:'#dcd7ba',cursorAccent:'#1f1f28',selectionBackground:'#2a2a37',selectionForeground:'#dcd7ba',black:'#090618',red:'#c34043',green:'#769462',yellow:'#c0a36e',blue:'#7e9cd8',magenta:'#957fb8',cyan:'#6a9589',white:'#c8c093',brightBlack:'#727169',brightRed:'#e82424',brightGreen:'#98bb6c',brightYellow:'#e6c384',brightBlue:'#7fb4ca',brightMagenta:'#938aa9',brightCyan:'#7aa89f',brightWhite:'#dcd7ba'},
  },
  'Synthwave \'84':{
    mode:'dark',
    ui:{bg:'#262335',sidebarBg:'#1e1b2e',border:'#36325a',accent:'#f97e72',text:'#e0d0c0',textMuted:'#6a5f84',textBright:'#f8f1e8',textDim:'#36325a',danger:'#f97e72',accentBorder:'#4a4480'},
    terminal:{background:'#262335',foreground:'#e0d0c0',cursor:'#f97e72',cursorAccent:'#262335',selectionBackground:'#36325a',selectionForeground:'#f8f1e8',black:'#262335',red:'#f97e72',green:'#72f1b8',yellow:'#f5d76e',blue:'#7b89bf',magenta:'#ff7edb',cyan:'#72f1b8',white:'#e0d0c0',brightBlack:'#6a5f84',brightRed:'#f97e72',brightGreen:'#72f1b8',brightYellow:'#f5d76e',brightBlue:'#7b89bf',brightMagenta:'#ff7edb',brightCyan:'#72f1b8',brightWhite:'#f8f1e8'},
  },
  // \u2500\u2500 Additional dark themes \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  'VSCode Dark+':{
    mode:'dark',
    ui:{bg:'#1e1e1e',sidebarBg:'#252526',border:'#3c3c3c',accent:'#569cd6',text:'#d4d4d4',textMuted:'#858585',textBright:'#ffffff',textDim:'#3c3c3c',danger:'#f44747',accentBorder:'#007acc'},
    terminal:{background:'#1e1e1e',foreground:'#cccccc',cursor:'#aeafad',cursorAccent:'#1e1e1e',selectionBackground:'#264f78',selectionForeground:'#ffffff',black:'#000000',red:'#cd3131',green:'#0dbc79',yellow:'#e5e510',blue:'#2472c8',magenta:'#bc3fbc',cyan:'#11a8cd',white:'#e5e5e5',brightBlack:'#666666',brightRed:'#f14c4c',brightGreen:'#23d18b',brightYellow:'#f5f543',brightBlue:'#3b8eea',brightMagenta:'#d670d6',brightCyan:'#29b8db',brightWhite:'#ffffff'},
  },
  'VSCode Dark Modern':{
    mode:'dark',
    ui:{bg:'#1f1f1f',sidebarBg:'#181818',border:'#2b2b2b',accent:'#0078d4',text:'#cccccc',textMuted:'#9d9d9d',textBright:'#ffffff',textDim:'#2b2b2b',danger:'#f85149',accentBorder:'#0078d4'},
    terminal:{background:'#1f1f1f',foreground:'#cccccc',cursor:'#aeafad',cursorAccent:'#1f1f1f',selectionBackground:'#264f78',selectionForeground:'#ffffff',black:'#272727',red:'#f74e4e',green:'#5fa84d',yellow:'#f5f543',blue:'#3b8eea',magenta:'#bc3fbc',cyan:'#11a8cd',white:'#e5e5e5',brightBlack:'#666666',brightRed:'#f87171',brightGreen:'#7fd962',brightYellow:'#fbbf24',brightBlue:'#60a5fa',brightMagenta:'#d670d6',brightCyan:'#22d3ee',brightWhite:'#ffffff'},
  },
  'Vesper':{
    mode:'dark',
    ui:{bg:'#101010',sidebarBg:'#161616',border:'#232323',accent:'#ffc799',text:'#ffffff',textMuted:'#8b8b8b',textBright:'#ffffff',textDim:'#232323',danger:'#ff8080',accentBorder:'#3d3d3d'},
    terminal:{background:'#101010',foreground:'#ffffff',cursor:'#ffc799',cursorAccent:'#101010',selectionBackground:'#3d3d3d',selectionForeground:'#ffffff',black:'#101010',red:'#ff8080',green:'#99ffe4',yellow:'#ffc799',blue:'#a0a0a0',magenta:'#ff8080',cyan:'#99ffe4',white:'#ffffff',brightBlack:'#8b8b8b',brightRed:'#ff8080',brightGreen:'#99ffe4',brightYellow:'#ffc799',brightBlue:'#a0a0a0',brightMagenta:'#ff8080',brightCyan:'#99ffe4',brightWhite:'#ffffff'},
  },
  'Vitesse Dark':{
    mode:'dark',
    ui:{bg:'#121212',sidebarBg:'#181818',border:'#252525',accent:'#4d9375',text:'#dbd7ca',textMuted:'#7d8087',textBright:'#dbd7ca',textDim:'#252525',danger:'#cb7676',accentBorder:'#393a34'},
    terminal:{background:'#121212',foreground:'#dbd7ca',cursor:'#dbd7ca',cursorAccent:'#121212',selectionBackground:'#393a34',selectionForeground:'#dbd7ca',black:'#393a34',red:'#cb7676',green:'#4d9375',yellow:'#dbd7ca',blue:'#6394bf',magenta:'#d3869b',cyan:'#5eaab5',white:'#dbd7ca',brightBlack:'#7d8087',brightRed:'#cb7676',brightGreen:'#80a665',brightYellow:'#e6cc77',brightBlue:'#6394bf',brightMagenta:'#d3869b',brightCyan:'#5eaab5',brightWhite:'#dbd7ca'},
  },
  'Houston':{
    mode:'dark',
    ui:{bg:'#17191e',sidebarBg:'#1d1f25',border:'#2e313a',accent:'#00d8ff',text:'#cdd6f4',textMuted:'#858da3',textBright:'#ffffff',textDim:'#2e313a',danger:'#ff5d77',accentBorder:'#0078d4'},
    terminal:{background:'#17191e',foreground:'#cdd6f4',cursor:'#00d8ff',cursorAccent:'#17191e',selectionBackground:'#2e313a',selectionForeground:'#ffffff',black:'#17191e',red:'#ff5d77',green:'#00d6c5',yellow:'#ffac4f',blue:'#00d8ff',magenta:'#cc83fa',cyan:'#00d6c5',white:'#cdd6f4',brightBlack:'#858da3',brightRed:'#ff7d92',brightGreen:'#5eead4',brightYellow:'#ffc371',brightBlue:'#7fe2ff',brightMagenta:'#dba6ff',brightCyan:'#5eead4',brightWhite:'#ffffff'},
  },
  'Andromeda':{
    mode:'dark',
    ui:{bg:'#23262e',sidebarBg:'#1f2229',border:'#2b2f38',accent:'#ee5d43',text:'#d5ced9',textMuted:'#5f6167',textBright:'#ffffff',textDim:'#2b2f38',danger:'#ee5d43',accentBorder:'#3e4359'},
    terminal:{background:'#23262e',foreground:'#d5ced9',cursor:'#ee5d43',cursorAccent:'#23262e',selectionBackground:'#3e4359',selectionForeground:'#ffffff',black:'#1e2025',red:'#ee5d43',green:'#96e072',yellow:'#ffe66d',blue:'#7cb7ff',magenta:'#c74ded',cyan:'#00e8c6',white:'#d5ced9',brightBlack:'#5f6167',brightRed:'#f48d6f',brightGreen:'#a8e87f',brightYellow:'#ffe66d',brightBlue:'#9ec1ff',brightMagenta:'#c74ded',brightCyan:'#00e8c6',brightWhite:'#ffffff'},
  },
  'Iceberg':{
    mode:'dark',
    ui:{bg:'#161821',sidebarBg:'#0f1117',border:'#1e2132',accent:'#84a0c6',text:'#c6c8d1',textMuted:'#6b7089',textBright:'#d2d4de',textDim:'#1e2132',danger:'#e27878',accentBorder:'#444b71'},
    terminal:{background:'#161821',foreground:'#c6c8d1',cursor:'#c6c8d1',cursorAccent:'#161821',selectionBackground:'#272c42',selectionForeground:'#c6c8d1',black:'#161821',red:'#e27878',green:'#b4be82',yellow:'#e2a478',blue:'#84a0c6',magenta:'#a093c7',cyan:'#89b8c2',white:'#c6c8d1',brightBlack:'#6b7089',brightRed:'#e98989',brightGreen:'#c0ca8e',brightYellow:'#e9b189',brightBlue:'#91acd1',brightMagenta:'#ada0d3',brightCyan:'#95c4ce',brightWhite:'#d2d4de'},
  },
  'Tomorrow Night':{
    mode:'dark',
    ui:{bg:'#1d1f21',sidebarBg:'#161719',border:'#373b41',accent:'#81a2be',text:'#c5c8c6',textMuted:'#969896',textBright:'#ffffff',textDim:'#373b41',danger:'#cc6666',accentBorder:'#5e6770'},
    terminal:{background:'#1d1f21',foreground:'#c5c8c6',cursor:'#c5c8c6',cursorAccent:'#1d1f21',selectionBackground:'#373b41',selectionForeground:'#c5c8c6',black:'#1d1f21',red:'#cc6666',green:'#b5bd68',yellow:'#f0c674',blue:'#81a2be',magenta:'#b294bb',cyan:'#8abeb7',white:'#c5c8c6',brightBlack:'#969896',brightRed:'#d54e53',brightGreen:'#b9ca4a',brightYellow:'#e7c547',brightBlue:'#7aa6da',brightMagenta:'#c397d8',brightCyan:'#70c0b1',brightWhite:'#ffffff'},
  },
  'Monokai Pro':{
    mode:'dark',
    ui:{bg:'#2d2a2e',sidebarBg:'#221f22',border:'#403e41',accent:'#ffd866',text:'#fcfcfa',textMuted:'#727072',textBright:'#fcfcfa',textDim:'#403e41',danger:'#ff6188',accentBorder:'#5b595c'},
    terminal:{background:'#2d2a2e',foreground:'#fcfcfa',cursor:'#fcfcfa',cursorAccent:'#2d2a2e',selectionBackground:'#5b595c',selectionForeground:'#fcfcfa',black:'#403e41',red:'#ff6188',green:'#a9dc76',yellow:'#ffd866',blue:'#fc9867',magenta:'#ab9df2',cyan:'#78dce8',white:'#fcfcfa',brightBlack:'#727072',brightRed:'#ff6188',brightGreen:'#a9dc76',brightYellow:'#ffd866',brightBlue:'#fc9867',brightMagenta:'#ab9df2',brightCyan:'#78dce8',brightWhite:'#fcfcfa'},
  },
  'Apprentice':{
    mode:'dark',
    ui:{bg:'#262626',sidebarBg:'#1c1c1c',border:'#444444',accent:'#87afaf',text:'#bcbcbc',textMuted:'#6c6c6c',textBright:'#dadada',textDim:'#444444',danger:'#af5f5f',accentBorder:'#5f8787'},
    terminal:{background:'#262626',foreground:'#bcbcbc',cursor:'#dadada',cursorAccent:'#262626',selectionBackground:'#444444',selectionForeground:'#dadada',black:'#1c1c1c',red:'#af5f5f',green:'#5f875f',yellow:'#87875f',blue:'#5f87af',magenta:'#8787af',cyan:'#5f8787',white:'#6c6c6c',brightBlack:'#444444',brightRed:'#ff8700',brightGreen:'#87af87',brightYellow:'#ffffaf',brightBlue:'#8fafd7',brightMagenta:'#8787af',brightCyan:'#5fafaf',brightWhite:'#ffffff'},
  },
  'Snazzy':{
    mode:'dark',
    ui:{bg:'#282a36',sidebarBg:'#21222c',border:'#34353e',accent:'#ff6ac1',text:'#eff0eb',textMuted:'#7d7d7d',textBright:'#ffffff',textDim:'#34353e',danger:'#ff5c57',accentBorder:'#3e3f4a'},
    terminal:{background:'#282a36',foreground:'#eff0eb',cursor:'#97979b',cursorAccent:'#282a36',selectionBackground:'#3e3f4a',selectionForeground:'#eff0eb',black:'#282a36',red:'#ff5c57',green:'#5af78e',yellow:'#f3f99d',blue:'#57c7ff',magenta:'#ff6ac1',cyan:'#9aedfe',white:'#f1f1f0',brightBlack:'#686868',brightRed:'#ff5c57',brightGreen:'#5af78e',brightYellow:'#f3f99d',brightBlue:'#57c7ff',brightMagenta:'#ff6ac1',brightCyan:'#9aedfe',brightWhite:'#eff0eb'},
  },
  'Catppuccin Frapp\u00e9':{
    mode:'dark',
    ui:{bg:'#303446',sidebarBg:'#292c3c',border:'#414559',accent:'#8caaee',text:'#c6d0f5',textMuted:'#737994',textBright:'#f2d5cf',textDim:'#414559',danger:'#e78284',accentBorder:'#51576d'},
    terminal:{background:'#303446',foreground:'#c6d0f5',cursor:'#f2d5cf',cursorAccent:'#303446',selectionBackground:'#51576d',selectionForeground:'#c6d0f5',black:'#51576d',red:'#e78284',green:'#a6d189',yellow:'#e5c890',blue:'#8caaee',magenta:'#f4b8e4',cyan:'#81c8be',white:'#b5bfe2',brightBlack:'#626880',brightRed:'#e78284',brightGreen:'#a6d189',brightYellow:'#e5c890',brightBlue:'#8caaee',brightMagenta:'#f4b8e4',brightCyan:'#81c8be',brightWhite:'#a5adce'},
  },
  // \u2500\u2500 Light themes \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  'GitHub Light':{
    mode:'light',
    ui:{bg:'#ffffff',sidebarBg:'#f6f8fa',border:'#d0d7de',accent:'#0969da',text:'#1f2328',textMuted:'#656d76',textBright:'#1f2328',textDim:'#d8dee4',danger:'#cf222e',accentBorder:'#0969da'},
    terminal:{background:'#ffffff',foreground:'#1f2328',cursor:'#1f2328',cursorAccent:'#ffffff',selectionBackground:'#b6e3ff',selectionForeground:'#1f2328',black:'#24292f',red:'#cf222e',green:'#1a7f37',yellow:'#9a6700',blue:'#0969da',magenta:'#8250df',cyan:'#1b7c83',white:'#6e7781',brightBlack:'#57606a',brightRed:'#a40e26',brightGreen:'#116329',brightYellow:'#4d2d00',brightBlue:'#0550ae',brightMagenta:'#6639ba',brightCyan:'#3192aa',brightWhite:'#8c959f'},
  },
  'Solarized Light':{
    mode:'light',
    ui:{bg:'#fdf6e3',sidebarBg:'#eee8d5',border:'#eee8d5',accent:'#268bd2',text:'#657b83',textMuted:'#93a1a1',textBright:'#586e75',textDim:'#eee8d5',danger:'#dc322f',accentBorder:'#93a1a1'},
    terminal:{background:'#fdf6e3',foreground:'#657b83',cursor:'#586e75',cursorAccent:'#fdf6e3',selectionBackground:'#eee8d5',selectionForeground:'#586e75',black:'#073642',red:'#dc322f',green:'#859900',yellow:'#b58900',blue:'#268bd2',magenta:'#d33682',cyan:'#2aa198',white:'#eee8d5',brightBlack:'#002b36',brightRed:'#cb4b16',brightGreen:'#586e75',brightYellow:'#657b83',brightBlue:'#839496',brightMagenta:'#6c71c4',brightCyan:'#93a1a1',brightWhite:'#fdf6e3'},
  },
  'One Light':{
    mode:'light',
    ui:{bg:'#fafafa',sidebarBg:'#f0f0f0',border:'#e5e5e6',accent:'#4078f2',text:'#383a42',textMuted:'#a0a1a7',textBright:'#202329',textDim:'#e5e5e6',danger:'#e45649',accentBorder:'#4078f2'},
    terminal:{background:'#fafafa',foreground:'#383a42',cursor:'#383a42',cursorAccent:'#fafafa',selectionBackground:'#e5e5e6',selectionForeground:'#383a42',black:'#383a42',red:'#e45649',green:'#50a14f',yellow:'#c18401',blue:'#4078f2',magenta:'#a626a4',cyan:'#0184bc',white:'#a0a1a7',brightBlack:'#696c77',brightRed:'#ca1243',brightGreen:'#50a14f',brightYellow:'#986801',brightBlue:'#4078f2',brightMagenta:'#a626a4',brightCyan:'#0184bc',brightWhite:'#383a42'},
  },
  'Tokyo Night Light':{
    mode:'light',
    ui:{bg:'#d5d6db',sidebarBg:'#cbccd1',border:'#b7b9c0',accent:'#34548a',text:'#343b58',textMuted:'#6c6e75',textBright:'#343b58',textDim:'#cbccd1',danger:'#8c4351',accentBorder:'#5a6386'},
    terminal:{background:'#d5d6db',foreground:'#343b58',cursor:'#343b58',cursorAccent:'#d5d6db',selectionBackground:'#9699a3',selectionForeground:'#343b58',black:'#0f0f14',red:'#8c4351',green:'#33635c',yellow:'#8f5e15',blue:'#34548a',magenta:'#5a3e8e',cyan:'#0f4b6e',white:'#343b58',brightBlack:'#6c6e75',brightRed:'#a3536b',brightGreen:'#485e30',brightYellow:'#8f5e15',brightBlue:'#34548a',brightMagenta:'#5a3e8e',brightCyan:'#0f4b6e',brightWhite:'#343b58'},
  },
  'Catppuccin Latte':{
    mode:'light',
    ui:{bg:'#eff1f5',sidebarBg:'#e6e9ef',border:'#dce0e8',accent:'#1e66f5',text:'#4c4f69',textMuted:'#9ca0b0',textBright:'#4c4f69',textDim:'#dce0e8',danger:'#d20f39',accentBorder:'#7287fd'},
    terminal:{background:'#eff1f5',foreground:'#4c4f69',cursor:'#dc8a78',cursorAccent:'#eff1f5',selectionBackground:'#bcc0cc',selectionForeground:'#4c4f69',black:'#5c5f77',red:'#d20f39',green:'#40a02b',yellow:'#df8e1d',blue:'#1e66f5',magenta:'#ea76cb',cyan:'#179299',white:'#acb0be',brightBlack:'#6c6f85',brightRed:'#d20f39',brightGreen:'#40a02b',brightYellow:'#df8e1d',brightBlue:'#1e66f5',brightMagenta:'#ea76cb',brightCyan:'#179299',brightWhite:'#bcc0cc'},
  },
  'Gruvbox Light':{
    mode:'light',
    ui:{bg:'#fbf1c7',sidebarBg:'#f2e5bc',border:'#d5c4a1',accent:'#d65d0e',text:'#3c3836',textMuted:'#7c6f64',textBright:'#282828',textDim:'#d5c4a1',danger:'#cc241d',accentBorder:'#bdae93'},
    terminal:{background:'#fbf1c7',foreground:'#3c3836',cursor:'#3c3836',cursorAccent:'#fbf1c7',selectionBackground:'#d5c4a1',selectionForeground:'#3c3836',black:'#fbf1c7',red:'#cc241d',green:'#98971a',yellow:'#d79921',blue:'#458588',magenta:'#b16286',cyan:'#689d6a',white:'#7c6f64',brightBlack:'#928374',brightRed:'#9d0006',brightGreen:'#79740e',brightYellow:'#b57614',brightBlue:'#076678',brightMagenta:'#8f3f71',brightCyan:'#427b58',brightWhite:'#3c3836'},
  },
  'Ros\u00e9 Pine Dawn':{
    mode:'light',
    ui:{bg:'#faf4ed',sidebarBg:'#fffaf3',border:'#dfdad9',accent:'#907aa9',text:'#575279',textMuted:'#9893a5',textBright:'#575279',textDim:'#dfdad9',danger:'#b4637a',accentBorder:'#cecacd'},
    terminal:{background:'#faf4ed',foreground:'#575279',cursor:'#575279',cursorAccent:'#faf4ed',selectionBackground:'#dfdad9',selectionForeground:'#575279',black:'#f2e9e1',red:'#b4637a',green:'#286983',yellow:'#ea9d34',blue:'#56949f',magenta:'#907aa9',cyan:'#d7827e',white:'#575279',brightBlack:'#9893a5',brightRed:'#b4637a',brightGreen:'#286983',brightYellow:'#ea9d34',brightBlue:'#56949f',brightMagenta:'#907aa9',brightCyan:'#d7827e',brightWhite:'#575279'},
  },
  'Ayu Light':{
    mode:'light',
    ui:{bg:'#fcfcfc',sidebarBg:'#f3f4f5',border:'#e5e6e7',accent:'#399ee6',text:'#5c6166',textMuted:'#8a9199',textBright:'#3a3f43',textDim:'#e5e6e7',danger:'#f07171',accentBorder:'#abb0b6'},
    terminal:{background:'#fcfcfc',foreground:'#5c6166',cursor:'#ff6a00',cursorAccent:'#fcfcfc',selectionBackground:'#e5e6e7',selectionForeground:'#5c6166',black:'#000000',red:'#f07171',green:'#86b300',yellow:'#f2ae49',blue:'#399ee6',magenta:'#a37acc',cyan:'#4cbf99',white:'#abb0b6',brightBlack:'#8a9199',brightRed:'#f07171',brightGreen:'#86b300',brightYellow:'#f2ae49',brightBlue:'#399ee6',brightMagenta:'#a37acc',brightCyan:'#4cbf99',brightWhite:'#3a3f43'},
  },
  'Everforest Light':{
    mode:'light',
    ui:{bg:'#fdf6e3',sidebarBg:'#f4f0d9',border:'#e0dcc7',accent:'#8da101',text:'#5c6a72',textMuted:'#939f91',textBright:'#3a4143',textDim:'#e0dcc7',danger:'#f85552',accentBorder:'#a6b0a0'},
    terminal:{background:'#fdf6e3',foreground:'#5c6a72',cursor:'#5c6a72',cursorAccent:'#fdf6e3',selectionBackground:'#bec5b2',selectionForeground:'#5c6a72',black:'#5c6a72',red:'#f85552',green:'#8da101',yellow:'#dfa000',blue:'#3a94c5',magenta:'#df69ba',cyan:'#35a77c',white:'#dfddc8',brightBlack:'#939f91',brightRed:'#f85552',brightGreen:'#8da101',brightYellow:'#dfa000',brightBlue:'#3a94c5',brightMagenta:'#df69ba',brightCyan:'#35a77c',brightWhite:'#fdf6e3'},
  },
  'Quiet Light':{
    mode:'light',
    ui:{bg:'#f5f5f5',sidebarBg:'#eeeeee',border:'#dddddd',accent:'#4b69c6',text:'#333333',textMuted:'#888888',textBright:'#1f1f1f',textDim:'#dddddd',danger:'#a31515',accentBorder:'#aabbdd'},
    terminal:{background:'#f5f5f5',foreground:'#333333',cursor:'#4b69c6',cursorAccent:'#f5f5f5',selectionBackground:'#c6dbf1',selectionForeground:'#333333',black:'#333333',red:'#a31515',green:'#7a3e9d',yellow:'#9f4e44',blue:'#4b69c6',magenta:'#7a3e9d',cyan:'#318495',white:'#888888',brightBlack:'#666666',brightRed:'#cd3131',brightGreen:'#7a3e9d',brightYellow:'#bc6f3c',brightBlue:'#4b69c6',brightMagenta:'#aa5d92',brightCyan:'#3e8fc1',brightWhite:'#1f1f1f'},
  },
  'Vitesse Light':{
    mode:'light',
    ui:{bg:'#ffffff',sidebarBg:'#f9f9f9',border:'#e5e5e5',accent:'#1e754f',text:'#393a34',textMuted:'#a0ada0',textBright:'#181818',textDim:'#e5e5e5',danger:'#ab5959',accentBorder:'#a0ada0'},
    terminal:{background:'#ffffff',foreground:'#393a34',cursor:'#393a34',cursorAccent:'#ffffff',selectionBackground:'#e1e3e6',selectionForeground:'#393a34',black:'#393a34',red:'#ab5959',green:'#1e754f',yellow:'#a65e2b',blue:'#296aa3',magenta:'#a13865',cyan:'#2993a3',white:'#a0ada0',brightBlack:'#aaaaaa',brightRed:'#bd6b6b',brightGreen:'#358a64',brightYellow:'#bf7836',brightBlue:'#3179b3',brightMagenta:'#bd5078',brightCyan:'#3aa3b4',brightWhite:'#181818'},
  },
};

let currentThemeName='Tokyo Night';
let customTheme=null; // {ui:{...}, terminal:{...}} or null

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
  for(const p of app.panes.values()){if(p.term)p.term.options.theme=t.terminal}
}

function getCurrentTheme(){return customTheme||THEMES[currentThemeName]}

const TOPTS={
  scrollback:50000,cursorBlink:true,cursorStyle:'block',
  fontSize:14,lineHeight:1.2,allowProposedApi:true,logLevel:'off',
  fontFamily:"'Menlo','Monaco','Consolas','Liberation Mono','Courier New',monospace",
  theme:THEMES['Tokyo Night'].terminal,
};

// ═══ TermPane: xterm + WebSocket ═══

class TermPane {
  constructor(id, name) {
    this.id=id; this.name=name;
    this.ws=null; this.term=null; this.fit=null; this._opened=false; this._buf=[]; this._reconnecting=false; this._destroyed=false; this._retryDelay=1000;
    this._sendQueue=[]; this._sendQueueMax=64; this._sendDropCount=0;
    this._decoder=new TextDecoder('utf-8',{fatal:false}); this._outputBuf=''; this._flushScheduled=false;
    this.el=document.createElement('div');
    this.el.className='tp'; this.el.dataset.pid=id;
    this.box=document.createElement('div');
    this.box.style.cssText='width:100%;height:100%';
    this.el.appendChild(this.box);
    // Drag & drop upload
    this.el.addEventListener('dragover',e=>{e.preventDefault();if([...e.dataTransfer.types].includes('Files')){e.stopPropagation();this.el.classList.add('dragover')}});
    this.el.addEventListener('dragleave',()=>this.el.classList.remove('dragover'));
    this.el.addEventListener('drop',e=>{if(!e.dataTransfer.files||!e.dataTransfer.files.length)return;e.preventDefault();e.stopPropagation();this.el.classList.remove('dragover');this._uploadFiles(e.dataTransfer.files)});
  }
  open() {
    if(this._opened) return; this._opened=true;
    this.term=new Terminal(TOPTS);
    this.fit=new FitAddon.FitAddon();
    this.term.loadAddon(this.fit);
    try{this.term.loadAddon(new WebLinksAddon.WebLinksAddon((_e,uri)=>{
      const w=window.open(uri,'_blank');
      const pendingId=codeServerPending.get(uri);
      if(pendingId&&w){codeServerPending.delete(uri);codeServerTrack(pendingId,w)}
    }))}catch(e){}
    try{this.term.loadAddon(new Unicode11Addon.Unicode11Addon());this.term.unicode.activeVersion='11'}catch(e){}
    try{this.search=new SearchAddon.SearchAddon();this.term.loadAddon(this.search)}catch(e){}
    this.term.open(this.box);
    this.term.attachCustomKeyEventHandler(e=>{
      if(e.key==='Enter'&&e.shiftKey&&!e.ctrlKey&&!e.altKey&&!e.metaKey){
        if(e.type==='keydown') this._send(new Uint8Array([OP.INPUT,0x1b,0x0d]));
        e.preventDefault();
        e.stopPropagation();
        return false;
      }
      return true;
    });
    // Block browser Ctrl+ shortcuts → let them go to terminal
    // Cmd+ shortcuts left for browser (copy/paste/tab close etc)
    this.box.addEventListener('keydown',e=>{
      // Cmd+Left/Right → Home/End
      if(e.metaKey&&!e.ctrlKey&&!e.altKey){
        if(e.key==='ArrowLeft'){e.preventDefault();this._send(new Uint8Array([OP.INPUT,0x01]));return}
        if(e.key==='ArrowRight'){e.preventDefault();this._send(new Uint8Array([OP.INPUT,0x05]));return}
      }
      // Alt+Left/Right → word jump
      if(e.altKey&&!e.ctrlKey&&!e.metaKey){
        if(e.key==='ArrowLeft'){e.preventDefault();this._send(new Uint8Array([OP.INPUT,0x1b,0x62]));return}
        if(e.key==='ArrowRight'){e.preventDefault();this._send(new Uint8Array([OP.INPUT,0x1b,0x66]));return}
      }
      // Ctrl+ shortcuts → bypass to terminal, block browser
      if(e.ctrlKey&&!e.metaKey) e.preventDefault();
    });
    this.term.onData(d=>{
      let out=d;
      // Apply mobile sticky modifier (Ctrl/Alt) to virtual-keyboard input
      const A=window.app;
      if(A && A.isMobile && A._modKbd && out.length===1){
        const mk=A._modKbd;
        const c=out.charCodeAt(0);
        if(mk.ctrl && c>=0x40 && c<=0x7e) out=String.fromCharCode(c & 0x1f);
        if(mk.alt) out='\x1b'+out;
        let changed=false;
        if(mk.ctrl===true){mk.ctrl=false;changed=true}
        if(mk.alt===true){mk.alt=false;changed=true}
        if(changed){
          document.querySelectorAll('#mobile-keybar .mkb-btn[data-mod]').forEach(b=>{
            const mm=b.dataset.mod, st=mk[mm];
            b.classList.toggle('sticky', st===true);
            b.classList.toggle('locked', st==='lock');
          });
        }
      }
      const b=enc.encode(out);
      const m=new Uint8Array(1+b.length);m[0]=OP.INPUT;m.set(b,1);
      this._send(m);
    });
    this.term.onResize(({cols,rows})=>{
      const m=new Uint8Array(5);m[0]=OP.RESIZE;
      new DataView(m.buffer).setUint16(1,cols,false);
      new DataView(m.buffer).setUint16(3,rows,false);
      this._send(m);
    });
    try{this.fit.fit()}catch{}
    for(const d of this._buf) try{this.term.write(d)}catch{}
    this._buf=[];
    if(this.term) this.term.scrollToBottom();
  }
  connect() {
    const p=location.protocol==='https:'?'wss:':'ws:';
    const cols=(this.term&&this.term.cols)||120;
    const rows=(this.term&&this.term.rows)||40;
    const url=`${p}//${location.host}/ws?cols=${cols}&rows=${rows}&pane=${encodeURIComponent(this.id)}`;
    this.ws=new WebSocket(url); this.ws.binaryType='arraybuffer';
    this.ws.onopen=()=>{
      if(this.term){
        const m=new Uint8Array(5);m[0]=OP.RESIZE;
        new DataView(m.buffer).setUint16(1,this.term.cols,false);
        new DataView(m.buffer).setUint16(3,this.term.rows,false);
        this._send(m);
      }
      this._flushSendQueue();
      if(this._reconnecting){
        setTimeout(()=>{this.el.style.opacity='1';this._reconnecting=false;if(this.term)this.term.scrollToBottom()},300);
      }
    };
    this.ws.onmessage=e=>{
      const d=new Uint8Array(e.data); if(!d.length) return;
      if(d[0]===OP.OUTPUT){
        this._handleOutput(d.subarray(1));
      } else if(d[0]===OP.SID){
        this.id=dec.decode(d.subarray(1)); this.el.dataset.pid=this.id;
      } else if(d[0]===OP.EXIT){
        this.write('\r\n\x1b[90m── exited ──\x1b[0m\r\n');
      } else if(d[0]===OP.ERROR){
        this.write('\r\n\x1b[31m'+dec.decode(d.subarray(1))+'\x1b[0m\r\n');
      }
    };
    this.ws.onclose=()=>{
      if(this._destroyed) return;
      this._showOverlay('연결 끊김', '재연결 중...');
      this._scheduleReconnect();
    };
    this.ws.onerror=()=>{
      if(this._destroyed) return;
      this._showOverlay('연결 오류', '재연결 중...');
      this._scheduleReconnect();
    };
  }
  _scheduleReconnect(){
    if(this._destroyed||this._reconnectPending) return;
    this._reconnectPending=true;
    if(this.ws){try{this.ws.onclose=null;this.ws.onerror=null;this.ws.onmessage=null;this.ws.close()}catch{}this.ws=null}
    // Reset decoder state so any half-received multibyte sequence from the
    // dead connection doesn't get spliced with bytes from the new one.
    try{this._decoder=new TextDecoder('utf-8',{fatal:false});this._outputBuf=''}catch{}
    this._reconnect();
  }
  write(s){if(this.term)try{this.term.write(s)}catch{}else this._buf.push(s)}
  doFit(){if(this.fit)try{this.fit.fit()}catch{}}
  focus(){if(this.term)try{this.term.focus()}catch{}}
  _reconnect(){
    if(this._destroyed) return;
    this._retryDelay=Math.min(this._retryDelay*1.5,30000);
    setTimeout(()=>{
      if(this._destroyed) return;
      const p=location.protocol==='https:'?'wss:':'ws:';
      const cols=(this.term&&this.term.cols)||120;
      const rows=(this.term&&this.term.rows)||40;
      const url=`${p}//${location.host}/ws?cols=${cols}&rows=${rows}&pane=${encodeURIComponent(this.id)}`;
      const ws=new WebSocket(url); ws.binaryType='arraybuffer';
      this._pendingWs=ws;
      this._reconnectPending=false;
      ws.onopen=()=>{
        this.ws=ws; this._retryDelay=1000;
        this._pendingWs=null;
        if(this.term){
          const m=new Uint8Array(5);m[0]=OP.RESIZE;
          new DataView(m.buffer).setUint16(1,this.term.cols,false);
          new DataView(m.buffer).setUint16(3,this.term.rows,false);
          this._send(m);
        }
        this._flushSendQueue();
        setTimeout(()=>{this._hideOverlay();this.el.style.opacity='1';this._reconnecting=false;if(this.term)this.term.scrollToBottom()},300);
      };
      ws.onmessage=e=>{
        const d=new Uint8Array(e.data); if(!d.length) return;
        if(d[0]===OP.OUTPUT){ this._handleOutput(d.subarray(1)); }
        else if(d[0]===OP.SID){ this.id=dec.decode(d.subarray(1));this.el.dataset.pid=this.id; }
        else if(d[0]===OP.EXIT){ this.write('\r\n\x1b[90m── exited ──\x1b[0m\r\n'); }
        else if(d[0]===OP.ERROR){ this.write('\r\n\x1b[31m'+dec.decode(d.subarray(1))+'\x1b[0m\r\n'); }
      };
      ws.onclose=()=>{
        if(this._destroyed)return;
        if(this.ws&&this.ws!==ws) return;
        if(this.ws===ws) this.ws=null;
        this._showOverlay('연결 끊김','재연결 중...');
        this._scheduleReconnect();
      };
      ws.onerror=()=>{
        if(this._destroyed)return;
        if(this.ws&&this.ws!==ws) return;
        this._showOverlay('연결 오류','재연결 중...');
        this._scheduleReconnect();
      };
    },this._retryDelay);
  }
  _showOverlay(title,sub){
    let ov=this.el.querySelector('.tp-overlay');
    if(!ov){ov=document.createElement('div');ov.className='tp-overlay';this.el.appendChild(ov)}
    ov.innerHTML=`<div class="tp-ov-title">${title}</div><div class="tp-ov-sub">${sub}</div>`;
    ov.classList.add('visible');
  }
  _hideOverlay(){
    const ov=this.el.querySelector('.tp-overlay');
    if(ov)ov.classList.remove('visible');
  }
  _handleOutput(data){
    // stream:true preserves UTF-8 multibyte state across WS chunk boundaries
    this._outputBuf+=this._decoder.decode(data,{stream:true});
    if(this._flushScheduled) return;
    this._flushScheduled=true;
    // Use setTimeout instead of requestAnimationFrame so output flushes
    // even when the browser tab is hidden/backgrounded.
    setTimeout(()=>this._doFlush(),0);
  }
  _doFlush(){
    this._flushScheduled=false;
    const text=this._outputBuf; this._outputBuf='';
    if(!text) return;
    const re=/\x1b\]777;(\w+);([^\x07]*)\x07/g;
    let m;
    while((m=re.exec(text))!==null){
      const cmd=m[1],val=m[2];
      if(cmd==='Download') this._downloadFile(val);
      else if(cmd==='Cwd') this._onCwd(val);
      else if(cmd==='OpenCodeServer') this._openCodeServer(val);
      else if(cmd==='CodeServerList') this._listCodeServers(val);
    }
    const clean=text.replace(/\x1b\]777;\w+;[^\x07]*\x07/g,'');
    if(this.term) try{this.term.write(clean||'')}catch{}
    else if(clean) this._buf.push(enc.encode(clean));
  }
  _onCwd(cwd){
    this._cwd=cwd;
    if(app)app._cwd=cwd;
    if(app)app._updateStatusBar();
  }
  _downloadFile(path){
    const a=document.createElement('a');
    a.href='/api/download?path='+encodeURIComponent(path);
    a.download='';document.body.appendChild(a);a.click();a.remove();
    this.term.write('\x1b[2m↓ Downloading: '+path+'\x1b[0m\r\n');
  }
  _listCodeServers(json){
    let list=[];
    try{list=JSON.parse(json)||[]}catch{}
    const T=this.term;
    const cols=Math.max(40,(T&&T.cols)||80);
    const line=ch=>ch.repeat(Math.min(cols-2,60));
    const fmtAge=s=>{
      s=s|0;
      if(s<60)return s+'s';
      if(s<3600)return Math.floor(s/60)+'m';
      const h=Math.floor(s/3600),m=Math.floor((s%3600)/60);
      return m?h+'h'+m+'m':h+'h';
    };
    const shortFolder=p=>{
      if(!p)return'';
      const max=Math.max(20,cols-20);
      return p.length<=max?p:'…'+p.slice(-(max-1));
    };
    T.write('\r\n');
    if(!list.length){
      T.write('  \x1b[2m─── \x1b[0m\x1b[36mcode-server\x1b[0m \x1b[2m──────── (없음) ─\x1b[0m\r\n');
      T.write('  \x1b[2m   `edit <path>` 로 새 인스턴스 생성\x1b[0m\r\n\r\n');
      return;
    }
    const maxId=Math.max(2,...list.map(x=>x.id.length));
    const maxAge=Math.max(3,...list.map(x=>fmtAge(x.age||0).length));
    T.write(`  \x1b[2m─── \x1b[0m\x1b[1;36mcode-server\x1b[0m \x1b[2m── ${list.length}개 활성 ${line('─').slice(12+String(list.length).length)}\x1b[0m\r\n`);
    for(const it of list){
      const url=location.origin+it.path+'?folder='+encodeURIComponent(it.folder);
      codeServerPending.set(url,it.id);
      const id=it.id.padEnd(maxId,' ');
      const age=fmtAge(it.age||0).padStart(maxAge,' ');
      T.write('\r\n');
      T.write(`  \x1b[32m●\x1b[0m \x1b[1;33m${id}\x1b[0m  \x1b[2m${age}\x1b[0m  \x1b[37m${shortFolder(it.folder)}\x1b[0m\r\n`);
      T.write(`    ${' '.repeat(maxId)}\x1b[2m↳\x1b[0m  \x1b[4;38;5;75m${url}\x1b[0m\r\n`);
    }
    T.write(`  \x1b[2m${line('─')}\x1b[0m\r\n`);
    T.write(`  \x1b[2m URL 클릭 → 해당 인스턴스 열기   ·   edit stop <id|all> 로 종료\x1b[0m\r\n\r\n`);
  }
  _openCodeServer(val){
    // val = "id|path|folder"
    const parts=val.split('|');
    if(parts.length<2)return;
    const id=parts[0], csPath=parts[1], folder=parts.slice(2).join('|');
    const url=location.origin+csPath+'?folder='+encodeURIComponent(folder);
    // FR-E2: 같은 id 의 살아있는 창이 이미 있으면 새 창을 열지 않는다.
    const existing=codeServerWatchers.get(id);
    if(existing&&existing.win&&!existing.win.closed){
      try{existing.win.focus()}catch{}
      this.term.write('\x1b[36m[edit] 이미 열려 있음: '+url+'\x1b[0m\r\n');
      return;
    }
    const open=()=>{
      const w=window.open(url,'_blank');
      if(w){codeServerTrack(id,w);return true}
      return false;
    };
    if(!open()){
      // popup blocker — 터미널에 클릭 가능한 링크 표시 (사용자 제스처로 재시도)
      this.term.write('\x1b[33m[edit] 팝업이 차단됨 — 아래 URL 클릭: '+url+'\x1b[0m\r\n');
      codeServerPending.set(url,id);
    } else {
      this.term.write('\x1b[36m[edit] VSCode 열림: '+url+'\x1b[0m\r\n');
    }
  }
  _uploadFiles(files){
    if(!files||!files.length)return;
    // Get cwd from server for this pane
    fetch('/api/cwd?pane='+this.id).then(r=>r.json()).then(({cwd})=>{
      let i=0;
      const uploadNext=()=>{
        if(i>=files.length){this._send(new Uint8Array([OP.INPUT,0x0d]));return;}
        const f=files[i++];
        const fd=new FormData();fd.append('file',f);
        this.term.write('\x1b[2m↑ Uploading: '+f.name+'\x1b[0m\r\n');
        fetch('/api/upload?dir='+encodeURIComponent(cwd),{method:'POST',body:fd})
          .then(r=>r.json()).then(d=>{
            this.term.write('\x1b[2m  ✓ '+d.name+' ('+this._fmtSize(d.size)+')\x1b[0m\r\n');
            uploadNext();
          }).catch(()=>{
            this.term.write('\x1b[31m  ✗ Upload failed\x1b[0m\r\n');uploadNext();
          });
      };
      uploadNext();
    });
  }
  _fmtSize(b){
    if(b<1024)return b+'B';
    if(b<1048576)return(b/1024).toFixed(1)+'KB';
    return(b/1048576).toFixed(1)+'MB';
  }
  destroy(){
    this._destroyed=true;
    if(this._pendingWs&&this._pendingWs!==this.ws){
      try{this._pendingWs.onopen=null;this._pendingWs.onclose=null;this._pendingWs.onerror=null;this._pendingWs.onmessage=null;this._pendingWs.close()}catch{}
      this._pendingWs=null;
    }
    if(this.ws){this.ws.onclose=null;this.ws.onerror=null;this.ws.close();this.ws=null}
    if(this.term){this.term.dispose();this.term=null}
    this.el.remove(); this._opened=false;
  }
  _send(m){
    const ws=this.ws;
    if(ws&&ws.readyState===1){ws.send(m);return}
    if(ws&&ws.readyState===0){
      if(this._sendQueue.length>=this._sendQueueMax){this._sendQueue.shift();this._sendDropCount++}
      this._sendQueue.push(m);
      return;
    }
    this._sendDropCount++;
  }
  _flushSendQueue(){
    if(!this.ws||this.ws.readyState!==1)return;
    const q=this._sendQueue;this._sendQueue=[];
    for(const m of q){this.ws.send(m)}
  }
}

// ═══ MdViewer: markdown viewer tab ═══

const MD_EXTENSIONS=/\.(md|mdown|markdown)$/i;

class MdViewer {
  constructor(id, name, filePath) {
    this.id = id;
    this.name = name;
    this.filePath = filePath;
    this.el = document.createElement('div');
    this.el.className = 'md-viewer';
    this.el.tabIndex = 0;
    this._loading = false;
    this._loaded = false;
    this._restored = false;
    this._suppressScroll = 0;
    this._scrollTimer = null;
    this.el.addEventListener('scroll', () => this._onScroll());
    this.fetchAndRender();
  }

  async fetchAndRender() {
    this._loading = true;
    this._loaded = false;
    this._restored = false;
    try {
      const r = await fetch('/api/md-file?path=' + encodeURIComponent(this.filePath));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const md = await r.text();
      this.el.innerHTML = marked.parse(md, { gfm: true, breaks: true });
      this._interceptLinks();
      this._loaded = true;
      this._tryRestore();
    } catch (e) {
      this.el.innerHTML =
        '<div class="md-error">파일을 불러올 수 없습니다' +
        '<div class="md-error-path">' + this._esc(this.filePath) + '</div></div>';
    }
    this._loading = false;
  }

  refresh() { this.fetchAndRender() }

  _tryRestore() {
    if (this._restored || !this._loaded) return;
    if (!this.el.classList.contains('vis')) return;
    if (typeof app === 'undefined' || !app) return;
    const entry = app.mdScrolls && app.mdScrolls.get(this.id);
    if (!entry) { this._restored = true; return; }
    this._applyScroll(entry);
    this._restored = true;
  }

  _applyScroll(entry) {
    if (!entry) return;
    const max = Math.max(0, this.el.scrollHeight - this.el.clientHeight);
    let target = entry.top;
    if (target > max + 4 || target < 0) {
      target = Math.round((entry.ratio || 0) * max);
    }
    this._suppressScroll++;
    this.el.scrollTop = target;
    setTimeout(() => { this._suppressScroll = Math.max(0, this._suppressScroll - 1); }, 80);
  }

  _onScroll() {
    if (this._suppressScroll > 0) return;
    if (!this._loaded) return;
    if (typeof app === 'undefined' || !app) return;
    // 50ms throttle: leading edge fires immediately, subsequent events within
    // the window are coalesced into a single trailing flush. Keeps remote
    // viewers visibly in sync during continuous scrolling without flooding the
    // server with PUTs.
    const now = Date.now();
    const last = this._scrollLastSent || 0;
    const since = now - last;
    const fire = () => {
      this._scrollLastSent = Date.now();
      const top = this.el.scrollTop;
      const max = Math.max(1, this.el.scrollHeight - this.el.clientHeight);
      app.saveMdScroll(this.id, top, top / max);
    };
    if (since >= 50) {
      if (this._scrollTimer) { clearTimeout(this._scrollTimer); this._scrollTimer = null; }
      fire();
      return;
    }
    if (this._scrollTimer) return;
    this._scrollTimer = setTimeout(() => {
      this._scrollTimer = null;
      fire();
    }, 50 - since);
  }

  _interceptLinks() {
    this.el.querySelectorAll('a').forEach(a => {
      a.addEventListener('click', e => {
        let href = a.getAttribute('href');
        if (!href || href === '#' || href.startsWith('#')) return;
        e.preventDefault();
        e.stopPropagation();
        try { href = decodeURIComponent(href) } catch {}
        // External URLs → new window
        if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('mailto:')) {
          window.open(href, '_blank');
          return;
        }
        // Strip anchor fragment, keep clean path
        const hashIdx = href.indexOf('#');
        const linkHref = hashIdx >= 0 ? href.substring(0, hashIdx) : href;
        // .md links → open as new markdown tab
        if (MD_EXTENSIONS.test(linkHref)) {
          const baseDir = this.filePath.substring(0, this.filePath.lastIndexOf('/'));
          const absPath = this._resolve(baseDir, linkHref);
          const name = linkHref.split('/').pop().replace(MD_EXTENSIONS, '');
          const rid = app ? app.focused : null;
          if (rid) app.addTab(rid, 'markdown', { name, filePath: absPath });
          return;
        }
        // Other relative/absolute links → download via API
        const isRel = linkHref.startsWith('./') || linkHref.startsWith('../') ||
          (!linkHref.startsWith('/') && linkHref.includes('/'));
        if (linkHref.startsWith('/') || isRel) {
          const baseDir = this.filePath.substring(0, this.filePath.lastIndexOf('/'));
          const absPath = this._resolve(baseDir, linkHref);
          const dl = document.createElement('a');
          dl.href = '/api/md-file?path=' + encodeURIComponent(absPath);
          dl.download = '';
          document.body.appendChild(dl);
          dl.click();
          dl.remove();
        }
      });
    });
  }

  _resolve(base, rel) {
    if (rel.startsWith('/')) return rel;
    const combined = base + '/' + rel;
    const parts = combined.split('/');
    const stack = [];
    for (const p of parts) {
      if (!p || p === '.') continue;
      if (p === '..') { if (stack.length) stack.pop(); continue; }
      stack.push(p);
    }
    return '/' + stack.join('/');
  }

  _esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  destroy() {
    if (this._scrollTimer) { clearTimeout(this._scrollTimer); this._scrollTimer = null; }
    this.el.remove();
  }
}

// ═══ Layout helpers ═══

function normalizeTab(t) {
  if (!t.type) t.type = t.paneId ? 'terminal' : 'markdown';
  return t;
}
function normalizeLayout(n) {
  if (!n) return n;
  if (n.type === 'region' && n.tabs) n.tabs.forEach(normalizeTab);
  if (n.type === 'split' && n.children) n.children.forEach(normalizeLayout);
  return n;
}

function doSplit(n,rid,nrs,dir){
  // nrs: 단일 region 또는 region 배열
  const list=Array.isArray(nrs)?nrs:[nrs];
  if(n.type==='region') return n.id===rid?{type:'split',direction:dir,children:[n,...list]}:n;
  if(n.children) n.children=n.children.map(c=>doSplit(c,rid,nrs,dir));
  return n;
}
function doRemove(n,rid){
  if(!n) return null;
  if(n.type==='region') return n.id===rid?null:n;
  if(!n.children) return null;
  n.children=n.children.map(c=>doRemove(c,rid)).filter(Boolean);
  if(!n.children.length) return null;
  if(n.children.length===1) return n.children[0];
  return n;
}
function findRg(n,rid){
  if(!n) return null;
  if(n.type==='region') return n.id===rid?n:null;
  if(n.children) for(const c of n.children){const f=findRg(c,rid);if(f)return f}
  return null;
}
function firstRg(n){
  if(!n) return null;
  if(n.type==='region') return n;
  if(n.children) for(const c of n.children){const f=firstRg(c);if(f)return f}
  return null;
}
function allPids(n){
  if(!n) return [];
  if(n.type==='region') return (n.tabs||[]).filter(t=>t.type!=='markdown').map(t=>t.paneId);
  if(n.children) return n.children.flatMap(c=>allPids(c));
  return [];
}
function findPath(n,rid){
  if(!n) return null;
  if(n.type==='region') return n.id===rid?[n]:null;
  if(n.children) for(const c of n.children){const p=findPath(c,rid);if(p)return[n,...p]}
  return null;
}
function closestRg(n,rid){
  const path=findPath(n,rid);
  if(!path||path.length<2)return firstRg(n);
  for(let i=path.length-2;i>=0;i--){
    const parent=path[i];if(!parent.children)continue;
    const ci=parent.children.indexOf(path[i+1]);if(ci<0)continue;
    const c=parent.children[ci+1]||parent.children[ci-1];
    if(c){const r=firstRg(c);if(r)return r}
  }
  return firstRg(n);
}
function clean(n,ok){
  if(!n) return null;
  if(n.type==='region'){
    if(n.tabs) n.tabs=n.tabs.filter(t=>{
      if(t.type==='markdown') return true;
      return ok.has(t.paneId);
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

// ═══ App ═══

// ═══ InputBinding: 키보드/마우스/단축키 dispatch (S1-Phase3 추출) ═══
// App 의 _bind 책임을 분리. 동작은 1:1 보존.
// Built-in hotkeys are not user-rebindable and may match modifier variants
// (e.g. Ctrl OR Cmd) that the single-binding `shortcuts` table can't express.
// They are dispatched through the same `executeAction` path as user shortcuts.
const BUILTIN_HOTKEYS = [
  { match: e => e.code === 'KeyF' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey, action: 'toggleSearch' },
];

class InputBinding {
  constructor(app){ this.app = app; }

  bind(){
    if(this.app._kb) return; this.app._kb=true;
    document.getElementById('split-h').addEventListener('click',()=>this.app.split('horizontal'));
    document.getElementById('split-v').addEventListener('click',()=>this.app.split('vertical'));
    document.getElementById('agents-toggle').addEventListener('click',()=>this.app._agentsToggle());
    const ap=document.getElementById('agents-panel'),aph=document.getElementById('agents-handle');
    try{if(localStorage.getItem('agentsPanelOpen')==='1'){ap.classList.add('open');aph.classList.add('open');document.getElementById('agents-toggle').classList.add('open');this.app._agentsStartPoll()}}catch{}
    aph.addEventListener('mousedown',e=>{e.preventDefault();
      const sx=e.clientX,sw=ap.offsetWidth;
      const mv=e=>{const w=sw-(e.clientX-sx);if(w>=160&&w<=480){document.documentElement.style.setProperty('--ag-w',w+'px')}};
      const up=()=>{document.removeEventListener('mousemove',mv);document.removeEventListener('mouseup',up);for(const p of this.app.panes.values())if(p.el.classList.contains('vis'))p.doFit();try{localStorage.setItem('agentsWidth',ap.offsetWidth)}catch{}};
      document.addEventListener('mousemove',mv);document.addEventListener('mouseup',up);
    });
    try{const aw=parseInt(localStorage.getItem('agentsWidth'));if(aw>=160&&aw<=480)document.documentElement.style.setProperty('--ag-w',aw+'px')}catch{}
    const sb=document.getElementById('sidebar'),sbh=document.getElementById('sb-handle');
    sbh.addEventListener('mousedown',e=>{e.preventDefault();
      const sx=e.clientX,sw=sb.offsetWidth;
      const mv=e=>{const w=sw+(e.clientX-sx);if(w>=100&&w<=400){document.documentElement.style.setProperty('--sb-w',w+'px');this.app.ws.sidebarWidth=w}};
      const up=()=>{document.removeEventListener('mousemove',mv);document.removeEventListener('mouseup',up);for(const p of this.app.panes.values())if(p.el.classList.contains('vis'))p.doFit();try{localStorage.setItem('sidebarWidth',this.app.ws.sidebarWidth)}catch{}this.app._save()};
      document.addEventListener('mousemove',mv);document.addEventListener('mouseup',up);
    });
    this.app._recording=null;
    window.addEventListener('keydown',e=>{
      if(this.app._recording){e.preventDefault();e.stopImmediatePropagation();
        if(e.code==='Escape'){
          const btn=document.querySelector('.sc-key.recording');
          if(btn){btn.classList.remove('recording');btn.textContent=displayKey(shortcuts[btn.dataset.action]||'')}
          this.app._recording=null;return;
        }
        if(MOD_CODES.has(e.code))return;
        shortcuts[this.app._recording]=fmtShortcut(e);
        const btn=document.querySelector(`.sc-key[data-action="${this.app._recording}"]`);
        this.app._recording=null;
        if(btn){btn.classList.remove('recording');btn.textContent=displayKey(shortcuts[btn.dataset.action]||'')}
        this.app._saveSettings();
        return;
      }
      const ae=document.activeElement;
      if(ae.tagName==='INPUT'||(ae.tagName==='TEXTAREA'&&!ae.classList.contains('xterm-helper-textarea')))return;
      for(const h of BUILTIN_HOTKEYS){
        if(h.match(e)){e.preventDefault();e.stopImmediatePropagation();this.app.executeAction(h.action);return}
      }
      for(const[action,key]of Object.entries(shortcuts)){
        if(matchShortcut(e,key)){e.preventDefault();e.stopImmediatePropagation();this.app.executeAction(action);return}
      }
    },true);
    const si=document.getElementById('search-input');
    si.addEventListener('input',()=>this.app._doSearch('next'));
    si.addEventListener('keydown',e=>{
      if(e.key==='Enter'){e.preventDefault();this.app._doSearch(e.shiftKey?'prev':'next')}
      if(e.key==='Escape'){e.preventDefault();e.stopPropagation();this.app.closeSearch()}
      e.stopPropagation();
    });
    document.getElementById('search-next').addEventListener('click',()=>this.app._doSearch('next'));
    document.getElementById('search-prev').addEventListener('click',()=>this.app._doSearch('prev'));
    document.getElementById('search-case').addEventListener('click',function(){this.classList.toggle('active')});
    document.getElementById('search-close').addEventListener('click',()=>this.app.closeSearch());
    this.app._initModal();
    this.app._initStatusBar();
    this.app._initPresets();
    this.app._initMobile();
    this.app._initMobileKeybar();
    this.app._initAttn();
  }
}

// ═══ Renderer: layout → DOM (S1-Phase2 외과적 추출) ═══
// App 의 render / _rSidebar / _rTopbar / _rLayout / _buildNode / _buildRg
// / _buildSp / _handle 책임을 분리. Renderer 내부 메서드 호출은 this.X 로,
// App 상태·메서드는 this.app.X 로 접근한다. 동작은 1:1 보존.
class Renderer {
  constructor(app){ this.app = app; }

  render(){
    const oldFocus=this.app._prevFocus;
    this.app._prevFocus=this.app.focused;
    if(oldFocus!==undefined&&oldFocus!==this.app.focused){
      this.app._clearAllSearchDecorations();
      this.app._researchIfOpen();
    }
    this.app._applyMobileMode();
    this._rSidebar();this._rTopbar();this._rLayout();
    this.app._updateCwd();
    this.app._updateStatusBar();
  }

  _rSidebar(){
    const el=document.getElementById('sessions'); el.innerHTML='';
    for(const s of this.app.ws.sessions){
      const d=document.createElement('div');
      // FR-PAN-16: 알람이 있는 세션을 사이드바에서 구분 표시
      d.className='si'+(s.id===this.app.ws.activeSession?' active':'')+(this.app._sessionHasAttn(s)?' attn':'');
      d.dataset.sid=s.id;
      d.innerHTML=`<span class="si-dot"></span><span class="si-name">${s.name}</span><span class="si-x">×</span>`;
      d.addEventListener('click',e=>{if(!e.target.classList.contains('si-x'))this.app.switchSession(s.id)});
      d.querySelector('.si-x').addEventListener('click',e=>{e.stopPropagation();this.app.delSession(s.id)});
      d.querySelector('.si-name').addEventListener('dblclick',e=>{e.stopPropagation();this.app._rename(s,e.target)});
      d.draggable=true;
      d.addEventListener('dragstart',e=>{this.app._drag={type:'session',idx:this.app.ws.sessions.indexOf(s)};e.dataTransfer.effectAllowed='move';setTimeout(()=>d.classList.add('dragging'),0)});
      d.addEventListener('dragend',()=>{this.app._drag=null;d.classList.remove('dragging');el.querySelectorAll('.si').forEach(si=>si.classList.remove('drag-above','drag-below'))});
      d.addEventListener('dragover',e=>{if(!this.app._drag||this.app._drag.type!=='session')return;e.preventDefault();el.querySelectorAll('.si').forEach(si=>si.classList.remove('drag-above','drag-below'));const rect=d.getBoundingClientRect();d.classList.add(e.clientY<rect.top+rect.height/2?'drag-above':'drag-below')});
      d.addEventListener('drop',e=>{e.preventDefault();e.stopPropagation();if(!this.app._drag||this.app._drag.type!=='session')return;const srcIdx=this.app._drag.idx;this.app._drag=null;el.querySelectorAll('.si').forEach(si=>si.classList.remove('drag-above','drag-below'));const rect=d.getBoundingClientRect();const insBefore=e.clientY<rect.top+rect.height/2;const[moved]=this.app.ws.sessions.splice(srcIdx,1);let ins=this.app.ws.sessions.indexOf(s);if(!insBefore)ins++;this.app.ws.sessions.splice(ins,0,moved);this.app._save();this.app.render()});
      el.appendChild(d);
    }
    el.addEventListener('dragover',e=>{if(!this.app._drag||this.app._drag.type!=='session')return;e.preventDefault()});
    el.addEventListener('drop',e=>{if(!this.app._drag||this.app._drag.type!=='session')return;e.preventDefault();const srcIdx=this.app._drag.idx;this.app._drag=null;el.querySelectorAll('.si').forEach(si=>si.classList.remove('drag-above','drag-below'));const[moved]=this.app.ws.sessions.splice(srcIdx,1);this.app.ws.sessions.push(moved);this.app._save();this.app.render()});
  }

  _rTopbar(){
    const a=this.app._as();
    document.getElementById('session-name').textContent=a?a.name:'';
    const ind=document.getElementById('m-pane-indicator');
    if(ind){
      const n=this.app._mobilePaneCount();
      if(n<=0){ind.textContent='0/0'}
      else{
        if(this.app._mPaneIdx>=n) this.app._mPaneIdx=n-1;
        if(this.app._mPaneIdx<0) this.app._mPaneIdx=0;
        ind.textContent=`${this.app._mPaneIdx+1}/${n}`;
      }
    }
    const dt=document.getElementById('m-drawer-toggle');
    if(dt) dt.textContent = this.app._drawerOpen ? '✕' : '☰';
  }

  _rLayout(){
    const area=document.getElementById('area');
    const s=this.app._as();
    for(const p of this.app.panes.values()){
      if(p.el.classList.contains('vis')){
        const vp=p.el.querySelector('.xterm-viewport');
        if(vp) p._scrollTop=vp.scrollTop;
        if(p.term){try{p._viewportY=p.term.buffer.active.viewportY}catch{}}
      }
      p.el.classList.remove('vis');area.appendChild(p.el);
    }
    for(const v of this.app.mdViewers.values()){
      if(v.el.classList.contains('vis')) v._scrollTop=v.el.scrollTop;
      v.el.classList.remove('vis');area.appendChild(v.el);
    }
    for(const c of [...area.children]){if(c.classList.contains('sp')||c.classList.contains('rg'))c.remove()}
    if(!s?.layout) return;
    if(!findRg(s.layout,this.app.focused)){this.app._setFocus(firstRg(s.layout)?.id||null, s)}
    let dom;
    if(this.app.isMobile){
      const regs=this.app._flattenRegions(s.layout);
      if(regs.length){
        const fIdx=regs.findIndex(r=>r.id===this.app.focused);
        if(fIdx>=0) this.app._mPaneIdx=fIdx;
        else if(this.app._mPaneIdx>=regs.length) this.app._mPaneIdx=regs.length-1;
        const target=regs[this.app._mPaneIdx];
        if(target){this.app._setFocus(target.id, s);dom=this._buildRg(target)}
      }
    }else{
      dom=this._buildNode(s.layout);
    }
    if(dom) area.appendChild(dom);
    const allTabIds=new Set();
    const walk=n=>{if(!n)return;if(n.type==='region'&&n.tabs)n.tabs.forEach(t=>allTabIds.add(t.id));if(n.type==='split'&&n.children)n.children.forEach(walk)};
    for(const sess of this.app.ws.sessions){if(sess&&sess.layout)walk(sess.layout)}
    for(const[tid,v] of this.app.mdViewers){if(!allTabIds.has(tid)){v.destroy();this.app.mdViewers.delete(tid)}}
    requestAnimationFrame(()=>{
      for(const p of this.app.panes.values()){
        if(p.el.classList.contains('vis')){
          if(!p._opened)p.open();
          p.doFit();
          // Restore scrollback after DOM detach.
          //
          // xterm v5 keeps two states: internal `buffer.ydisp` (drives row
          // rendering) and DOM `.xterm-viewport.scrollTop` (drives scrollbar
          // and scroll events). Detach + display:none + reattach via
          // appendChild fires scroll events which `_handleScroll` either
          // ignores (offsetParent null) or applies (offsetParent non-null).
          // The exact timing is browser-dependent, leaving us in any of:
          //   (a) ydisp preserved, scrollTop reset → scrollbar at top, content correct
          //   (b) ydisp reset, scrollTop preserved → scrollbar at original, content at top
          //   (c) both reset → both at top  (the user-reported case)
          //   (d) both preserved → no fix needed
          // `term.scrollLines(delta)` early-returns when delta==0, so the
          // case where ydisp matches our target is a no-op and leaves the
          // DOM unsynced. We force a guaranteed resync by toggling ydisp
          // through 0 (or away from target if target==0) before scrolling
          // back, which always fires `_onScroll` → `syncScrollArea` →
          // `_innerRefresh`. _innerRefresh then sets scrollTop = ydisp *
          // rowHeight authoritatively. As a safety net we also write the
          // captured pixel value directly.
          if(p.term&&typeof p._viewportY==='number'){
            try{
              const buf=p.term.buffer.active;
              const max=Math.max(0,buf.length-p.term.rows);
              const target=Math.min(Math.max(0,p._viewportY),max);
              if(target>0){
                p.term.scrollToTop();
                p.term.scrollToLine(target);
              }else if(max>0){
                p.term.scrollToBottom();
                p.term.scrollToTop();
              }else{
                p.term.scrollToTop();
              }
            }catch{}
          }
          if(typeof p._scrollTop==='number'){
            const vp=p.el.querySelector('.xterm-viewport');
            if(vp){try{vp.scrollTop=p._scrollTop}catch{}}
          }
        }
      }
      if(this.app.focused){
        const rg=findRg(s.layout,this.app.focused);
        if(rg){const tab=rg.tabs.find(t=>t.id===rg.activeTab);if(tab){
          if(tab.type==='markdown'){const v=this.app.mdViewers.get(tab.id);if(v)v.el.focus()}
          else{const p=this.app.panes.get(tab.paneId);if(p)p.focus()}
        }}
      }
    });
  }

  _buildNode(n){
    if(!n) return null;
    if(n.type==='region') return this._buildRg(n);
    if(n.type==='split'&&n.children) return this._buildSp(n);
    return null;
  }

  _buildRg(n){
    const el=document.createElement('div');
    // FR-PAN-9: 활성탭 pane 이 주의 상태이고 region 이 포커스 안 됐을 때만 region 강조
    const focused=n.id===this.app.focused;
    const at0=(n.tabs||[]).find(t=>t.id===n.activeTab);
    const rgAttn=!focused&&at0&&this.app._attnHas(at0.paneId);
    el.className='rg'+(focused?' focused':'')+(rgAttn?' attn':'');
    el.dataset.rid=n.id;
    const tabs=document.createElement('div'); tabs.className='rg-tabs';
    for(const tab of(n.tabs||[])){
      const t=document.createElement('div');
      // FR-PAN-9/TC-PAN-17: 사용자가 지금 보고 있는 탭(포커스+활성)은 강조하지 않음
      const tabActive=tab.id===n.activeTab;
      const tabAttn=this.app._attnHas(tab.paneId)&&!(focused&&tabActive);
      t.className='rt'+(tabActive?' active':'')+(tabAttn?' attn':'');
      if(tab.paneId) t.dataset.pid=tab.paneId; // 타깃 알림 갱신용(전체 재렌더 없이)
      t.innerHTML=`<span>${tab.name}</span><span class="rt-x">×</span>`;
      t.addEventListener('click',e=>{
        e.stopPropagation();
        if(e.target.classList.contains('rt-x')) this.app.closeTab(n.id,tab.id);
        else this.app.switchTab(n.id,tab.id);
      });
      t.querySelector('span').addEventListener('dblclick',e=>{e.stopPropagation();this.app._rename(tab,e.target)});
      t.draggable=true;
      t.addEventListener('dragstart',e=>{this.app._drag={type:'tab',srcRegionId:n.id,tabId:tab.id};e.dataTransfer.effectAllowed='move';e.stopPropagation();setTimeout(()=>t.classList.add('dragging'),0)});
      t.addEventListener('dragend',()=>{this.app._drag=null;t.classList.remove('dragging');tabs.querySelectorAll('.rt').forEach(r=>r.classList.remove('drag-left','drag-right'));document.querySelectorAll('.rg-drop-indicator').forEach(ind=>ind.style.display='none')});
      t.addEventListener('dragover',e=>{if(!this.app._drag||this.app._drag.type!=='tab')return;e.preventDefault();e.stopPropagation();tabs.querySelectorAll('.rt').forEach(r=>r.classList.remove('drag-left','drag-right'));const rect=t.getBoundingClientRect();t.classList.add(e.clientX<rect.left+rect.width/2?'drag-left':'drag-right');document.querySelectorAll('.rg-drop-indicator').forEach(ind=>ind.style.display='none')});
      t.addEventListener('drop',e=>{e.preventDefault();e.stopPropagation();if(!this.app._drag||this.app._drag.type!=='tab')return;const{srcRegionId,tabId}=this.app._drag;this.app._drag=null;tabs.querySelectorAll('.rt').forEach(r=>r.classList.remove('drag-left','drag-right'));const s=this.app._as();if(!s)return;if(srcRegionId===n.id){const rg=findRg(s.layout,n.id);if(!rg)return;const si=rg.tabs.findIndex(tt=>tt.id===tabId);const di=rg.tabs.findIndex(tt=>tt.id===tab.id);if(si<0||di<0||si===di)return;const rect=t.getBoundingClientRect();const insBefore=e.clientX<rect.left+rect.width/2;const[moved]=rg.tabs.splice(si,1);let ins=rg.tabs.findIndex(tt=>tt.id===tab.id);if(!insBefore)ins++;rg.tabs.splice(ins,0,moved);rg.activeTab=tabId;this.app._save();this.app.render()}else{const rect=t.getBoundingClientRect();this.app._moveTabToRegion(srcRegionId,tabId,n.id,tab.id,e.clientX<rect.left+rect.width/2)}});
      tabs.appendChild(t);
    }
    const add=document.createElement('button'); add.className='rt-add'; add.textContent='+';
    add.addEventListener('click',e=>{e.stopPropagation();this.app.addTab(n.id)});
    tabs.addEventListener('dragover',e=>{if(!this.app._drag||this.app._drag.type!=='tab')return;e.preventDefault();e.stopPropagation();if(this.app._drag.srcRegionId!==n.id)tabs.classList.add('drag-target')});
    tabs.addEventListener('dragleave',e=>{if(!tabs.contains(e.relatedTarget))tabs.classList.remove('drag-target')});
    tabs.addEventListener('drop',e=>{e.preventDefault();e.stopPropagation();tabs.classList.remove('drag-target');tabs.querySelectorAll('.rt').forEach(r=>r.classList.remove('drag-left','drag-right'));if(!this.app._drag||this.app._drag.type!=='tab')return;const{srcRegionId,tabId}=this.app._drag;this.app._drag=null;const s=this.app._as();if(!s)return;if(srcRegionId===n.id){const rg=findRg(s.layout,n.id);if(!rg)return;const si=rg.tabs.findIndex(t=>t.id===tabId);if(si<0)return;const[moved]=rg.tabs.splice(si,1);rg.tabs.push(moved);rg.activeTab=tabId;this.app._save();this.app.render()}else{this.app._moveTabToRegion(srcRegionId,tabId,n.id,null,false)}});
    tabs.appendChild(add); el.appendChild(tabs);
    const body=document.createElement('div'); body.className='rg-body';
    const at=(n.tabs||[]).find(t=>t.id===n.activeTab);
    if(at){
      if(at.type==='markdown'){
        let viewer=this.app.mdViewers.get(at.id);
        if(!viewer){viewer=new MdViewer(at.id,at.name,at.filePath);this.app.mdViewers.set(at.id,viewer)}
        body.appendChild(viewer.el);viewer.el.classList.add('vis');
        if(viewer._scrollTop){
          const st=viewer._scrollTop;
          viewer._suppressScroll=(viewer._suppressScroll||0)+1;
          requestAnimationFrame(()=>{viewer.el.scrollTop=st;setTimeout(()=>{viewer._suppressScroll=Math.max(0,viewer._suppressScroll-1)},80)});
        } else {
          viewer._tryRestore();
        }
      }else{
        const p=this.app.panes.get(at.paneId);
        if(p){body.appendChild(p.el);p.el.classList.add('vis')}
      }
    }
    body.addEventListener('dragover',e=>{if(!this.app._drag||this.app._drag.type!=='tab')return;e.preventDefault();e.stopPropagation();tabs.querySelectorAll('.rt').forEach(r=>r.classList.remove('drag-left','drag-right'));this.app._showBodyDropIndicator(body,this.app._getDragZone(body,e))});
    body.addEventListener('dragleave',e=>{if(!body.contains(e.relatedTarget))this.app._clearBodyDropIndicator(body)});
    body.addEventListener('drop',e=>{e.preventDefault();e.stopPropagation();if(!this.app._drag||this.app._drag.type!=='tab')return;const zone=this.app._getDragZone(body,e);const{srcRegionId,tabId}=this.app._drag;this.app._drag=null;this.app._clearBodyDropIndicator(body);if(zone==='center'){if(srcRegionId===n.id)return;this.app._moveTabToRegion(srcRegionId,tabId,n.id,null,false)}else{this.app._splitRegionWithTab(srcRegionId,tabId,n.id,zone)}});
    el.appendChild(body);
    el.addEventListener('mousedown',()=>this.app.setFocus(n.id));
    return el;
  }

  _buildSp(n){
    const el=document.createElement('div'); el.className='sp'; el.dataset.d=n.direction; el._node=n;
    for(let i=0;i<n.children.length;i++){
      const sc=document.createElement('div'); sc.className='sc';
      if(n.sizes&&n.sizes[i]!=null) sc.style.flex=n.sizes[i];
      const built=this._buildNode(n.children[i]);
      if(built) sc.appendChild(built);
      el.appendChild(sc);
      if(i<n.children.length-1){const h=document.createElement('div');h.className='sh';el.appendChild(h);this._handle(h,el)}
    }
    return el;
  }

  _handle(h,sp){
    h.addEventListener('mousedown',e=>{
      e.preventDefault();
      const dir=sp.dataset.d, prev=h.previousElementSibling, next=h.nextElementSibling;
      const sx=e.clientX, sy=e.clientY;
      const tot=dir==='horizontal'?prev.offsetWidth+next.offsetWidth:prev.offsetHeight+next.offsetHeight;
      const start=dir==='horizontal'?prev.offsetWidth:prev.offsetHeight;
      const mv=e=>{
        if(dir==='horizontal'){
          const nw=start+(e.clientX-sx);if(nw<60||tot-nw<60)return;
          prev.style.flex=`${nw/tot}`;next.style.flex=`${(tot-nw)/tot}`;
        }else{
          const nh=start+(e.clientY-sy);if(nh<60||tot-nh<60)return;
          prev.style.flex=`${nh/tot}`;next.style.flex=`${(tot-nh)/tot}`;
        }
      };
      const up=()=>{
        document.removeEventListener('mousemove',mv);document.removeEventListener('mouseup',up);
        const nd=sp._node;
        if(nd){nd.sizes=[];for(const c of sp.children){if(c.classList.contains('sc'))nd.sizes.push(parseFloat(c.style.flex)||1)}this.app._save()}
        for(const p of this.app.panes.values())if(p.el.classList.contains('vis'))p.doFit();
      };
      document.addEventListener('mousemove',mv);document.addEventListener('mouseup',up);
    });
  }
}

class App {
  constructor(){
    this.panes=new Map();
    this.mdViewers=new Map();
    this.mdScrolls=new Map();
    this.clientId=(crypto&&crypto.randomUUID?crypto.randomUUID():String(Math.random()).slice(2));
    this.ws={sessions:[],activeSession:null};
    this.wsETag=null;
    this.focused=null;
    this._attn=new Map(); // paneId → {reason} 주의 상태 집합 (FR-PAN-9/16)
    this._attnNotifs={}; // paneId → Notification (재팝업 위해 직전 알림 보관)
    this._activity=new Map(); // paneId → {state,tool,detail} 활동 상태 (AGENT_ACTIVITY_PANEL_SRS)
    this._s=0;this._r=0;this._t=0;this._kb=false;
    this._drag=null;
    this._stats={};this._latency=null;
    this._mPaneIdx=0; // mobile current pane index (volatile)
    this._drawerOpen=false;
    this._modKbd=null; // {ctrl:bool|'lock', alt:bool|'lock'}
    this.renderer=new Renderer(this);
    this.inputBinding=new InputBinding(this);
  }

  // ── Mobile mode ──

  // displayMode / mobileBreakpoint are per-tab (sessionStorage), NOT synced via workspace.
  get displayMode(){
    try{const v=sessionStorage.getItem('displayMode');if(v==='mobile'||v==='desktop'||v==='auto')return v}catch{}
    return 'auto';
  }
  set displayMode(v){
    if(v!=='mobile'&&v!=='desktop'&&v!=='auto') v='auto';
    try{sessionStorage.setItem('displayMode', v)}catch{}
  }
  get mobileBreakpoint(){
    try{const v=parseInt(sessionStorage.getItem('mobileBreakpoint'),10);if(v>=320&&v<=2000)return v}catch{}
    return 768;
  }
  set mobileBreakpoint(v){
    const n=parseInt(v,10);
    if(!(n>=320&&n<=2000)) return;
    try{sessionStorage.setItem('mobileBreakpoint', String(n))}catch{}
  }
  get isMobile(){
    const m=this.displayMode;
    if(m==='mobile') return true;
    if(m==='desktop') return false;
    return window.innerWidth < this.mobileBreakpoint;
  }
  _applyMobileMode(){
    const mob=this.isMobile;
    document.body.classList.toggle('mobile', mob);
    if(!mob && this._drawerOpen){this._drawerOpen=false;document.body.classList.remove('drawer-open')}
    if(!mob){document.body.classList.remove('keyboard-up')}
  }
  _toggleDrawer(open){
    if(!this.isMobile){this._drawerOpen=false;document.body.classList.remove('drawer-open');return}
    this._drawerOpen = (open===undefined) ? !this._drawerOpen : !!open;
    document.body.classList.toggle('drawer-open', this._drawerOpen);
  }

  // Flatten split tree → array of region nodes (in-order: L→R, T→B)
  _flattenRegions(node, out){
    out = out || [];
    if(!node) return out;
    if(node.type==='region') out.push(node);
    else if(node.type==='split' && node.children){
      for(const c of node.children) this._flattenRegions(c, out);
    }
    return out;
  }
  _mobileCurrentRegion(){
    const s=this._as(); if(!s||!s.layout) return null;
    const regs=this._flattenRegions(s.layout);
    if(!regs.length) return null;
    if(this._mPaneIdx>=regs.length) this._mPaneIdx=regs.length-1;
    if(this._mPaneIdx<0) this._mPaneIdx=0;
    return regs[this._mPaneIdx];
  }
  _mobilePaneCount(){
    const s=this._as(); if(!s||!s.layout) return 0;
    return this._flattenRegions(s.layout).length;
  }
  navMobilePane(delta){
    const n=this._mobilePaneCount(); if(n<=1) return;
    this._mPaneIdx = (this._mPaneIdx + delta + n) % n;
    const rg=this._mobileCurrentRegion();
    if(rg){
      this._setFocus(rg.id);
      this._save();
    }
    this.render();
  }

  async init(){
    try{
      const stRes=await fetch('/api/state');
      this.wsETag=stRes.headers.get('ETag')||stRes.headers.get('Etag')||null;
      const st=await stRes.json();
      const sp=st.panes||[];
      const sv=st.workspace;
      const ok=new Set(sp.map(p=>p.id));
      for(const p of sp){const pane=this._mkPane(p.id,p.name);pane._reconnecting=true;pane.el.style.opacity='0'}
      if(sv&&sv.sessions&&sv.sessions.length){
        this.ws=sv;
        // Migration: displayMode/mobileBreakpoint were briefly stored in workspace.
        // Now per-device (localStorage); strip from synced state.
        if('displayMode' in this.ws) delete this.ws.displayMode;
        if('mobileBreakpoint' in this.ws) delete this.ws.mobileBreakpoint;
        if(this.ws.sidebarWidth){
          const w=Math.max(100,Math.min(400,this.ws.sidebarWidth));
          document.documentElement.style.setProperty('--sb-w',w+'px');
          try{localStorage.setItem('sidebarWidth',w)}catch{}
        }
        for(const s of this.ws.sessions){
          if(!s||!s.id) continue;
          const n=parseInt(s.id.replace(/\D/g,''),10); if(n>this._s) this._s=n;
          s.layout=clean(s.layout,ok);
          if(s.layout) normalizeLayout(s.layout);
          if(s.layout) this._rids(s.layout);
        }
        this.ws.sessions=this.ws.sessions.filter(s=>s&&s.layout);
        if(!this.ws.sessions.find(s=>s.id===this.ws.activeSession))
          this.ws.activeSession=this.ws.sessions[0]?.id||null;
      }
      if(!this.ws.sessions.length) await this._mkSession();
    }catch(e){
      console.error('[App] init error:',e);
      if(!this.ws.sessions.length) await this._mkSession();
    }
    const a=this._as();
    if(a&&a.layout){const saved=a.focusedRegion;const f=(saved&&findRg(a.layout,saved))?{id:saved}:firstRg(a.layout);if(f)this._setFocus(f.id, a)}
    await this._loadMdScrolls();
    this.render();
    this._bind();
    this._subscribeCommands();
  }

  async _loadMdScrolls(){
    try{
      const r=await fetch('/api/md-scroll');
      if(!r.ok) return;
      const j=await r.json();
      const tabs=j&&j.tabs;
      if(!tabs) return;
      for(const[k,v] of Object.entries(tabs)) this.mdScrolls.set(k,v);
    }catch(e){console.warn('[mdscroll] load',e)}
  }

  saveMdScroll(tabId, top, ratio){
    if(!tabId) return;
    const ts=Date.now();
    this.mdScrolls.set(tabId, {top, ratio, ts});
    fetch('/api/md-scroll', {
      method:'PUT',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({tabId, top, ratio, by: this.clientId}),
    }).catch(e=>console.warn('[mdscroll] put',e));
  }

  _onMdScrollRemote(args){
    if(!args||!args.tabId) return;
    if(args.by===this.clientId) return;
    const entry={top: args.top||0, ratio: args.ratio||0, ts: args.ts||Date.now()};
    this.mdScrolls.set(args.tabId, entry);
    const v=this.mdViewers.get(args.tabId);
    if(v&&v.el.classList.contains('vis')) v._applyScroll(entry);
  }

  // 외부 CLI(dmctl) → 서버 → SSE 브로드캐스트 수신 → executeAction 재사용
  _subscribeCommands(){
    let retry=1000;
    const connect=()=>{
      try{
        const es=new EventSource('/api/commands/sse');
        es.onopen=()=>{retry=1000;this._attnRestore();this._activityRestore()};
        es.onmessage=(e)=>{
          try{
            const m=JSON.parse(e.data);
            if(m.action==='workspace_changed'){
              this._onWorkspaceChanged(m.args&&m.args.rev);
              return;
            }
            if(m.action==='md_scroll_changed'){
              this._onMdScrollRemote(m.args||{});
              return;
            }
            if(m.action==='pane_attention'){
              this._onPaneAttention(m.args||{});
              return;
            }
            if(m.action==='pane_attention_clear'){
              this._onPaneAttentionClear(m.args||{});
              return;
            }
            if(m.action==='pane_activity'){
              this._onPaneActivity(m.args||{});
              return;
            }
            // REMOTE_COMMAND_RESULT_SRS: reqId 는 broadcast payload 의 top-level
            // 이므로 args 에 합쳐 _execRemote 로 전달 (echo correlation).
            const args=m.args||{};
            if(m.reqId) args.reqId=m.reqId;
            this._execRemote(m.action, args);
          }catch(err){console.error('[cmd] parse',err)}
        };
        es.onerror=()=>{
          try{es.close()}catch{}
          setTimeout(connect, retry);
          retry=Math.min(retry*2, 30000);
        };
        this._cmdES=es;
      }catch(e){console.error('[cmd] connect',e); setTimeout(connect, retry)}
    };
    connect();
  }

  async _onWorkspaceChanged(rev){
    // While a local save is in flight, the SSE we just received is almost
    // certainly an echo of our own PUT (the PUT response with the new ETag
    // hasn't returned yet, so wsETag is still stale and would erroneously
    // pass the rev check). Defer until save settles.
    if(this._saveInflight){ this._wsApplyPending=true; return }
    if(this._wsApplyInflight){ this._wsApplyPending=true; return }
    const cur=this.wsETag?parseInt(this.wsETag,10):-1;
    if(typeof rev==='number' && rev<=cur) return;
    this._wsApplyInflight=true;
    try{
      do{
        this._wsApplyPending=false;
        const r=await fetch('/api/state');
        if(!r.ok) break;
        const et=r.headers.get('ETag')||r.headers.get('Etag');
        const st=await r.json();
        const sv=st&&st.workspace;
        const sp=(st&&st.panes)||[];
        if(!sv||!sv.sessions) break;
        this._applyRemoteWorkspace(sv, sp);
        if(et) this.wsETag=et;
      }while(this._wsApplyPending);
    }catch(err){console.error('[ws] sync',err)}
    finally{this._wsApplyInflight=false}
  }

  _applyRemoteWorkspace(sv, serverPanes){
    const ok=new Set((serverPanes||[]).map(p=>p.id));
    const nameOf=new Map((serverPanes||[]).map(p=>[p.id,p.name]));
    for(const id of ok){
      if(!this.panes.has(id)) this._mkPane(id, nameOf.get(id)||id);
    }
    for(const [id,p] of Array.from(this.panes.entries())){
      if(!ok.has(id)){ try{p.destroy()}catch{} this.panes.delete(id) }
    }
    for(const s of sv.sessions){
      if(!s||!s.id) continue;
      const n=parseInt(s.id.replace(/\D/g,''),10); if(n>this._s) this._s=n;
      s.layout=clean(s.layout, ok);
      if(s.layout) normalizeLayout(s.layout);
      if(s.layout) this._rids(s.layout);
    }
    sv.sessions=sv.sessions.filter(s=>s&&s.layout);
    if(!sv.sessions.find(s=>s.id===sv.activeSession))
      sv.activeSession=sv.sessions[0]?.id||null;
    this.ws=sv;
    if('displayMode' in this.ws) delete this.ws.displayMode;
    if('mobileBreakpoint' in this.ws) delete this.ws.mobileBreakpoint;
    if(this.ws.sidebarWidth){
      const w=Math.max(100,Math.min(400,this.ws.sidebarWidth));
      document.documentElement.style.setProperty('--sb-w',w+'px');
      try{localStorage.setItem('sidebarWidth',w)}catch{}
    }
    const a=this._as();
    if(a&&a.layout){
      const saved=a.focusedRegion;
      const f=(saved&&findRg(a.layout,saved))?{id:saved}:firstRg(a.layout);
      if(f) this._setFocus(f.id, a);
    }
    this.render();
  }

  // REMOTE_COMMAND_RESULT_SRS FR-RCR-6: 생성 명령의 새 엔터티 id 를 reqId 와 묶어
  // 서버에 echo. best-effort — 실패해도 서버 timeout 이 백스톱 (DC-RCR-3).
  _echoResult(reqId, result){
    fetch('/api/command-result',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        reqId,
        newSessions:result.newSessions||[],
        newRegions:result.newRegions||[],
        newTabs:result.newTabs||[],
      }),
    }).catch(()=>{});
  }

  _execRemote(action, args){
    args=args||{};
    if(action==='focus'){this._focusLocation(args.location); return}
    if(action==='openMdTab'){
      const{name,filePath,location}=args;
      if(!filePath){console.warn('[cmd] openMdTab: filePath required');return}
      if(location) this._focusLocation(location);
      const rid=this.focused;
      if(rid) this.addTab(rid,'markdown',{name:name||filePath.split('/').pop(),filePath});
      return;
    }
    // RENAME_TAB_SESSION_SRS FR-RNS-1/2: 순수 데이터 변경 — 포커스 무영향.
    if(action==='renameTab'||action==='renameSession'){
      if(!args.location||!args.name){console.warn('[cmd] '+action+': location/name 필수');return}
      const tgt=this._resolveLocation(args.location);
      if(!tgt){console.warn('[cmd] '+action+': 대상 없음',args.location);return}
      const name=String(args.name).slice(0,64);
      if(action==='renameTab') tgt.tab.name=name;
      else tgt.session.name=name;
      this._save(); this.render();
      return;
    }
    // REMOTE_SESSION_TAB_CREATE_SRS FR-RST-5: newSession/newTab 은 name/keepFocus
    // 를 전달하기 위해 명시 분기. 의미는 _mkSession/addTab 내부에서 보장.
    if(action==='newSession'){
      this._mkSession({name:args.name,keepFocus:!!args.keepFocus}).then((c)=>{
        this.render();
        if(args.reqId&&c) this._echoResult(args.reqId,{newSessions:[c.session],newRegions:[c.region],newTabs:[c.tab]});
      });
      return;
    }
    if(action==='newTab'){
      const opts={name:args.name,keepFocus:!!args.keepFocus};
      let rid=null;
      if(args.location){
        const tgt=this._resolveLocation(args.location);
        if(!tgt) return;
        if(opts.keepFocus){
          opts.sessionId=tgt.sessionId;
          rid=tgt.regionId;
        }else{
          this._focusLocation(args.location);
          rid=this.focused;
        }
      }else{
        rid=this.focused;
      }
      if(rid) this.addTab(rid,'terminal',opts).then((tab)=>{
        if(args.reqId&&tab) this._echoResult(args.reqId,{newTabs:[tab]});
      });
      return;
    }
    const isSplit=(action==='splitH'||action==='splitV');
    if(isSplit){
      const opts={count:args.count,keepFocus:!!args.keepFocus};
      if(args.location){
        const tgt=this._resolveLocation(args.location);
        if(!tgt) return;
        opts.targetSession=tgt.sessionId;
        opts.targetRegion=tgt.regionId;
      }
      const dir=action==='splitH'?'horizontal':'vertical';
      this.split(dir,opts).then((c)=>{
        if(args.reqId&&c) this._echoResult(args.reqId,{newRegions:c.regions,newTabs:c.tabs});
      });
      return;
    }
    const keepFocus=!!args.keepFocus;
    // location 지정 closeTab 은 활성/비활성 세션 구분 없이 포커스를 건드리지 않고 직접 close.
    // keepFocus 인자는 호환을 위해 받지만, location 이 있으면 항상 포커스 유지로 취급한다.
    if(action==='closeTab' && args.location){
      const tgt=this._resolveLocation(args.location);
      if(tgt && tgt.regionId && tgt.tabId){
        this.closeTab(tgt.regionId, tgt.tabId, tgt.sessionId);
        return;
      }
    }
    let savedSession=null, savedFocused=null;
    if(args.location && keepFocus){
      savedSession=this.ws.activeSession;
      savedFocused=this.focused;
    }
    if(args.location) this._focusLocation(args.location);
    const result=this.executeAction(action);
    Promise.resolve(result).then(()=>{
      if(savedSession==null) return;
      if(this.ws.activeSession!==savedSession && this.ws.sessions.some(x=>x.id===savedSession)){
        const cur=this._as(); if(cur) cur.focusedRegion=this.focused;
        this.ws.activeSession=savedSession;
      }
      const a=this._as();
      if(a&&savedFocused&&findRg(a.layout,savedFocused)){
        this._setFocus(savedFocused, a);
      }
      this._save(); this.render();
    });
  }

  _resolveLocation(loc){
    if(!loc) return null;
    const m=String(loc).toUpperCase().trim().match(/^S?(\d+)(?:[.\s]+P?(\d+))?(?:[.\s]+T?(\d+))?$/);
    if(!m) return null;
    const si=parseInt(m[1],10)-1;
    const pi=m[2]?parseInt(m[2],10)-1:0;
    const ti=m[3]?parseInt(m[3],10)-1:0;
    const sess=this.ws.sessions[si]; if(!sess) return null;
    const regions=[]; this._collectRegions(sess.layout,regions);
    const rg=regions[pi]; if(!rg) return null;
    const tab=rg.tabs[ti]; if(!tab) return null;
    return {sessionId:sess.id,regionId:rg.id,tabId:tab.id,session:sess,region:rg,tab:tab};
  }

  // "4.1.1", "S4.P1.T1", "4", "4.2" 등을 지원. 1-base positional (session.region.tab).
  _focusLocation(loc){
    if(!loc){console.warn('[cmd] focus: location 누락');return}
    const m=String(loc).toUpperCase().trim().match(/^S?(\d+)(?:[.\s]+P?(\d+))?(?:[.\s]+T?(\d+))?$/);
    if(!m){console.warn('[cmd] focus: 형식 오류',loc);return}
    const si=parseInt(m[1],10)-1;
    const pi=m[2]?parseInt(m[2],10)-1:0;
    const ti=m[3]?parseInt(m[3],10)-1:0;
    const sess=this.ws.sessions[si];
    if(!sess){console.warn('[cmd] focus: session #'+(si+1)+' 없음');return}
    const regions=[]; this._collectRegions(sess.layout, regions);
    const rg=regions[pi];
    if(!rg){console.warn('[cmd] focus: region #'+(pi+1)+' 없음');return}
    const tab=rg.tabs[ti];
    if(!tab){console.warn('[cmd] focus: tab #'+(ti+1)+' 없음');return}
    if(this.ws.activeSession!==sess.id){
      const cur=this._as(); if(cur) cur.focusedRegion=this.focused;
      this.ws.activeSession=sess.id;
    }
    rg.activeTab=tab.id;
    this._setFocus(rg.id, sess);
    this._save(); this.render();
  }

  _collectRegions(n, out){
    if(!n) return;
    if(n.type==='region'){out.push(n);return}
    if(n.children) for(const c of n.children) this._collectRegions(c,out);
  }

  _rids(n){
    if(!n) return;
    if(n.type==='region'){
      const r=parseInt((n.id||'').replace(/\D/g,''),10);if(r>this._r)this._r=r;
      if(n.tabs) for(const t of n.tabs){const x=parseInt((t.id||'').replace(/\D/g,''),10);if(x>this._t)this._t=x}
      return;
    }
    if(n.children) for(const c of n.children) this._rids(c);
  }

  _mkPane(id,name){
    if(this.panes.has(id)) return this.panes.get(id);
    const p=new TermPane(id,name);
    document.getElementById('area').appendChild(p.el);
    p.connect();
    this.panes.set(id,p);
    return p;
  }

  async _isPaneBusy(paneId){
    try{const r=await fetch(`/api/panes/${paneId}/busy`);const d=await r.json();return d.busy}catch{return false}
  }

  _confirmClose(msg){
    return new Promise(resolve=>{
      const ov=document.createElement('div');ov.className='confirm-overlay';
      ov.innerHTML=`<div class="confirm-box"><div class="confirm-msg">${msg}</div><div class="confirm-btns"><button class="confirm-ok">닫기</button><button class="confirm-cancel">취소</button></div></div>`;
      document.body.appendChild(ov);
      ov.querySelector('.confirm-ok').focus();
      const cleanup=v=>{ov.remove();document.removeEventListener('keydown',onKey);resolve(v)};
      const onKey=e=>{if(e.key==='Enter'){e.preventDefault();cleanup(true)}else if(e.key==='Escape'){e.preventDefault();cleanup(false)}};
      document.addEventListener('keydown',onKey);
      ov.querySelector('.confirm-ok').addEventListener('click',()=>cleanup(true));
      ov.querySelector('.confirm-cancel').addEventListener('click',()=>cleanup(false));
      ov.addEventListener('click',e=>{if(e.target===ov)cleanup(false)});
    });
  }

  async _newPane(cwd,cwdPane){
    let q='';
    if(cwd) q='&cwd='+encodeURIComponent(cwd);
    else if(cwdPane) q='&cwdPane='+encodeURIComponent(cwdPane);
    const r=await fetch('/api/panes?cols=120&rows=40'+q,{method:'POST'});
    if(!r.ok) throw new Error('create pane failed');
    const {id,name}=await r.json();
    return this._mkPane(id,name);
  }

  async _focusedCwd(){
    const p=this._focusedTermPane();
    if(!p) return null;
    try{const r=await fetch('/api/cwd?pane='+p.id);const d=await r.json();return d.cwd||null}catch{return null}
  }

  async _kill(pid){
    const p=this.panes.get(pid);
    if(p){p.destroy();this.panes.delete(pid)}
    try{await fetch(`/api/panes/${pid}`,{method:'DELETE'})}catch{}
  }
  _killBg(pid){
    const p=this.panes.get(pid);
    if(p){p.destroy();this.panes.delete(pid)}
    fetch(`/api/panes/${pid}`,{method:'DELETE'}).catch(()=>{});
  }

  _as(){return this.ws.sessions.find(s=>s.id===this.ws.activeSession)||null}

  // _setFocus is the single entry point for the focus invariant
  // (this.focused === active session.focusedRegion). It accepts an optional
  // session reference; when omitted, the active session is used. When the
  // mutated session is not the active one, only its focusedRegion is updated
  // (this.focused unchanged). REG-2~8 회귀 클래스 차단용 단일 진입점.
  _setFocus(rid, sess){
    const target = sess || this._as();
    if(target) target.focusedRegion = rid;
    if(!sess || (target && target.id === this.ws.activeSession)){
      this.focused = rid;
      // FR-PAN-11: 포커스된 활성 탭 pane 의 주의 상태 해제(로컬+엔드포인트)
      if(this.focused===rid) this._attnClearFocused();
    }
    this._agentsRender(); // 외부 포커스 변경도 카드 .focused 에 즉시 반영(render 미경유 경로 포함)
  }

  // ── Pane Attention Notify (PANE_ATTENTION_NOTIFY_SRS) ──

  // 설정 영속화는 localStorage(per-device), 기존 /api/settings 스키마 무변경 (FR-PAN-14)
  // 데스크톱 알림은 기본 ON(권한 허용 시 동작) — '0' 으로 명시 비활성만 끈다 (FR-PAN-13a)
  get attnDesktop(){try{return localStorage.getItem('attnDesktop')!=='0'}catch{return true}}
  set attnDesktop(v){try{localStorage.setItem('attnDesktop',v?'1':'0')}catch{}}
  get attnSound(){try{return localStorage.getItem('attnSound')==='1'}catch{return false}}
  set attnSound(v){try{localStorage.setItem('attnSound',v?'1':'0')}catch{}}
  get agentsPollMs(){try{const v=parseInt(localStorage.getItem('agentsPollMs'));return v>=1000?v:AGENTS_POLL_DEFAULT}catch{return AGENTS_POLL_DEFAULT}}
  set agentsPollMs(v){try{localStorage.setItem('agentsPollMs',String(v))}catch{}}

  _attnHas(paneId){return this._attn.has(paneId)}

  // 활성 세션의 포커스 region 의 activeTab paneId === paneId 인지 (FR-PAN-9)
  _isPaneFocusedActive(paneId){
    if(!paneId) return false;
    const s=this._as(); if(!s||!s.layout) return false;
    const rg=findRg(s.layout,this.focused); if(!rg) return false;
    const at=(rg.tabs||[]).find(t=>t.id===rg.activeTab);
    return !!at&&at.paneId===paneId;
  }

  _onPaneAttention({paneId,reason}={}){
    if(!paneId) return;
    // 억제(즉시 해제)는 "정말로 보고 있을 때"만 — 브라우저 창이 OS 포커스를 가졌고(다른 앱이
    // 위에 있지 않음) 그 pane 에 포커스가 있을 때. 다른 프로그램을 보고 있으면(document.hasFocus()
    // false) 포커스여도 알람을 살린다 (FR-PAN-9/13/요구2).
    const browserFocused=(typeof document!=='undefined'&&typeof document.hasFocus==='function')?document.hasFocus():true;
    if(browserFocused&&this._isPaneFocusedActive(paneId)){this._attnClear(paneId);return}
    this._attn.set(paneId,{reason});
    this._attnRefresh();
    this._attnDesktopNotify(reason,paneId); // FR-PAN-13a
    this._attnBeep(); // FR-PAN-13c
  }

  _onPaneAttentionClear({paneId}={}){
    if(!paneId) return;
    this._attnCloseNotif(paneId);
    if(!this._attn.delete(paneId)) return;
    this._attnRefresh();
  }

  // FR-PAN-12: 합류/재연결 시 현재 주의 집합 복원(기존 것 병합)
  _attnRestore(){
    fetch('/api/panes/attention').then(r=>r.ok?r.json():null).then(j=>{
      if(!j||!Array.isArray(j.paneIds)) return;
      for(const pid of j.paneIds){if(!this._attn.has(pid))this._attn.set(pid,{reason:'signaled'})}
      this._attnRefresh();
    }).catch(()=>{});
  }

  // FR-PAN-11: 로컬 즉시 제거 + 백엔드 해제(다른 브라우저로 전파)
  _attnClear(paneId){
    if(!paneId) return;
    this._attnCloseNotif(paneId);
    this._attn.delete(paneId);
    fetch('/api/panes/attention/clear',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({paneId})}).catch(()=>{});
    this._attnRefresh();
  }

  // FR-PAN-17: 모든 알람 일괄 해제
  _attnClearAll(){
    fetch('/api/panes/attention/clear-all',{method:'POST'}).catch(()=>{});
    Object.keys(this._attnNotifs||{}).forEach(k=>this._attnCloseNotif(k));
    this._attn.clear();
    this._attnCenterClose();
    this._attnRefresh();
  }

  // FR-PAN-16: 세션 layout 안에 주의 상태 pane 이 있는지
  _sessionHasAttn(s){
    if(!s||!s.layout||!this._attn.size) return false;
    const walk=(node)=>{
      if(!node) return false;
      if(node.type==='region') return (node.tabs||[]).some(t=>t.paneId&&this._attn.has(t.paneId));
      if(node.children) return node.children.some(walk);
      return false;
    };
    return walk(s.layout);
  }

  // 포커스된 활성 탭이 주의 상태면 해제. 그 탭은 어차피 강조 안 되므로 full render 불필요
  _attnClearFocused(){
    if(!this._attn.size) return;
    const s=this._as(); if(!s||!s.layout) return;
    const rg=findRg(s.layout,this.focused); if(!rg) return;
    const at=(rg.tabs||[]).find(t=>t.id===rg.activeTab);
    if(at&&at.paneId&&this._attn.has(at.paneId)) this._attnClear(at.paneId);
  }

  // 모든 세션 layout 트리를 walk 해 paneId 를 가진 tab 위치 반환 (FR-PAN-16)
  _findPaneLocation(paneId){
    if(!paneId) return null;
    const walk=(node,session)=>{
      if(!node) return null;
      if(node.type==='region'){
        const tab=(node.tabs||[]).find(t=>t.paneId===paneId);
        return tab?{session,region:node,tab}:null;
      }
      if(node.children) for(const c of node.children){const f=walk(c,session);if(f)return f}
      return null;
    };
    for(const s of this.ws.sessions){const f=walk(s.layout,s);if(f)return f}
    return null;
  }

  // FR-PAN-16: 해당 pane 으로 포커스 이동(_setFocus 가 _attnClearFocused 로 해제)
  _jumpToPane(paneId){
    const loc=this._findPaneLocation(paneId);
    if(!loc) return;
    this.ws.activeSession=loc.session.id;
    loc.region.activeTab=loc.tab.id;
    this._setFocus(loc.region.id, loc.session);
    this.render();
  }

  // FR-AAP-15: SSE pane_activity 수신 → 최신 상태로 덮어쓰고 카드 타깃 갱신
  _onPaneActivity({paneId,state,tool,detail}={}){
    if(!paneId||!state) return;
    if(state==='ended'){ // 종료 → 카드 제거
      if(this._activity.delete(paneId)) this._agentsRender();
      return;
    }
    this._activity.delete(paneId); // 재삽입으로 최신 항목을 Map 끝(=맨 위)으로
    this._activity.set(paneId,{state,tool:tool||'',detail:detail||''});
    this._agentsRender();
  }

  // FR-AAP-15: 합류/재연결 시 현재 활동 스냅샷 복원
  _activityRestore(){
    fetch('/api/panes/activity').then(r=>r.ok?r.json():null).then(j=>{
      if(!j||!Array.isArray(j.activities)) return;
      j.activities.sort((a,b)=>(a.updatedAt||0)-(b.updatedAt||0)); // 오래된→최신: 끝이 가장 최근
      this._activity.clear();
      for(const a of j.activities) this._activity.set(a.paneId,{state:a.state,tool:a.tool||'',detail:a.detail||''});
      this._agentsRender();
    }).catch(()=>{});
  }

  // FR-AAP-11/12: 우측 활동 패널 토글(열림 상태 영속)
  _agentsToggle(){
    const panel=document.getElementById('agents-panel'),handle=document.getElementById('agents-handle');
    if(!panel) return;
    const open=!panel.classList.contains('open');
    panel.classList.toggle('open',open);
    handle.classList.toggle('open',open);
    const btn=document.getElementById('agents-toggle');if(btn)btn.classList.toggle('open',open);
    try{localStorage.setItem('agentsPanelOpen',open?'1':'0')}catch{}
    for(const p of this.panes.values()) if(p.el.classList.contains('vis')) p.doFit();
    if(open){this._agentsRender();this._agentsStartPoll()}else{this._agentsStopPoll()}
  }

  // FR-AAP-19: 패널 열림 동안 주기적으로 서버 스냅샷과 동기화(자동 새로고침)
  _agentsStartPoll(){
    this._agentsStopPoll();
    this._agentsTimer=setInterval(()=>this._activityRestore(),this.agentsPollMs);
  }
  _agentsStopPoll(){
    if(this._agentsTimer){clearInterval(this._agentsTimer);this._agentsTimer=null}
  }

  // FR-AAP-13/14/16/18: 활동 중인 pane 카드 렌더. _findPaneLocation 실패(종료/없음)
  // pane 은 제외, attention 있으면 .attn 합성, 클릭 시 점프+알람 해제.
  _agentsRender(){
    const panel=document.getElementById('agents-panel');
    if(!panel||!panel.classList.contains('open')) return;
    panel.innerHTML='';
    const head=document.createElement('div');
    head.className='ag-head';
    head.innerHTML=`<span class="ag-title">Agents</span><button class="ag-refresh" title="새로고침">↻</button><button class="ag-close" title="닫기">✕</button>`;
    head.querySelector('.ag-refresh').addEventListener('click',e=>{e.stopPropagation();this._activityRestore()});
    head.querySelector('.ag-close').addEventListener('click',e=>{e.stopPropagation();this._agentsToggle()});
    panel.appendChild(head);
    let n=0;
    for(const [paneId,info] of [...this._activity].reverse()){ // 최신(맨 위)부터
      const loc=this._findPaneLocation(paneId);
      if(!loc) continue;
      n++;
      const card=document.createElement('div');
      card.className='ag-card'+(this._attnHas(paneId)?' attn':'')+(this._isPaneFocusedActive(paneId)?' focused':'');
      card.dataset.pid=paneId;
      card.innerHTML=`<div class="ag-loc"></div><div class="ag-state"></div><div class="ag-detail"></div>`;
      card.querySelector('.ag-loc').textContent=(loc.session.name||'')+' · '+(loc.tab.name||paneId);
      const st=card.querySelector('.ag-state');
      st.classList.add(info.state); // 상태별 색(.ag-state.working 등)
      st.textContent=(AGENT_STATE_ICON[info.state]||'●')+' '+info.state+(info.tool?' · '+info.tool:'');
      const dt=card.querySelector('.ag-detail');
      if(info.detail) dt.textContent=info.detail; else dt.remove();
      card.addEventListener('click',()=>{this._jumpToPane(paneId);if(this._attnHas(paneId))this._attnClear(paneId)});
      panel.appendChild(card);
    }
    if(!n){
      const empty=document.createElement('div');
      empty.className='ag-empty';
      empty.textContent='활동 중인 에이전트 없음';
      panel.appendChild(empty);
    }
  }

  // FR-PAN-16: 제목 배지 + notification center 배지/팝오버 갱신
  _attnRefresh(){
    const n=this._attn.size;
    document.title=(n?'('+n+') ':'')+'Terminal'; // FR-PAN-13b
    // 사이드바 세션 알람 표시 갱신 (전체 재렌더 없이)
    document.querySelectorAll('#sessions .si').forEach(el=>{
      const s=this.ws.sessions.find(x=>x.id===el.dataset.sid);
      el.classList.toggle('attn', !!(s&&this._sessionHasAttn(s)));
    });
    // 탭/리전 강조도 타깃 토글 — 전체 render() 를 피해 포커스 플리커(xterm blur/refocus)를 막는다.
    document.querySelectorAll('#area .rt[data-pid]').forEach(t=>{
      const rg=t.closest('.rg');
      const focusedRegion=!!(rg&&rg.classList.contains('focused'));
      const active=t.classList.contains('active');
      t.classList.toggle('attn', this._attnHas(t.dataset.pid)&&!(focusedRegion&&active));
    });
    document.querySelectorAll('#area .rg[data-rid]').forEach(rg=>{
      const at=rg.querySelector('.rt.active[data-pid]');
      const pid=at?at.dataset.pid:null;
      rg.classList.toggle('attn', !!(pid&&this._attnHas(pid)&&!rg.classList.contains('focused')));
    });
    const badge=document.getElementById('attn-badge');
    if(badge){
      const cnt=badge.querySelector('.attn-count');
      if(cnt) cnt.textContent=String(n);
      badge.style.display=n?'':'none';
      if(!n) this._attnCenterClose();
    }
    const center=document.getElementById('attn-center');
    if(center&&center.classList.contains('open')) this._attnCenterRender();
    this._agentsRender(); // FR-AAP-18: 활동 카드의 alarm 표시도 함께 갱신
  }

  _attnCenterToggle(){
    const center=document.getElementById('attn-center');
    if(!center) return;
    if(center.classList.contains('open')) this._attnCenterClose();
    else{center.classList.add('open');this._attnCenterRender()}
  }

  _attnCenterClose(){
    const center=document.getElementById('attn-center');
    if(center) center.classList.remove('open');
  }

  _attnCenterRender(){
    const center=document.getElementById('attn-center');
    if(!center) return;
    center.innerHTML='';
    if(!this._attn.size){this._attnCenterClose();return}
    const head=document.createElement('div');
    head.className='attn-head';
    head.innerHTML=`<span class="attn-title">주의 알림 ${this._attn.size}</span><button class="attn-clear-all">모두 제거</button>`;
    head.querySelector('.attn-clear-all').addEventListener('click',e=>{e.stopPropagation();this._attnClearAll()});
    center.appendChild(head);
    for(const [paneId,info] of this._attn){
      const loc=this._findPaneLocation(paneId);
      const name=loc?loc.tab.name:paneId;
      const reason=info&&info.reason==='idle'?'작업 멈춤':'알림 신호';
      const item=document.createElement('div');
      item.className='attn-item';
      item.innerHTML=`<span class="attn-name"></span><span class="attn-reason"></span>`;
      item.querySelector('.attn-name').textContent=name;
      item.querySelector('.attn-reason').textContent=reason;
      item.addEventListener('click',()=>{this._jumpToPane(paneId);this._attnCenterClose()});
      center.appendChild(item);
    }
  }

  // FR-PAN-13a: 데스크톱 알림(권한 granted + 설정 on). pane 별 직전 알림을 닫고 새로 띄운다.
  _attnDesktopNotify(reason,paneId){
    if(!this.attnDesktop) return;
    if(typeof Notification==='undefined'||Notification.permission!=='granted') return;
    const loc=this._findPaneLocation(paneId);
    const where=loc?[loc.session&&loc.session.name,loc.tab&&loc.tab.name].filter(Boolean).join(' · '):('pane '+paneId);
    const head=reason==='done'?'✅ 작업 완료':reason==='waiting'?'⌨️ 입력 대기 중':reason==='idle'?'⏸️ 작업이 멈췄습니다':'🔔 주의가 필요합니다';
    // 같은 pane 의 이전 알림을 닫고 새로 띄운다 — tag+renotify 는 (특히 macOS 에서)
    // 조용히 갱신만 되어 재팝업이 안 되므로, close→재생성으로 매번 확실히 다시 띄운다.
    this._attnNotifs=this._attnNotifs||{};
    this._attnCloseNotif(paneId);
    try{this._attnNotifs[paneId]=new Notification(head,{body:where||('pane '+paneId)})}catch{}
  }

  // 저장해 둔 데스크톱 알림 객체를 닫는다(있으면).
  _attnCloseNotif(paneId){
    if(this._attnNotifs&&this._attnNotifs[paneId]){
      try{this._attnNotifs[paneId].close()}catch{}
      delete this._attnNotifs[paneId];
    }
  }

  // FR-PAN-13c: WebAudio 짧은 비프(외부 파일 없음). 설정 on 일 때만
  _attnBeep(){
    if(!this.attnSound) return;
    const Ctx=window.AudioContext||window['webkitAudioContext'];
    if(!Ctx) return;
    if(!this._audioCtx) this._audioCtx=new Ctx();
    const ctx=this._audioCtx;
    const osc=ctx.createOscillator();
    const gain=ctx.createGain();
    osc.type='sine';
    osc.frequency.value=880;
    gain.gain.value=.05;
    osc.connect(gain);gain.connect(ctx.destination);
    const t=ctx.currentTime;
    osc.start(t);
    gain.gain.setValueAtTime(.05,t);
    gain.gain.exponentialRampToValueAtTime(.0001,t+.18);
    osc.stop(t+.2);
  }

  // notification center 배지/팝오버 이벤트 바인딩 + 설정 토글 (FR-PAN-14/16)
  _initAttn(){
    const badge=document.getElementById('attn-badge');
    if(badge&&!badge._bound){
      badge._bound=true;
      badge.addEventListener('click',e=>{e.stopPropagation();this._attnCenterToggle()});
    }
    document.addEventListener('click',e=>{
      const center=document.getElementById('attn-center');
      if(!center||!center.classList.contains('open')) return;
      if(center.contains(e.target)||(badge&&badge.contains(e.target))) return;
      this._attnCenterClose();
    });
    const dt=document.getElementById('attn-desktop');
    if(dt){
      dt.checked=this.attnDesktop;
      dt.addEventListener('change',()=>{
        if(dt.checked&&typeof Notification!=='undefined'&&Notification.permission==='default'){
          Notification.requestPermission().then(p=>{if(p!=='granted'){dt.checked=false;this.attnDesktop=false}});
        }
        this.attnDesktop=dt.checked;
      });
    }
    const sd=document.getElementById('attn-sound');
    if(sd){
      sd.checked=this.attnSound;
      sd.addEventListener('change',()=>{this.attnSound=sd.checked});
    }
    const ap=document.getElementById('agents-poll');
    if(ap){
      ap.value=String(this.agentsPollMs);
      ap.addEventListener('change',()=>{
        this.agentsPollMs=parseInt(ap.value);
        if(this._agentsTimer) this._agentsStartPoll(); // 폴링 중이면 새 주기로 재시작
      });
    }
    // 데스크톱 알림 권한은 사용자 제스처가 필요하므로, 켜져 있고 아직 미결정이면
    // 첫 상호작용에서 한 번 요청한다 (브라우저 정책 충족) — FR-PAN-13a.
    // capture 단계로 들어야 xterm 이 pointer/key 이벤트를 먼저 소비해도 누락되지 않는다.
    if(typeof Notification!=='undefined'&&Notification.permission==='default'&&this.attnDesktop&&!this._attnPermAsked){
      this._attnPermAsked=true;
      let asked=false;
      const ask=()=>{if(asked)return;asked=true;try{const r=Notification.requestPermission();if(r&&r.then)r.then(()=>this._initAttn&&this._attnRefresh())}catch{}};
      document.addEventListener('pointerdown',ask,{once:true,capture:true});
      document.addEventListener('keydown',ask,{once:true,capture:true});
    }
    // 브라우저로 돌아오면(다른 앱→복귀) 지금 보고 있는 pane 의 알람은 해제 (요구2 보완).
    if(!this._attnFocusBound){
      this._attnFocusBound=true;
      window.addEventListener('focus',()=>this._attnClearFocused());
    }
    this._attnRefresh();
  }

  async _mkSession(opts={}){
    const p=await this._newPane();
    const r=`r${++this._r}`,t=`t${++this._t}`;
    const name=(typeof opts.name==='string'&&opts.name?opts.name:'Session').slice(0,64);
    const s={
      id:`s${++this._s}`,name,
      layout:{type:'region',id:r,tabs:[{id:t,name:'Shell',type:'terminal',paneId:p.id}],activeTab:t}
    };
    this.ws.sessions.push(s);
    // REMOTE_SESSION_TAB_CREATE_SRS FR-RST-2: keepFocus 면 세션은 사이드바에만
    // 추가 — activeSession/focused 무변화 (백그라운드 잡 컨테이너 패턴).
    if(!opts.keepFocus){
      this.ws.activeSession=s.id;
      this._setFocus(r, s);
    }
    // Fire-and-forget save: keeps the UI snappy. Awaiting here would block
    // render on the PUT roundtrip (see split/addTab which already use
    // this pattern).
    this._save();
    // REMOTE_COMMAND_RESULT_SRS FR-RCR-6/7: 생성한 엔터티 id 반환 (echo 용).
    return {session:s.id, region:r, tab:{uuid:t, paneId:p.id}};
  }

  async addSession(){await this._mkSession();this.render()}

  async delSession(sid){
    const i=this.ws.sessions.findIndex(s=>s.id===sid);
    if(i<0) return;
    const s=this.ws.sessions[i];
    const pids=allPids(s.layout);
    const busyChecks=await Promise.all(pids.map(pid=>this._isPaneBusy(pid)));
    if(busyChecks.some(Boolean)){
      const ok=await this._confirmClose('실행 중인 프로세스가 있습니다. 세션을 종료하시겠습니까?');
      if(!ok) return;
    }
    for(const pid of pids) this._kill(pid);
    this.ws.sessions.splice(i,1);
    if(!this.ws.sessions.length){await this._mkSession();this.render();return}
    if(this.ws.activeSession===sid)
      this.ws.activeSession=this.ws.sessions[Math.min(i,this.ws.sessions.length-1)].id;
    const a=this._as();
    if(a&&a.layout){
      const next=(a.focusedRegion&&findRg(a.layout,a.focusedRegion))?a.focusedRegion:firstRg(a.layout)?.id||null;
      this._setFocus(next, a);
    } else this.focused=null;
    // Render first, save in background (matches split/addTab/closeTab).
    this.render();
    this._save();
  }

  switchSession(sid){
    if(this.ws.activeSession===sid){
      if(this.isMobile && this._drawerOpen) this._toggleDrawer(false);
      return;
    }
    const cur=this._as();if(cur)cur.focusedRegion=this.focused;
    this.ws.activeSession=sid;
    const a=this._as();
    if(a&&a.layout){
      const next=(a.focusedRegion&&findRg(a.layout,a.focusedRegion))?a.focusedRegion:firstRg(a.layout)?.id||null;
      this._setFocus(next, a);
    } else this.focused=null;
    this._mPaneIdx=0;
    if(this.isMobile && this._drawerOpen) this._toggleDrawer(false);
    this._save(); this.render();
  }

  _findMdTab(filePath) {
    for (const s of this.ws.sessions) {
      if (!s || !s.layout) continue;
      let result = null;
      const walk = n => {
        if (!n || result) return;
        if (n.type === 'region' && n.tabs) {
          for (const t of n.tabs) {
            if (t.type === 'markdown' && t.filePath === filePath) {
              result = { tab: t, region: n, session: s };
              return;
            }
          }
        }
        if (n.type === 'split' && n.children) {
          for (const c of n.children) walk(c);
        }
      };
      walk(s.layout);
      if (result) return result;
    }
    return null;
  }

  async addTab(rid, type = 'terminal', opts = {}) {
    // opts.sessionId 지정 시 비활성 세션의 region 에도 추가 가능 (FR-RST-4).
    const s = opts.sessionId ? this.ws.sessions.find(x => x.id === opts.sessionId) : this._as();
    if (!s) return;
    const rg = findRg(s.layout, rid); if (!rg) return;
    if (type === 'markdown') {
      if (!opts.filePath) { console.warn('[addTab] markdown tab requires filePath'); return }
      const existing = this._findMdTab(opts.filePath);
      if (existing) {
        const cur = this._as(); if (cur) cur.focusedRegion = this.focused;
        this.ws.activeSession = existing.session.id;
        existing.region.activeTab = existing.tab.id;
        this._setFocus(existing.region.id, existing.session);
        const viewer = this.mdViewers.get(existing.tab.id);
        if (viewer) viewer.refresh();
        this.render();
        this._save();
        return;
      }
      const name = opts.name || opts.filePath.split('/').pop();
      const t = `t${++this._t}`;
      rg.tabs.push({ id: t, name, type: 'markdown', filePath: opts.filePath });
      rg.activeTab = t;
      this.render();
      this._save();
      return;
    }
    const ref = this._regionNewPaneRef(s, rid);
    const p = await this._newPane(ref.cwd || null, ref.cwd ? null : (ref.cwdPane || null));
    const t = `t${++this._t}`;
    const name = (typeof opts.name === 'string' && opts.name ? opts.name : 'Shell').slice(0, 64);
    rg.tabs.push({ id: t, name, type: 'terminal', paneId: p.id });
    // FR-RST-4: keepFocus 면 대상 region 의 활성 탭도 바꾸지 않는다 (백그라운드 추가).
    if (!opts.keepFocus) rg.activeTab = t;
    this.render();
    this._save();
    // REMOTE_COMMAND_RESULT_SRS FR-RCR-7: 생성한 tab id+paneId 반환 (echo 용).
    return { uuid: t, paneId: p.id };
  }

  async closeTab(rid,tid,sid){
    // sid 를 지정하면 해당 세션의 탭을 닫는다 (비활성 세션 대상도 지원).
    // 지정 안 하면 기존 동작: 활성 세션에서 닫는다.
    const s = sid ? this.ws.sessions.find(x=>x.id===sid) : this._as();
    if(!s) return;
    const rg=findRg(s.layout,rid); if(!rg) return;
    const tab=rg.tabs.find(t=>t.id===tid); if(!tab) return;
    const isMd=tab.type==='markdown';
    if(isMd){
      const viewer=this.mdViewers.get(tab.id);
      if(viewer){viewer.destroy();this.mdViewers.delete(tab.id)}
    }else{
      if(await this._isPaneBusy(tab.paneId)){
        const ok=await this._confirmClose('실행 중인 프로세스가 있습니다. 탭을 닫으시겠습니까?');
        if(!ok) return;
      }
    }
    const paneId=tab.paneId;
    const closingIdx=rg.tabs.findIndex(t=>t.id===tid);
    rg.tabs=rg.tabs.filter(t=>t.id!==tid);
    const isActive = s.id === this.ws.activeSession;
    if(!rg.tabs.length){
      const prevClosestId=closestRg(s.layout,rid)?.id||null;
      s.layout=doRemove(s.layout,rid);
      if(!s.layout){if(!isMd&&paneId)this._killBg(paneId);await this.delSession(s.id);return}
      if(isActive){
        const fallback=this.focused===rid?prevClosestId:this.focused;
        const next=fallback&&findRg(s.layout,fallback)?fallback:firstRg(s.layout)?.id||null;
        this._setFocus(next, s);
      } else if(s.focusedRegion===rid){
        s.focusedRegion=prevClosestId&&findRg(s.layout,prevClosestId)?prevClosestId:firstRg(s.layout)?.id||null;
      }
    } else {
      if(rg.activeTab===tid){
        const ni=closingIdx<rg.tabs.length?closingIdx:rg.tabs.length-1;
        rg.activeTab=rg.tabs[ni].id;
      }
    }
    this.render();
    if(!isMd&&paneId){
      this._killBg(paneId);
    }
    this._save();
  }

  switchTab(rid,tid){
    const s=this._as(); if(!s) return;
    const rg=findRg(s.layout,rid); if(!rg) return;
    if(rg.activeTab===tid && this.focused===rid){this._setFocus(rid, s); return}
    rg.activeTab=tid; this._setFocus(rid, s);
    this._save(); this.render();
  }

  // split is serialized through this._splitChain so that rapid successive
  // calls (e.g. holding the shortcut) don't race on this.focused: each call
  // waits for the previous to finish — including the _setFocus that updates
  // the new target — before reading focus or layout state.
  split(dir,opts={}){
    const prev=this._splitChain||Promise.resolve();
    const next=prev.then(()=>this._splitInner(dir,opts)).catch(err=>{console.error('[split] error',err)});
    this._splitChain=next.finally(()=>{ if(this._splitChain===next) this._splitChain=null; });
    return next;
  }

  async _splitInner(dir,opts={}){
    if(this.isMobile && !opts.force) return;
    const tgtSessionId=opts.targetSession||this.ws.activeSession;
    let s=this.ws.sessions.find(x=>x.id===tgtSessionId);
    const tgtRegionId=opts.targetRegion||(tgtSessionId===this.ws.activeSession?this.focused:null);
    if(!s||!tgtRegionId) return;
    let count=parseInt(opts.count,10); if(!Number.isFinite(count)||count<2) count=2;
    const keepFocus=!!opts.keepFocus;
    // SPLIT_KEEPFOCUS_FIX_SRS FR-SKF-1: keepFocus 면 호출 직전 사용자 포커스를 저장해 사후 복원.
    const savedSession = keepFocus ? this.ws.activeSession : null;
    const savedFocused = keepFocus ? this.focused : null;
    const ref=this._regionNewPaneRef(s,tgtRegionId);
    const refPaneId=ref.cwd ? null : (ref.cwdPane || null);
    const newRegions=[]; let lastR=null;
    for(let i=0;i<count-1;i++){
      const p=await this._newPane(ref.cwd || null, refPaneId);
      const r=`r${++this._r}`,t=`t${++this._t}`;
      newRegions.push({type:'region',id:r,tabs:[{id:t,name:'Shell',type:'terminal',paneId:p.id}],activeTab:t});
      lastR=r;
    }
    // Re-fetch session after awaits: this.ws may have been replaced by an
    // SSE workspace_changed apply during the _newPane awaits, leaving our
    // earlier `s` reference stale (and invisible to render). Bail if the
    // target region is gone — the created panes will be reaped on the next
    // workspace sync.
    s=this.ws.sessions.find(x=>x.id===tgtSessionId);
    if(!s||!findRg(s.layout,tgtRegionId)) return;
    s.layout=doSplit(s.layout,tgtRegionId,newRegions,dir);
    if(keepFocus){
      // FR-SKF-1: 저장된 사용자 포커스를 그대로 복원. activeSession / focused 모두.
      // FR-SKF-3: 저장된 region 이 사후 layout 에서 사라졌으면 무동작 + 경고.
      if(this.ws.activeSession!==savedSession && this.ws.sessions.some(x=>x.id===savedSession)){
        this.ws.activeSession=savedSession;
      }
      const a=this._as();
      if(a && savedFocused && findRg(a.layout,savedFocused)){
        this._setFocus(savedFocused, a);
      } else if(savedFocused){
        console.warn('[split] keepFocus: savedFocused region gone after split, leaving focus as-is');
      }
    } else {
      if(this.ws.activeSession!==tgtSessionId){
        const cur=this._as(); if(cur) cur.focusedRegion=this.focused;
        this.ws.activeSession=tgtSessionId;
      }
      const next = lastR || tgtRegionId;
      this._setFocus(next, s);
    }
    this.render();
    this._save();
    // REMOTE_COMMAND_RESULT_SRS FR-RCR-7: 생성한 region/tab id 반환 (echo 용).
    return {
      regions: newRegions.map(rg=>rg.id),
      tabs: newRegions.map(rg=>({uuid:rg.tabs[0].id, paneId:rg.tabs[0].paneId})),
    };
  }

  _regionActivePaneId(sess,rid){
    const rg=findRg(sess.layout,rid); if(!rg) return null;
    const tab=rg.tabs.find(t=>t.id===rg.activeTab)||rg.tabs[0];
    return tab?.paneId||null;
  }

  // For new pane creation (split / addTab terminal): if the region's active
  // tab is a markdown viewer, derive cwd from its file path so the new shell
  // opens next to the doc the user is reading. Otherwise inherit the parent
  // terminal's cwd via cwdPane (existing behaviour).
  _regionNewPaneRef(sess,rid){
    const rg=findRg(sess.layout,rid); if(!rg) return {};
    const tab=rg.tabs.find(t=>t.id===rg.activeTab)||rg.tabs[0];
    if(!tab) return {};
    if(tab.type==='markdown' && typeof tab.filePath==='string' && tab.filePath.startsWith('/')){
      const i=tab.filePath.lastIndexOf('/');
      const dir = i>0 ? tab.filePath.substring(0,i) : '/';
      return {cwd: dir};
    }
    if(tab.paneId) return {cwdPane: tab.paneId};
    return {};
  }

  switchSessionNext(){
    const idx=this.ws.sessions.findIndex(s=>s.id===this.ws.activeSession);
    if(idx<0)return; this.switchSession(this.ws.sessions[(idx+1)%this.ws.sessions.length].id);
  }
  switchSessionPrev(){
    const idx=this.ws.sessions.findIndex(s=>s.id===this.ws.activeSession);
    if(idx<0)return; this.switchSession(this.ws.sessions[(idx-1+this.ws.sessions.length)%this.ws.sessions.length].id);
  }
  switchTabNext(){
    const s=this._as();if(!s||!this.focused)return;
    const rg=findRg(s.layout,this.focused);if(!rg)return;
    const i=rg.tabs.findIndex(t=>t.id===rg.activeTab);if(i<0)return;
    this.switchTab(rg.id,rg.tabs[(i+1)%rg.tabs.length].id);
  }
  switchTabPrev(){
    const s=this._as();if(!s||!this.focused)return;
    const rg=findRg(s.layout,this.focused);if(!rg)return;
    const i=rg.tabs.findIndex(t=>t.id===rg.activeTab);if(i<0)return;
    this.switchTab(rg.id,rg.tabs[(i-1+rg.tabs.length)%rg.tabs.length].id);
  }
  paneNavigate(dir){
    const s=this._as();if(!s||!this.focused)return;
    const path=findPath(s.layout,this.focused);if(!path||path.length<2)return;
    for(let i=path.length-2;i>=0;i--){
      const parent=path[i],child=path[i+1];
      if(parent.type!=='split')continue;
      const isH=parent.direction==='horizontal';
      const ci=parent.children.indexOf(child);
      let ti=-1;
      if(dir==='right'&&isH)ti=ci+1; if(dir==='left'&&isH)ti=ci-1;
      if(dir==='down'&&!isH)ti=ci+1; if(dir==='up'&&!isH)ti=ci-1;
      if(ti>=0&&ti<parent.children.length){
        const target=firstRg(parent.children[ti]);
        if(target){this._setFocus(target.id, s);this._save();this.render();return}
      }
    }
  }
  addTabFocused(){if(this.focused)this.addTab(this.focused,'terminal')}
  closeTabFocused(){
    const s=this._as();if(!s||!this.focused)return;
    const rg=findRg(s.layout,this.focused);if(!rg)return;
    this.closeTab(rg.id,rg.activeTab);
  }
  closeSessionActive(){this.delSession(this.ws.activeSession)}

  executeAction(action){
    const map={
      sessionNext:()=>this.switchSessionNext(),sessionPrev:()=>this.switchSessionPrev(),
      tabNext:()=>this.switchTabNext(),tabPrev:()=>this.switchTabPrev(),
      paneUp:()=>this.paneNavigate('up'),paneDown:()=>this.paneNavigate('down'),
      paneLeft:()=>this.paneNavigate('left'),paneRight:()=>this.paneNavigate('right'),
      splitH:()=>this.split('horizontal'),splitV:()=>this.split('vertical'),
      newSession:()=>this.addSession(),newTab:()=>this.addTabFocused(),
      closeSession:()=>this.closeSessionActive(),closeTab:()=>this.closeTabFocused(),
      agentsToggle:()=>this._agentsToggle(),
      toggleSearch:()=>this.toggleSearch(),
    };
    return map[action]?.();
  }

  // ── Search ──
  toggleSearch(){
    const bar=document.getElementById('search-bar');
    if(!bar.classList.contains('hidden')){this.closeSearch();return}
    bar.classList.remove('hidden');
    document.getElementById('search-input').focus();
    for(const pane of this.panes.values())if(pane.el.classList.contains('vis'))pane.doFit();
  }
  closeSearch(){
    const bar=document.getElementById('search-bar');
    bar.classList.add('hidden');
    document.getElementById('search-input').value='';
    document.getElementById('search-count').textContent='';
    this._clearAllSearchDecorations();
    this._focusedTermPane()?.focus();
    for(const pane of this.panes.values())if(pane.el.classList.contains('vis'))pane.doFit();
  }
  _clearAllSearchDecorations(){
    for(const p of this.panes.values())if(p.search)p.search.clearDecorations();
  }
  _searchOpen(){return !document.getElementById('search-bar').classList.contains('hidden')}
  _researchIfOpen(){
    if(!this._searchOpen())return;
    setTimeout(()=>this._doSearch('next'),50);
  }
  _focusedTermPane(){
    if(!this.focused)return null;
    const s=this._as();if(!s)return null;
    const rg=findRg(s.layout,this.focused);if(!rg)return null;
    const tab=rg.tabs.find(t=>t.id===rg.activeTab);
    if(!tab||tab.type!=='terminal')return null;
    return this.panes.get(tab.paneId);
  }
  _focusedTab(){
    if(!this.focused)return null;
    const s=this._as();if(!s)return null;
    const rg=findRg(s.layout,this.focused);if(!rg)return null;
    const tab=rg.tabs.find(t=>t.id===rg.activeTab);
    return tab||null;
  }
  _doSearch(dir){
    const p=this._focusedTermPane();if(!p||!p.search)return;
    const q=document.getElementById('search-input').value;
    const cs=document.getElementById('search-case').classList.contains('active');
    if(!q){document.getElementById('search-count').textContent='';return}
    const accent=getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    const ab=getComputedStyle(document.documentElement).getPropertyValue('--accent-border').trim();
    const danger=getComputedStyle(document.documentElement).getPropertyValue('--danger').trim();
    const opts={regex:false,wholeWord:false,caseSensitive:cs,incremental:true,
      decorations:{matchBackground:hexToRgba(accent,.4),matchBorder:ab,
        activeMatchBackground:hexToRgba(danger,.5),activeMatchBorder:danger}};
    const found=dir==='prev'?p.search.findPrevious(q,opts):p.search.findNext(q,opts);
    document.getElementById('search-count').textContent=found!==undefined?(found?'':'없음'):'';
  }

  setFocus(rid){
    if(this.focused===rid) return;
    this._clearAllSearchDecorations();
    this._setFocus(rid);
    this._prevFocus=rid;
    document.querySelectorAll('.rg').forEach(el=>{
      el.classList.toggle('focused',el.dataset.rid===rid);
    });
    this._researchIfOpen();
    this._updateCwd();
    this._updateStatusBar();
    this._save();
  }

  _save(){
    this._savePending=true;
    if(this._saveChain) return this._saveChain;
    this._saveInflight=true;
    const run=async()=>{
      while(this._savePending){
        this._savePending=false;
        try{
          const headers={'Content-Type':'application/json'};
          if(this.wsETag) headers['If-Match']=this.wsETag;
          const res=await fetch('/api/workspace',{method:'PUT',headers,body:JSON.stringify(this.ws)});
          if(res.status===409){
            try{
              const gr=await fetch('/api/workspace');
              if(gr.ok) this.wsETag=gr.headers.get('ETag')||gr.headers.get('Etag')||null;
            }catch{}
            this._savePending=true;
            continue;
          }
          if(res.ok){
            const et=res.headers.get('ETag')||res.headers.get('Etag');
            if(et) this.wsETag=et;
          }
        }catch{}
      }
      this._saveChain=null;
      this._saveInflight=false;
      // Deferred workspace_changed events from during the save were almost
      // certainly echoes of our own PUT (now reflected in the updated
      // wsETag). Drop them — any genuinely newer external change will land
      // as a future SSE event with rev > our new wsETag and be applied
      // through the normal rev check.
      this._wsApplyPending=false;
    };
    this._saveChain=run();
    return this._saveChain;
  }

  _rename(obj, el){
    const old = obj.name;
    const input = document.createElement('input');
    input.type = 'text'; input.value = old; input.className = 'rename-input';
    el.replaceWith(input); input.focus(); input.select();
    const done = () => {
      const v = input.value.trim();
      if(v && v !== old) { obj.name = v; this._save(); }
      this.render();
    };
    input.addEventListener('blur', done, {once:true});
    input.addEventListener('keydown', e => {
      if(e.key==='Enter'){e.preventDefault();input.blur()}
      if(e.key==='Escape'){input.value=old;input.blur()}
    });
  }

  // ── Render (위임) ──

  render(){ this.renderer.render(); this._agentsRender() }


  _bind(){ this.inputBinding.bind() }

  // ── Mobile bindings ──

  _initMobile(){
    // Topbar mobile buttons
    const prev=document.getElementById('m-pane-prev');
    const next=document.getElementById('m-pane-next');
    const addT=document.getElementById('m-add-tab');
    const srch=document.getElementById('m-search-btn');
    const drwr=document.getElementById('m-drawer-toggle');
    const bd=document.getElementById('drawer-backdrop');
    if(prev) prev.addEventListener('click',()=>this.navMobilePane(-1));
    if(next) next.addEventListener('click',()=>this.navMobilePane(1));
    if(addT) addT.addEventListener('click',()=>{
      const rg=this._mobileCurrentRegion(); if(rg) this.addTab(rg.id);
    });
    if(srch) srch.addEventListener('click',()=>this.toggleSearch&&this.toggleSearch());
    if(drwr) drwr.addEventListener('click',()=>{this._toggleDrawer();this._rTopbar()});
    if(bd) bd.addEventListener('click',()=>{this._toggleDrawer(false);this._rTopbar()});
    // Drawer close button injected into sidebar (visible only on mobile)
    const sb=document.getElementById('sidebar');
    if(sb && !sb.querySelector('.drawer-close')){
      const xb=document.createElement('button');
      xb.className='drawer-close';xb.textContent='✕';xb.title='닫기';
      xb.addEventListener('click',()=>{this._toggleDrawer(false);this._rTopbar()});
      sb.insertBefore(xb, sb.firstChild);
    }
    // Auto-close drawer on session switch (mobile)
    // (handled in switchSession via _drawerOpen check)

    // Display Settings panel sync
    const dsMode=document.getElementById('ds-mode');
    const dsBp=document.getElementById('ds-bp');
    if(dsMode){
      dsMode.value=this.displayMode;
      dsMode.addEventListener('change',()=>{
        this.displayMode=dsMode.value;
        this.render();
      });
    }
    if(dsBp){
      dsBp.value=this.mobileBreakpoint;
      dsBp.addEventListener('change',()=>{
        let v=parseInt(dsBp.value,10);
        if(!(v>=320&&v<=2000)){v=768;dsBp.value=v}
        this.mobileBreakpoint=v;
        this.render();
      });
    }
  }

  _initMobileKeybar(){
    const bar=document.getElementById('mobile-keybar');
    if(!bar) return;
    bar.innerHTML='';
    const keys=[
      {label:'Esc',send:''},
      {label:'Tab',send:'\t'},
      {label:'Ctrl',mod:'ctrl'},
      {label:'Alt',mod:'alt'},
      {label:'↑',send:'[A'},
      {label:'↓',send:'[B'},
      {label:'←',send:'[D'},
      {label:'→',send:'[C'},
      {label:'|',send:'|'},
      {label:'~',send:'~'},
      {label:'/',send:'/'},
      {label:'-',send:'-'},
      {label:'Home',send:'[H'},
      {label:'End',send:'[F'},
      {label:'PgUp',send:'[5~'},
      {label:'PgDn',send:'[6~'},
    ];
    const FULL_NAMES={
      'Esc':'Escape','Tab':'Tab','Ctrl':'Control (modifier)','Alt':'Alt (modifier)',
      '↑':'Arrow Up','↓':'Arrow Down','←':'Arrow Left','→':'Arrow Right',
      '|':'Pipe','~':'Tilde','/':'Slash','-':'Hyphen',
      'Home':'Home','End':'End','PgUp':'Page Up','PgDn':'Page Down',
    };
    this._modKbd={ctrl:false,alt:false};
    const refresh=()=>{
      bar.querySelectorAll('.mkb-btn[data-mod]').forEach(b=>{
        const m=b.dataset.mod, st=this._modKbd[m];
        b.classList.toggle('sticky', st===true);
        b.classList.toggle('locked', st==='lock');
      });
    };
    const sendToFocused=(s)=>{
      const p=this._focusedTermPane();
      if(!p) return;
      let out=s;
      // Ctrl modifier: convert printable a-z/A-Z to ctrl code (1-26)
      if(this._modKbd.ctrl && s.length===1){
        const c=s.charCodeAt(0);
        if(c>=0x40 && c<=0x7e) out=String.fromCharCode(c & 0x1f);
      }
      // Alt prefix: ESC + char
      if(this._modKbd.alt && out.length>=1 && !out.startsWith('')){
        out=''+out;
      }
      try{p.term.focus();}catch{}
      try{
        const bts=enc.encode(out);
        const msg=new Uint8Array(1+bts.length);msg[0]=OP.INPUT;msg.set(bts,1);
        p._send(msg);
      }catch{}
      // Clear sticky (not lock)
      if(this._modKbd.ctrl===true) this._modKbd.ctrl=false;
      if(this._modKbd.alt===true) this._modKbd.alt=false;
      refresh();
    };
    const showTip=(text, btn)=>{
      let tip=document.getElementById('mkb-tip');
      if(!tip){tip=document.createElement('div');tip.id='mkb-tip';document.body.appendChild(tip)}
      tip.textContent=text;
      const r=btn.getBoundingClientRect();
      tip.style.left=(r.left+r.width/2)+'px';
      tip.style.top=(r.top-8)+'px';
    };
    const hideTip=()=>{const t=document.getElementById('mkb-tip');if(t)t.remove()};
    for(const k of keys){
      const b=document.createElement('button');
      b.className='mkb-btn';b.textContent=k.label;b.type='button';
      const full=FULL_NAMES[k.label]||k.label;
      b.title=full;b.setAttribute('aria-label',full);
      if(k.mod){b.dataset.mod=k.mod}
      // prevent focus theft from xterm
      b.addEventListener('mousedown',e=>e.preventDefault());
      let lastTap=0;
      let pressTimer=null;
      let longPressFired=false;
      b.addEventListener('touchstart',e=>{
        e.preventDefault();
        longPressFired=false;
        pressTimer=setTimeout(()=>{longPressFired=true;showTip(full,b)},600);
      },{passive:false});
      const cancelPress=()=>{
        if(pressTimer){clearTimeout(pressTimer);pressTimer=null}
      };
      b.addEventListener('touchmove',()=>{cancelPress();hideTip();longPressFired=false});
      b.addEventListener('touchcancel',()=>{cancelPress();hideTip();longPressFired=false});
      b.addEventListener('touchend',e=>{
        cancelPress();
        if(longPressFired){e.preventDefault();hideTip();return}
      });
      b.addEventListener('click',e=>{
        e.preventDefault();
        if(longPressFired){longPressFired=false;return}
        if(k.mod){
          const now=Date.now();
          const dbl=(now-lastTap)<350;
          lastTap=now;
          const cur=this._modKbd[k.mod];
          if(dbl){this._modKbd[k.mod]=(cur==='lock')?false:'lock'}
          else{this._modKbd[k.mod]=cur?false:true}
          refresh();
        }else{
          sendToFocused(k.send);
        }
      });
      bar.appendChild(b);
    }
    // visualViewport tracking — keyboard up/down detection
    if(window.visualViewport){
      const vv=window.visualViewport;
      const kbH_PX=()=>{
        const v=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--m-kb-h'));
        return isFinite(v)?v:38;
      };
      const apply=()=>{
        if(!this.isMobile){
          document.body.classList.remove('keyboard-up');
          document.body.style.paddingBottom='';
          bar.style.bottom='';
          return;
        }
        const kbH=Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
        const isUp=kbH > 80;
        document.body.classList.toggle('keyboard-up', isUp);
        if(isUp){
          bar.style.bottom = kbH + 'px';
          document.body.style.paddingBottom = (kbH + kbH_PX()) + 'px';
        }else{
          bar.style.bottom = '';
          document.body.style.paddingBottom = '';
        }
        // Refit terminal
        for(const p of this.panes.values()){if(p.el.classList.contains('vis'))p.doFit()}
      };
      vv.addEventListener('resize', apply);
      vv.addEventListener('scroll', apply);
      apply();
    }
  }


  async _saveSettings(){
    try{await fetch('/api/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({themeName:customTheme?null:currentThemeName,customTheme,shortcuts,statusBar,statsInterval,layoutPresets,defaultPreset})})}catch{}
  }

  // ── Modal & Theme ──

  _initModal(){
    const overlay=document.getElementById('modal-overlay');
    const modal=document.getElementById('modal');
    document.getElementById('settings-btn').addEventListener('click',()=>{
      overlay.classList.add('open');
      this._renderThemePanel();this._renderShortcutList();this._renderPresets();
      const dsMode=document.getElementById('ds-mode');
      const dsBp=document.getElementById('ds-bp');
      if(dsMode) dsMode.value=this.displayMode;
      if(dsBp) dsBp.value=this.mobileBreakpoint;
      // Auto-close drawer when opening settings on mobile
      if(this.isMobile && this._drawerOpen){this._toggleDrawer(false);this._rTopbar()}
    });
    document.getElementById('modal-close').addEventListener('click',()=>overlay.classList.remove('open'));
    overlay.addEventListener('click',e=>{if(e.target===overlay)overlay.classList.remove('open')});
    document.addEventListener('keydown',e=>{if(e.key==='Escape'&&overlay.classList.contains('open')){e.preventDefault();overlay.classList.remove('open')}});
    modal.querySelectorAll('.mtab').forEach(tab=>{
      tab.addEventListener('click',()=>{
        modal.querySelectorAll('.mtab').forEach(t=>t.classList.remove('active'));
        tab.classList.add('active');
        modal.querySelectorAll('.mpanel').forEach(p=>p.style.display='none');
        document.getElementById('panel-'+tab.dataset.tab).style.display='';
        if(tab.dataset.tab==='presets')this._renderPresets();
      });
    });
  }

  _renderThemePanel(){
    const list=document.getElementById('theme-list'); list.innerHTML='';
    const activeName=customTheme?null:currentThemeName;
    const groups={dark:[],light:[]};
    for(const name of Object.keys(THEMES)){
      const t=THEMES[name];
      (t.mode==='light'?groups.light:groups.dark).push(name);
    }
    const renderGroup=(label,names)=>{
      if(!names.length) return;
      const hdr=document.createElement('div');
      hdr.className='tl-section'; hdr.textContent=label;
      list.appendChild(hdr);
      for(const name of names){
        const t=THEMES[name];
        const item=document.createElement('div');
        item.className='tl-item'+(name===activeName?' active':'');
        const keys=['bg','accent','text','border','danger'];
        let dots='<div class="tl-dots">';
        for(const k of keys){const v=t.ui[k];dots+=`<span style="background:${v}"></span>`}
        dots+='</div>';
        item.innerHTML=`${dots}<span class="tl-name">${name}</span>`;
        item.addEventListener('click',()=>{
          currentThemeName=name; customTheme=null;
          applyThemeObj(t); this._renderThemePanel(); this._hideCustomEditor();
          this._saveSettings();
        });
        list.appendChild(item);
      }
    };
    renderGroup('Dark', groups.dark);
    renderGroup('Light', groups.light);
    this._renderPreview();
  }

  _renderPreview(){
    const t=getCurrentTheme();
    const u=t.ui, tr=t.terminal;
    const ah=hexToRgba(u.accent,.08);
    const c=tr; // shorthand
    document.getElementById('theme-preview').innerHTML=`
    <div style="display:flex;height:100%">
      <div class="pv-sidebar" style="background:${u.sidebarBg};border-right:1px solid ${u.border}">
        <div style="font-size:6px;color:${u.textMuted};padding:4px 2px;letter-spacing:.05em">SESSIONS</div>
        <div style="display:flex;align-items:center;gap:3px;padding:2px 4px">
          <div class="pv-dot" style="background:${u.accent}"></div>
          <span style="font-size:7px;color:${u.textBright}">Main</span>
          <span style="font-size:7px;color:${u.danger};margin-left:auto">×</span>
        </div>
        <div style="display:flex;align-items:center;gap:3px;padding:2px 4px;background:${ah}">
          <div class="pv-dot" style="background:${u.accent}"></div>
          <span style="font-size:7px;color:${u.textBright};font-weight:600">Work</span>
          <span style="font-size:7px;color:${u.danger};margin-left:auto">×</span>
        </div>
        <div style="display:flex;align-items:center;gap:3px;padding:2px 4px">
          <div class="pv-dot" style="background:${u.textDim}"></div>
          <span style="font-size:7px;color:${u.text}">Test</span>
          <span style="font-size:7px;color:${u.danger};margin-left:auto;opacity:.4">×</span>
        </div>
      </div>
      <div class="pv-main" style="background:${u.bg}">
        <div class="pv-topbar" style="background:${u.sidebarBg};border-bottom:1px solid ${u.border}">
          <span style="color:${u.text}">Work</span>
          <span style="flex:1"></span>
          <span style="color:${u.textMuted};font-size:7px;border:1px solid ${u.accentBorder};border-radius:2px;padding:0 3px">Split H</span>
          <span style="color:${u.accent};font-size:7px;border:1px solid ${u.accentBorder};border-radius:2px;padding:0 3px">Split V</span>
        </div>
        <div class="pv-split">
          <div class="pv-split-left" style="border:2px solid ${u.accent}">
            <div class="pv-tabs" style="background:${u.sidebarBg};border-bottom:1px solid ${u.border}">
              <div class="pv-tab" style="color:${u.textMuted};border-right:1px solid ${u.border}">Shell <span style="color:${u.danger}">×</span></div>
              <div class="pv-tab" style="color:${u.textBright};background:${ah};border-bottom:1px solid ${u.accent}">vim <span style="color:${u.danger}">×</span></div>
            </div>
            <div class="pv-term" style="background:${c.background};color:${c.foreground}">
              <span style="color:${c.green}">$</span> <span style="color:${c.cyan}">echo</span> <span style="color:${c.yellow}">"palette"</span><br>
              <span style="background:${c.selectionBackground};color:${c.selectionForeground}">selected text here █</span><br>
              <span style="color:${c.red}">● Red</span> <span style="color:${c.green}">● Grn</span> <span style="color:${c.yellow}">● Ylw</span> <span style="color:${c.blue}">● Blu</span><br>
              <span style="color:${c.magenta}">● Mag</span> <span style="color:${c.cyan}">● Cyn</span> <span style="color:${c.white}">● Wht</span> <span style="color:${c.brightBlack}">● Bk</span><br>
              <span style="color:${c.brightRed}">● BR</span> <span style="color:${c.brightGreen}">● BG</span> <span style="color:${c.brightYellow}">● BY</span> <span style="color:${c.brightBlue}">● BB</span><br>
              <span style="color:${c.brightMagenta}">● BM</span> <span style="color:${c.brightCyan}">● BC</span> <span style="color:${c.brightWhite}">● BW</span> <span style="color:${c.black}">● Bk</span>
            </div>
          </div>
          <div style="width:3px;background:${u.border}"></div>
          <div class="pv-split-right" style="border:1px solid ${u.border}">
            <div class="pv-tabs" style="background:${u.sidebarBg};border-bottom:1px solid ${u.border}">
              <div class="pv-tab" style="color:${u.textBright};background:${ah};border-bottom:1px solid ${u.accent}">htop <span style="color:${u.danger}">×</span></div>
              <div class="pv-tab" style="color:${u.textMuted};border-left:1px solid ${u.border}">Shell <span style="color:${u.danger}">×</span></div>
            </div>
            <div class="pv-term" style="background:${c.background};color:${c.foreground}">
              <span style="color:${c.cyan}">PID</span> <span style="color:${c.green}">CPU</span> <span style="color:${c.yellow}">MEM</span> <span style="color:${c.blue}">CMD</span><br>
              <span style="color:${c.foreground}"> 1  </span><span style="color:${c.green}">  2% </span><span style="color:${c.yellow}">  1% </span><span style="color:${c.foreground}">bash</span><br>
              <span style="color:${c.foreground}"> 42 </span><span style="color:${c.red}"> 99% </span><span style="color:${c.red}"> 45% </span><span style="color:${c.foreground}">node</span><br>
              <br>
              <span style="color:${c.foreground}">cursor: </span><span style="background:${c.cursor};color:${c.cursorAccent}"> █ </span>
            </div>
          </div>
        </div>
        <div class="pv-status" style="background:${u.sidebarBg};border-top:1px solid ${u.border}">
          <span style="color:${u.accent}">●</span>
          <span style="color:${u.textMuted};margin-left:4px">2 sessions · 3 panes</span>
          <span style="margin-left:auto;color:${u.danger};font-size:7px">ERR</span>
          <span style="margin-left:4px;color:${u.text};font-size:7px">OK</span>
        </div>
      </div>
    </div>`;
  }

  _hideCustomEditor(){
    document.getElementById('custom-editor').style.display='none';
    document.getElementById('custom-toggle').classList.remove('active');
  }

  _showCustomEditor(){
    const base=getCurrentTheme();
    customTheme=JSON.parse(JSON.stringify(base));
    document.getElementById('custom-toggle').classList.add('active');
    document.getElementById('custom-editor').style.display='';
    // UI colors
    const uiDiv=document.getElementById('ce-ui'); uiDiv.innerHTML='';
    for(const [key,label] of Object.entries(UI_LABELS)){
      uiDiv.appendChild(this._colorInput(key,label,customTheme.ui));
    }
    // Terminal colors
    const termDiv=document.getElementById('ce-terminal'); termDiv.innerHTML='';
    for(const [key,label] of Object.entries(TERM_LABELS)){
      termDiv.appendChild(this._colorInput(key,label,customTheme.terminal));
    }
  }

  _colorInput(key,label,obj){
    const item=document.createElement('div'); item.className='ce-item';
    const lbl=document.createElement('label'); lbl.textContent=label;
    const inp=document.createElement('input'); inp.type='color'; inp.value=obj[key]||'#000000';
    inp.addEventListener('input',()=>{
      obj[key]=inp.value;
      applyThemeObj(customTheme);
      this._renderPreview();
      this._saveSettings();
    });
    item.appendChild(lbl); item.appendChild(inp);
    return item;
  }

  _renderShortcutList(){
    const el=document.getElementById('sc-list');if(!el)return;
    el.innerHTML='';
    const groups=[
      {label:'세션',keys:['sessionNext','sessionPrev','newSession','closeSession']},
      {label:'탭',keys:['tabNext','tabPrev','newTab','closeTab']},
      {label:'Pane',keys:['paneUp','paneDown','paneLeft','paneRight']},
      {label:'분할',keys:['splitH','splitV']},
      {label:'에이전트',keys:['agentsToggle']},
    ];
    for(const g of groups){
      const title=document.createElement('div');title.className='sc-group-title';title.textContent=g.label;
      el.appendChild(title);
      for(const k of g.keys){
        const row=document.createElement('div');row.className='sc-row';
        const label=document.createElement('span');label.textContent=SHORTCUT_LABELS[k];
        const btn=document.createElement('button');btn.className='sc-key';btn.dataset.action=k;
        btn.textContent=displayKey(shortcuts[k]||'');
        // Click → record mode
        btn.addEventListener('click',()=>{
          this._cancelRecording();
          this._recording=k;btn.textContent='키를 누르세요...';btn.classList.add('recording');
        });
        const rst=document.createElement('button');rst.className='sc-rst';rst.textContent='↺';rst.title='초기화';
        rst.addEventListener('click',()=>{shortcuts[k]=SHORTCUT_DEFAULTS[k];this._saveSettings();btn.textContent=displayKey(shortcuts[k])});
        row.appendChild(label);
        const btns=document.createElement('div');btns.className='sc-btns';
        btns.appendChild(btn);btns.appendChild(rst);
        row.appendChild(btns);
        el.appendChild(row);
      }
    }
  }
  _cancelRecording(){
    if(!this._recording)return;
    const btn=document.querySelector('.sc-key.recording');
    if(btn){btn.classList.remove('recording');btn.textContent=displayKey(shortcuts[btn.dataset.action]||'')}
    this._recording=null;
  }

  // ── Status Bar ──
  _initStatusBar(){
    this._stats={};this._latency=null;
    this._startStatsPoll();
    this._renderStatusBarSettings();
  }
  _startStatsPoll(){
    if(this._statsInterval)clearInterval(this._statsInterval);
    this._statsInterval=setInterval(()=>this._pollStats(),statsInterval);
    this._pollStats();
  }
  async _pollStats(){
    // Measure real network latency with lightweight ping
    try{
      const t0=performance.now();
      await fetch('/api/ping');
      this._latency=Math.round(performance.now()-t0);
    }catch{this._latency=null}
    // Fetch stats separately (may be slow due to `top` command)
    try{
      const r=await fetch('/api/stats');
      this._stats=await r.json();
    }catch{}
    this._updateStatusBar();
  }
  _updateStatusBar(){
    const bar=document.getElementById('status-bar');if(!bar)return;
    const items=[];
    if(statusBar.connection){
      const ok=this._latency!==null;
      items.push(`<span class="sb-item"><span class="sb-dot ${ok?'ok':'err'}"></span>${ok?'연결됨':'끊김'}</span>`);
    }
    if(statusBar.latency&&this._latency!==null){
      items.push(`<span class="sb-item">${this._latency}ms</span>`);
    }
    if(statusBar.location){
      const loc=this._locationLabel();
      if(loc)items.push(`<span class="sb-item" title="MCP id: ${loc}">📍 ${loc}</span>`);
    }
    if(statusBar.cwd){
      const cwd=this._cwd||'~';
      // Show ~/.../last3dirs
      let short=cwd.replace(/^\/Users\/[^/]+/,'~');
      const parts=short.split('/');
      if(parts.length>4)short='~/.../'+parts.slice(-3).join('/');
      items.push(`<span class="sb-item">📁 ${short}</span>`);
    }
    if(statusBar.hostname&&this._stats.hostname){
      items.push(`<span class="sb-item">💻 ${this._stats.hostname}</span>`);
    }
    if(statusBar.cpu&&this._stats.cpu!==undefined){
      items.push(`<span class="sb-item">CPU ${this._stats.cpu}%</span>`);
    }
    if(statusBar.memory&&this._stats.memTotal){
      const used=this._fmtBytes(this._stats.memUsed);
      const total=this._fmtBytes(this._stats.memTotal);
      items.push(`<span class="sb-item">MEM ${used}/${total}</span>`);
    }
    if(statusBar.disk&&this._stats.diskPct){
      items.push(`<span class="sb-item">DISK ${this._stats.diskPct}%</span>`);
    }
    if(statusBar.termsize){
      const p=this._focusedTermPane();
      if(p&&p.term){
        items.push(`<span class="sb-item">${p.term.cols}×${p.term.rows}</span>`);
      }
    }
    if(statusBar.uptime){
      const parts=[];
      if(this._stats.sysUptime)parts.push('시스템 '+this._stats.sysUptime);
      if(this._stats.srvUptime)parts.push('서버 '+this._stats.srvUptime);
      if(parts.length)items.push(`<span class="sb-item">↑ ${parts.join(' │ ')}</span>`);
    }
    bar.innerHTML=items.join('')||'';
  }
  _fmtBytes(b){
    if(b<1073741824)return(b/1048576).toFixed(1)+'MB';
    return(b/1073741824).toFixed(1)+'GB';
  }
  _locationLabel(){
    const s=this._as();if(!s||!s.layout||!this.focused)return null;
    const sidx=this.ws.sessions.findIndex(x=>x.id===this.ws.activeSession);
    if(sidx<0)return null;
    const regions=[];
    const walk=n=>{
      if(!n)return;
      if(n.type==='region')regions.push(n);
      else if(n.type==='split')for(const c of(n.children||[]))walk(c);
    };
    walk(s.layout);
    const pidx=regions.findIndex(r=>r.id===this.focused);
    if(pidx<0)return null;
    const rg=regions[pidx];
    const tidx=rg.tabs.findIndex(t=>t.id===rg.activeTab);
    if(tidx<0)return null;
    return `S${sidx+1}.P${pidx+1}.T${tidx+1}`;
  }
  _updateCwd(){
    const p=this._focusedTermPane();if(!p)return;
    fetch('/api/cwd?pane='+p.id).then(r=>r.json()).then(({cwd})=>{this._cwd=cwd;this._updateStatusBar()}).catch(()=>{});
  }
  _renderStatusBarSettings(){
    const el=document.getElementById('sb-settings');if(!el)return;
    el.innerHTML='';
    // Interval selector
    const iRow=document.createElement('div');iRow.className='sbs-row';
    const iLabel=document.createElement('span');iLabel.textContent='갱신 주기';
    const iSel=document.createElement('select');iSel.className='sbs-select';
    [{v:1000,t:'1초'},{v:2000,t:'2초'},{v:3000,t:'3초'},{v:5000,t:'5초'},{v:10000,t:'10초'},{v:30000,t:'30초'}].forEach(o=>{
      const opt=document.createElement('option');opt.value=o.v;opt.textContent=o.t;
      if(String(statsInterval)===String(o.v))opt.selected=true;
      iSel.appendChild(opt);
    });
    iSel.addEventListener('change',()=>{statsInterval=parseInt(iSel.value);this._saveSettings();this._startStatsPoll()});
    iRow.appendChild(iLabel);iRow.appendChild(iSel);
    el.appendChild(iRow);
    // Item toggles
    for(const[k,v]of Object.entries(STATUS_ITEMS)){
      const row=document.createElement('div');row.className='sbs-row';
      const label=document.createElement('span');label.textContent=v.label;
      const toggle=document.createElement('label');
      const inp=document.createElement('input');inp.type='checkbox';inp.checked=!!statusBar[k];
      const slider=document.createElement('span');slider.className='slider';
      inp.addEventListener('change',()=>{statusBar[k]=inp.checked;this._saveSettings();this._updateStatusBar()});
      toggle.appendChild(inp);toggle.appendChild(slider);
      row.appendChild(label);row.appendChild(toggle);
      el.appendChild(row);
    }
  }

  // ── Layout Presets ──
  _initPresets(){
    document.getElementById('preset-save').addEventListener('click',()=>this._savePreset());
    this._renderPresets();
  }
  _savePreset(){
    const s=this._as();if(!s)return;
    // Strip layout to just structure (remove paneIds, keep tab counts)
    const strip=n=>{
      if(!n)return null;
      if(n.type==='region')return{type:'region',tabCount:n.tabs?n.tabs.length:1};
      if(n.type==='split')return{type:'split',direction:n.direction,children:n.children.map(strip),sizes:n.sizes?[...n.sizes]:null};
      return null;
    };
    const layout=strip(s.layout);
    const name='프리셋 '+(layoutPresets.length+1);
    layoutPresets.push({name,layout});
    this._saveSettings();
    this._renderPresets();
  }
  async _loadPreset(idx){
    const preset=layoutPresets[idx];if(!preset)return;
    // Create new session with preset layout
    await this._mkSession();
    const s=this._as();if(!s)return;
    // Build layout from preset, creating panes as needed
    const build=async(tpl)=>{
      if(!tpl)return null;
      if(tpl.type==='region'){
        const tabs=[];
        for(let i=0;i<tpl.tabCount;i++){
          const p=await this._newPane();
          tabs.push({id:`t${++this._t}`,name:'Shell',type:'terminal',paneId:p.id});
        }
        const rid=`r${++this._r}`;
        return{type:'region',id:rid,tabs,activeTab:tabs[0].id};
      }
      if(tpl.type==='split'){
        const children=[];
        for(const c of tpl.children){
          const built=await build(c);
          if(built)children.push(built);
        }
        return{type:'split',direction:tpl.direction,children,sizes:tpl.sizes?[...tpl.sizes]:null};
      }
      return null;
    };
    s.layout=await build(preset.layout);
    this._setFocus(firstRg(s.layout)?.id||null, s);
    await this._save();this.render();
  }
  _deletePreset(idx){
    layoutPresets.splice(idx,1);
    if(defaultPreset===idx)defaultPreset=-1;
    else if(defaultPreset>idx)defaultPreset--;
    this._saveSettings();
    this._renderPresets();
  }
  _renamePreset(idx){
    const item=document.querySelector(`.preset-item[data-idx="${idx}"] .preset-name`);
    if(!item)return;
    const inp=document.createElement('input');inp.className='preset-rename-input';
    inp.value=layoutPresets[idx].name;inp.style.cssText='background:var(--bg);border:1px solid var(--accent);border-radius:3px;padding:2px 6px;color:var(--text);font-size:12px;width:100%;outline:none';
    item.replaceWith(inp);inp.focus();inp.select();
    const save=()=>{
      layoutPresets[idx].name=inp.value.trim()||layoutPresets[idx].name;
      this._saveSettings();this._renderPresets();
    };
    inp.addEventListener('blur',save);
    inp.addEventListener('keydown',e=>{if(e.key==='Enter')save();if(e.key==='Escape'){inp.value=layoutPresets[idx].name;save()}e.stopPropagation()});
  }
  _describeLayout(layout){
    if(!layout)return'';
    if(layout.type==='region')return`탭 ${layout.tabCount}개`;
    if(layout.type==='split'){
      const dir=layout.direction==='horizontal'?'가로':'세로';
      const descs=layout.children.map(c=>this._describeLayout(c)).filter(Boolean);
      return`${dir} 분할 [${descs.join(', ')}]`;
    }
    return'';
  }
  _renderPresets(){
    const el=document.getElementById('preset-list');if(!el)return;
    el.innerHTML='';
    // Update sidebar preset button visibility
    const pbtn=document.getElementById('add-preset');
    if(pbtn)pbtn.style.display=defaultPreset>=0&&layoutPresets[defaultPreset]?'':'none';
    if(!layoutPresets.length){
      el.innerHTML='<div style="color:var(--text-dim);font-size:12px;text-align:center;padding:20px">저장된 프리셋이 없습니다</div>';
      return;
    }
    layoutPresets.forEach((p,i)=>{
      const item=document.createElement('div');item.className='preset-item';item.dataset.idx=i;
      if(i===defaultPreset)item.style.borderColor='var(--accent)';
      const info=document.createElement('div');info.className='preset-info';
      const name=document.createElement('div');name.className='preset-name';name.textContent=p.name;
      name.addEventListener('dblclick',e=>{e.stopPropagation();this._renamePreset(i)});
      const desc=document.createElement('div');desc.className='preset-desc';desc.textContent=this._describeLayout(p.layout);
      info.appendChild(name);info.appendChild(desc);
      item.appendChild(info);
      // Star (default) button
      const star=document.createElement('button');star.className='preset-btn';
      star.textContent=i===defaultPreset?'★':'☆';star.title='기본 프리셋으로 설정';
      star.addEventListener('click',e=>{e.stopPropagation();defaultPreset=defaultPreset===i?-1:i;this._saveSettings();this._renderPresets()});
      item.appendChild(star);
      // Load button
      const load=document.createElement('button');load.className='preset-btn';load.textContent='▶';load.title='불러오기';
      load.addEventListener('click',e=>{e.stopPropagation();this._loadPreset(i)});
      item.appendChild(load);
      // Delete button
      const del=document.createElement('button');del.className='preset-btn del';del.textContent='✕';del.title='삭제';
      del.addEventListener('click',e=>{e.stopPropagation();this._deletePreset(i)});
      item.appendChild(del);
      el.appendChild(item);
    });
  }

  // ── Drag helpers ──
  _getDragZone(el,e){const rect=el.getBoundingClientRect();const x=e.clientX-rect.left;const y=e.clientY-rect.top;const w=rect.width,h=rect.height;if(x/w<0.25)return'left';if(x/w>0.75)return'right';if(y/h<0.25)return'top';if(y/h>0.75)return'bottom';return'center'}
  _showBodyDropIndicator(bodyEl,zone){let ind=bodyEl.querySelector('.rg-drop-indicator');if(!ind){ind=document.createElement('div');ind.className='rg-drop-indicator';bodyEl.appendChild(ind)}ind.dataset.zone=zone;ind.style.display=''}
  _clearBodyDropIndicator(bodyEl){const ind=bodyEl?.querySelector('.rg-drop-indicator');if(ind)ind.style.display='none'}

  _moveTabToRegion(srcRid,tabId,dstRid,beforeTabId,insertBefore){
    const s=this._as();if(!s)return;
    const srcRg=findRg(s.layout,srcRid);const dstRg=findRg(s.layout,dstRid);
    if(!srcRg||!dstRg)return;
    const ti=srcRg.tabs.findIndex(t=>t.id===tabId);if(ti<0)return;
    const[tab]=srcRg.tabs.splice(ti,1);
    if(srcRg.tabs.length===0){s.layout=doRemove(s.layout,srcRid);if(this.focused===srcRid)this._setFocus(dstRid, s)}
    else if(srcRg.activeTab===tabId)srcRg.activeTab=srcRg.tabs[0].id;
    const dst=findRg(s.layout,dstRid);if(!dst)return;
    if(beforeTabId){let ins=dst.tabs.findIndex(t=>t.id===beforeTabId);if(ins<0)ins=dst.tabs.length;else if(!insertBefore)ins++;dst.tabs.splice(ins,0,tab)}
    else dst.tabs.push(tab);
    dst.activeTab=tab.id;this._setFocus(dstRid, s);
    if(!s.layout){this._mkSession();return}
    this._save();this.render();
  }

  _splitRegionWithTab(srcRid,tabId,targetRid,zone){
    const s=this._as();if(!s)return;
    const srcRg=findRg(s.layout,srcRid);if(!srcRg)return;
    if(srcRid===targetRid&&srcRg.tabs.length<=1)return;
    const ti=srcRg.tabs.findIndex(t=>t.id===tabId);if(ti<0)return;
    const[tab]=srcRg.tabs.splice(ti,1);
    if(srcRg.tabs.length===0)s.layout=doRemove(s.layout,srcRid);
    else if(srcRg.activeTab===tabId)srcRg.activeTab=srcRg.tabs[0].id;
    const newRid=`r${++this._r}`;
    const newRg={type:'region',id:newRid,tabs:[tab],activeTab:tab.id};
    const dir=(zone==='left'||zone==='right')?'horizontal':'vertical';
    const before=zone==='left'||zone==='top';
    const splitNode=n=>{
      if(!n)return null;
      if(n.type==='region'&&n.id===targetRid)return{type:'split',direction:dir,children:before?[newRg,n]:[n,newRg]};
      if(n.type==='split'){n.children=n.children.map(splitNode).filter(Boolean);if(!n.children.length)return null;if(n.children.length===1)return n.children[0]}
      return n;
    };
    s.layout=splitNode(s.layout);
    if(!s.layout){this._mkSession();return}
    this._setFocus(newRid, s);this._save();this.render();
  }
}

const app=new App();
window.app=app;
window.__dongminalDebug={
  sendDropCount(){let n=0;app.panes&&app.panes.forEach(p=>{n+=p._sendDropCount||0});return n},
  sendQueueLength(){let n=0;app.panes&&app.panes.forEach(p=>{n+=(p._sendQueue&&p._sendQueue.length)||0});return n}
};

// Restore saved theme from server
(async()=>{try{const r=await fetch('/api/settings');if(r.ok){const saved=await r.json();
  if(saved.shortcuts) Object.assign(shortcuts,saved.shortcuts);
  if(saved.statusBar) Object.assign(statusBar,saved.statusBar);
  if(saved.statsInterval) statsInterval=saved.statsInterval;
  if(saved.layoutPresets) layoutPresets=saved.layoutPresets;
  if(saved.defaultPreset!==undefined) defaultPreset=saved.defaultPreset;
  if(saved.customTheme){customTheme=saved.customTheme;applyThemeObj(customTheme)}
  else if(saved.themeName&&THEMES[saved.themeName]){currentThemeName=saved.themeName;applyThemeObj(THEMES[currentThemeName])}
}}catch{}})();

app.init();
if(!(defaultPreset>=0&&layoutPresets[defaultPreset]))document.getElementById('add-preset').style.display='none';
document.getElementById('add-session').addEventListener('click',()=>app.addSession());
document.getElementById('add-preset').addEventListener('click',()=>{
  if(defaultPreset>=0&&layoutPresets[defaultPreset]) app._loadPreset(defaultPreset);
  else app.addSession();
});

// Custom toggle handler
document.getElementById('custom-toggle').addEventListener('click',()=>{
  const editor=document.getElementById('custom-editor');
  if(editor.style.display==='none'){app._showCustomEditor()}
  else{app._hideCustomEditor()}
});

window.addEventListener('resize',()=>{
  const wasMobile=document.body.classList.contains('mobile');
  const nowMobile=app.isMobile;
  if(wasMobile!==nowMobile){app.render()}
  else{for(const p of app.panes.values())if(p.el.classList.contains('vis'))p.doFit()}
});
window.addEventListener('beforeunload',e=>{if(app.panes.size>0)e.preventDefault()});
