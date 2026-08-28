/**
 * Remote Terminal — theme definitions
 */

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
  // Additional dark themes
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
  // Bright dark themes — 배경 휘도·채도가 높아 밝게 느껴지는 다크군 (Cobalt² 계열)
  'Tokyo Night Storm':{
    mode:'dark',
    ui:{bg:'#24283b',sidebarBg:'#1f2335',border:'#3b4261',accent:'#7aa2f7',text:'#a9b1d6',textMuted:'#565f89',textBright:'#c0caf5',textDim:'#414868',danger:'#f7768e',accentBorder:'#3d59a1'},
    terminal:{background:'#24283b',foreground:'#a9b1d6',cursor:'#c0caf5',cursorAccent:'#24283b',selectionBackground:'#364a82',selectionForeground:'#c0caf5',black:'#1d202f',red:'#f7768e',green:'#9ece6a',yellow:'#e0af68',blue:'#7aa2f7',magenta:'#bb9af7',cyan:'#7dcfff',white:'#a9b1d6',brightBlack:'#414868',brightRed:'#f7768e',brightGreen:'#9ece6a',brightYellow:'#e0af68',brightBlue:'#7aa2f7',brightMagenta:'#bb9af7',brightCyan:'#7dcfff',brightWhite:'#c0caf5'},
  },
  'Ayu Mirage':{
    mode:'dark',
    ui:{bg:'#1f2430',sidebarBg:'#1a1f29',border:'#33415e',accent:'#ffcc66',text:'#cccac2',textMuted:'#707a8c',textBright:'#ffffff',textDim:'#33415e',danger:'#f28779',accentBorder:'#5c6773'},
    terminal:{background:'#1f2430',foreground:'#cccac2',cursor:'#ffcc66',cursorAccent:'#1f2430',selectionBackground:'#33415e',selectionForeground:'#cccac2',black:'#191e2a',red:'#ed8274',green:'#a6cc70',yellow:'#fad07b',blue:'#6dcbfa',magenta:'#cfbafa',cyan:'#90e1c6',white:'#c7c7c7',brightBlack:'#686868',brightRed:'#f28779',brightGreen:'#d5ff80',brightYellow:'#ffd173',brightBlue:'#73d0ff',brightMagenta:'#dfbfff',brightCyan:'#95e6cb',brightWhite:'#ffffff'},
  },
  'Oceanic Next':{
    mode:'dark',
    ui:{bg:'#1b2b34',sidebarBg:'#16232b',border:'#343d46',accent:'#6699cc',text:'#cdd3de',textMuted:'#65737e',textBright:'#d8dee9',textDim:'#343d46',danger:'#ec5f67',accentBorder:'#4f5b66'},
    terminal:{background:'#1b2b34',foreground:'#cdd3de',cursor:'#c0c5ce',cursorAccent:'#1b2b34',selectionBackground:'#4f5b66',selectionForeground:'#d8dee9',black:'#29414f',red:'#ec5f67',green:'#99c794',yellow:'#fac863',blue:'#6699cc',magenta:'#c594c5',cyan:'#5fb3b3',white:'#d8dee9',brightBlack:'#405860',brightRed:'#ec5f67',brightGreen:'#99c794',brightYellow:'#fac863',brightBlue:'#6699cc',brightMagenta:'#c594c5',brightCyan:'#5fb3b3',brightWhite:'#ffffff'},
  },
  'Panda Syntax':{
    mode:'dark',
    ui:{bg:'#292a2b',sidebarBg:'#212223',border:'#3b3d3f',accent:'#19f9d8',text:'#e6e6e6',textMuted:'#676b79',textBright:'#ffffff',textDim:'#3b3d3f',danger:'#ff2c6d',accentBorder:'#4a4d52'},
    terminal:{background:'#292a2b',foreground:'#e6e6e6',cursor:'#ff2c6d',cursorAccent:'#292a2b',selectionBackground:'#4a4d52',selectionForeground:'#ffffff',black:'#1f1f20',red:'#ff2c6d',green:'#19f9d8',yellow:'#ffb86c',blue:'#45a9f9',magenta:'#ff75b5',cyan:'#6fc1ff',white:'#e6e6e6',brightBlack:'#676b79',brightRed:'#ff4b82',brightGreen:'#34fbdd',brightYellow:'#ffcc95',brightBlue:'#6fc1ff',brightMagenta:'#ff9ac1',brightCyan:'#7ad6f7',brightWhite:'#ffffff'},
  },
  'LaserWave':{
    mode:'dark',
    ui:{bg:'#27212e',sidebarBg:'#1e1a24',border:'#3f3849',accent:'#eb64b9',text:'#ffffff',textMuted:'#91889b',textBright:'#ffffff',textDim:'#3f3849',danger:'#f97e72',accentBorder:'#b381c5'},
    terminal:{background:'#27212e',foreground:'#ffffff',cursor:'#eb64b9',cursorAccent:'#27212e',selectionBackground:'#4d4152',selectionForeground:'#ffffff',black:'#39273c',red:'#f97e72',green:'#74dfc4',yellow:'#ffe261',blue:'#40b4c4',magenta:'#eb64b9',cyan:'#b381c5',white:'#ffffff',brightBlack:'#91889b',brightRed:'#ff9b8f',brightGreen:'#8ff7dd',brightYellow:'#fff287',brightBlue:'#59d3e3',brightMagenta:'#ff7fd0',brightCyan:'#cb9fdd',brightWhite:'#ffffff'},
  },
  'Zenburn':{
    mode:'dark',
    ui:{bg:'#3f3f3f',sidebarBg:'#383838',border:'#545454',accent:'#8cd0d3',text:'#dcdccc',textMuted:'#9f9f8f',textBright:'#ffffff',textDim:'#4d4d4d',danger:'#cc9393',accentBorder:'#709080'},
    terminal:{background:'#3f3f3f',foreground:'#dcdccc',cursor:'#dcdccc',cursorAccent:'#3f3f3f',selectionBackground:'#545454',selectionForeground:'#ffffff',black:'#4d4d4d',red:'#cc9393',green:'#7f9f7f',yellow:'#f0dfaf',blue:'#8cd0d3',magenta:'#dc8cc3',cyan:'#93e0e3',white:'#dcdccc',brightBlack:'#709080',brightRed:'#dca3a3',brightGreen:'#bfebbf',brightYellow:'#f0efd0',brightBlue:'#94bff3',brightMagenta:'#ec93d3',brightCyan:'#93e0e3',brightWhite:'#ffffff'},
  },
  'Tomorrow Night Eighties':{
    mode:'dark',
    ui:{bg:'#2d2d2d',sidebarBg:'#262626',border:'#515151',accent:'#6699cc',text:'#cccccc',textMuted:'#999999',textBright:'#ffffff',textDim:'#393939',danger:'#f2777a',accentBorder:'#666666'},
    terminal:{background:'#2d2d2d',foreground:'#cccccc',cursor:'#cccccc',cursorAccent:'#2d2d2d',selectionBackground:'#515151',selectionForeground:'#ffffff',black:'#2d2d2d',red:'#f2777a',green:'#99cc99',yellow:'#ffcc66',blue:'#6699cc',magenta:'#cc99cc',cyan:'#66cccc',white:'#cccccc',brightBlack:'#999999',brightRed:'#f2777a',brightGreen:'#99cc99',brightYellow:'#ffcc66',brightBlue:'#6699cc',brightMagenta:'#cc99cc',brightCyan:'#66cccc',brightWhite:'#ffffff'},
  },
  'Gruvbox Material':{
    mode:'dark',
    ui:{bg:'#32302f',sidebarBg:'#2a2827',border:'#45403d',accent:'#a9b665',text:'#d4be98',textMuted:'#928374',textBright:'#ddc7a1',textDim:'#45403d',danger:'#ea6962',accentBorder:'#5a524c'},
    terminal:{background:'#32302f',foreground:'#d4be98',cursor:'#d4be98',cursorAccent:'#32302f',selectionBackground:'#45403d',selectionForeground:'#ddc7a1',black:'#32302f',red:'#ea6962',green:'#a9b665',yellow:'#d8a657',blue:'#7daea3',magenta:'#d3869b',cyan:'#89b482',white:'#d4be98',brightBlack:'#928374',brightRed:'#ea6962',brightGreen:'#a9b665',brightYellow:'#d8a657',brightBlue:'#7daea3',brightMagenta:'#d3869b',brightCyan:'#89b482',brightWhite:'#ddc7a1'},
  },
  'Mariana':{
    mode:'dark',
    ui:{bg:'#343d46',sidebarBg:'#2d353d',border:'#4e5a65',accent:'#f9ae58',text:'#d8dee9',textMuted:'#7f8c98',textBright:'#ffffff',textDim:'#4e5a65',danger:'#ec5f67',accentBorder:'#65737e'},
    terminal:{background:'#343d46',foreground:'#d8dee9',cursor:'#f9ae58',cursorAccent:'#343d46',selectionBackground:'#4e5a65',selectionForeground:'#ffffff',black:'#3b4550',red:'#ec5f67',green:'#99c794',yellow:'#fac863',blue:'#6699cc',magenta:'#c594c5',cyan:'#5fb3b3',white:'#d8dee9',brightBlack:'#65737e',brightRed:'#ec5f67',brightGreen:'#99c794',brightYellow:'#f9ae58',brightBlue:'#6699cc',brightMagenta:'#c594c5',brightCyan:'#5fb3b3',brightWhite:'#ffffff'},
  },
  'Hopscotch':{
    mode:'dark',
    ui:{bg:'#322931',sidebarBg:'#2a232a',border:'#433b42',accent:'#fd8b19',text:'#b9b5b8',textMuted:'#797379',textBright:'#ffffff',textDim:'#433b42',danger:'#dd464c',accentBorder:'#5c545b'},
    terminal:{background:'#322931',foreground:'#b9b5b8',cursor:'#fd8b19',cursorAccent:'#322931',selectionBackground:'#5c545b',selectionForeground:'#ffffff',black:'#322931',red:'#dd464c',green:'#8fc13e',yellow:'#fdcc59',blue:'#1290bf',magenta:'#c85e7c',cyan:'#149b93',white:'#b9b5b8',brightBlack:'#797379',brightRed:'#dd464c',brightGreen:'#8fc13e',brightYellow:'#fdcc59',brightBlue:'#1290bf',brightMagenta:'#c85e7c',brightCyan:'#149b93',brightWhite:'#ffffff'},
  },
  // Light themes
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

var currentThemeName='Tokyo Night';
var customTheme=null; // {ui:{...}, terminal:{...}} or null

// Set TOPTS initial theme now that THEMES is defined
TOPTS.theme = THEMES['Tokyo Night'].terminal;
