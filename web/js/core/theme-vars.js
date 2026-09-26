/**
 * Remote Terminal — 테마 변수 계산·적용
 *
 * OPTIMIZE_REFACTOR_SRS FR-OPT-11-6 (FEC-24): 옛 helpers.js 에서 주제별로 갈라 왔다. 본문은
 * 바꾸지 않았다. index.html 이 옛 helpers.js 자리에 같은 순서로 싣는다.
 */

// ── Theme helpers ──

const UI_LABELS={bg:'Background',sidebarBg:'Sidebar',border:'Border',accent:'Accent',text:'Text',textMuted:'Muted',textBright:'Bright',textDim:'Dim',danger:'Danger',accentBorder:'Accent Bd'};
const TERM_LABELS={background:'BG',foreground:'FG',cursor:'Cursor',selectionBackground:'Select',black:'Black',red:'Red',green:'Green',yellow:'Yellow',blue:'Blue',magenta:'Magenta',cyan:'Cyan',white:'White',brightBlack:'BrBlk',brightRed:'BrRed',brightGreen:'BrGrn',brightYellow:'BrYlw',brightBlue:'BrBlu',brightMagenta:'BrMag',brightCyan:'BrCyn',brightWhite:'BrWht'};

function hexToRgba(hex,a){const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);return`rgba(${r},${g},${b},${a})`}
// 알림 강조색: 팔레트(테마 terminal 색) 중 accent(포커스)와 가장 대비되는 색을 고른다.
// 색을 하드코딩하지 않고, accent 가 노랑/주황인 테마에서도 포커스와 겹치지 않게 한다(FR-PAN-10).
function pickAttnColor(theme){
  const T=theme.terminal||{};
  // WORDING_COLOR_SRS FR-WRD-36: 최후 폴백도 **테마 안**이다.
  //   이전 동작: `'#e0af68'`(Tokyo Night 의 yellow) — 팔레트가 없는 테마에서
  //             54종과 무관한 한 색이 섰다
  //   새  동작: 그 테마의 `accent` 로 떨어진다
  //   이유:     닿는 일이 드문 자리여도 색이 테마 밖으로 나가면 게이트가 재는
  //             면적이 줄고, 그 자리는 다음에 또 는다
  const fallback=T.brightYellow||T.yellow||(theme.ui&&theme.ui.accent);
  const acc=hexRgb(theme.ui&&theme.ui.accent);
  const cands=[T.brightYellow||T.yellow,T.brightMagenta||T.magenta,T.brightCyan||T.cyan,T.brightGreen||T.green].filter(Boolean);
  if(!acc||!cands.length) return fallback;
  let best=cands[0],bestD=-1;
  for(const c of cands){const rgb=hexRgb(c);if(!rgb)continue;const d=(rgb.r-acc.r)**2+(rgb.g-acc.g)**2+(rgb.b-acc.b)**2;if(d>bestD){bestD=d;best=c}}
  return best;
}

// `hexRgb`·`mixHex` 는 **`core/contrast.js` 로 옮겼다** (DESIGN_TOKENS_SRS
// FR-TOK-14 / D-TOK-5). 게이트와 런타임이 같은 파생을 부르려면 그 계산이 의존 0
// 인 파일에 있어야 하고, 고전 스크립트는 전역을 공유하므로 여기 사본을 남기면
// 뒤가 앞을 덮는다 (M6 §4-A-2). `contrast.js` 가 이 파일 앞에 실린다.
const BORDER_STRONG_MIX=.35;
// UIUX_OVERHAUL_SRS FR-HIE-1: 경계의 아래 단. `--border-strong` 이 text 쪽으로
// 가듯 이쪽은 bg 쪽으로 간다 — 사다리의 방향이 하나여야 "선 하나가 위계 하나"
// (§3.3 원칙 2)가 선다. 값이 `.35` 보다 큰 것은 거리가 달라서다: border→text 는
// 멀고 border→bg 는 가깝다. 실측(54종)에서 `--border` 의 대비 1.09~1.74 가
// 1.05~1.39 로 내려간다 — 행 사이는 속삭이고 칸의 경계가 말한다.
const BORDER_WEAK_MIX=.45;
// SLOT_TITLE_BOUNDARY_SRS FR-STB-21·22: 슬롯 경계색. `--border-strong` 과 같은
// 방식이되 섞는 상대가 accent 다 — border 쪽은 "이것은 경계다", accent 쪽은 "이
// 경계는 주목을 요구한다" 는 뜻이다. terminal(ANSI) 팔레트에서 뽑지 않는 이유는
// 그 색들이 터미널 텍스트를 위해 고른 것이지 UI 조화를 위해 고른 것이 아니어서다.
// 값을 바꿀 때는 border·accent·bg 세 축의 거리를 함께 확인한다 (FR-STB-23).
const SLOT_EDGE_MIX=.55;

/**
 * SYSTEM_THEME_FOLLOW_SRS FR-STF-6: 맵 **계산**은 적용과 분리된다 — 반대 모드의
 * 슬롯은 화면에 닿지 않고 계산돼 캐시로만 간다 (FR-STF-5).
 */
function themeVarsOf(theme){
  const ui=theme.ui;
  // 주의 알림색은 팔레트 중 accent(포커스)와 가장 대비되는 색 — 포커스와 겹치지 않게 (FR-PAN-10)
  const attn=pickAttnColor(theme);
  /**
   * DESIGN_TOKENS_SRS FR-TOK-13: 대비 파생은 **여기 한 자리**에서만 일어난다.
   *
   * 팔레트는 정본이므로 고치지 않고(D-TOK-1 / FR-TOK-16), 글자 토큰만 바닥을
   * 넘도록 끌어올린다. 계산은 `core/contrast.js` 가 하고 게이트도 **같은
   * 함수**를 부른다 (D-TOK-5) — 둘이 갈라지면 게이트는 초록인데 화면은 미달이
   * 된다.
   */
  const aa=deriveContrastTokens(ui,theme.mode,attn,theme.terminal);
  /**
   * BOOT_SCREEN_SRS FR-BTS-1 / D-4: 세우는 변수를 **맵으로 한 번에** 만든다.
   *
   * 첫 페인트 선주입(`index.html` 의 head 인라인)이 이 맵을 그대로 다시 세우기
   * 때문이다 — 파생값(`mixHex`·`pickAttnColor`·`deriveContrastTokens`)의 계산은
   * **여기 한 자리**에만 남고, 선주입은 그것을 다시 계산하지 않는다. 그래서
   * 파생 비용이 첫 페인트에 실리지 않는다 (NFR-TOK-2).
   */
  const vars={
    '--bg':ui.bg,
    '--sidebar-bg':ui.sidebarBg,
    // 표 머리·그룹 머리의 표면 (FR-TOK-5). 네 자리가 이것을 읽으면서 정의된
    // 적이 없어 **투명으로 떨어지고 있었다** (`UX-5`).
    '--bg-alt':aa.bgAlt,
    '--border':ui.border,
    '--accent':ui.accent,
    // 글자 넷은 파생이다 (FR-TOK-2·2a). `--text-dim` 만 원시값으로 남는다 —
    // 그것은 글자 토큰이 아니라 **경계·채움**용이다 (FR-TOK-3 / D-TOK-2).
    '--text':aa.text,
    '--text-muted':aa.textMuted,
    '--text-bright':aa.textBright,
    '--text-hint':aa.textHint,
    '--text-dim':ui.textDim,
    '--danger':ui.danger,
    // 강조색을 **글자로** 쓰는 자리 (FR-TOK-4). 경계·배경으로 쓰는 `--accent`·
    // `--danger`·`--attn` 은 바닥이 다르므로(3:1) 원본 그대로 둔다.
    '--accent-text':aa.accentText,
    '--danger-text':aa.dangerText,
    '--attn-text':aa.attnText,
    // FR-TOK-25: 포커스 링. 바닥이 3:1 인 것은 글자가 아니라 UI 컴포넌트여서다
    // (WCAG 1.4.11). `--accent` 를 그대로 쓰면 밝은 테마 둘에서 링이 보이지 않는다.
    '--focus-ring':aa.focusRing,
    '--accent-border':ui.accentBorder,
    '--border-weak':mixHex(ui.border,ui.bg,BORDER_WEAK_MIX),
    '--border-strong':mixHex(ui.border,ui.text,BORDER_STRONG_MIX),
    '--slot-edge':mixHex(ui.border,ui.accent,SLOT_EDGE_MIX),
    '--accent-hover':hexToRgba(ui.accent,.1),
    '--accent-active':hexToRgba(ui.accent,.12),
    '--accent-subtle':hexToRgba(ui.accent,.08),
    // DESIGN_TOKENS_SRS FR-TOK-7: 위험 틴트도 파생이다. 종전에는 CSS 11곳에
    // Tokyo Night 의 `rgba(247,118,142,α)` 가 박혀 있어 나머지 53종에서 어긋났다.
    '--danger-subtle':hexToRgba(ui.danger,.12),
    '--danger-strong':hexToRgba(ui.danger,.2),
    '--attn':attn,
    '--attn-subtle':hexToRgba(attn,.16),
    '--attn-glow':hexToRgba(attn,.5),
    /**
     * WORDING_COLOR_SRS FR-WRD-30·31: 백드롭과 그림자도 파생이다.
     *
     *   이전 동작: `style.css` 의 `rgba(0,0,0,.4~.6)` 네 벌이 54종 전부에 걸렸다
     *             — 라이트 **11종**에서 모달 뒤가 60% 검정으로 덮였다
     *   새  동작: 그늘의 색과 알파를 **모드가 가른다**
     *   이유:     `style.css:95~97` 이 이미 *"테마별 파생이 필요해지면 그때 이
     *             토큰이 applyThemeObj 로 옮겨간다"* 고 예고했다. 이 이주는 그
     *             예고의 실행이지 결정의 번복이 아니다
     *
     * `--shadow-*` 가 **전체 값**(geometry 포함)이라는 사용자 결정(2026-09-13)은
     * 그대로다 — 뜻은 둘이고(붙은 것·떠 있는 것) 그 뜻이 값에 실려 있어야 한다.
     * 그래서 여기서도 색이 아니라 전체 값을 만든다 (FR-WRD-31).
     */
    ...deriveShade(ui,theme.mode),
  };
  // FR-DRV-13d: 구문 강조색을 **실제로** 터미널 팔레트에서 세운다. 그 주석이
  // 약속한 지 오래인데 파생이 없어 여섯 다 폴백으로 떨어지고 있었다.
  if(aa.syntax) for(const k in aa.syntax) vars['--term-'+k]=aa.syntax[k];
  return vars;
}

/** 시스템 모드 — `dark`/`light`. 선주입(`index.html`)이 같은 질의를 읽는다. */
function systemColorMode(){
  return (typeof matchMedia==='function'&&matchMedia('(prefers-color-scheme: dark)').matches)?'dark':'light';
}

/**
 * FR-OPT-11-7 (FEC-33): 터미널 검색의 일치 장식. 테마가 바뀔 때만 달라지므로
 * `applyThemeObj` 가 한 번 계산해 `searchDecor` 에 둔다 — 종전에는 키 입력마다
 * `getComputedStyle` 을 세 번 불렀다.
 */
var searchDecor=null;
function searchDecorOf(vars){
  const accent=vars['--accent'], danger=vars['--danger'];
  return {matchBackground:hexToRgba(accent,.4),matchBorder:vars['--accent-border'],
    activeMatchBackground:hexToRgba(danger,.5),activeMatchBorder:danger};
}

function applyThemeObj(theme){
  const ui=theme.ui;
  const vars=themeVarsOf(theme);
  searchDecor=searchDecorOf(vars);
  const s=document.documentElement.style;
  for(const k in vars) s.setProperty(k,vars[k]);
  // FR-BTS-2: 기록 실패는 다음 부팅의 첫 페인트가 기본값이 된다는 뜻일 뿐이다.
  // FR-STF-5: 추종이 켜져 있으면 **두 슬롯의 맵**을 캐시한다 — 선주입이 시스템
  // 모드로 하나를 고른다. 꺼져 있으면 종전 키 하나이고 스위치 키는 지운다.
  PrefStore.local.setJson(THEME_VARS_KEY,vars);
  if(typeof themeFollowSystem!=='undefined'&&themeFollowSystem&&THEMES[themeNameDark]&&THEMES[themeNameLight]){
    PrefStore.local.set(THEME_FOLLOW_KEY,'1');
    PrefStore.local.setJson(THEME_VARS_KEY+'.dark',themeVarsOf(THEMES[themeNameDark]));
    PrefStore.local.setJson(THEME_VARS_KEY+'.light',themeVarsOf(THEMES[themeNameLight]));
  }else PrefStore.local.remove(THEME_FOLLOW_KEY);
  TOPTS.theme=theme.terminal;
  document.getElementById('area').style.background=ui.bg;
  for(const p of app.tools.values()){if(p.term)p.term.options.theme=theme.terminal}
  if(typeof FileEditor!=='undefined'&&FileEditor.applyTheme) FileEditor.applyTheme();
  // FR-GIT-119: 레인 색은 테마 팔레트에서 파생한다 — 테마를 바꾸면 그래프도
  // 따라 바뀐다 (V47).
  if(typeof GitHistory!=='undefined'&&GitHistory.applyTheme) GitHistory.applyTheme();
}

function getCurrentTheme(){return customTheme||THEMES[currentThemeName]}
