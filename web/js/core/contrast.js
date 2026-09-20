/**
 * Dongminal — 색 대비와 파생 (DESIGN_TOKENS_SRS FR-TOK-8~17).
 *
 * 테마 팔레트는 **정본이다** (D-TOK-1 / FR-TOK-16). Nord 의 `#4c566a` 는 Nord
 * 그 자체이므로 54벌을 손으로 올리지 않는다. 대신 여기서 **파생한다** — 원시
 * 팔레트 값을 앵커 쪽으로 섞어 바닥을 넘는 **최초의** 값을 찾는다.
 *
 * ## 왜 의존이 0 인가
 *
 * **게이트와 런타임이 같은 함수를 불러야 하기 때문이다** (D-TOK-5). 게이트가
 * 값을 다시 계산하면 둘이 갈라지고, 갈라진 순간 **게이트는 초록인데 화면은
 * 미달**이 된다 — M6 "비싸게 배운 것 9" 와 같은 부류다. `scripts/` 의 게이트와
 * `web/js/test/` 의 단위 검사가 브라우저 없이 이 파일을 싣는다.
 *
 * 그래서 상수도 참조하지 않는다. 바닥과 스텝은 이 파일이 소유한다.
 *
 * ## `hexRgb`·`mixHex` 가 여기 있는 이유
 *
 * `core/helpers.js` 에 있던 것을 **옮겼다** (복사가 아니다). 고전 스크립트는 하나의
 * 전역 렉시컬 환경을 공유하므로 같은 이름을 두 파일에 두면 뒤가 앞을 덮는다 —
 * M6 §4-A-2 가 `_setFocus` 승격에서 무한 재귀로 겪은 그 일이다. 이 파일은
 * `helpers.js` **앞에** 실린다 (`index.html`).
 */

/**
 * FR-TOK-11 / D-TOK-4 — 바닥은 **사다리다.**
 *
 * 셋에 같은 바닥 4.5 를 주면 안 되는 이유는 실측이다: 가장 흐리던 것(`textDim`,
 * 대비 중앙값 1.28)이 가장 많이 올라가 **중간 단계를 추월한다.** 테마 54종 중
 * **34종**에서 `hint > muted` 가 됐다 — 흐리라고 만든 색이 더 진해진다.
 *
 * 사다리는 54/54 에서 세 단계를 지킨다 (간격 최소 0.56 · 1.04).
 *
 * `text` 의 7.0 은 접근성을 위해 고른 값이 **아니다** — 아래 두 단계가 숨 쉴
 * 공간이다. 팔레트 중앙값이 이미 9.84 라 손대는 테마는 13/54 뿐이다.
 */
const CONTRAST_FLOORS = {
  hint: 4.5,   // WCAG 1.4.3 본문 하한
  muted: 5.5,
  text: 7.0,
  // `--text-bright` 의 **하한**일 뿐이다. 실제 바닥은 그 테마에서 파생된
  // `--text` 가 올린다 (`deriveContrastTokens`) — 아래 주석을 본다.
  bright: 7.0,
  strong: 4.5, // 글자로 쓰는 강조색 (accent·danger·attn)
  ui: 3.0,     // WCAG 1.4.11 UI 컴포넌트·경계
};

/**
 * FR-TOK-12 — 섞는 비율의 눈금. 이분 탐색을 쓰지 않는다: **결정론과 재현이
 * 정밀도보다 중요하고**, 최대 오차는 한 눈금이다.
 */
const CONTRAST_STEP = 0.05;

function hexRgb(hex){if(typeof hex!=='string'||hex[0]!=='#'||hex.length<7)return null;return{r:parseInt(hex.slice(1,3),16),g:parseInt(hex.slice(3,5),16),b:parseInt(hex.slice(5,7),16)}}

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

/** WCAG 2.1 상대휘도. 흑 0 · 백 1 이 정확히 나온다. */
function relLuminance(hex){
  const c=hexRgb(hex);
  if(!c) return 0;
  const ch=v=>{v/=255;return v<=.03928?v/12.92:Math.pow((v+.055)/1.055,2.4)};
  return .2126*ch(c.r)+.7152*ch(c.g)+.0722*ch(c.b);
}

/** WCAG 2.1 대비비. 순서와 무관하고 1~21 사이다. */
function contrastRatio(a,b){
  const x=relLuminance(a),y=relLuminance(b);
  const hi=x>y?x:y, lo=x>y?y:x;
  return (hi+.05)/(lo+.05);
}

/**
 * FR-TOK-8·9 — `raw` 를 `anchor` 쪽으로 섞어 **`bgs` 전부**에서 `floor` 를 넘는
 * 최초의 값을 찾는다.
 *
 * 배경이 둘인 것이 요점이다 (FR-TOK-9): 같은 토큰이 본문과 사이드바 양쪽에
 * 쓰이므로 **나쁜 쪽**을 기준으로 삼아야 한다. 하나만 보면 사이드바에서 미달인
 * 색이 통과한다.
 *
 * @returns {{color:string, mix:number}} `mix` 는 섞은 비율(0 이면 손대지 않았다).
 */
function liftContrast(raw,anchor,bgs,floor){
  const ok=c=>bgs.every(bg=>contrastRatio(c,bg)>=floor);
  if(ok(raw)) return {color:raw,mix:0};
  const steps=Math.round(1/CONTRAST_STEP);
  for(let i=1;i<=steps;i++){
    const t=+(i*CONTRAST_STEP).toFixed(2);
    const c=mixHex(raw,anchor,t);
    if(ok(c)) return {color:c,mix:t};
  }
  // **닿지 못하는 팔레트가 있다.** 배경이 중간 밝기면(가령 `#808080`) 흰색도
  // 검은색도 7.0 에 미치지 못한다 — 그 배경 위에서 그 대비는 존재하지 않는다.
  // 내장 테마 54종에는 없고 `check-contrast.mjs` 가 새로 들어오는 것을 막지만,
  // 사용자 지정 테마는 게이트를 지나지 않는다 (FR-TOK-17). 그때는 **닿을 수 있는
  // 가장 먼 곳**을 준다 — 바닥을 못 넘는 것과 원래 색 그대로 두는 것 중에는
  // 앞이 낫다.
  return {color:anchor,mix:1};
}

/**
 * FR-TOK-10 / D-TOK-3 — 섞어 갈 방향.
 *
 * 배경 반대편 극단(흰색/검은색)으로 바로 가지 않는 이유는 **색상을 잃기**
 * 때문이다 — Gruvbox 의 흐린 글자가 회색이 되면 Gruvbox 가 아니다.
 * `textBright` 는 그 테마가 스스로 고른 "가장 또렷한 글자" 이므로 그리로 섞으면
 * 테마 안에 머문다. 실측 54종 중 53종이 여기서 멎고, 닿지 않는 1종만 내려간다.
 *
 * 내려갈 때 **모드를 보지 않는다.** 탐침이 그 이유를 드러냈다: 배경이 `#808080`
 * 이면 검은색이 5.32 인데 흰색은 3.95 다 — 모드가 `dark` 라는 이유로 흰색을
 * 고르면 더 나쁜 쪽을 고르게 된다. 모드는 배경의 밝기를 **짐작한** 값이고,
 * 여기서는 짐작할 필요 없이 **재면 된다**.
 *
 * `mode` 는 동률일 때만 쓴다 — 대비가 같으면 테마가 스스로 밝힌 쪽을 따른다.
 */
/**
 * FR-TOK-5 — `--bg-alt`. 표 머리·그룹 머리가 앉는 표면이고, 정의된 적이 없어
 * 네 자리가 **투명으로 떨어지고 있었다** (`UX-5`).
 *
 * `--border` 쪽으로 섞지 않는다: 테마에 따라 `border` 가 `bg` 와 거의 같아
 * 표면이 사라진다 (실측 최소 1.001 — 없는 것과 같다). `text` 쪽으로 섞으면
 * 54종 전부에서 1.067~1.202 로 **고르게** 벌어진다. 밝은 테마에서는 어두워지고
 * 어두운 테마에서는 밝아지는 것도 자동으로 따라온다.
 */
const BG_ALT_MIX=.06;

/**
 * FR-TOK-9 — 글자가 놓이는 배경 **전부**. 하나라도 빠뜨리면 그 표면 위에서만
 * 조용히 미달이 된다: `--bg-alt` 를 넣기 전 실측에서 `--text-hint` 가 그 위에서
 * 4.33 까지 떨어졌다.
 */
function referenceBackgrounds(ui){
  return [ui.bg,ui.sidebarBg,mixHex(ui.bg,ui.text,BG_ALT_MIX)].filter(Boolean);
}

function pickContrastAnchor(ui,mode){
  const bgs=referenceBackgrounds(ui);
  const floor=CONTRAST_FLOORS.text;
  if(ui.textBright&&bgs.every(bg=>contrastRatio(ui.textBright,bg)>=floor)) return ui.textBright;
  const worst=c=>bgs.reduce((m,bg)=>Math.min(m,contrastRatio(c,bg)),Infinity);
  const w=worst('#ffffff'),b=worst('#000000');
  if(w>b) return '#ffffff';
  if(b>w) return '#000000';
  return mode==='light'?'#000000':'#ffffff';
}

/**
 * FR-TOK-2·4 — 팔레트에서 글자 토큰을 세운다. **팔레트는 읽기만 한다**
 * (FR-TOK-16).
 *
 * `attn` 은 팔레트가 아니라 터미널 색에서 골라 오므로(`pickAttnColor`) 인자로
 * 받는다 — 주지 않으면 `attnText` 도 내지 않는다.
 */
/**
 * 구문 강조가 쓰는 ANSI 이름 여섯 (FR-DRV-13d).
 *
 * `style-docrender.css` 가 *"터미널 팔레트에서 파생하므로 편집기·터미널·렌더가
 * 같은 색 세계를 쓴다"* 고 적어 두고 **그 파생을 두지 않았다** — 여섯 다
 * `var(--term-magenta,var(--accent))` 의 폴백으로 떨어지고 있었다. 주석이 약속한
 * 것과 화면이 하는 일이 달랐다는 뜻이다.
 *
 * `bright*` 를 먼저 보는 것은 터미널 관행이다 — 어두운 배경에서 기본 ANSI 는
 * 대체로 너무 어둡다.
 */
/**
 * WORDING_COLOR_SRS FR-WRD-30·31 — **그늘**(백드롭·그림자)의 파생.
 *
 * 다크 테마의 그늘은 검정이다: 팔레트의 색이 아니라 **빛이 없는 상태**다.
 * 라이트 테마의 그늘은 검정이 아니라 그 팔레트의 **잉크**(`ui.text`)다 — 밝은
 * 종이 위의 `0 8px 32px` 50% 검정은 "떠 있다" 가 아니라 "더럽다" 로 읽힌다.
 *
 * **감사의 제안을 한 자리에서 정정했다** (규약 3-4). `AUDIT-design.md` §1-4 는
 * 라이트의 그늘로 `ui.textDim` 을 제안했지만, 이 저장소의 `textDim` 은 **글자가
 * 아니라 경계·채움**이고(FR-TOK-3 / D-TOK-2) 라이트 11종 실측에서 상대휘도가
 * **0.562~0.807** 이다 — 거의 흰색이라 그늘이 되지 못한다. 같은 11종의
 * `ui.text` 는 0.016~0.186 이다.
 *
 * **알파도 모드가 가른다.** 같은 알파를 라이트에 쓰면 색만 바꿔도 여전히 무겁다.
 *
 * `--shadow-*` 는 **전체 값**이다 (사용자 결정 2026-09-13, style.css:89~93) —
 * 뜻이 둘이고(화면에 붙은 것 `-1` · 떠 있는 것 `-2`) 그 뜻은 기하에 실린다.
 * 그래서 색만 주지 않고 값을 통째로 만든다.
 */
const SHADE_DARK='#000000';
const SHADE_ALPHA={
  dark:{backdrop:.6,soft:.4,s1:.4,s2:.5},
  light:{backdrop:.35,soft:.22,s1:.18,s2:.22},
};
function deriveShade(ui,mode){
  const light=mode==='light';
  const shade=light?ui.text:SHADE_DARK;
  const a=SHADE_ALPHA[light?'light':'dark'];
  const rgba=(c,al)=>{const p=hexRgb(c);return p?`rgba(${p.r},${p.g},${p.b},${al})`:c};
  return{
    '--backdrop':rgba(shade,a.backdrop),
    '--backdrop-soft':rgba(shade,a.soft),
    '--shadow-1':`0 2px 10px ${rgba(shade,a.s1)}`,
    '--shadow-2':`0 8px 32px ${rgba(shade,a.s2)}`,
  };
}

const SYNTAX_KEYS=['red','green','yellow','blue','magenta','cyan'];

function deriveContrastTokens(ui,mode,attn,term){
  const bgs=referenceBackgrounds(ui);
  const anchor=pickContrastAnchor(ui,mode);
  const at=(raw,floor)=>liftContrast(raw,anchor,bgs,floor).color;
  const worst=c=>bgs.reduce((m,bg)=>Math.min(m,contrastRatio(c,bg)),Infinity);

  const text=at(ui.text,CONTRAST_FLOORS.text);
  /**
   * `--text-bright` 의 바닥은 **고정값이 아니다.**
   *
   * `--text` 를 7.0 까지 올리고 나면 팔레트의 `textBright` 가 그보다 흐릴 수
   * 있다 — 실측 6/54 가 그랬고, Solarized Light 의 `#586e75` 는 4.39 로 AA
   * 자체를 못 넘었다. "가장 또렷한 글자" 가 본문보다 흐린 것은 이름이 거짓말을
   * 하는 상태이고, 그 토큰은 `color:` 로 103번 쓰인다.
   *
   * 그래서 바닥을 **파생된 `--text` 가 실제로 닿은 곳**으로 올린다.
   *
   * 그것으로도 닿지 못하는 자리가 하나 남는다: **앵커가 `textBright` 자신일
   * 때**다. 그리로 섞는 것은 제자리걸음이므로 값이 움직이지 않는다. Monokai 가
   * 그렇다 — 팔레트의 `#f8f8f0`(13.93)이 `#f8f8f2`(13.94)보다 0.01 흐리다.
   * **팔레트 자신의 모순**이고 파생이 만든 것이 아니다. 그때는 둘을 합친다:
   * "가장 또렷한 글자" 가 본문보다 흐릴 수는 없으니, 본문이 곧 가장 또렷한
   * 글자다.
   */
  const brightFloor=Math.max(CONTRAST_FLOORS.bright,worst(text));
  let textBright=at(ui.textBright,brightFloor);
  if(worst(textBright)<worst(text)) textBright=text;

  const out={
    anchor,
    // 파생이 이것을 **소유한다** — 글자의 참조 배경이기도 하므로 다른 자리에서
    // 따로 계산하면 두 값이 갈린다 (FR-TOK-5·9).
    bgAlt:mixHex(ui.bg,ui.text,BG_ALT_MIX),
    text,
    textBright,
    textMuted:at(ui.textMuted,CONTRAST_FLOORS.muted),
    textHint:at(ui.textDim,CONTRAST_FLOORS.hint),
    accentText:at(ui.accent,CONTRAST_FLOORS.strong),
    dangerText:at(ui.danger,CONTRAST_FLOORS.strong),
    /**
     * FR-TOK-25 — 포커스 링. 글자가 아니라 **UI 컴포넌트**이므로 바닥이 3:1 이다
     * (WCAG 1.4.11). `--accent-text`(4.5)와 나누는 이유가 그것이다: 링에 글자
     * 바닥을 주면 52/54 에서 이유 없이 더 바랜다 — 필요한 만큼만 움직인다.
     *
     * 실측으로 원시 `--accent` 가 3:1 을 못 넘는 테마는 둘이다 (Ayu Light 2.62 ·
     * Everforest Light 2.50). 그 둘에서 포커스가 보이지 않았다.
     */
    focusRing:at(ui.accent,CONTRAST_FLOORS.ui),
  };
  if(attn) out.attnText=at(attn,CONTRAST_FLOORS.strong);
  if(term){
    // 구문 강조도 **글자다** — 같은 바닥을 받는다 (FR-A11Y-6). 코드 블록의
    // 배경(`color-mix(text 6%, bg)`)이 `--bg-alt` 와 사실상 같은 색이므로
    // 참조 배경 셋이 그 자리를 이미 덮는다.
    out.syntax={};
    for(const k of SYNTAX_KEYS){
      const raw=term['bright'+k[0].toUpperCase()+k.slice(1)]||term[k];
      if(raw) out.syntax[k]=at(raw,CONTRAST_FLOORS.strong);
    }
  }
  return out;
}
