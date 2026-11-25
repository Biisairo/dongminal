/**
 * Remote Terminal — theme definitions
 *
 * PERF 3.4.12.6: 부팅 표는 기본 두 테마(Tokyo Night·GitHub Light)뿐이다. 나머지는 `themes-catalog.js`(`themes` 묶음)가 더한다.
 */

const THEMES={
  'Tokyo Night':{
    mode:'dark',
    ui:{bg:'#1a1b26',sidebarBg:'#16161e',border:'#292e42',accent:'#7aa2f7',accent2:'#9ece6a',text:'#a9b1d6',textMuted:'#565f89',textBright:'#c0caf5',textDim:'#414868',danger:'#f7768e',accentBorder:'#3d59a1'},
    terminal:{background:'#1a1b26',foreground:'#a9b1d6',cursor:'#c0caf5',cursorAccent:'#1a1b26',selectionBackground:'#33467c',selectionForeground:'#c0caf5',black:'#15161e',red:'#f7768e',green:'#9ece6a',yellow:'#e0af68',blue:'#7aa2f7',magenta:'#bb9af7',cyan:'#7dcfff',white:'#a9b1d6',brightBlack:'#414868',brightRed:'#f7768e',brightGreen:'#9ece6a',brightYellow:'#e0af68',brightBlue:'#7aa2f7',brightMagenta:'#bb9af7',brightCyan:'#7dcfff',brightWhite:'#c0caf5'},
  },
  'GitHub Light':{
    mode:'light',
    ui:{bg:'#ffffff',sidebarBg:'#f6f8fa',border:'#d0d7de',accent:'#0969da',accent2:'#1a7f37',text:'#1f2328',textMuted:'#656d76',textBright:'#1f2328',textDim:'#d8dee4',danger:'#cf222e',accentBorder:'#0969da'},
    terminal:{background:'#ffffff',foreground:'#1f2328',cursor:'#1f2328',cursorAccent:'#ffffff',selectionBackground:'#b6e3ff',selectionForeground:'#1f2328',black:'#24292f',red:'#cf222e',green:'#1a7f37',yellow:'#9a6700',blue:'#0969da',magenta:'#8250df',cyan:'#1b7c83',white:'#6e7781',brightBlack:'#57606a',brightRed:'#a40e26',brightGreen:'#116329',brightYellow:'#4d2d00',brightBlue:'#0550ae',brightMagenta:'#6639ba',brightCyan:'#3192aa',brightWhite:'#8c959f'},
  },
};

var currentThemeName='Tokyo Night';
// SYSTEM_THEME_FOLLOW_SRS FR-STF-1 / D-STF-1: 추종 스위치와 모드별 슬롯 둘.
// `currentThemeName` 을 없애지 않는다 — 추종이 꺼진 블롭은 그 이름 하나로 산다.
var themeFollowSystem=false;
var themeNameDark='Tokyo Night';
var themeNameLight='GitHub Light';
var customTheme=null; // {ui:{...}, terminal:{...}} or null
// THEME_SEED_COLOR_SRS FR-SEED-1: 메인색. `#rrggbb` 또는 '' (끔). 테마 바깥의 설정이다.
var seedColor='';

// Set TOPTS initial theme now that THEMES is defined
TOPTS.theme = THEMES['Tokyo Night'].terminal;
