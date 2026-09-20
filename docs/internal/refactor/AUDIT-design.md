# 감사: 디자인 시스템 (색·토큰·CSS)

> **읽기 전용 감사.** 소스는 한 줄도 고치지 않았다. 이 문서가 유일한 산출물이다.

- 대상: `refactor` 브랜치 `ba13ec92`
- 범위: `web/*.css` 6벌 (4,518줄) · `web/js/ui/themes.js` · `web/js/core/contrast.js` ·
  `web/js/**/*.js` 118벌 · `web/index.html`
- 기준선: 사용자 규칙 **"모든 색상은 테마에서 정해진 색을 조합하여 만들어야 한다."**
  즉 `themes.js` 의 `ui`·`terminal` 팔레트에서 파생된 CSS 변수만이 정당한 색의 출처다.

---

## 0. 요약

### 0.1 먼저 인정할 것 — 이 코드베이스는 이미 게이트가 있다

감사 착수 시 여섯 게이트를 실행했고 **전부 초록이다**:

| 게이트 | 결과 |
|---|---|
| `check-hardcoded-color.mjs` | ok — `:root` 밖 색 리터럴 **0** (선언 5,451개 읽음) |
| `check-css-vars.mjs` | ok — 읽기 94개 이름 전부 정의됨 |
| `check-z-index.mjs` | ok — 선언 36개 전부 층 토큰, 산술 0 |
| `check-font-size.mjs` | ok — 선언 364개 전부 토큰 |
| `check-contrast.mjs` | ok — 테마 54 × 토큰 7 × 배경 3, 바닥 미달 0 |
| `check-focus.mjs` | ok — 바탕 선택자 20개 전부 포커스 짝 있음 |

따라서 **이 감사의 값어치는 게이트가 면제하는 자리에 있다.** 게이트는 셋을
보지 않는다: ① `:root` 블록 **안**, ② `web/js/**` 와 `index.html`,
③ `web/vendor/` (`readdirSync('web')` 는 비재귀).

### 0.2 색상 위반 집계 — 전수

색 리터럴이 나타나는 모든 자리를 스크립트로 세었다 (`themes.js`·`contrast.js`
제외 — 그 둘은 팔레트 정본이다).

| 구역 | 리터럴 출현 | 정당 | **위반** |
|---|---:|---:|---:|
| `web/*.css` `:root` **밖** | 0 | 0 | **0** |
| `web/*.css` `:root` **안** | 42 | 32 (런타임 주입 폴백) | **10** |
| `web/js/**/*.js` | 13 | 2 | **11** |
| `web/index.html` | 4 | 0 | **4** |
| `web/vendor/xterm.css` | 3 | 3 (벤더) | 0 |
| **합계** | **62** | **37** | **25** |

**위반 25건**. 등급별로:

| 등급 | 건수 | 내용 |
|---|---:|---|
| **A — 실사용 화면이 깨진다** | **2** | `--git-st-add`(라이트 11종 파탄) · `file-editor.js` 의 `#f44` |
| **B — 다크 전제 상수** | **4** | `--backdrop`·`--backdrop-soft`·`--shadow-1`·`--shadow-2` |
| **C — 진단 도구(`?diag=1`)** | **9** | `diag.js` 가 주입하는 전체 스타일시트 |
| **D — 폴백·브랜드 중복** | **10** | `helpers.js` 폴백 1 · 부팅 브랜드 토큰 4 · SVG 중복 4 · `--doc-paper` 1 |

> `:root` 안 42 중 **32는 위반이 아니다.** `applyThemeObj`(`helpers.js:232~269`)가
> 이름 32개를 런타임에 덮어쓴다 — 이 값들은 첫 페인트용 기본 테마 파생 결과이고,
> 주석이 그렇게 적고 있으며 실제로 그렇다. 확인했다.

### 0.3 그 밖의 발견 요약

| # | 등급 | 제목 | 근거 수치 |
|---|---|---|---|
| 1 | **HIGH** | `--git-st-add` 가 Tokyo Night 초록으로 고정 | 라이트 테마 **11/11** 에서 1.26~1.83:1 (3:1 미달) |
| 2 | **HIGH** | 간격·반경·gap 에 토큰 체계가 없다 | padding 고유값 **99** · margin **47** · gap **15** · radius **13** |
| 3 | **HIGH** | `--mono` 토큰이 세워졌으나 이주가 안 끝났다 | `var(--mono)` **3회** vs 생 `monospace` **42회** |
| 4 | **MED** | `--ui-radius`·`--ui-gap` 도 같은 상태 | `var(--ui-radius)` 6 vs `4px` 42 / `var(--ui-gap)` 3 vs `6px` 45 |
| 5 | **MED** | 백드롭·그림자가 다크 전제 | `rgba(0,0,0,.4~.6)` 4벌 × 라이트 테마 11종 |
| 6 | **MED** | 게이트 셋이 `web/js/**` 를 안 본다 | `diag.js` 가 색 9 · `z-index:9999` · `font:10px` 를 동시에 우회 |
| 7 | **MED** | `line-height` px 고정 12곳이 `--fs-scale` 을 안 탄다 | 12 선언, 전부 `font-size:var(--fs-*)` 와 같은 규칙 안 |
| 8 | **LOW** | 키트의 탭 변형 2종이 죽어 있다 | `.ui-tabs-underline`·`.ui-tabs-side` 참조 0 |
| 9 | **LOW** | `boot-flow` 가 `left` 를 애니메이션한다 | 13개 키프레임 중 유일한 레이아웃 유발 |
| 10 | **INFO** | 선택자 깊이·특이도는 건강하다 | 4단 이상 선택자 **1개** · `!important` 실사용 13 (전부 주석 근거 있음) |

---

## 1. 색상 하드코딩 전수 조사 (최우선)

### [HIGH] 1-1. `--git-st-add` 가 Tokyo Night 의 초록으로 고정되어 라이트 테마 11종에서 읽히지 않는다

- **위치**
  - 정의: `web/style.css:148` — `--git-st-add:#9ece6a;`
  - 사용(글자): `web/style-git.css:538` `.git-file-st.st-add` · `web/style-git.css:545` `.git-file-st.st-new` ·
    `web/style-editor.css:184` `.ed-row.st-add .ed-name` · `web/style-git-views.css:706` `.git-sub-state[data-state="ok"]`
  - 사용(배경): `web/style-editor.css:464` `.fe-dd-add`
  - JS 매핑: `web/js/core/constants-editor.js:563` — `[ED_DD_ADD]:'--git-st-add'`
- **현상** — 값이 `themes.js` 의 Tokyo Night `terminal.green`(`#9ece6a`)과 같은 값인데
  파생이 아니라 리터럴이고, `applyThemeObj` 의 주입 맵(`helpers.js:232~269`)에 없다.
  즉 **54종 전부에서 이 한 값이 그대로 쓰인다.**
- **비용** — 실측(WCAG 2.1 상대휘도, 각 테마의 `ui.bg` 대비):

  | 테마 | 대비 |
  |---|---:|
  | Tokyo Night Light (`#d5d6db`) | **1.26:1** |
  | Gruvbox Light (`#fbf1c7`) | 1.61:1 |
  | Catppuccin Latte (`#eff1f5`) | 1.62:1 |
  | Rosé Pine Dawn (`#faf4ed`) | 1.67:1 |
  | Quiet Light (`#f5f5f5`) | 1.68:1 |
  | Solarized Light · Everforest Light (`#fdf6e3`) | 1.69:1 |
  | One Light (`#fafafa`) | 1.75:1 |
  | Ayu Light (`#fcfcfc`) | 1.78:1 |
  | GitHub Light · Vitesse Light (`#ffffff`) | 1.83:1 |

  **11/11 라이트 테마가 4.5:1 은 물론 3:1 조차 넘지 못한다.** `--text-dim` 이
  99번 글자로 쓰이면서 54종 어디서도 3:1 을 못 넘던 그 상태(`DESIGN_TOKENS_SRS` §2.1)와
  **정확히 같은 부류**이고, 그 문서가 고친 뒤에 남은 마지막 한 자리다.
  `check-contrast.mjs` 가 검사하는 7개 토큰(`scripts/check-contrast.mjs:35~47`)에
  이 이름이 없어 게이트가 조용히 초록이다.
- **제안** — **같은 저장소 안에 이미 선례가 있다.** `web/style-git-views.css:1011` 이
  똑같은 문제("전역 테마에 성공 색이 없다")를 이렇게 풀었다:

  ```css
  .run-view{--run-ok:var(--term-green)}
  ```

  `--term-green` 은 `deriveContrastTokens`(`contrast.js:226~235`)가 터미널 팔레트에서
  뽑아 **`CONTRAST_FLOORS.strong`(4.5) 로 끌어올린** 값이다. 그러므로:

  ```css
  /* style.css:148 */
  --git-st-add:var(--term-green);
  ```

  이 한 줄로 54/54 가 4.5:1 을 보장받는다 — 파생이 이미 그 일을 하고 있고,
  이 자리만 그 파생을 쓰지 않고 있었다. 주석(`style.css:142~147`)이 적은
  "전역 테마에 추가 색이 없으므로 값을 이 한 자리에서 정한다" 는 `--run-ok` 의
  선례가 생긴 뒤로는 낡았다.
- **덧** — `.fe-dd-add`(`style-editor.css:464`)는 이 색을 **배경**으로 쓴다.
  배경은 바닥이 3:1(WCAG 1.4.11)이므로 `--term-green` 으로 옮겨도 충분하다.
- **위험도**: LOW (한 줄, 게이트가 회귀를 잡는다) — 단 `--term-green` 을
  `check-contrast.mjs` 의 `CHECK` 배열에 넣어 게이트가 실제로 지키게 해야 한다.
- **공수**: S

### [MED] 1-2. `file-editor.js` 가 저장 실패 표시에 `#f44` 를 직접 쓴다

- **위치**: `web/js/ui/file-editor.js:842`
  ```js
  this.el.style.boxShadow = 'inset 0 0 0 2px #f44';
  ```
- **현상** — 저장 실패 플래시(500ms)의 붉은색이 테마와 무관하게 고정이다.
  테마의 `danger` 는 `#8c4351`(Tokyo Night Light) ~ `#ff2c6d`(Panda) 까지 폭이 넓고,
  `#f44` 는 그 어느 것도 아니다.
- **비용** — 화면의 다른 모든 위험 표시(`var(--danger)` 86곳)와 색이 어긋난다.
  라이트 테마의 흰 바탕에서 `#f44` 는 대비 3.7:1 로 2px 테두리로는 눈에 띄지 않는다.
  인라인 스타일이라 `check-hardcoded-color.mjs` 범위 밖이다.
- **제안** — 색을 JS 가 들지 않는다. CSS 에 한 줄을 두고 클래스를 토글한다:
  ```css
  /* style-editor.css */
  .fe-save-failed{box-shadow:inset 0 0 0 2px var(--danger)}
  ```
  ```js
  this.el.classList.add('fe-save-failed');
  TIMERS.after(500, () => this.el.classList.remove('fe-save-failed'), {...});
  ```
  `style.transition` 을 지우는 기존 정리 로직과도 어긋나지 않는다.
- **위험도**: LOW · **공수**: S

### [LOW] 1-3. `diag.js` 가 스타일시트 한 벌을 통째로 주입하며 색·층·글자 세 체계를 동시에 우회한다

- **위치**: `web/js/ui/diag.js:35~48` (진입: `web/index.html:823`, `?diag=1` 일 때만)
- **현상** — 색 리터럴 9개(`rgba(0,0,0,.88)`·`#0f0`×3·`#0a0`×2·`#020`·`#060`·`#030`),
  `z-index:9999`, `font:10px/1.35`.
- **비용** — 셋 다 이미 체계가 있다: `--z-edge:600`(`style.css:77`) 위에 9999 가
  얹히고, `--fs-*`(5종) 밖에 10px 이 서고, 색은 테마와 무관하다.
  `DESIGN_TOKENS_SRS` 가 "`.ed-find` 9997 · `.tc-copy` 9999 가 요점이다 — 위에
  있어야 한다는 뜻을 값으로 말할 방법이 없어서 큰 수를 골랐다" 고 쓴 바로 그 패턴이
  **JS 안에서 살아남아 있다.** 게이트 셋(`check-z-index`·`check-font-size`·
  `check-hardcoded-color`)이 전부 `web/*.css` 만 읽어서 보지 못한다.
- **제안** — 둘 중 하나. ① 이 스타일을 `web/style-diag.css` 로 떼어내 게이트 범위에
  넣고 토큰을 쓴다. ② 명시적 면제로 남기되 **파일 머리에 "이 파일은 테마 밖이다,
  까닭은 진단 도구가 테마 자체가 망가졌을 때도 보여야 하기 때문이다" 를 적고**
  게이트에 면제 목록을 둔다 — `check-hardcoded-color.mjs` 의 주석이 이미
  *"조용한 예외는 예외가 아니라 구멍이다"* 라고 적었다.
  ②가 더 정직하다: 진단 화면이 테마 파생에 의존하면 테마 파생이 깨졌을 때 못 읽는다.
- **위험도**: LOW · **공수**: S(②) / M(①)

### [MED] 1-4. 백드롭·그림자 4벌이 다크 전제 상수다

- **위치**: `web/style.css:98~101`
  ```css
  --backdrop:rgba(0,0,0,.6);
  --backdrop-soft:rgba(0,0,0,.4);
  --shadow-1:0 2px 10px rgba(0,0,0,.4);
  --shadow-2:0 8px 32px rgba(0,0,0,.5);
  ```
- **현상** — 주입 맵에 없다. 54종 전부에서 검정이다.
  `style.css:95~97` 의 주석이 이것을 **이미 알고 유예했다**:
  > "라이트 테마에서 검정 그림자가 무거운 것은 이 문서의 범위가 아니다 (§8) —
  > 여기 값은 테마와 무관한 상수이고, 테마별 파생이 필요해지면 그때 이 토큰이
  > `applyThemeObj` 로 옮겨간다."
- **비용** — 라이트 테마 **11종**에서 모달 뒤가 60% 검정으로 덮인다. 사용처 전수:

  | 토큰 | 사용처 |
  |---|---|
  | `--backdrop` (4) | `.ui-modal`(`style-kit.css:136`) · 드롭 오버레이(`style.css:949`) · `style.css:996` · `#drawer-backdrop`(`style.css:1281`) |
  | `--backdrop-soft` (2) | `.pn-dimmed .pn-body>.pn-dim-hint`(`style.css:1014`) · `style-editor.css:231` |
  | `--shadow-1`·`--shadow-2` | `.ui-modal-box`·`.ui-menu`·`.ui-size-box` 등 |

  밝은 종이 위의 `0 8px 32px` 50% 검정 그림자는 "떠 있다" 가 아니라 "더럽다" 로 읽힌다.
- **제안** — 파생으로 옮긴다. `themeVarsOf` 에 네 줄:
  ```js
  // 그림자의 색은 그 테마의 "가장 어두운 쪽" 이다 — 라이트 테마에서는
  // 검정이 아니라 팔레트의 textDim 계열이 종이 위에 놓이는 그늘이다.
  const shade = t.mode === 'light' ? ui.textDim : '#000000';
  '--backdrop':      hexToRgba(shade, t.mode === 'light' ? .35 : .6),
  '--backdrop-soft': hexToRgba(shade, t.mode === 'light' ? .22 : .4),
  '--shadow-1':      `0 2px 10px ${hexToRgba(shade, t.mode === 'light' ? .18 : .4)}`,
  '--shadow-2':      `0 8px 32px ${hexToRgba(shade, t.mode === 'light' ? .22 : .5)}`,
  ```
  `hexToRgba` 는 `helpers.js:181` 에 이미 있다. 알파를 모드로 가르는 것이
  요점이다 — 라이트에서 같은 알파를 쓰면 여전히 무겁다.
- **주의** — `--shadow-1/2` 는 **전체 값**(geometry 포함)이라는 결정이
  `style.css:89~93` 에 있다(사용자 결정 2026-09-13). 그 결정을 뒤집지 말고
  **JS 쪽에서도 전체 값을 만들어 주입**해야 한다. 위 예시가 그렇게 쓰여 있다.
- **위험도**: MED (54종 × 모달 7벌의 겉모습이 움직인다. 라이트 11종만 바뀌지만
  눈으로 확인이 필요하다) · **공수**: M

### [LOW] 1-5. 부팅 브랜드 색이 `:root` 와 인라인 SVG 로 갈라져 중복된다

- **위치**
  - `web/style.css:1537~1545` — `--boot-brand:#4F8461` · `--boot-brand-lit:#6fae83` ·
    `--boot-glow:rgba(79,132,97,.09)` · `--boot-shadow:rgba(53,97,70,.34)`
  - `web/index.html:111~117` — `stop-color="#4F8461"` · `stop-color="#356146"` ·
    `stroke="#08110D"` ×2
- **현상** — **테마 밖인 것은 옳다.** `style.css:1534~1536` 이 근거를 적었다:
  파비콘 타일 그라데이션과 같은 값이어야 부팅 화면과 탭 아이콘이 같은 물건으로 보인다.
  문제는 **값이 두 자리에 산다**는 것이다. `--boot-shadow:rgba(53,97,70,.34)` 의
  `53,97,70` 은 `#356146` 이고, 그 `#356146` 이 SVG 에도 따로 적혀 있다.
  `#08110D`(로고 획)는 어디에도 이름이 없다.
- **비용** — 브랜드 색을 바꾸면 고칠 자리가 다섯이고, 그중 둘은 HTML 안이라
  `check-hardcoded-color.mjs` 가 보지 않는다. 한쪽만 고치면 부팅 화면과 파비콘이 갈린다.
- **제안** — 브랜드 팔레트를 `:root` 한 자리로 모으고 SVG 가 `var()` 를 읽게 한다
  (인라인 SVG 는 CSS 변수를 상속받는다):
  ```css
  --boot-brand:#4F8461;       /* 타일 밝은 쪽 */
  --boot-brand-dk:#356146;    /* 타일 어두운 쪽 — --boot-shadow 의 rgb */
  --boot-brand-lit:#6fae83;   /* 진행 바 하이라이트 */
  --boot-brand-ink:#08110D;   /* 로고 획 */
  ```
  ```html
  <stop offset="0" stop-color="var(--boot-brand)"/>
  <stop offset="1" stop-color="var(--boot-brand-dk)"/>
  … stroke="var(--boot-brand-ink)"
  ```
  단 이 `<svg>` 는 `<body>` 안(`index.html:108`)이라 `:root` 변수가 닿는다 —
  `style.css:1537` 의 `:root` 는 `<head>` 의 `<link>` 로 이미 서 있다. 확인했다.
- **위험도**: LOW · **공수**: S

### [INFO] 1-6. 위반이 아닌 것 — 확인한 면제

| 자리 | 값 | 판정 |
|---|---|---|
| `style-docrender.css:143` | `--doc-paper:#fff` | **정당.** 여기 그려지는 것은 우리 화면이 아니라 남의 HTML 문서이고 그 문서는 흰 바탕을 전제로 쓰였다 (`style-docrender.css:136~140` 이 근거를 적었다). 이름을 얻고 `:root` 에 모였다는 게이트의 요구도 지켰다. |
| `helpers.js:186` | `'#e0af68'` | **경미.** `pickAttnColor` 의 최후 폴백 — `t.terminal` 이 통째로 없을 때만 닿는다. 내장 54종은 전부 `terminal` 을 갖는다. 다만 값이 Tokyo Night 의 yellow 이므로, 굳이 남긴다면 `ui.accent` 로 떨어뜨리는 편이 테마 안에 머문다. |
| `app-settings-theme.js:250` | `'#000000'` | **색이 아니다.** `<input type="color">` 의 `value` 가 비었을 때의 자리표. 화면에 칠해지지 않는다. |
| `helpers.js:181` | `` `rgba(${r},${g},${b},${a})` `` | **생성자다.** 리터럴이 아니라 파생 함수 자체. |
| `vendor/xterm.css:81,82,95` | `#000`·`#FFF` | **벤더.** `.xterm-screen` 의 인쇄/접근성 대비 기본값. 손대지 않는다. |
| `style.css:865~867` | `--pv-fs-xs/sm/md:7/8/9px` | **정당.** `.theme-preview-panel` 에 매인 정의이고 `style.css:859~863` 이 근거를 적었다 — 미리보기는 글자가 아니라 **그림**이라 `--fs-*` 의 바닥(9px)보다 작아야 한다. `FR-TOK-28` 이 인정하는 형태다. |

---

## 2. 테마 토큰 파생 구조

### 2.1 실측 — "496개 변수" 는 낡았다

CSS 6벌에서 주석을 지우고 센 값이다:

| 척도 | 실측 |
|---|---:|
| `--` 토큰 **출현** (정의 + 참조 전부) | **1,958** |
| 고유 이름 (정의 ∪ 참조) | **94** |
| CSS 에서 **정의**된 이름 | **85** |
| CSS 에서 `var()` 로 **참조**된 이름 | **94** |

`check-css-vars.mjs` 의 "읽기 94" 와 일치한다.
정의 85 < 참조 94 인 차이(**9**)는 전부 **JS 가 런타임에 세우는 것**이고,
전수는 다음과 같다:

```
--sb-w  --tab-w  --ag-w  --fill            (레이아웃·측정값)
--git-row-h  --git-detail-h  --fe-offer-h  (측정값)
--ufe-alpha                                (포커스 액자 세기 — style.css:1641~1643 이 명시)
--ae-alpha                                 (알림 액자 세기)
```

`check-css-vars.mjs:80~83` 이 `setProperty('--x'` 와 맵 키 `'--x':` 둘 다를 읽어
이것을 알고 통과시킨다. **미정의 참조는 0이다.**

### 2.2 계층도

```
themes.js  THEMES[name]                            ← 팔레트 정본 (54종, 고치지 않는다)
  ├─ ui{bg,sidebarBg,border,accent,text,textMuted,
  │     textBright,textDim,danger,accentBorder}
  └─ terminal{background,foreground,…,bright*}      (ANSI 20색)
          │
          ▼
contrast.js  deriveContrastTokens(ui,mode,attn,term)
  ├─ referenceBackgrounds() = [bg, sidebarBg, mixHex(bg,text,.06)]   ← 배경 셋 전부
  ├─ pickContrastAnchor()   = textBright | #fff | #000
  └─ liftContrast(raw,anchor,bgs,floor)  ← 0.05 눈금으로 섞어 바닥을 넘는 최초값
          │
          ▼
helpers.js  themeVarsOf(t) → 32개 이름  ────────────────────┐
                                                             │ applyThemeObj 가
  [A] 팔레트 그대로 (7)                                       │ documentElement.style
    --bg --sidebar-bg --border --accent --text-dim            │ 에 setProperty
    --danger --accent-border                                  │
  [B] 대비 파생 (7)                                           │  + localStorage 캐시
    --text --text-muted --text-bright --text-hint             │    (첫 페인트 선주입,
    --accent-text --danger-text --focus-ring                  │     index.html:49)
  [C] 혼합 파생 (3)                                           │
    --bg-alt      = mixHex(bg,text,.06)                       │
    --border-strong = mixHex(border,text,BORDER_STRONG_MIX)   │
    --slot-edge   = mixHex(border,accent,.55)                 │
  [D] 알파 파생 (8)                                           │
    --accent-hover/.1  --accent-active/.12 --accent-subtle/.08│
    --danger-subtle/.12 --danger-strong/.2                    │
    --attn-subtle/.16  --attn-glow/.5                         │
  [E] 팔레트 선택 파생 (2)                                    │
    --attn      = pickAttnColor(t)  ← terminal 중 accent 와   │
    --attn-text = liftContrast(attn,…,4.5)    가장 먼 색      │
  [F] 터미널 파생 (6)                                         │
    --term-{red,green,yellow,blue,magenta,cyan}               │
      = bright* || * 를 strong(4.5) 바닥으로 올림             │
────────────────────────────────────────────────────────────┘

CSS :root 에 **고정**된 것 (주입되지 않음 = 테마 무관 상수)
  ├─ 크기·층 (정당)
  │    --fs-scale --fs-{xs,sm,md,lg,xl}     (style.css:52~57)
  │    --z-{raised,sticky,overlay,modal,popover,edge}  (72~77)
  │    --touch-min --m-kb-h --sb-rail-w --sb-rail-fs   (154~164)
  │    --ui-{btn-h,btn-h-sm,btn-h-lg,btn-px,radius,gap,font,
  │          icon-ratio,icon-sm,icon-md,icon-lg,tab-h} (style-kit.css:27~48)
  │    --git-{hit,btn-h,row-min,indent,tree-pad0}      (style-git-views.css:743)
  │    --edge-fade --ufe-sat                           (style.css:1631,1639)
  │    --mono                                          (style.css:119)
  ├─ 색 — 정당한 상수
  │    --doc-paper                          (style-docrender.css:143)
  │    --boot-brand --boot-brand-lit --boot-glow --boot-shadow  (style.css:1538~1544)
  └─ 색 — ✗ 파생이어야 하는데 고정된 것
       --backdrop --backdrop-soft --shadow-1 --shadow-2   ← §1-4
       --git-st-add                                       ← §1-1  ★ 최우선

CSS 안에서 **다른 변수로부터 파생**된 것 (정당 · 선례)
  --ui-font       : var(--fs-sm)                (style-kit.css:35)
  --sb-rail-fs    : var(--fs-xs)                (style.css:164)
  --fs-*          : calc(Npx * var(--fs-scale)) (style.css:53~57)
  --ui-btn-h*     : calc(Npx * var(--fs-scale)) (style-kit.css:27~30)
  --git-sec-divider: 2px solid var(--border-strong)  (style.css:132)
  --run-ok        : var(--term-green)           (style-git-views.css:1011)  ★ 모범
```

### 2.3 지적 — 고정인데 파생이어야 하는 것

**정확히 다섯이다**: `--git-st-add`(§1-1) · `--backdrop`·`--backdrop-soft`·
`--shadow-1`·`--shadow-2`(§1-4). 그 밖에는 없다. 전수 대조했다.

### [LOW] 2-4. `:root` 블록이 여섯 자리에 흩어져 있다

- **위치**: `style-kit.css:20` · `style.css:33` · `style.css:1537` · `style.css:1628` ·
  `style-git-views.css:743` · `style-docrender.css:143`
- **현상** — `check-hardcoded-color.mjs` 의 설계 근거가
  *"그 자리를 `:root` 하나로 모으면 팔레트가 한 화면에서 검토된다"* 인데,
  실제로는 넷이 아니라 **여섯 화면**이다.
- **비용** — 낮다. 넷은 "쓰는 자리 바로 위" 라는 규약을 지키고 있고
  (`--doc-paper` 는 `.dr-html` 바로 위, 부팅 토큰은 `#boot` 바로 위),
  그것이 오히려 읽기 좋다. `style.css:1628`(`--edge-fade`·`--ufe-sat`)도 같다.
- **제안** — 바꾸지 않는다. 다만 `DESIGN_TOKENS_SRS` §3.6 의 "한자리" 라는 표현을
  **"쓰는 자리 위의 `:root`"** 로 정정해 문서와 코드를 일치시킨다.
  게이트는 이미 그렇게 동작한다(`splitRoot` 가 파일마다 모든 `:root` 를 찾는다).
- **위험도**: LOW · **공수**: S (문서만)

---

## 3. 테마 간 검증

테마는 **54종** (dark 43 · light 11). 라이트 11종:
GitHub Light, Solarized Light, One Light, Tokyo Night Light, Catppuccin Latte,
Gruvbox Light, Rosé Pine Dawn, Ayu Light, Everforest Light, Quiet Light, Vitesse Light.

| 축 | 상태 |
|---|---|
| 글자 대비 7종 × 54 × 배경 3 | **보장됨** — `check-contrast.mjs` 초록. 파생이 실제로 일한다 |
| `--git-st-add` | **파탄 11/54** (§1-1) — 게이트 사각지대 |
| `--backdrop`·`--shadow-*` | **부적절 11/54** (§1-4) — 깨지진 않으나 무겁다 |
| `--attn` (`pickAttnColor`) | 건강 — 팔레트에서 accent 와 가장 먼 색을 고르고 4.5 로 올린다 |
| `--term-*` 구문색 6 | 건강 — `bright*` 우선, 4.5 바닥 |
| `--text-dim` | **글자로 쓰지 않는다**는 규약(`FR-TOK-3`)이 지켜지는지는 이 감사가 검증하지 않았다 — `check-contrast` 도 보지 않는다. §7-3 참고 |

### [MED] 3-1. 라이트 테마에서 `backdrop-filter:blur` 와 검정 백드롭이 겹친다

- **위치**: `style-kit.css:136` (`.ui-modal`, `--backdrop` .6) ·
  `style.css:1014` (`.pn-dimmed .pn-body>.pn-dim-hint`, `--backdrop-soft` .4)
- **현상** — `background:var(--backdrop*)` + `backdrop-filter:blur(2px)` 조합.
  라이트 테마에서 밝은 화면을 40~60% 검정으로 덮은 뒤 흐린다.
- **비용** — 모달 7벌 전부(`#modal-overlay`·`.confirm-overlay`·`.bg-modal`·
  `.runs-modal`·`.gc-modal`·`.git-dialog`·`.ui-modal`)가 이 한 벌로 수렴했으므로
  (`DESIGN_TOKENS_SRS` §3.9), 이 한 값이 라이트 11종의 **모든 모달**을 정한다.
- **제안** — §1-4 의 파생이 이것을 함께 고친다. blur 는 그대로 둔다.
- **위험도**: MED · **공수**: (§1-4 에 포함)

### [INFO] 3-2. 검증하지 못한 것

`themes.js` 의 54종을 실제 브라우저에서 렌더해 보지 않았다. 위 판정은 전부
**계산 가능한 제약**(WCAG 대비·주입 맵 대조)에 한한다. 미적 파탄(예: 특정 테마에서
`--slot-edge` 가 배경과 구분되지 않음)은 이 방법으로 답할 수 없다.
`scripts/shots` 가 있으므로 스크린샷 매트릭스를 돌릴 여지는 있다 —
이 감사의 범위 밖이다.

---

## 4. CSS 중복·충돌·죽은 선택자

### [INFO] 4-1. 특이도와 깊이는 건강하다 — 지적할 것이 없다

- 자손 결합 **4단 이상 선택자: 1개**.
  `style.css:422` — `html.sb-collapsed body:not(.mobile) .sbl-item.has-badge:not(.attn) .sbl-dot`
  (접힌 레일에서의 배지 점. 조건 넷이 전부 뜻을 갖는다.)
- `!important` **실사용 13** (나머지 9건은 주석 안의 언급이다):

  | 자리 | 근거 |
  |---|---|
  | `style.css:31` `[hidden]` | D-2 — 숨김의 자리를 하나로. `check-visibility.sh` 가 지킨다 |
  | `style.css:1020` `.pn-dimmed .tp-overlay` | 포커스 오버레이 위 겹침 제거 |
  | `style.css:1254~1259,1289,1298,1374` (7) | `.mobile-only` 특이도 전쟁. `style.css:1242~1246` 이 **전쟁의 전말을 기록**하고 규약(`:not([hidden])`)으로 닫았다 |
  | `style.css:1595~1598` (4) | `prefers-reduced-motion` 전역 — 관용 |
  | `style-editor.css:462,470` (2) | Monaco 가 만든 DOM 의 폭 강제 |

  `style-kit.css` 는 **0** 이다 (`FR-UIK-1·11` 불변이 지켜진다).
  **전부 근거가 주석에 있다.** 손댈 것이 없다.

### [LOW] 4-2. 죽은 선택자 넷

동적 조립(`'st-'+code`·`ns+'-box'`·`'ui-icon-'+size` 등 접두 24종 / 접미 21종)을
해석한 뒤에도 **참조가 0인 클래스는 넷**이다 (CSS 고유 클래스 898 중).

| 클래스 | 위치 | 판정 |
|---|---|---|
| `.ui-tabs-underline` | `style-kit.css:117` | **키트 탭 변형이 한 번도 쓰이지 않았다** |
| `.ui-tabs-side` | `style-kit.css:120` | 〃 |
| `.ui-menu-group` | `style-kit.css:176` | 메뉴 안 컨트롤 무리 — 미사용 |
| `.sb-sep` | `style.css:1048` | 상태바 구분선 — 미사용 |

> `hljs-*` 27종과 `.monaco-editor`·`.function_` 은 벤더가 붙이는 클래스이므로
> 죽은 것이 아니다. 별도로 확인했다.

- **비용** — `.ui-tabs-*` 둘이 특히 뜻있다. `DESIGN_TOKENS_SRS` §7.6 이
  **아직 닫히지 않은 과도기 잔여표**를 갖고 있고, 그 표에 정확히 넷이 있다:

  | 클래스 | CSS 선언 수 (SRS §7.6 실측) | 키트 병기 |
  |---|---:|---|
  | `.pn-tab` | 43 | 아니다 |
  | `.sb-tab` | 35 | 전부 (`UIKit.tab` cls) |
  | `.mtab` | 13 | 아니다 |
  | `.ed-side-tab` | 16 | 아니다 |

  넷 중 셋이 키트와 병기조차 되지 않는다. **키트가 준비한 활성 표시 축
  (`underline`/`side`)을 아무도 안 쓰고 있다는 사실이 그 표의 반대편 증거다** —
  `D-5`(과도기)가 열려 있는 이유가 이 두 줄에서도 읽힌다.
- **제안** — 지우지 않는다. `.ui-tabs-*` 는 **써야 할 것**이다:
  탭 넷(`#sb-tabs`·`.pn-tab`·`.mtab`·`.ed-tab` 계열)을 키트로 이주시키는 것이
  §3.7 의 종료 조건이고, 그때 이 둘이 쓰인다.
  `.ui-menu-group`·`.sb-sep` 둘은 지운다(합 5줄).
- **위험도**: LOW · **공수**: S(삭제 2) / L(탭 이주)

### [LOW] 4-3. 파일 경계를 넘는 같은 선택자 — 대부분 정당

기계적으로는 21건이 나왔으나 실제로 검토하니 대부분 **선택자 목록의 한 항목**이라
중복이 아니다 (`style.css:175` 의 `user-select:text` 예외 묶음 등).
진짜로 두 파일이 같은 선택자를 각자 선언하는 자리는 셋이다:

| 선택자 | 위치 | 판정 |
|---|---|---|
| `.git-view` | `style-git.css:29` (배치) · `style-git-views.css:332` (`user-select`) | **정당.** 뜻이 다르고 주석(`style-git-views.css:327~331`)이 왜 여기인지 적었다 |
| `.git-remote-more` | `style-git.css:103` (모양) · `style-git-views.css:760` (글자 크기) | **경미한 분산.** 한 요소의 규칙이 두 파일에 있다 |
| `.git-dialog-row`·`.git-commit-amend`·`.git-commit-opt` | `style-git.css:231,308,328` · `style-git-views.css:831` | 〃 |

- **비용** — 낮다. 다만 §12 의 책임 경계 재정의로 자연히 해소된다.
- **위험도**: LOW · **공수**: (§12 에 포함)

---

## 5. 간격·크기 스케일

### [HIGH] 5-1. 간격에는 토큰 체계가 아예 없다 — 글자 크기·z-index 가 겪은 것과 같은 부류

`DESIGN_TOKENS_SRS` §1.1 이 스스로 진단을 적었다:
> "글자 크기 12종이 토큰 없이 흩어졌고, z-index 값 28종이 서로를 모른 채 커졌으며…
> **값이 뜻을 말하지 않으면 다음 사람은 옆줄을 베껴 쓴다.**"

그 문서는 글자와 층을 고쳤다. **간격은 손대지 않았다.** 실측:

| 속성 | 선언 수 | **고유 값** |
|---|---:|---:|
| `padding` (계열 전부) | 322 | **99** |
| `margin` (계열 전부) | — | **47** |
| `gap` | 172 | **15** |
| `border-radius` | 171 | **13** |
| `border-*-width` | 201 | 4 (1/2/3/4px) |

**99종의 padding.** 글자 크기 12종·z-index 28값보다 나쁘다.

분포를 보면 실제로는 소수의 값이 지배한다:

`gap` — 상위 셋이 133/172 (77%):
```
57  8px      45  6px      31  4px      10  2px       8  10px
 7  3px       3  var(--ui-gap)  2  5px    2  14px    2  0
 1  7px   1  12px   1  1px   1  "6px 14px"   1  "2px 10px"
```

`border-radius` — 상위 둘이 109/171 (64%):
```
67  3px    42  4px    14  8px    13  6px    10  2px
 6  5px     6  50%     4  var(--ui-radius)   2  9px   2  7px   1  10px
```

`padding` — 상위 10이 112/322 (35%), 나머지 **89종이 210 선언에 흩어져 있다**:
```
17 "2px 8px"  12 "4px 8px"  12 "3px 8px"  11 "6px 10px"  11 "0 6px"
10 "6px 8px"  10 "4px 10px" 10 "0 4px"    10 "0"          9 "4px 6px"
```

- **비용** — 이 분포가 말하는 것은 **뜻으로 갈린 것이 아니라 손으로 고른 것**이라는
  사실이다. `3px`과 `4px` radius 가 109군데에 섞여 있는데 둘을 가르는 규칙은 없다
  (`.ui-menu-item` 은 3, `.ui-btn` 은 4, `.git-*` 는 섞임). 한 자리를 고치면
  나머지가 남는다 — 정확히 SRS 가 없애려 한 상태다.
- **제안** — **이미 있는 토큰부터 쓰게 한다.** 새 이름을 만들기 전에:

  `--ui-radius:4px` 는 `style-kit.css:31` 에 **이미 있고 6번 쓰인다.**
  같은 값 `4px` 리터럴이 **42번** 있다. `--ui-gap:calc(6px*scale)` 은
  **3번** 쓰이고 `6px` 리터럴 gap 이 **45번** 있다.
  **토큰이 없는 게 아니라 이주가 안 끝났다.**

  그 위에 스케일을 세운다 (값의 출처는 위 분포다 — 실측 상위값을 이름으로 승격):

  ```css
  /* 간격 — 분포 상위 네 값이 172 gap 중 143(83%)을 덮는다 */
  --sp-1:calc(2px * var(--fs-scale));   /* 10 gap · 붙은 것 */
  --sp-2:calc(4px * var(--fs-scale));   /* 31 gap · 조밀한 행 */
  --sp-3:calc(6px * var(--fs-scale));   /* 45 gap = 현 --ui-gap */
  --sp-4:calc(8px * var(--fs-scale));   /* 57 gap · 기본 */
  --sp-5:calc(12px * var(--fs-scale));  /* 상자 안쪽 */
  --sp-6:calc(16px * var(--fs-scale));  /* 본문 여백 */
  --ui-gap:var(--sp-3);                 /* 옛 이름은 가리킨다 (--ui-font 선례) */

  /* 모서리 — 뜻은 셋이다 */
  --r-sm:3px;                  /* 67회 · 행·항목 */
  --r-md:4px;                  /* 42회 · 버튼·입력 = 현 --ui-radius */
  --r-lg:8px;                  /* 14회 · 상자·모달 */
  --r-pill:50%;                /*  6회 · 점·원 */
  --ui-radius:var(--r-md);
  ```

  `--ui-font:var(--fs-sm)`(`style-kit.css:35`)이 **옛 이름을 새 이름으로 가리키는
  선례를 이미 만들어 두었다.** 같은 방법을 쓰면 사용처를 한 번에 안 고쳐도 된다.
- **배율 주의** — `--r-*` 에는 `--fs-scale` 을 걸지 않는다.
  `style-kit.css:26` 이 그 근거를 적었다: *"모서리는 크기의 함수가 아니다"*(FR-FSS-6).
  간격은 반대로 걸어야 한다 — 글자가 커지는데 여백이 그대로면 빽빽해진다.
  **단 이것은 동작 변경이므로 사용자 결정이 필요하다** (현재 간격은 배율을 타지 않는다).
- **게이트** — 이주가 끝나면 `check-font-size.mjs` 를 본떠
  `check-spacing.mjs`(padding/margin/gap/radius 에 px 리터럴 0)를 둔다.
  게이트 없이 이주하면 다음 커밋이 다시 `6px` 을 적는다.
- **위험도**: MED (화면 전체의 여백이 움직인다. 단계적으로 — radius 먼저, gap 다음, padding 마지막) · **공수**: L

---

## 6. 타이포그래피

### [HIGH] 6-1. `--mono` 가 세워졌으나 이주가 3/45 에서 멈췄다

- **위치**: 정의 `web/style.css:119`
  ```css
  --mono:'Menlo','Monaco','Consolas','Liberation Mono','Courier New',monospace;
  ```
  주석이 의도를 적었다: *"고정폭 글꼴은 한 벌이다. `style-docrender.css` 가 같은
  스택을 따로 적고 있었고 `style-git.css` 는 없는 `--mono` 를 읽어 `monospace` 로
  떨어졌다."*
- **현상** — 그 뒤로 이주가 되지 않았다. 실측:

  | 꼴 | 건수 |
  |---|---:|
  | `font-family:var(--mono)` | **3** (`style-git.css:49` · `style-docrender.css:71,152`) |
  | `font-family:monospace` | **36** |
  | `font-family:ui-monospace,monospace` | **5** |
  | `font-family:'Menlo','Monaco','Consolas',monospace` | **1** (`style-editor.css:502`) |
  | **생 선언 합** | **42** |

- **비용** — 세 벌의 서로 다른 고정폭 스택이 한 화면에 공존한다.
  `style-git-views.css:64`(diff 본문)는 `ui-monospace,monospace`,
  `style-git.css:493`(상태 문자)는 `monospace`, `style-git.css:49`는 `var(--mono)` —
  **같은 Git 창 안에서 세 폰트가 섞인다.** 고정폭 글꼴은 자폭이 다르면
  diff 의 열 정렬이 어긋난다.
  `style-editor.css:502` 는 `--mono` 의 앞 세 항목만 복사한 축약본이라,
  Linux 에서 `Liberation Mono` 폴백을 잃는다.
- **제안** — 42곳을 `var(--mono)` 로 바꾼다. 단 `ui-monospace` 는 **의도된 것일 수
  있다** (macOS 의 SF Mono 를 잡는다). 그렇다면 `--mono` 의 앞에 `ui-monospace` 를
  넣어 한 벌로 합친다:
  ```css
  --mono:ui-monospace,'Menlo','Monaco','Consolas','Liberation Mono','Courier New',monospace;
  ```
  이 한 줄이 42곳의 차이를 없앤다. 게이트: `check-font-size.mjs` 에
  `font-family` 의 `monospace` 리터럴 0 조항을 더한다.
- **위험도**: LOW (폰트 스택 통일은 되돌리기 쉽다) · **공수**: M

### [MED] 6-2. `line-height` px 고정 12곳이 `--fs-scale` 을 타지 않는다

- **위치** (전부 같은 규칙 안에 `font-size:var(--fs-*)` 가 함께 있다):

  | 자리 | font-size | line-height |
  |---|---|---|
  | `style-kit.css:124` `.ui-tab-badge` | `--fs-xs` | `15px` |
  | `style-kit.css:195` `.ui-badge` | `--fs-sm` | `14px` |
  | `style-git.css:302` | `--fs-md` | `17px` |
  | `style.css:353` | `--fs-sm` | `14px` |
  | `style.css:444` | `--fs-xs` | `12px` |
  | `style.css:1034` `.sb-item` | — | `16px` |
  | `style.css:1041` `.sb-update` | — | `16px` |
  | `style-git-views.css:64` (diff 본문) | `--fs-md` | `18px` |
  | `style-git-views.css:160` | `--fs-xs` | `13px` |
  | `style-git-views.css:192` | `--fs-sm` | `14px` |
  | `style-git-views.css:1122` | `--fs-xs` | `14px` |
  | `style-git-views.css:1153` `body.mobile .sb-tab-badge` | `--fs-sm` | `18px` |

- **현상** — `FONT_SIZE_SETTING_SRS` FR-FSS-3·4 가 `--fs-scale` 로 글자를 키우는데,
  이 12곳의 행간은 고정이다. `--fs-scale:1.5` 면 `--fs-sm` 은 16.5px 인데
  행간은 14px 로 남아 **글자가 행 상자를 넘는다.**
- **비용** — 배지 계열이 특히 나쁘다 (`.ui-badge`·`.ui-tab-badge`·`.sb-tab-badge`).
  `line-height` 로 세로 중앙을 맞추는 관용이라, 배율이 오르면 숫자가 배지 밖으로 나간다.
  `style-kit.css:23~25` 가 *"글자를 담는 상자는 글자와 **함께** 커진다.
  글꼴만 키우면 19.8px 글자가 26px 버튼 안에 남는다"* 라고 적고 버튼은 고쳤는데,
  **배지는 같은 병을 그대로 갖고 있다.**
- **제안** — 두 갈래.
  ① 무단위로 바꾼다: `line-height:14px` + `font-size:var(--fs-sm)`(11px) → `line-height:1.27`.
     세로 중앙이 목적이면 `display:inline-flex;align-items:center` 로 바꾸는 편이 낫다.
  ② 배율을 건다: `line-height:calc(14px * var(--fs-scale))`.
  배지처럼 **상자 높이가 곧 행간**인 자리는 ②가 안전하고, 본문 성격(`style-git-views.css:64`
  diff)은 ①이 맞다.
- **게이트** — `check-font-size.mjs` 에 "`font-size:var(--fs-*)` 를 가진 규칙에
  px `line-height` 금지" 조항을 더한다.
- **위험도**: LOW · **공수**: M

### [LOW] 6-3. `letter-spacing` 은 11 선언 · 7종이나 지적할 만큼은 아니다

```
4  .05em    2  .04em    1  normal   1  .16em(부팅 로고타입)
1  .12em    1  .06em    1  .02em
```
`.16em` 은 `.boot-name`(`style.css:1565`)의 로고타입이라 별개다.
나머지 6종은 전부 머리글·라벨의 미세 조정이고 값의 폭이 좁다(.02~.06em).
**토큰화할 값어치가 없다.** 남긴다.

### [INFO] 6-4. `--fs-*` 자체는 건강하다

`check-font-size.mjs` 가 364 선언 전부를 검증하고 초록이다.
`--ui-font:var(--fs-sm)` 로 키트가 본문을 가리키는 구조도 지켜진다.

---

## 7. z-index

### [INFO] 7-1. CSS 안에서는 완결됐다

`--z-raised:100` / `--z-sticky:200` / `--z-overlay:300` / `--z-modal:400` /
`--z-popover:500` / `--z-edge:600` (`style.css:72~77`).
`check-z-index.mjs`: **선언 36개 전부 층에서 오고, 층에 대한 산술이 0.**
같은 층 안의 순서를 DOM 에 맡긴다는 `FR-TOK-22` 도 지켜진다.

### [LOW] 7-2. JS 가 주입하는 층 하나가 체계 밖에 있다

- **위치**: `web/js/ui/diag.js:37` — `z-index:9999`
- **현상** — 유일한 우회다 (`web/js/**` 전수 확인).
- **비용** — `--z-edge:600` 위에 9999 가 서는 것 자체는 **의도로는 맞다**
  (진단 오버레이는 무엇 위에든 떠야 한다). 문제는 그 뜻이 값으로 적혀 있지 않다는 것.
- **제안** — §1-3 과 함께 처리한다. `--z-diag:700` 을 층에 추가하거나,
  `diag.js` 를 명시적 면제로 문서화한다.
- **위험도**: LOW · **공수**: S

### [INFO] 7-3. 이 감사가 검증하지 못한 것

`--text-dim` 을 `color:` 로 쓰지 말라는 `FR-TOK-3`/`D-TOK-2` 규약이 지켜지는지는
게이트가 없다(`check-contrast.mjs` 는 토큰 7종만 본다). `style.css:239`
(`.ui-scroll::-webkit-scrollbar-thumb{background:var(--text-dim)}`)처럼 **채움**으로
쓰는 것은 규약에 맞지만, 글자로 쓰는 자리가 새로 들어와도 아무도 막지 않는다.
`check-hardcoded-color.mjs` 를 본떠 `color:var(--text-dim)` 0 을 지키는 한 줄짜리
게이트가 값어치 있다. (**공수 S**)

---

## 8. 반응형·모바일

### [INFO] 8-1. 폭 기반 미디어 쿼리가 **하나도 없다** — 의도된 설계다

CSS 6벌의 `@media` 는 **넷뿐이고 전부 `prefers-reduced-motion`** 이다.
반응형은 전량 클래스 기반이다:

```
app.js:88   get isMobile(){ … return window.innerWidth < this.mobileBreakpoint }
app-mobile.js:10   document.body.classList.toggle('mobile', mob)
            → body.mobile 선택자 90회 (style.css 60 · git-views 16 · git 11 · editor 3)
```

- **평가** — **좋은 선택이다.** 브레이크포인트가 JS 한 자리(`mobileBreakpoint`,
  320~2000 범위로 검증됨)에 있고 사용자가 `displayMode` 로 강제 전환할 수도 있다.
  미디어 쿼리였다면 "데스크톱 모드로 보기" 를 만들 수 없다.
  **브레이크포인트 일관성 문제는 존재하지 않는다** — 값이 하나뿐이다.

### [INFO] 8-2. `--touch-min:44px` 는 잘 지켜진다

22곳이 `var(--touch-min)` 을 읽는다 (`style.css` 13 · `style-git-views.css` 7 ·
`style-editor.css` 1 · 정의 1). `style.css:1426` 의 `width:18px` 은 세로 높이를
`var(--touch-min)` 으로 주고 폭만 좁힌 것인데, `style.css:155` 의 주석이
근거를 적었다: *"E-3: 폭은 면제, 세로는 받는다."*

지적할 것이 없다.

---

## 9. 모션

### [INFO] 9-1. `prefers-reduced-motion` 은 전역으로 받는다 — 모범이다

`style.css:1593~1600` 이 `*,*::before,*::after` 에 걸고, `style.css:1581~1592` 가
**왜 전역인지**를 적었다:
> "착수 시 이 선언은 세 자리뿐이었고 `animation:` 19 · `transition:` 29 중 나머지는
> 요청을 받지 않았다 — 자리마다 손으로 적는 한 새 애니메이션은 항상 덮이지 않은 채로 들어온다."

그리고 멎었을 때 모양이 깨지는 셋만 따로 적었다(`:1602~1608`, `style-git-views.css:1131`).
`.01ms` 를 쓰는 관용, `animation-iteration-count:1` 의 이유, `transitionend`
리스너가 0임을 확인한 사실까지 주석에 있다.

**손댈 것이 없다.** 이 축은 완결됐다.

### [LOW] 9-2. 전환 시간이 8종이다

`transition:` 28 선언, 지속시간 8종:
```
15  .15s    8  .1s     4  .2s     4  .12s
 1  .3s     1  .22s    1  .18s    1  .08s
```
- **현상** — 상위 둘(.15s/.1s)이 23/28(82%)을 덮고, 나머지 5종은 1~4회씩이다.
- **비용** — 낮다. 다만 `.12s`·`.18s`·`.22s` 는 `.1s`·`.2s` 와 사람 눈에 구분되지
  않는다 — 값이 뜻을 말하지 않는 그 부류의 작은 판이다.
- **제안** — 토큰 둘이면 충분하다:
  ```css
  --t-fast:.1s;   /* 눌림·호버 — 즉각 */
  --t-base:.15s;  /* 나타남·사라짐 */
  --t-slow:.3s;   /* 자리 이동 */
  ```
  `.3s` 는 남기고(`#boot` 의 `.18s` 는 부팅 걷힘이라 별개로 봐도 된다),
  `.08/.12/.18/.22` 넷을 셋으로 흡수한다.
- **위험도**: LOW · **공수**: S

---

## 10. CSS 성능

### [MED] 10-1. `boot-flow` 가 `left` 를 애니메이션한다 — 부팅 중에

- **위치**: `web/style.css:1578`
  ```css
  @keyframes boot-flow{0%{left:-45%}100%{left:103%}}
  ```
  적용: `style.css:1571~1573` `.boot-bar i` — `animation:boot-flow 1.25s ease-in-out infinite`
- **현상** — 13개 키프레임 중 **유일하게 레이아웃을 유발하는 속성**을 애니메이션한다.
  나머지 12는 `opacity`·`transform`·`box-shadow`·`background`·`border-color` 다.
- **비용** — `left` 변경은 매 프레임 레이아웃 → 페인트 → 합성 전부를 돈다.
  그것도 **부팅 중**, 즉 스크립트 파싱·워크스페이스 로드가 동시에 도는
  가장 바쁜 순간에 60fps 로 무한 반복한다. `.boot-bar`(`position:relative`)가
  `overflow:hidden` 이라 레이아웃 범위는 좁지만, 공짜는 아니다.
- **제안** — `transform` 으로 옮긴다. 상자 폭이 46% 이므로:
  ```css
  .boot-bar i{position:absolute;top:0;bottom:0;left:0;width:46%;border-radius:3px;
    background:linear-gradient(90deg,transparent,var(--boot-brand),var(--boot-brand-lit),transparent);
    animation:boot-flow 1.25s ease-in-out infinite}
  @keyframes boot-flow{0%{transform:translateX(-98%)}100%{transform:translateX(224%)}}
  ```
  (`-45%`/`103%` 는 상자 기준, `translateX` 는 자기 폭 46% 기준이므로
  `-45/46≈-98%`, `103/46≈224%`.)
  `prefers-reduced-motion` 쪽(`style.css:1606`)이 `left:0;width:100%` 로
  되돌리고 있으므로 **그쪽도 함께 고쳐야 한다** — `transform:none;width:100%`.
- **위험도**: LOW · **공수**: S

### [INFO] 10-2. `will-change` 남용 없음 · blur 는 최소

- `will-change`: **0건**. (선언하지 않는 편이 낫다는 판단이 관철됐다.)
- `backdrop-filter:blur(2px)`: 2곳 (`style-kit.css:136` `.ui-modal` ·
  `style.css:1014` `.pn-dimmed .pn-body>.pn-dim-hint`).
  `style.css:1625~1627` 이 터미널 위에는 blur 를 쓰지 않는 이유까지 적었다 —
  *"1px 획의 텍스트라 약한 흐림에도 글자가 뭉개진다"*(D-6).
- `filter:drop-shadow`: 1곳 (`style.css:1562` 부팅 로고). 반경 18px, 부팅 중만.
- 큰 그림자: `--shadow-2`(`0 8px 32px`) 가 최대. 과하지 않다.

지적할 것이 없다.

### [INFO] 10-3. 셀렉터 비용

자손 결합 4단 이상 1개(§4-1). 범용 선택자는 셋뿐이고
(`*,*::before,*::after` — 리셋 1 + reduced-motion 1), 전부 정당하다.
속성 선택자는 `[hidden]`·`[draggable="true"]`·`[data-state="…"]` 류로 좁다.

**CSS 성능 축에서 실제로 고칠 것은 §10-1 하나뿐이다.**

---

## 11. 게이트의 사각지대 — 종합

이 감사가 찾은 것의 절반은 **게이트가 안 보는 자리**에서 나왔다. 정리한다:

| 게이트 | 현재 범위 | 사각지대 | 그 결과 발견된 것 |
|---|---|---|---|
| `check-hardcoded-color` | `web/*.css` `:root` 밖 | `:root` 안 · `web/js/**` · `index.html` · `web/vendor/` | §1-1 §1-2 §1-3 §1-4 §1-5 |
| `check-z-index` | `web/*.css` | `web/js/**` | §7-2 |
| `check-font-size` | `web/*.css` | `web/js/**` · `font-family` · `line-height` | §6-1 §6-2 §7-2 |
| `check-contrast` | 토큰 7종 | `--git-st-add`·`--attn-text`·`--term-*`·`--text-dim` 규약 | §1-1 §7-3 |
| (없음) | — | 간격·반경·전환시간 | §5-1 §9-2 |

### [MED] 11-1. 게이트 셋의 `readdirSync('web')` 을 재귀로 바꾸는 것만으로는 부족하다

- **위치**: `scripts/check-hardcoded-color.mjs:82` · `check-z-index.mjs:53` ·
  `check-font-size.mjs:53` — 셋 다 같은 한 줄
  ```js
  const files = readdirSync(CSS_DIR).filter(f => f.endsWith('.css')).map(f => join(CSS_DIR, f));
  ```
- **현상** — 비재귀라 `web/vendor/xterm.css` 를 건너뛴다. 재귀로 바꾸면
  벤더가 걸리므로 **면제 목록이 함께 필요하다.**
- **제안** — 재귀 + `web/vendor/` 명시 면제 + **면제 건수 출력**.
  `check-hardcoded-color.mjs` 가 `mask` 를 다루는 방식(`maskSkipped` 를 찍는다)을
  그대로 쓰면 된다 — 그 파일의 주석이 이미 원칙을 적었다:
  *"몇 건을 건너뛰었는지 찍는다 — 조용한 예외는 예외가 아니라 구멍이다."*
- **더 중요한 것** — 세 게이트를 `web/js/**/*.js` 와 `web/index.html` 로 넓히는 일.
  `diag.js` 하나가 색 9 · 층 1 · 글자 1 을 동시에 우회하고 있었다는 사실이
  그 값어치를 말한다.
- **위험도**: LOW (게이트는 읽기만 한다) · **공수**: M

---

## 12. 통합 제안 — 여섯 파일의 책임 경계

### 12.1 현재

| 파일 | 줄 | 실제로 든 것 |
|---|---:|---|
| `style-kit.css` | 243 | 크기 토큰 · 버튼 · 탭 · 모달 · 메뉴 · 컨트롤 · 배지 · 아이콘 · HUD · 스크롤 |
| `style.css` | 1,742 | **색 토큰 전부** + 층 + 글자 + 사이드바·탑바·슬롯·pane·터미널·모달·테마·단축키·검색·DnD·상태바·프리셋·확인창·모바일·탭바 + **부팅** + **포커스 액자** |
| `style-git.css` | 685 | Git 창 골격 · 작업 로그 · 파일 목록 · 다이얼로그 |
| `style-git-views.css` | 1,176 | Git 뷰(history·diff·branches·stash·submodule·worktree) + **Runs** + **Agents/BG** + **사이드바 탭** |
| `style-editor.css` | 513 | 편집기 · Monaco 덧칠 · LSP · diff 거터 |
| `style-docrender.css` | 159 | 문서 렌더 · 구문 강조 · 표 |

### 12.2 지적

**① `style.css` 가 셋을 겸한다.** 토큰 원천(1~165) · 앱 껍데기(166~1,530) ·
독립 기능 둘(부팅 1,529~1,608, 포커스 액자 1,611~1,742). 뒤의 둘은
앱 껍데기와 아무 관계가 없고, 각자 자기 SRS(`BOOT_SCREEN_SRS`·`UNFOCUSED_EDGE_SRS`)와
자기 `:root` 블록을 갖고 있다.

**② `style-git-views.css` 가 이름과 다르다.** Runs(`~250줄`)·Agents/BG·
사이드바 탭은 Git 뷰가 아니다. 파일 경계를 넘는 선택자 중복(§4-3)이
대부분 이 파일과 `style-git.css` 사이에서 난다.

**③ 키트가 덜 찼다.** `.ui-tabs-*` 둘이 죽어 있고(§4-2), 간격·반경 토큰이 없고(§5-1),
고정폭 글꼴 토큰이 `style.css` 에 있다(`--mono`, `style.css:119`).

### 12.3 제안 — 세 걸음

```
[1단계] 토큰을 키트로 모은다 (색은 그대로 둔다)
  style-kit.css 로 이동:  --mono(style.css:119)
  style-kit.css 에 신설:  --sp-1..6  --r-sm/md/lg/pill  --t-fast/base/slow
  style.css 에 남긴다:    색 토큰 전부 · --fs-* · --z-* · --touch-min 등 앱 상수
    ↳ 근거: 키트 머리가 "색은 소유하지 않는다"(FR-UIK-2)고 적었다. 그 선은 지킨다.
       크기·간격·모서리·시간은 키트의 것이 맞다 — 이미 --ui-btn-h 가 거기 산다.

[2단계] style.css 에서 독립 기능 둘을 뗀다
  style-boot.css   ← style.css:1529~1608  (80줄, BOOT_SCREEN_SRS)
  style-edge.css   ← style.css:1611~1742 (132줄, UNFOCUSED_EDGE_SRS)
  → style.css 1,742 → ~1,530
  ⚠ <link> 순서를 지켜야 한다. index.html:23~30 의 주석이 근거:
    "네 파일의 <link> 순서가 원본의 선언 순서와 같아야 한다 — 캐스케이드가
     그것으로 보존된다." 두 파일은 맨 뒤에 붙인다 (원래 style.css 의 끝이었다).

[3단계] style-git-views.css 에서 Git 아닌 것을 뗀다
  style-runs.css   ← Runs 패널·Run 뷰 (style-git-views.css:~890~1100)
  나머지는 style-git.css 와 경계를 다시 긋는다:
    style-git.css       = Git **창**의 골격·공통(다이얼로그·파일행·로그)
    style-git-views.css = Git **뷰**마다의 것만 (history/diff/branches/stash/sub/wt)
  → §4-3 의 중복 셋(.git-remote-more · .git-dialog-row · .git-commit-*)이
     자연히 한 파일로 모인다.
```

- **순서가 중요하다.** 1단계는 안전하다(토큰 이동은 캐스케이드와 무관).
  2·3단계는 `<link>` 순서를 건드리므로 한 번에 하나씩, 시각 회귀 확인과 함께.
- **먼저 하지 말 것** — 파일을 쪼개기 **전에** §1-1·§1-2 를 고친다.
  색 위반을 안은 채로 파일을 옮기면 회귀의 원인을 가른다.
- **스펙이 필요하다.** `DESIGN_TOKENS_SRS` §8 비목표 6이
  *"CSS 파일 분할·재배치. 선언을 옮기지 않고 **값만** 토큰으로 바꾼다"* 라고
  명시적으로 범위 밖에 둔 일이다. 그러므로 §12 는 그 문서의 후속이 아니라
  **새 SRS 가 필요한 항목**이다. §1~§11 은 대부분 기존 SRS 의 FR 에 붙일 수 있다.
- **위험도**: 1단계 LOW · 2단계 MED · 3단계 MED · **공수**: M / M / L

---

## 13. 권고 순서

| 순 | 항목 | 근거 | 공수 | 위험 |
|---:|---|---|---|---|
| 1 | §1-1 `--git-st-add:var(--term-green)` + 게이트 추가 | 라이트 11종 파탄. 한 줄 | S | LOW |
| 2 | §1-2 `#f44` → `.fe-save-failed` 클래스 | 테마 무시 | S | LOW |
| 3 | §11-1 게이트 셋을 `web/js/**`·`index.html` 로 확장 | 사각지대를 먼저 닫아야 이후가 안 샌다 | M | LOW |
| 4 | §10-1 `boot-flow` → `transform` | 부팅 중 레이아웃 스래싱 | S | LOW |
| 5 | §6-1 `--mono` 이주 42곳 | Git 창에 고정폭 3종 혼재 | M | LOW |
| 6 | §1-4 백드롭·그림자 파생 | 라이트 11종. SRS §8 이 유예한 것 | M | MED |
| 7 | §6-2 `line-height` px 12곳 | 배율 올리면 배지가 깨진다 | M | LOW |
| 8 | §5-1 간격·반경 스케일 (radius → gap → padding) | 99종 padding. 최대 항목 | L | MED |
| 9 | §12 파일 경계 재정의 (1→2→3단계) | 구조 | M/M/L | LOW/MED |
| 10 | §4-2 `.ui-tabs-*` 로 탭 넷 이주 | `DESIGN_TOKENS_SRS` §3.7 종료 조건 | L | MED |

---

## 부록 A. 조사 방법

전수 집계는 전부 스크립트로 했고 눈으로 세지 않았다.

- `:root` 안 색 리터럴 42건 — `check-hardcoded-color.mjs` 의 `splitRoot`·`scan`·
  `HEX`/`FUNC`/`NAMED` 정규식을 그대로 재사용해 `inside` 블록을 출력하도록 뒤집었다.
  게이트와 **같은 정의**를 쓰므로 게이트가 통과시킨 것이 정확히 무엇인지 나온다.
- 주입 여부 — `helpers.js:232~272` 의 `vars` 객체 키 32개(+`--term-*` 6)를
  42건과 이름으로 대조했다.
- 테마 대비 — `themes.js` 의 `THEMES` 를 중괄호 균형으로 잘라 `eval` 하고,
  `contrast.js` 와 **같은 WCAG 2.1 공식**으로 54종 × `ui.bg` 를 계산했다.
- 죽은 클래스 — CSS 898 클래스를 JS 118벌 + `index.html` 전문과 대조하되,
  `'pfx-' +` 꼴 동적 접두 24종과 `+ '-sfx'` 꼴 동적 접미 21종을 먼저 추출해
  조립 가능한 이름을 제외했다. (이 단계 없이는 오탐이 90건이었다.)
- 값 분포 — `grep -o` + `sort | uniq -c`.

재현용 스크립트는 `/tmp/{root-lits,js-lits,dead,kf,depth}.mjs` 에 있으나
임시 파일이므로 필요하면 위 서술로 다시 만든다.

## 부록 B. 이 감사가 답하지 못한 것

- **브라우저 렌더 검증 없음.** 54종을 실제로 그려 보지 않았다. §3 의 판정은
  계산 가능한 제약에 한한다.
- **`--text-dim` 의 `color:` 사용 여부를 세지 않았다.** `DESIGN_TOKENS_SRS` §2.1 이
  착수 시 99곳이라고 적었고 그 뒤 `--text-hint` 가 생겼는데, 현재 몇 곳이 남았는지는
  이 감사가 확인하지 않았다 (§7-3).
- **Monaco 테마 파생**(`FileEditor.applyTheme`)은 범위 밖이다. `helpers.js:300` 이
  호출하는 것은 확인했으나 그 안의 색 처리는 보지 않았다.
- **`style-git.css`·`style-git-views.css`·`style-editor.css` 의 본문을 전부 읽지
  않았다.** 색·간격·글자·층은 스크립트로 전수 집계했으나, 규칙 하나하나의
  타당성은 검토하지 않았다.
