# SRS: Bright Dark 테마 추가 (IEEE 29148 준수)

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)
Cobalt²처럼 다크 모드이면서 배경 휘도가 상대적으로 높거나 색 채도가 높아 "밝게 느껴지는" 다크 테마를 추가한다. 기존 `THEMES_EXPANSION_SRS.md`(아카이브)의 후속 확장 스펙.

### 1.2 범위 (Scope)
- 포함: `web/js/ui/themes.js` 의 `THEMES` 객체에 `mode:'dark'` 항목 추가.
- 비포함: 테마 피커 UI(`_renderThemePanel`) 구조 변경, 신규 섹션(예: "Bright Dark") 신설, 색 토큰 신설, 기존 테마 값 수정.
- 사용자 결정(2026-08-28): 신규 항목은 별도 섹션 없이 기존 **Dark 섹션에 합쳐** 노출한다. 추가 규모는 8~10개.

### 1.3 정의 (Definitions)
- **Bright dark**: `mode==='dark'` 이면서 (a) 배경 휘도가 기존 다크 평균보다 높거나, (b) 전경/ANSI 색의 채도가 높아 화면 인상이 밝은 테마. 기준점은 Cobalt²(`bg #193549`, accent `#ffc600`).
- **Near-duplicate**: 두 테마의 주요 토큰(`bg/accent/red/green/blue`) 색차가 사람 눈에 구분되지 않는 경우.
- **UI 토큰**: `bg, sidebarBg, border, accent, text, textMuted, textBright, textDim, danger, accentBorder`.
- **터미널 토큰**: `background, foreground, cursor, cursorAccent, selectionBackground, selectionForeground` + ANSI 16색.

## 2. 현황 (Current State)
- `web/js/ui/themes.js` 에 다크 32개 / 라이트 11개 = 총 43개.
- 다크군 중 "밝은" 인상은 Cobalt², Shades of Purple, Synthwave '84, Catppuccin Frappé 정도로 편중되어 있고, 대부분은 `bg` 휘도가 낮다.
- 테마 피커는 `mode` 값으로 Dark/Light 2개 섹션만 렌더링한다(`web/js/core/app-settings.js:_renderThemePanel`).

## 3. 요구사항 (Requirements)

### 3.1 기능 요구사항 (Functional)
| ID | 요구사항 | 우선 |
|----|---------|------|
| FR-1 | 신규 다크 테마 10개를 추가한다: Tokyo Night Storm, Ayu Mirage, Oceanic Next, Panda Syntax, LaserWave, Zenburn, Tomorrow Night Eighties, Gruvbox Material, Mariana, Hopscotch. | 필수 |
| FR-2 | 모든 신규 항목은 `mode:'dark'` 이며, UI 토큰 10개와 터미널 토큰 22개를 빠짐없이 채운다. | 필수 |
| FR-3 | 각 신규 항목의 색값은 해당 원본 테마(공개된 IDE/터미널 팔레트)를 근거로 하며, 임의 창작 색으로 대체하지 않는다. | 필수 |
| FR-4 | 신규 항목은 기존 테마와 near-duplicate 가 아니어야 한다. 특히 Oceanic Next↔Material Ocean, Gruvbox Material↔Gruvbox Dark, Tomorrow Night Eighties↔Tomorrow Night 은 `bg` 및 `accent` 가 육안으로 구분되어야 한다. | 필수 |
| FR-5 | 신규 항목은 `THEMES` 의 마지막 다크 항목(`Catppuccin Frappé`) 직후, 첫 라이트 항목(`GitHub Light`) 직전에 삽입한다. | 필수 |
| FR-6 | 테마 피커의 섹션 개수는 2개(Dark/Light)로 유지되고, Dark 섹션 내 기존 항목의 상대 순서(인덱스 0~31)는 변하지 않는다. | 필수 |
| FR-7 | `_renderThemePanel`, `applyThemeObj`, `pickAttnColor`, 영속화(`themeName`) 로직은 수정하지 않는다. | 필수 |

### 3.2 비기능 요구사항 (Non-functional)
- NFR-1 변경 파일은 `web/js/ui/themes.js` 와 본 스펙 문서로 한정한다.
- NFR-2 기존 `THEMES` 항목의 어떤 값도 변경되지 않는다(diff 는 순수 추가).
- NFR-3 기존 테마 e2e(`e2e/theme.spec.ts`) 는 수정 없이 통과한다.

## 4. 검증 (Verification)
| ID | 검증 방법 |
|----|----------|
| V-1 (FR-1,2) | `node -e` 로 `themes.js` 를 로드해 신규 10개 항목의 존재와 토큰 32개 전수 충족을 확인한다. |
| V-2 (FR-4) | 신규/기존 쌍의 `bg`, `accent` 값이 서로 다른지 프로그램적으로 확인하고, 지정 3쌍은 육안 대비를 명시한다. |
| V-3 (FR-6) | `npx playwright test e2e/theme.spec.ts` — 섹션 2개, Dark nth(5)=Solarized Dark 전제 회귀 없음. |
| V-4 (NFR-2) | `git diff web/js/ui/themes.js` 가 추가 라인만 포함(삭제/변경 라인 0). |

## 5. 리스크
- LOW: 데이터 추가 전용. 구조 변경 없음.
- 잔여 리스크: 원본 팔레트 색값의 세부 정확도(공개 팔레트 기억 기반) — 육안 검수로 보정한다.
