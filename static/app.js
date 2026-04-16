/**
 * Remote Terminal — cmux style
 * Session → LayoutTree(Region|Split), Region has own tab bar + terminal
 */

const OP={INPUT:0,RESIZE:1,OUTPUT:0,ERROR:1,EXIT:2,SID:3};
const enc=new TextEncoder(), dec=new TextDecoder();

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
};
const SHORTCUT_LABELS={
  sessionNext:'다음 세션',sessionPrev:'이전 세션',
  tabNext:'다음 탭',tabPrev:'이전 탭',
  paneUp:'Pane ↑',paneDown:'Pane ↓',paneLeft:'Pane ←',paneRight:'Pane →',
  splitH:'가로 분할',splitV:'세로 분할',
  newSession:'새 세션',newTab:'새 탭',
  closeSession:'세션 닫기',closeTab:'탭 닫기',
};
let shortcuts={...SHORTCUT_DEFAULTS};

const MOD_CODES=new Set(['ControlLeft','ControlRight','AltLeft','AltRight','MetaLeft','MetaRight','ShiftLeft','ShiftRight']);
function parseShortcut(s){const p=s.split('+');const k=p.pop();return{ctrl:p.includes('Ctrl'),alt:p.includes('Alt'),meta:p.includes('Meta'),shift:p.includes('Shift'),code:k}}
function matchShortcut(e,s){if(!s)return false;const p=parseShortcut(s);return e.ctrlKey===p.ctrl&&e.altKey===p.alt&&e.metaKey===p.meta&&e.shiftKey===p.shift&&e.code===p.code}
function fmtShortcut(e){const p=[];if(e.ctrlKey)p.push('Ctrl');if(e.altKey)p.push('Alt');if(e.metaKey)p.push('Meta');if(e.shiftKey)p.push('Shift');p.push(e.code);return p.join('+')}
function displayKey(s){return s.replace(/Key/g,'').replace(/BracketLeft/g,'[').replace(/BracketRight/g,']').replace(/Meta/g,'⌘').replace(/Ctrl/g,'⌃').replace(/Alt/g,'⌥').replace(/Shift/g,'⇧').replace(/Arrow/g,'')}

const THEMES={
  'Tokyo Night':{
    ui:{bg:'#1a1b26',sidebarBg:'#16161e',border:'#292e42',accent:'#7aa2f7',text:'#a9b1d6',textMuted:'#565f89',textBright:'#c0caf5',textDim:'#414868',danger:'#f7768e',accentBorder:'#3d59a1'},
    terminal:{background:'#1a1b26',foreground:'#a9b1d6',cursor:'#c0caf5',cursorAccent:'#1a1b26',selectionBackground:'#33467c',selectionForeground:'#c0caf5',black:'#15161e',red:'#f7768e',green:'#9ece6a',yellow:'#e0af68',blue:'#7aa2f7',magenta:'#bb9af7',cyan:'#7dcfff',white:'#a9b1d6',brightBlack:'#414868',brightRed:'#f7768e',brightGreen:'#9ece6a',brightYellow:'#e0af68',brightBlue:'#7aa2f7',brightMagenta:'#bb9af7',brightCyan:'#7dcfff',brightWhite:'#c0caf5'},
  },
  'Dracula':{
    ui:{bg:'#282a36',sidebarBg:'#21222c',border:'#44475a',accent:'#bd93f9',text:'#f8f8f2',textMuted:'#6272a4',textBright:'#f8f8f2',textDim:'#44475a',danger:'#ff5555',accentBorder:'#6272a4'},
    terminal:{background:'#282a36',foreground:'#f8f8f2',cursor:'#f8f8f2',cursorAccent:'#282a36',selectionBackground:'#44475a',selectionForeground:'#f8f8f2',black:'#21222c',red:'#ff5555',green:'#50fa7b',yellow:'#f1fa8c',blue:'#bd93f9',magenta:'#ff79c6',cyan:'#8be9fd',white:'#f8f8f2',brightBlack:'#6272a4',brightRed:'#ff5555',brightGreen:'#50fa7b',brightYellow:'#f1fa8c',brightBlue:'#bd93f9',brightMagenta:'#ff79c6',brightCyan:'#8be9fd',brightWhite:'#f8f8f2'},
  },
  'One Dark':{
    ui:{bg:'#282c34',sidebarBg:'#21252b',border:'#3e4451',accent:'#61afef',text:'#abb2bf',textMuted:'#5c6370',textBright:'#e5c07b',textDim:'#3e4451',danger:'#e06c75',accentBorder:'#4b5263'},
    terminal:{background:'#282c34',foreground:'#abb2bf',cursor:'#528bff',cursorAccent:'#282c34',selectionBackground:'#3e4451',selectionForeground:'#abb2bf',black:'#282c34',red:'#e06c75',green:'#98c379',yellow:'#e5c07b',blue:'#61afef',magenta:'#c678dd',cyan:'#56b6c2',white:'#abb2bf',brightBlack:'#5c6370',brightRed:'#e06c75',brightGreen:'#98c379',brightYellow:'#e5c07b',brightBlue:'#61afef',brightMagenta:'#c678dd',brightCyan:'#56b6c2',brightWhite:'#ffffff'},
  },
  'Nord':{
    ui:{bg:'#2e3440',sidebarBg:'#272c36',border:'#3b4252',accent:'#88c0d0',text:'#d8dee9',textMuted:'#4c566a',textBright:'#eceff4',textDim:'#3b4252',danger:'#bf616a',accentBorder:'#4c566a'},
    terminal:{background:'#2e3440',foreground:'#d8dee9',cursor:'#d8dee9',cursorAccent:'#2e3440',selectionBackground:'#434c5e',selectionForeground:'#d8dee9',black:'#3b4252',red:'#bf616a',green:'#a3be8c',yellow:'#ebcb8b',blue:'#81a1c1',magenta:'#b48ead',cyan:'#88c0d0',white:'#e5e9f0',brightBlack:'#4c566a',brightRed:'#bf616a',brightGreen:'#a3be8c',brightYellow:'#ebcb8b',brightBlue:'#81a1c1',brightMagenta:'#b48ead',brightCyan:'#88c0d0',brightWhite:'#eceff4'},
  },
  'Catppuccin':{
    ui:{bg:'#1e1e2e',sidebarBg:'#181825',border:'#313244',accent:'#89b4fa',text:'#cdd6f4',textMuted:'#585b70',textBright:'#f5e0dc',textDim:'#313244',danger:'#f38ba8',accentBorder:'#45475a'},
    terminal:{background:'#1e1e2e',foreground:'#cdd6f4',cursor:'#f5e0dc',cursorAccent:'#1e1e2e',selectionBackground:'#585b70',selectionForeground:'#cdd6f4',black:'#45475a',red:'#f38ba8',green:'#a6e3a1',yellow:'#f9e2af',blue:'#89b4fa',magenta:'#f5c2e7',cyan:'#94e2d5',white:'#bac2de',brightBlack:'#585b70',brightRed:'#f38ba8',brightGreen:'#a6e3a1',brightYellow:'#f9e2af',brightBlue:'#89b4fa',brightMagenta:'#f5c2e7',brightCyan:'#94e2d5',brightWhite:'#a6adc8'},
  },
  'Solarized Dark':{
    ui:{bg:'#002b36',sidebarBg:'#073642',border:'#073642',accent:'#268bd2',text:'#839496',textMuted:'#586e75',textBright:'#93a1a1',textDim:'#073642',danger:'#dc322f',accentBorder:'#586e75'},
    terminal:{background:'#002b36',foreground:'#839496',cursor:'#93a1a1',cursorAccent:'#002b36',selectionBackground:'#073642',selectionForeground:'#93a1a1',black:'#073642',red:'#dc322f',green:'#859900',yellow:'#b58900',blue:'#268bd2',magenta:'#d33682',cyan:'#2aa198',white:'#eee8d5',brightBlack:'#586e75',brightRed:'#cb4b16',brightGreen:'#586e75',brightYellow:'#657b83',brightBlue:'#839496',brightMagenta:'#6c71c4',brightCyan:'#93a1a1',brightWhite:'#fdf6e3'},
  },
  'Monokai':{
    ui:{bg:'#272822',sidebarBg:'#1e1f1c',border:'#3e3d32',accent:'#a6e22e',text:'#f8f8f2',textMuted:'#75715e',textBright:'#f8f8f0',textDim:'#49483e',danger:'#f92672',accentBorder:'#49483e'},
    terminal:{background:'#272822',foreground:'#f8f8f2',cursor:'#f8f8f0',cursorAccent:'#272822',selectionBackground:'#49483e',selectionForeground:'#f8f8f2',black:'#272822',red:'#f92672',green:'#a6e22e',yellow:'#f4bf75',blue:'#66d9ef',magenta:'#ae81ff',cyan:'#a1efe4',white:'#f8f8f2',brightBlack:'#75715e',brightRed:'#fd971f',brightGreen:'#a6e22e',brightYellow:'#e6db74',brightBlue:'#66d9ef',brightMagenta:'#ae81ff',brightCyan:'#a1efe4',brightWhite:'#ffffff'},
  },
  'GitHub Dark':{
    ui:{bg:'#0d1117',sidebarBg:'#010409',border:'#30363d',accent:'#58a6ff',text:'#c9d1d9',textMuted:'#8b949e',textBright:'#f0f6fc',textDim:'#21262d',danger:'#f85149',accentBorder:'#388bfd'},
    terminal:{background:'#0d1117',foreground:'#c9d1d9',cursor:'#58a6ff',cursorAccent:'#0d1117',selectionBackground:'#264f78',selectionForeground:'#c9d1d9',black:'#484f58',red:'#ff7b72',green:'#3fb950',yellow:'#d29922',blue:'#58a6ff',magenta:'#bc8cff',cyan:'#39c5cf',white:'#b1bac4',brightBlack:'#6e7681',brightRed:'#ffa198',brightGreen:'#56d364',brightYellow:'#e3b341',brightBlue:'#79c0ff',brightMagenta:'#d2a8ff',brightCyan:'#56d4dd',brightWhite:'#ffffff'},
  },
  'Material Ocean':{
    ui:{bg:'#0f111a',sidebarBg:'#0a0c12',border:'#1a1c25',accent:'#84ffff',text:'#8f93a2',textMuted:'#676e95',textBright:'#eeffff',textDim:'#1a1c25',danger:'#ff5370',accentBorder:'#2b2f3b'},
    terminal:{background:'#0f111a',foreground:'#8f93a2',cursor:'#ffcc00',cursorAccent:'#0f111a',selectionBackground:'#80cbc420',selectionForeground:'#eeffff',black:'#546e7a',red:'#ff5370',green:'#c3e88d',yellow:'#ffcb6b',blue:'#82aaff',magenta:'#c792ea',cyan:'#89ddff',white:'#eeffff',brightBlack:'#546e7a',brightRed:'#f07178',brightGreen:'#c3e88d',brightYellow:'#ffcb6b',brightBlue:'#82aaff',brightMagenta:'#c792ea',brightCyan:'#89ddff',brightWhite:'#ffffff'},
  },
  'Material Palenight':{
    ui:{bg:'#292d3e',sidebarBg:'#1e2030',border:'#3a3f5c',accent:'#c792ea',text:'#a6accd',textMuted:'#676e95',textBright:'#eeffff',textDim:'#3a3f5c',danger:'#ff5370',accentBorder:'#4a4e6a'},
    terminal:{background:'#292d3e',foreground:'#a6accd',cursor:'#ffcc00',cursorAccent:'#292d3e',selectionBackground:'#676e9536',selectionForeground:'#eeffff',black:'#546e7a',red:'#ff5370',green:'#c3e88d',yellow:'#ffcb6b',blue:'#82aaff',magenta:'#c792ea',cyan:'#89ddff',white:'#eeffff',brightBlack:'#546e7a',brightRed:'#f07178',brightGreen:'#c3e88d',brightYellow:'#ffcb6b',brightBlue:'#82aaff',brightMagenta:'#c792ea',brightCyan:'#89ddff',brightWhite:'#ffffff'},
  },
  'Ayu Dark':{
    ui:{bg:'#0a0e14',sidebarBg:'#010409',border:'#1a1f29',accent:'#39bae6',text:'#b3b1ad',textMuted:'#626a73',textBright:'#e6e1cf',textDim:'#1a1f29',danger:'#d95757',accentBorder:'#2a3040'},
    terminal:{background:'#0a0e14',foreground:'#b3b1ad',cursor:'#f29e74',cursorAccent:'#0a0e14',selectionBackground:'#1a1f29',selectionForeground:'#e6e1cf',black:'#1a1f29',red:'#d95757',green:'#7fd962',yellow:'#f29e74',blue:'#39bae6',magenta:'#d2a6ff',cyan:'#95e6cb',white:'#c7c7c7',brightBlack:'#1a1f29',brightRed:'#d95757',brightGreen:'#7fd962',brightYellow:'#f29e74',brightBlue:'#39bae6',brightMagenta:'#d2a6ff',brightCyan:'#95e6cb',brightWhite:'#ffffff'},
  },
  'Gruvbox Dark':{
    ui:{bg:'#282828',sidebarBg:'#1d2021',border:'#3c3836',accent:'#fe8019',text:'#ebdbb2',textMuted:'#928374',textBright:'#fbf1c7',textDim:'#3c3836',danger:'#fb4934',accentBorder:'#504945'},
    terminal:{background:'#282828',foreground:'#ebdbb2',cursor:'#ebdbb2',cursorAccent:'#282828',selectionBackground:'#504945',selectionForeground:'#ebdbb2',black:'#282828',red:'#cc241d',green:'#98971a',yellow:'#d79921',blue:'#458588',magenta:'#b16286',cyan:'#689d6a',white:'#a89984',brightBlack:'#928374',brightRed:'#fb4934',brightGreen:'#b8bb26',brightYellow:'#fabd2f',brightBlue:'#83a598',brightMagenta:'#d3869b',brightCyan:'#8ec07c',brightWhite:'#ebdbb2'},
  },
  'Ros\u00e9 Pine':{
    ui:{bg:'#191724',sidebarBg:'#1f1d2e',border:'#26233a',accent:'#c4a7e7',text:'#e0def4',textMuted:'#6e6a86',textBright:'#e0def4',textDim:'#26233a',danger:'#eb6f92',accentBorder:'#403d52'},
    terminal:{background:'#191724',foreground:'#e0def4',cursor:'#e0def4',cursorAccent:'#191724',selectionBackground:'#403d52',selectionForeground:'#e0def4',black:'#26233a',red:'#eb6f92',green:'#31748f',yellow:'#f6c177',blue:'#9ccfd8',magenta:'#c4a7e7',cyan:'#ebbcba',white:'#e0def4',brightBlack:'#6e6a86',brightRed:'#eb6f92',brightGreen:'#31748f',brightYellow:'#f6c177',brightBlue:'#9ccfd8',brightMagenta:'#c4a7e7',brightCyan:'#ebbcba',brightWhite:'#e0def4'},
  },
  'Night Owl':{
    ui:{bg:'#011627',sidebarBg:'#001122',border:'#1d3449',accent:'#82aaff',text:'#d6deeb',textMuted:'#5f7e97',textBright:'#ffffff',textDim:'#1d3449',danger:'#ef5350',accentBorder:'#2a4560'},
    terminal:{background:'#011627',foreground:'#d6deeb',cursor:'#80a4c2',cursorAccent:'#011627',selectionBackground:'#1d3b53',selectionForeground:'#ffffff',black:'#011627',red:'#ef5350',green:'#22da6e',yellow:'#c5e478',blue:'#82aaff',magenta:'#c792ea',cyan:'#21c7a8',white:'#ffffff',brightBlack:'#575656',brightRed:'#ef5350',brightGreen:'#22da6e',brightYellow:'#ffeb95',brightBlue:'#82aaff',brightMagenta:'#c792ea',brightCyan:'#7fdbca',brightWhite:'#ffffff'},
  },
  'Cobalt\u00b2':{
    ui:{bg:'#193549',sidebarBg:'#15232f',border:'#2a4a63',accent:'#ffc600',text:'#ffffff',textMuted:'#0088ff',textBright:'#ffffff',textDim:'#1f4662',danger:'#ff628c',accentBorder:'#3a6a8a'},
    terminal:{background:'#193549',foreground:'#ffffff',cursor:'#ffc600',cursorAccent:'#193549',selectionBackground:'#003c8f',selectionForeground:'#ffffff',black:'#000000',red:'#ff628c',green:'#08ff00',yellow:'#ff9f00',blue:'#0088ff',magenta:'#ff00ff',cyan:'#00fdf8',white:'#bbbbbb',brightBlack:'#555555',brightRed:'#ff628c',brightGreen:'#08ff00',brightYellow:'#ffcc00',brightBlue:'#0099ff',brightMagenta:'#ff77ff',brightCyan:'#00fdf8',brightWhite:'#ffffff'},
  },
  'Shades of Purple':{
    ui:{bg:'#2d2b55',sidebarBg:'#242240',border:'#3c3a6e',accent:'#a78bfa',text:'#a5b3ce',textMuted:'#5c5a8c',textBright:'#ffffff',textDim:'#3c3a6e',danger:'#ff6b8a',accentBorder:'#4a4880'},
    terminal:{background:'#2d2b55',foreground:'#a5b3ce',cursor:'#a78bfa',cursorAccent:'#2d2b55',selectionBackground:'#3c3a6e',selectionForeground:'#ffffff',black:'#242240',red:'#ff6b8a',green:'#7addff',yellow:'#ffb8d1',blue:'#a78bfa',magenta:'#ff9ef5',cyan:'#36f9f6',white:'#ffffff',brightBlack:'#5c5a8c',brightRed:'#ff6b8a',brightGreen:'#7addff',brightYellow:'#ffb8d1',brightBlue:'#a78bfa',brightMagenta:'#ff9ef5',brightCyan:'#36f9f6',brightWhite:'#ffffff'},
  },
  'Horizon':{
    ui:{bg:'#1c1e26',sidebarBg:'#16161c',border:'#232530',accent:'#e95678',text:'#cbced0',textMuted:'#6c6f93',textBright:'#d5d8da',textDim:'#232530',danger:'#e95678',accentBorder:'#2e303e'},
    terminal:{background:'#1c1e26',foreground:'#cbced0',cursor:'#e95678',cursorAccent:'#1c1e26',selectionBackground:'#2e303e',selectionForeground:'#cbced0',black:'#1c1e26',red:'#e95678',green:'#09f7a0',yellow:'#f7c67f',blue:'#21bfc2',magenta:'#b877db',cyan:'#53dce0',white:'#cbced0',brightBlack:'#6c6f93',brightRed:'#e95678',brightGreen:'#09f7a0',brightYellow:'#f7c67f',brightBlue:'#21bfc2',brightMagenta:'#b877db',brightCyan:'#53dce0',brightWhite:'#ffffff'},
  },
  'Doom One':{
    ui:{bg:'#282c34',sidebarBg:'#21252b',border:'#3e4451',accent:'#51afef',text:'#bbc2cf',textMuted:'#5b6268',textBright:'#ffffff',textDim:'#3e4451',danger:'#ff6c6b',accentBorder:'#4a5060'},
    terminal:{background:'#282c34',foreground:'#bbc2cf',cursor:'#51afef',cursorAccent:'#282c34',selectionBackground:'#3e4451',selectionForeground:'#bbc2cf',black:'#282c34',red:'#ff6c6b',green:'#98be65',yellow:'#ecbe7a',blue:'#51afef',magenta:'#c678dd',cyan:'#46d9ff',white:'#bbc2cf',brightBlack:'#5b6268',brightRed:'#ff6c6b',brightGreen:'#98be65',brightYellow:'#ecbe7a',brightBlue:'#51afef',brightMagenta:'#c678dd',brightCyan:'#46d9ff',brightWhite:'#ffffff'},
  },
  'Everforest':{
    ui:{bg:'#2b3339',sidebarBg:'#22272e',border:'#3a4249',accent:'#a7c080',text:'#d3c6aa',textMuted:'#859289',textBright:'#d3c6aa',textDim:'#3a4249',danger:'#e67e80',accentBorder:'#4a555b'},
    terminal:{background:'#2b3339',foreground:'#d3c6aa',cursor:'#d3c6aa',cursorAccent:'#2b3339',selectionBackground:'#4a555b',selectionForeground:'#d3c6aa',black:'#3a4249',red:'#e67e80',green:'#a7c080',yellow:'#dbbc7f',blue:'#7fbbb3',magenta:'#d699b6',cyan:'#7fbbb3',white:'#d3c6aa',brightBlack:'#5c6a72',brightRed:'#e67e80',brightGreen:'#a7c080',brightYellow:'#dbbc7f',brightBlue:'#7fbbb3',brightMagenta:'#d699b6',brightCyan:'#7fbbb3',brightWhite:'#d3c6aa'},
  },
  'Kanagawa':{
    ui:{bg:'#1f1f28',sidebarBg:'#181820',border:'#2a2a37',accent:'#7e9cd8',text:'#dcd7ba',textMuted:'#54546d',textBright:'#dcd7ba',textDim:'#2a2a37',danger:'#c34043',accentBorder:'#363646'},
    terminal:{background:'#1f1f28',foreground:'#dcd7ba',cursor:'#dcd7ba',cursorAccent:'#1f1f28',selectionBackground:'#2a2a37',selectionForeground:'#dcd7ba',black:'#090618',red:'#c34043',green:'#769462',yellow:'#c0a36e',blue:'#7e9cd8',magenta:'#957fb8',cyan:'#6a9589',white:'#c8c093',brightBlack:'#727169',brightRed:'#e82424',brightGreen:'#98bb6c',brightYellow:'#e6c384',brightBlue:'#7fb4ca',brightMagenta:'#938aa9',brightCyan:'#7aa89f',brightWhite:'#dcd7ba'},
  },
  'Synthwave \'84':{
    ui:{bg:'#262335',sidebarBg:'#1e1b2e',border:'#36325a',accent:'#f97e72',text:'#e0d0c0',textMuted:'#6a5f84',textBright:'#f8f1e8',textDim:'#36325a',danger:'#f97e72',accentBorder:'#4a4480'},
    terminal:{background:'#262335',foreground:'#e0d0c0',cursor:'#f97e72',cursorAccent:'#262335',selectionBackground:'#36325a',selectionForeground:'#f8f1e8',black:'#262335',red:'#f97e72',green:'#72f1b8',yellow:'#f5d76e',blue:'#7b89bf',magenta:'#ff7edb',cyan:'#72f1b8',white:'#e0d0c0',brightBlack:'#6a5f84',brightRed:'#f97e72',brightGreen:'#72f1b8',brightYellow:'#f5d76e',brightBlue:'#7b89bf',brightMagenta:'#ff7edb',brightCyan:'#72f1b8',brightWhite:'#f8f1e8'},
  },
};

let currentThemeName='Tokyo Night';
let customTheme=null; // {ui:{...}, terminal:{...}} or null

function hexToRgba(hex,a){const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);return`rgba(${r},${g},${b},${a})`}

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
    this.ws=null; this.term=null; this.fit=null; this._opened=false; this._buf=[]; this._reconnecting=false;
    this.el=document.createElement('div');
    this.el.className='tp'; this.el.dataset.pid=id;
    this.box=document.createElement('div');
    this.box.style.cssText='width:100%;height:100%';
    this.el.appendChild(this.box);
    // Drag & drop upload
    this.el.addEventListener('dragover',e=>{e.preventDefault();e.stopPropagation();this.el.classList.add('dragover')});
    this.el.addEventListener('dragleave',()=>this.el.classList.remove('dragover'));
    this.el.addEventListener('drop',e=>{e.preventDefault();e.stopPropagation();this.el.classList.remove('dragover');this._uploadFiles(e.dataTransfer.files)});
  }
  open() {
    if(this._opened) return; this._opened=true;
    this.term=new Terminal(TOPTS);
    this.fit=new FitAddon.FitAddon();
    this.term.loadAddon(this.fit);
    try{this.term.loadAddon(new WebLinksAddon.WebLinksAddon())}catch(e){}
    try{this.term.loadAddon(new Unicode11Addon.Unicode11Addon());this.term.unicode.activeVersion='11'}catch(e){}
    try{this.search=new SearchAddon.SearchAddon();this.term.loadAddon(this.search)}catch(e){}
    this.term.open(this.box);
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
      const b=enc.encode(d);
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
    const url=`${p}//${location.host}/ws?cols=120&rows=40&pane=${encodeURIComponent(this.id)}`;
    this.ws=new WebSocket(url); this.ws.binaryType='arraybuffer';
    this.ws.onopen=()=>{
      if(this.term){
        const m=new Uint8Array(5);m[0]=OP.RESIZE;
        new DataView(m.buffer).setUint16(1,this.term.cols,false);
        new DataView(m.buffer).setUint16(3,this.term.rows,false);
        this._send(m);
      }
      if(this._reconnecting){
        setTimeout(()=>{this.el.style.opacity='1';this._reconnecting=false;if(this.term)this.term.scrollToBottom()},300);
      }
    };
    this.ws.onmessage=e=>{
      const d=new Uint8Array(e.data); if(!d.length) return;
      if(d[0]===OP.OUTPUT){
        const data=d.subarray(1);
        // Detect download escape sequence: ESC ] 777 ; Download ; <path> BEL
        const text=dec.decode(data);
        const dlIdx=text.indexOf('\x1b]777;Download;');
        if(dlIdx!==-1){
          const start=dlIdx+15; // length of '\x1b]777;Download;'
          const end=text.indexOf('\x07',start);
          if(end!==-1){
            const path=text.substring(start,end);
            this._downloadFile(path);
            // Write remaining output (before + after the escape seq)
            const clean=text.substring(0,dlIdx)+text.substring(end+1);
            if(clean&&this.term) try{this.term.write(clean)}catch{}
            else if(!clean&&this.term) try{this.term.write('\r\n')}catch{}
          }else{
            if(this.term) try{this.term.write(data)}catch{}
          }
        }else{
          if(this.term) try{this.term.write(data)}catch{}
          else this._buf.push(new Uint8Array(data));
        }
      } else if(d[0]===OP.SID){
        this.id=dec.decode(d.subarray(1)); this.el.dataset.pid=this.id;
      } else if(d[0]===OP.EXIT){
        this.write('\r\n\x1b[90m── exited ──\x1b[0m\r\n');
      } else if(d[0]===OP.ERROR){
        this.write('\r\n\x1b[31m'+dec.decode(d.subarray(1))+'\x1b[0m\r\n');
      }
    };
    this.ws.onclose=()=>this.write('\r\n\x1b[90m── disconnected ──\x1b[0m\r\n');
    this.ws.onerror=()=>console.error('[TermPane] ws error', this.id);
  }
  write(s){if(this.term)try{this.term.write(s)}catch{}else this._buf.push(s)}
  doFit(){if(this.fit)try{this.fit.fit()}catch{}}
  focus(){if(this.term)try{this.term.focus()}catch{}}
  _downloadFile(path){
    const a=document.createElement('a');
    a.href='/api/download?path='+encodeURIComponent(path);
    a.download='';document.body.appendChild(a);a.click();a.remove();
    this.term.write('\x1b[2m↓ Downloading: '+path+'\x1b[0m\r\n');
  }
  _uploadFiles(files){
    if(!files||!files.length)return;
    // Get cwd from server for this pane
    fetch('/api/cwd?pane='+this.id).then(r=>r.json()).then(({cwd})=>{
      let i=0;
      const uploadNext=()=>{
        if(i>=files.length)return;
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
    if(this.ws){this.ws.onclose=null;this.ws.onerror=null;this.ws.close();this.ws=null}
    if(this.term){this.term.dispose();this.term=null}
    this.el.remove(); this._opened=false;
  }
  _send(m){if(this.ws&&this.ws.readyState===1)this.ws.send(m)}
}

// ═══ Layout helpers ═══

function doSplit(n,rid,nr,dir){
  if(n.type==='region') return n.id===rid?{type:'split',direction:dir,children:[n,nr]}:n;
  if(n.children) n.children=n.children.map(c=>doSplit(c,rid,nr,dir));
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
  if(n.type==='region') return (n.tabs||[]).map(t=>t.paneId);
  if(n.children) return n.children.flatMap(c=>allPids(c));
  return [];
}
function findPath(n,rid){
  if(!n) return null;
  if(n.type==='region') return n.id===rid?[n]:null;
  if(n.children) for(const c of n.children){const p=findPath(c,rid);if(p)return[n,...p]}
  return null;
}
function clean(n,ok){
  if(!n) return null;
  if(n.type==='region'){
    if(n.tabs) n.tabs=n.tabs.filter(t=>ok.has(t.paneId));
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

class App {
  constructor(){
    this.panes=new Map();
    this.ws={sessions:[],activeSession:null};
    this.focused=null;
    this._s=0;this._r=0;this._t=0;this._kb=false;
  }

  async init(){
    try{
      const st=await(await fetch('/api/state')).json();
      const sp=st.panes||[];
      const sv=st.workspace;
      const ok=new Set(sp.map(p=>p.id));
      for(const p of sp){const pane=this._mkPane(p.id,p.name);pane._reconnecting=true;pane.el.style.opacity='0'}
      if(sv&&sv.sessions&&sv.sessions.length){
        this.ws=sv;
        for(const s of this.ws.sessions){
          if(!s||!s.id) continue;
          const n=parseInt(s.id.replace(/\D/g,''),10); if(n>this._s) this._s=n;
          s.layout=clean(s.layout,ok);
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
    if(a&&a.layout){const f=firstRg(a.layout);if(f)this.focused=f.id}
    this.render();
    this._bind();
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

  async _newPane(){
    const r=await fetch('/api/panes?cols=120&rows=40',{method:'POST'});
    if(!r.ok) throw new Error('create pane failed');
    const {id,name}=await r.json();
    return this._mkPane(id,name);
  }

  async _kill(pid){
    const p=this.panes.get(pid);
    if(p){p.destroy();this.panes.delete(pid)}
    try{await fetch(`/api/panes/${pid}`,{method:'DELETE'})}catch{}
  }

  _as(){return this.ws.sessions.find(s=>s.id===this.ws.activeSession)||null}

  async _mkSession(){
    const p=await this._newPane();
    const r=`r${++this._r}`,t=`t${++this._t}`;
    const s={
      id:`s${++this._s}`,name:'Session',
      layout:{type:'region',id:r,tabs:[{id:t,name:'Shell',paneId:p.id}],activeTab:t}
    };
    this.ws.sessions.push(s);
    this.ws.activeSession=s.id;
    this.focused=r;
    await this._save();
  }

  async addSession(){await this._mkSession();this.render()}

  async delSession(sid){
    const i=this.ws.sessions.findIndex(s=>s.id===sid);
    if(i<0) return;
    const s=this.ws.sessions[i];
    for(const pid of allPids(s.layout)) this._kill(pid);
    this.ws.sessions.splice(i,1);
    if(!this.ws.sessions.length){await this._mkSession();this.render();return}
    if(this.ws.activeSession===sid)
      this.ws.activeSession=this.ws.sessions[Math.min(i,this.ws.sessions.length-1)].id;
    const a=this._as(); this.focused=a?firstRg(a.layout)?.id:null;
    await this._save(); this.render();
  }

  switchSession(sid){
    if(this.ws.activeSession===sid) return;
    this.ws.activeSession=sid;
    const a=this._as(); this.focused=a?firstRg(a.layout)?.id:null;
    this._save(); this.render();
  }

  async addTab(rid){
    const s=this._as(); if(!s) return;
    const rg=findRg(s.layout,rid); if(!rg) return;
    const p=await this._newPane();
    const t=`t${++this._t}`;
    rg.tabs.push({id:t,name:'Shell',paneId:p.id});
    rg.activeTab=t;
    await this._save(); this.render();
  }

  async closeTab(rid,tid){
    const s=this._as(); if(!s) return;
    const rg=findRg(s.layout,rid); if(!rg) return;
    const tab=rg.tabs.find(t=>t.id===tid); if(!tab) return;
    await this._kill(tab.paneId);
    rg.tabs=rg.tabs.filter(t=>t.id!==tid);
    if(!rg.tabs.length){
      s.layout=doRemove(s.layout,rid);
      if(!s.layout){await this.delSession(s.id);return}
      this.focused=firstRg(s.layout)?.id||null;
    } else {
      if(rg.activeTab===tid) rg.activeTab=rg.tabs[0].id;
    }
    await this._save(); this.render();
  }

  switchTab(rid,tid){
    const s=this._as(); if(!s) return;
    const rg=findRg(s.layout,rid); if(!rg) return;
    if(rg.activeTab===tid) return;
    rg.activeTab=tid; this.focused=rid;
    this._save(); this.render();
  }

  async split(dir){
    const s=this._as(); if(!s||!this.focused) return;
    const p=await this._newPane();
    const r=`r${++this._r}`,t=`t${++this._t}`;
    const nr={type:'region',id:r,tabs:[{id:t,name:'Shell',paneId:p.id}],activeTab:t};
    s.layout=doSplit(s.layout,this.focused,nr,dir);
    this.focused=r;
    await this._save(); this.render();
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
        if(target){this.focused=target.id;this.render();return}
      }
    }
  }
  addTabFocused(){if(this.focused)this.addTab(this.focused)}
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
    };
    if(map[action])map[action]();
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
    this._focusedPane()?.focus();
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
  _focusedPane(){
    if(!this.focused)return null;
    const s=this._as();if(!s)return null;
    const rg=findRg(s.layout,this.focused);if(!rg)return null;
    return this.panes.get(rg.tabs.find(t=>t.id===rg.activeTab)?.paneId);
  }
  _doSearch(dir){
    const p=this._focusedPane();if(!p||!p.search)return;
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
    this.focused=rid;
    this._prevFocus=rid;
    document.querySelectorAll('.rg').forEach(el=>{
      el.classList.toggle('focused',el.dataset.rid===rid);
    });
    this._researchIfOpen();
  }

  async _save(){
    try{await fetch('/api/workspace',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(this.ws)})}catch{}
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

  // ── Render ──

  render(){
    const oldFocus=this._prevFocus;
    this._prevFocus=this.focused;
    if(oldFocus!==undefined&&oldFocus!==this.focused){
      this._clearAllSearchDecorations();
      this._researchIfOpen();
    }
    this._rSidebar();this._rTopbar();this._rLayout();
  }

  _rSidebar(){
    const el=document.getElementById('sessions'); el.innerHTML='';
    for(const s of this.ws.sessions){
      const d=document.createElement('div');
      d.className='si'+(s.id===this.ws.activeSession?' active':'');
      d.innerHTML=`<span class="si-dot"></span><span class="si-name">${s.name}</span><span class="si-x">×</span>`;
      d.addEventListener('click',e=>{if(!e.target.classList.contains('si-x'))this.switchSession(s.id)});
      d.querySelector('.si-x').addEventListener('click',e=>{e.stopPropagation();this.delSession(s.id)});
      d.querySelector('.si-name').addEventListener('dblclick',e=>{e.stopPropagation();this._rename(s,e.target)});
      el.appendChild(d);
    }
  }

  _rTopbar(){
    const a=this._as();
    document.getElementById('session-name').textContent=a?a.name:'';
  }

  _rLayout(){
    const area=document.getElementById('area');
    const s=this._as();
    for(const p of this.panes.values()){p.el.classList.remove('vis');area.appendChild(p.el)}
    for(const c of [...area.children]){if(c.classList.contains('sp')||c.classList.contains('rg'))c.remove()}
    if(!s?.layout) return;
    if(!findRg(s.layout,this.focused)) this.focused=firstRg(s.layout)?.id||null;
    const dom=this._buildNode(s.layout);
    if(dom) area.appendChild(dom);
    requestAnimationFrame(()=>{
      for(const p of this.panes.values()){
        if(p.el.classList.contains('vis')){if(!p._opened)p.open();p.doFit()}
      }
      if(this.focused){
        const rg=findRg(s.layout,this.focused);
        if(rg){const tab=rg.tabs.find(t=>t.id===rg.activeTab);if(tab){const p=this.panes.get(tab.paneId);if(p)p.focus()}}
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
    el.className='rg'+(n.id===this.focused?' focused':'');
    el.dataset.rid=n.id;
    const tabs=document.createElement('div'); tabs.className='rg-tabs';
    for(const tab of(n.tabs||[])){
      const t=document.createElement('div');
      t.className='rt'+(tab.id===n.activeTab?' active':'');
      t.innerHTML=`<span>${tab.name}</span><span class="rt-x">×</span>`;
      t.addEventListener('click',e=>{
        e.stopPropagation();
        if(e.target.classList.contains('rt-x')) this.closeTab(n.id,tab.id);
        else this.switchTab(n.id,tab.id);
      });
      t.querySelector('span').addEventListener('dblclick',e=>{e.stopPropagation();this._rename(tab,e.target)});
      tabs.appendChild(t);
    }
    const add=document.createElement('button'); add.className='rt-add'; add.textContent='+';
    add.addEventListener('click',e=>{e.stopPropagation();this.addTab(n.id)});
    tabs.appendChild(add); el.appendChild(tabs);
    const body=document.createElement('div'); body.className='rg-body';
    const at=(n.tabs||[]).find(t=>t.id===n.activeTab);
    if(at){const p=this.panes.get(at.paneId);if(p){body.appendChild(p.el);p.el.classList.add('vis')}}
    el.appendChild(body);
    el.addEventListener('mousedown',()=>this.setFocus(n.id));
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
        if(nd){nd.sizes=[];for(const c of sp.children){if(c.classList.contains('sc'))nd.sizes.push(parseFloat(c.style.flex)||1)}this._save()}
        for(const p of this.panes.values())if(p.el.classList.contains('vis'))p.doFit();
      };
      document.addEventListener('mousemove',mv);document.addEventListener('mouseup',up);
    });
  }

  _bind(){
    if(this._kb) return; this._kb=true;
    document.getElementById('split-h').addEventListener('click',()=>this.split('horizontal'));
    document.getElementById('split-v').addEventListener('click',()=>this.split('vertical'));
    const sb=document.getElementById('sidebar'),sbh=document.getElementById('sb-handle');
    sbh.addEventListener('mousedown',e=>{e.preventDefault();
      const sx=e.clientX,sw=sb.offsetWidth;
      const mv=e=>{const w=sw+(e.clientX-sx);if(w>=100&&w<=400){sb.style.width=w+'px';sb.style.minWidth=w+'px'}};
      const up=()=>{document.removeEventListener('mousemove',mv);document.removeEventListener('mouseup',up);for(const p of this.panes.values())if(p.el.classList.contains('vis'))p.doFit()};
      document.addEventListener('mousemove',mv);document.addEventListener('mouseup',up);
    });
    // Global shortcut handler (capture phase → top priority)
    this._recording=null;
    window.addEventListener('keydown',e=>{
      // Recording mode — absolute top priority, blocks EVERYTHING
      if(this._recording){e.preventDefault();e.stopImmediatePropagation();
        if(e.code==='Escape'){
          const btn=document.querySelector('.sc-key.recording');
          if(btn){btn.classList.remove('recording');btn.textContent=displayKey(shortcuts[btn.dataset.action]||'')}
          this._recording=null;return;
        }
        if(MOD_CODES.has(e.code))return;
        shortcuts[this._recording]=fmtShortcut(e);
        const btn=document.querySelector(`.sc-key[data-action="${this._recording}"]`);
        this._recording=null;
        if(btn){btn.classList.remove('recording');btn.textContent=displayKey(shortcuts[btn.dataset.action]||'')}
        this._saveSettings();
        return;
      }
      // Skip if non-xterm input is focused
      const ae=document.activeElement;
      if(ae.tagName==='INPUT'||(ae.tagName==='TEXTAREA'&&!ae.classList.contains('xterm-helper-textarea')))return;
      // Search: Ctrl+F or Cmd+F
      if(e.key==='f'&&(e.ctrlKey||e.metaKey)){e.preventDefault();e.stopImmediatePropagation();this.toggleSearch();return}
      // Check configured shortcuts
      for(const[action,key]of Object.entries(shortcuts)){
        if(matchShortcut(e,key)){e.preventDefault();e.stopImmediatePropagation();this.executeAction(action);return}
      }
    },true);
    // Search bar bindings
    const si=document.getElementById('search-input');
    si.addEventListener('input',()=>this._doSearch('next'));
    si.addEventListener('keydown',e=>{
      if(e.key==='Enter'){e.preventDefault();this._doSearch(e.shiftKey?'prev':'next')}
      if(e.key==='Escape'){e.preventDefault();e.stopPropagation();this.closeSearch()}
      e.stopPropagation();
    });
    document.getElementById('search-next').addEventListener('click',()=>this._doSearch('next'));
    document.getElementById('search-prev').addEventListener('click',()=>this._doSearch('prev'));
    document.getElementById('search-case').addEventListener('click',function(){this.classList.toggle('active')});
    document.getElementById('search-close').addEventListener('click',()=>this.closeSearch());
    this._initModal();
  }

  async _saveSettings(){
    try{await fetch('/api/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({themeName:customTheme?null:currentThemeName,customTheme,shortcuts})})}catch{}
  }

  // ── Modal & Theme ──

  _initModal(){
    const overlay=document.getElementById('modal-overlay');
    const modal=document.getElementById('modal');
    document.getElementById('settings-btn').addEventListener('click',()=>{overlay.classList.add('open');this._renderThemePanel();this._renderShortcutList()});
    document.getElementById('modal-close').addEventListener('click',()=>overlay.classList.remove('open'));
    overlay.addEventListener('click',e=>{if(e.target===overlay)overlay.classList.remove('open')});
    modal.querySelectorAll('.mtab').forEach(tab=>{
      tab.addEventListener('click',()=>{
        modal.querySelectorAll('.mtab').forEach(t=>t.classList.remove('active'));
        tab.classList.add('active');
        modal.querySelectorAll('.mpanel').forEach(p=>p.style.display='none');
        document.getElementById('panel-'+tab.dataset.tab).style.display='';
      });
    });
  }

  _renderThemePanel(){
    const list=document.getElementById('theme-list'); list.innerHTML='';
    const activeName=customTheme?null:currentThemeName;
    for(const name of Object.keys(THEMES)){
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
      uiDiv.appendChild(this._colorInput(key,label,customTheme.ui,'ui'));
    }
    // Terminal colors
    const termDiv=document.getElementById('ce-terminal'); termDiv.innerHTML='';
    for(const [key,label] of Object.entries(TERM_LABELS)){
      termDiv.appendChild(this._colorInput(key,label,customTheme.terminal,'terminal'));
    }
  }

  _colorInput(key,label,obj,section){
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
}

// ═══ Bootstrap ═══

const app=new App();

// Restore saved theme from server
(async()=>{try{const r=await fetch('/api/settings');if(r.ok){const saved=await r.json();
  if(saved.shortcuts) Object.assign(shortcuts,saved.shortcuts);
  if(saved.customTheme){customTheme=saved.customTheme;applyThemeObj(customTheme)}
  else if(saved.themeName&&THEMES[saved.themeName]){currentThemeName=saved.themeName;applyThemeObj(THEMES[currentThemeName])}
}}catch{}})();

app.init();
document.getElementById('add-session').addEventListener('click',()=>app.addSession());

// Custom toggle handler
document.getElementById('custom-toggle').addEventListener('click',()=>{
  const editor=document.getElementById('custom-editor');
  if(editor.style.display==='none'){app._showCustomEditor()}
  else{app._hideCustomEditor()}
});

window.addEventListener('resize',()=>{for(const p of app.panes.values())if(p.el.classList.contains('vis'))p.doFit()});
window.addEventListener('beforeunload',e=>{if(app.panes.size>0){e.preventDefault();e.returnValue=''}});
