# SRS: 부팅 화면과 테마 선주입 (IEEE 29148 준수)

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)
페이지를 열 때 **저장된 테마가 아닌 기본 테마(Tokyo Night)가 먼저 그려지는 것**을 없애고, 앱이
쓸 수 있는 상태가 될 때까지 **부팅 화면**으로 덮는다.

### 1.2 범위 (Scope)
- 포함: `web/index.html`(head 선주입 스크립트 · 부팅 화면 마크업 · 스크립트 로드 1줄),
  `web/style.css`(부팅 화면 스타일), `web/js/core/helpers.js`(`applyThemeObj` 의 캐시 기록),
  `web/js/core/constants.js`(상수), `web/js/ui/boot-screen.js`(신규), `web/js/core/main.js`(걷힘 배선),
  `e2e/fixtures.ts`(준비 판정), `e2e/boot-screen.spec.ts`(신규).
- 비포함: 테마 정의(`themes.js`) 변경, `/api/settings` 스키마 변경, 서버측 렌더링, 스플래시 이미지 자산 추가,
  `soft-reload`(FR-SRL) 경로의 화면 재구성.

### 1.3 정의 (Definitions)
- **테마 변수**: `applyThemeObj` 가 `documentElement.style` 에 세우는 CSS 커스텀 프로퍼티 전부
  (`--bg` 외 파생값 `--border-strong`·`--slot-edge`·`--accent-*`·`--attn-*` 포함).
- **선주입(pre-seed)**: 첫 페인트 **이전에** head 의 인라인 스크립트가 테마 변수를 세우는 것.
- **부팅 화면(boot screen)**: `#boot` 오버레이. 로고 · 워드마크 · 진행 바 · 단계 텍스트로 구성한다. 로고와 브랜드 색은 파비콘(`assets/favicon.svg`)의 것과 같다.
- **준비 완료(boot ready)**: 테마 결정(설정 응답의 성공 또는 실패)과 `app.init()` 완료가 **모두** 끝난 상태.

## 2. 현황 (Current State)
1. `web/style.css:11` `:root` 가 Tokyo Night 값을 하드코딩한다 — 이것이 첫 페인트의 색이다.
2. `web/js/core/main.js:11` 의 IIFE 가 `GET /api/settings` 를 기다린 뒤 `applyThemeObj()` 로 덮는다
   (`main.js:21-22`). 즉 저장된 테마는 **네트워크 왕복 뒤**에야 화면에 닿는다.
3. `app.init()`(`web/js/core/app.js:113`)은 그 IIFE 와 **병렬**로 돌며 `/api/state` 를 기다린다. 그
   동안 사이드바·탑바·빈 `#area` 골격이 기본 테마 색으로 보인다.
4. 결과: 밝은 테마 사용자는 어두운 화면을 먼저 보고, 모든 사용자는 빈 골격이 채워지는 과정을 본다.

### 2.1 사용자 결정 (2026-09-06)
- **D-1** 부팅 화면은 "테마 결정 + 워크스페이스 준비 완료" 에서 걷는다. 터미널의 첫 출력은 기다리지 않는다.
- **D-2** 테마 캐시가 없는 최초 접속의 부팅 화면 색은 **현재 `:root` 기본값(Tokyo Night)** 이다. 중립색을 새로 만들지 않는다.
- **D-3** 부팅 화면 구성은 **로고 + 워드마크 + 진행 바 + 단계 텍스트**다. 진행 바는 비율을 말하지 않는다(흐른다) — 부팅의 두 걸음은 각자 네트워크에 달려 있어 남은 양을 셀 수 없다.

### 2.2 설계 결정
- **D-4** 캐시에 담는 것은 테마 이름이나 팔레트가 아니라 **최종 CSS 변수 맵**이다. 파생값 계산
  (`mixHex`·`pickAttnColor`)이 head 인라인 스크립트에 **복제되지 않아야** 하고, 그 계산은
  `applyThemeObj` 한 자리에만 산다.
- **D-5** 캐시 기록 지점은 `applyThemeObj` 안이다. 테마가 바뀌는 모든 경로(설정 복원 `main.js:21`,
  테마 선택 `app-settings.js:274`, 커스텀 편집 `app-settings.js:385`, 백업 가져오기 후 reload)가 이 함수를 지난다.
- **D-6** 선주입은 `sidebarWidth`·`sidebarCollapsed` 를 세우는 **기존 head 인라인 스크립트와 같은 자리**다
  (SIDEBAR_COLLAPSE_SRS FR-SBC-5 와 같은 근거: 첫 페인트에 필요한 것은 첫 페인트 전에 한 걸음으로 세운다).
- **D-7** 부팅 화면은 **정적 마크업**이다. JS 로 만들면 스크립트가 실행될 때까지 골격이 노출된다.

## 3. 요구사항 (Requirements)

### 3.1 기능 요구사항 (Functional)
| ID | 요구사항 | 우선 |
|----|---------|------|
| FR-BTS-1 | `applyThemeObj(t)` 는 자신이 세운 테마 변수 전부를 `{변수명: 값}` 맵으로 `localStorage['dm.themeVars']` 에 JSON 으로 기록한다. | 필수 |
| FR-BTS-2 | 기록 실패(사생활 모드·용량 초과)는 무시한다. 테마 적용 자체는 영향받지 않는다. | 필수 |
| FR-BTS-3 | `index.html` head 의 인라인 스크립트는 `dm.themeVars` 를 읽어 `documentElement.style` 에 그대로 세운다. 파생값을 다시 계산하지 않는다. | 필수 |
| FR-BTS-4 | 캐시가 없거나 JSON 이 깨졌거나 값이 객체가 아니면 아무것도 세우지 않는다 — 첫 페인트는 `:root` 기본값이다 (D-2). | 필수 |
| FR-BTS-5 | 선주입은 CSS 커스텀 프로퍼티(`--` 로 시작하는 키)만 세운다. 그 밖의 키는 무시한다. | 필수 |
| FR-BTS-6 | `index.html` 은 `#boot` 오버레이를 **정적 마크업**으로 가진다. 로고(인라인 SVG) · 워드마크 · 진행 바 · 단계 텍스트(`#boot-step`)를 포함한다. | 필수 |
| FR-BTS-7 | `#boot` 는 화면 전체를 덮고(모든 UI 위: `z-index` 1000) 배경은 `var(--bg)`, 텍스트는 `var(--text-muted)` 다 — 선주입된 테마를 따른다. | 필수 |
| FR-BTS-8 | `#boot` 는 걷히기 전 포인터 입력을 받는다(아래 UI 로 새지 않는다). | 필수 |
| FR-BTS-9 | `#boot-step` 의 초기 문구는 마크업에 있다("설정을 불러옵니다") — JS 가 돌기 전에도 보인다. | 필수 |
| FR-BTS-10 | `BootScreen.step(text)` 는 단계 문구를 바꾼다. `#boot` 가 이미 걷혔으면 아무 일도 하지 않는다. | 필수 |
| FR-BTS-11 | 설정 응답 처리가 끝나면 단계는 "워크스페이스를 복원합니다" 로 바뀐다. | 필수 |
| FR-BTS-12 | `BootScreen.done()` 은 `#boot` 를 페이드아웃(`BOOT_FADE_MS`)한 뒤 DOM 에서 제거한다. 두 번 불려도 한 번만 동작한다. | 필수 |
| FR-BTS-13 | 부팅 화면은 **테마 결정과 `app.init()` 완료가 모두 끝난 뒤** 걷힌다 (D-1). 둘 중 하나가 예외로 끝나도 걷힌다 — 실패는 부팅 화면에 갇히는 사유가 아니다. | 필수 |
| FR-BTS-14 | 페이지 로드 후 `BOOT_MAX_MS` 가 지나면 준비 완료와 무관하게 걷힌다. 서버 무응답에 화면이 영구히 잠기지 않는다. | 필수 |
| FR-BTS-15 | 다른 기기에서 테마를 바꿔 이 기기의 캐시가 낡은 경우, 첫 페인트는 낡은 색이고 설정 응답이 그것을 교정한다. 그 교정은 부팅 화면 아래에서 일어나 사용자에게 보이지 않는다. | 필수 |
| FR-BTS-16 | `e2e/fixtures.ts` 의 `waitForInit` 은 준비 판정에 **`#boot` 가 사라졌다**를 더한다 — 부팅 화면이 살아 있는 동안의 클릭은 스펙을 무작위로 깨뜨린다. | 필수 |

### 3.2 비기능 요구사항 (Non-functional)
- NFR-1 선주입 스크립트는 동기 인라인 1줄이며 네트워크에 닿지 않는다. 첫 페인트를 지연시키지 않는다.
- NFR-2 `applyThemeObj` 의 기존 동작(변수 값·`#area` 배경·xterm 테마·하위 뷰 훅)은 바뀌지 않는다.
- NFR-3 부팅 화면 CSS 는 `style.css` 에 산다. 새 CSS 파일과 `<link>` 를 늘리지 않는다(캐스케이드 순서 규약).
- NFR-4 기존 e2e 는 `waitForInit` 변경 외의 수정 없이 통과한다.

### 3.3 이전 동작 / 새 동작 / 이유
| 항목 | 이전 | 새 | 이유 |
|------|------|-----|------|
| 첫 페인트의 색 | 항상 Tokyo Night | 이 기기가 마지막에 쓴 테마(캐시 없으면 Tokyo Night) | 저장한 테마가 아닌 색이 보이지 않아야 한다 |
| 부팅 중 화면 | 빈 골격이 채워지는 과정이 보인다 | `#boot` 가 덮는다 | 준비되지 않은 화면은 조작 대상이 아니다 |
| 테마 저장 부수효과 | 없음 | `localStorage['dm.themeVars']` 기록 | 선주입의 유일한 입력 |

## 4. 검증 (Verification)
| ID | 대상 | 검증 방법 |
|----|------|----------|
| V-1 | FR-BTS-1·3·4 | e2e: 밝은 테마를 고르고 reload → **첫 페인트 시점**(`#boot` 가 살아 있는 동안)의 `--bg` 가 밝은 값이다. |
| V-2 | FR-BTS-4 | e2e: `localStorage` 를 비우고 첫 로드 → `--bg` 가 `:root` 기본값(`#1a1b26`)이다. 예외 없이 뜬다. |
| V-3 | FR-BTS-5 | e2e: 캐시에 `--bg` 와 비커스텀 키를 섞어 넣고 로드 → 커스텀만 반영되고 오류가 없다. |
| V-4 | FR-BTS-6·7·9 | e2e: `goto` 직후 `#boot` 가 보이고 로고·워드마크·진행 바가 함께 서며, `#boot-step` 에 문구가 있다. |
| V-5 | FR-BTS-12·13 | e2e: `waitForInit` 뒤 `#boot` 가 DOM 에 없고, 포커스된 칸의 터미널이 서 있다. |
| V-6 | FR-BTS-14 | e2e: `/api/settings` 를 무한 지연시켜도 `BOOT_MAX_MS + 여유` 안에 `#boot` 가 걷힌다. |
| V-7 | NFR-2·4 | `npx playwright test e2e/theme.spec.ts e2e/basic.spec.ts e2e/settings.spec.ts` 통과. |

## 5. 리스크
- LOW: 첫 페인트 경로에 인라인 스크립트 1줄과 오버레이 1개가 추가된다. 실패 경로는 전부 "선주입하지 않음 = 종전 동작" 으로 떨어진다.
- MEDIUM: 걷힘 조건이 `app.init()` 의 프로미스에 걸리므로, init 이 예외로 끝나면 걷힘도 그 자리에서 나야 한다 (FR-BTS-13) — 상한(FR-BTS-14)이 2차 방어다.
- 잔여: 낡은 캐시로 인한 첫 페인트 색 오차는 부팅 화면 아래에 숨는다 (FR-BTS-15).
