# SRS: 시스템 다크/라이트 추종 — 테마 둘과 첫 페인트 (IEEE 29148)

> **문서 상태**: 승인·구현완료

- 접수: 2026-09-13 (로드맵 M7 `UX-19` — "시스템 다크/라이트 추종 없음,
  `prefers-color-scheme` 0건")
- 마일스톤: M7 — 디자인 시스템. P2.
- 짝: [DESIGN_TOKENS_SRS](./DESIGN_TOKENS_SRS.md) §8 비목표 4 ("토큰 위에 서지만
  별개 항목") · [BOOT_SCREEN_SRS](./BOOT_SCREEN_SRS.md) FR-BTS-3~5 (첫 페인트
  선주입 — 이 문서가 그 캐시를 **둘**로 늘린다)

---

## 1. 개요

### 1.1 목적

OS 가 낮에 라이트, 밤에 다크로 바뀌어도 이 앱은 한 테마에 머문다. 테마 54종
(dark 43 · light 11)이 있고 각 테마가 `mode` 를 갖고 있으므로, 부족한 것은
**"어느 쪽을 따를 것인가" 의 스위치와 모드마다 하나씩의 자리**다.

### 1.2 범위

**포함**
- 설정 하나: `themeFollowSystem` (기본 꺼짐). 켜면 `prefers-color-scheme` 이
  다크/라이트 슬롯 중 하나를 고른다 (§3).
- 슬롯 둘: `themeNameDark` · `themeNameLight`. 테마 목록에서 고르는 일이 그
  테마의 `mode` 에 맞는 슬롯을 채운다.
- 첫 페인트: 선주입이 **두 맵**을 캐시하고 `matchMedia` 로 고른다 — 깜빡임 0
  (로드맵 DoD).

**비포함**
- 사용자 정의 테마(`customTheme`)의 슬롯화. 사용자 정의는 이름을 이기며(기존
  규약) 추종을 켜면 사용자 정의는 무시된다 — 그 사실을 화면이 말한다.
- 터미널·Monaco 의 별도 추종. 둘은 테마에서 파생하므로 테마가 바뀌면 따라온다.

### 1.3 정의

| 용어 | 정의 |
|---|---|
| **시스템 모드** | `matchMedia('(prefers-color-scheme: dark)').matches` 의 값. `dark`/`light` |
| **슬롯** | 모드마다 하나인 테마 이름. `themeNameDark`·`themeNameLight` |
| **맵** | `applyThemeObj` 가 세우는 최종 CSS 변수 객체 (BOOT_SCREEN_SRS D-4) |

## 2. 현재 상태

`prefers-color-scheme` 이 CSS·JS 어디에도 없다. `applyThemeObj(t)` 가 계산과
적용과 캐시를 한 함수에서 한다 — 다른 모드의 맵을 **적용하지 않고** 계산할 길이
없다. 선주입(`index.html` head)은 `dm.themeVars` 하나를 읽는다.

## 3. 요구사항

| ID | 요구 | 등급 |
|---|---|---|
| FR-STF-1 | 설정 `themeFollowSystem`(bool, 기본 false) · `themeNameDark`(string, 기본 `Tokyo Night`) · `themeNameLight`(string, 기본 `GitHub Light`) 가 `SETTINGS_SCHEMA`·`SETTINGS_ACCESS` 에 있다 (CONFIG_MANAGEMENT FR-CFG-1·5). | 필수 |
| FR-STF-2 | 추종이 켜져 있으면 적용되는 테마는 **시스템 모드의 슬롯**이다. 시스템 모드가 바뀌면(`matchMedia` change) 그 자리에서 다시 적용한다 — 새로고침이 필요 없다. | 필수 |
| FR-STF-3 | 추종이 켜진 채 목록에서 테마를 고르면 그 테마의 `mode` 에 맞는 슬롯이 바뀐다. 지금 시스템 모드와 같은 쪽이면 즉시 적용되고, 다른 쪽이면 저장만 된다 — 화면은 두 슬롯을 **둘 다 표시**한다 (`active` 는 적용 중인 것, `slot` 은 반대 모드의 것). | 필수 |
| FR-STF-4 | 추종이 꺼져 있으면 종전과 같다 — `themeName` 하나. 켜는 순간 현재 테마가 자기 모드의 슬롯에 들어간다(빈 슬롯은 기본값). | 필수 |
| FR-STF-5 | **첫 페인트에 깜빡임이 없다.** `applyThemeObj` 는 추종이 켜져 있으면 두 슬롯의 맵을 **둘 다** 캐시하고(`dm.themeVars.dark`·`dm.themeVars.light`), 선주입은 `dm.themeFollow==='1'` 이면 `matchMedia` 로 그중 하나를 세운다. 꺼져 있으면 종전 키 하나다. | 필수 |
| FR-STF-6 | 맵 계산은 적용과 분리된다: `themeVarsOf(t)` 가 순수 계산이고 `applyThemeObj(t)` 가 그것을 세운다. 반대 모드의 맵은 화면에 닿지 않고 계산된다. | 필수 |
| FR-STF-7 | 사용자 정의 테마가 있는 채 추종을 켜면 사용자 정의는 **적용되지 않고** 남는다. 패널이 그 사실을 한 줄로 말한다 (`.ds-hint`). | 필수 |
| FR-STF-8 | 설정 화면의 스위치는 테마 패널 머리의 `.ds-row` 체크박스 하나다 (`#ds-theme-follow`). 이름은 `.ds-row` 구조에서 파생한다 (`_labelSettingsRows`, G7-1). | 필수 |

## 4. 설계 결정

**D-STF-1: 슬롯은 둘이고 이름은 셋이다 — `themeName` 을 없애지 않는다.**
  추종이 꺼진 사용자의 저장 블롭에는 `themeName` 만 있다. 그것을 슬롯으로
  옮기면 이식 표(SETTINGS_PORTABILITY §3.1)와 옛 백업이 깨진다. 세 이름이 공존하고
  `themeFollowSystem` 이 어느 것을 읽을지 고른다.

**D-STF-2: 선주입은 맵을 고르기만 한다.**
  BOOT_SCREEN_SRS D-4 의 규약 — 파생을 첫 페인트에서 다시 계산하지 않는다 — 를
  지킨다. 캐시가 둘이 되는 것이 전부이며, `matchMedia` 한 번은 계산이 아니다.

**D-STF-3: 사용자 정의는 슬롯이 되지 않는다.**
  사용자 정의 테마는 `mode` 를 갖지 않는다(편집기가 팔레트만 만든다). 어느 슬롯인지
  정할 수 없으므로 추종과 함께 쓰지 않는다 — 켜면 무시되고, 그 사실이 보인다.

## 5. 검증

| ID | 무엇 |
|---|---|
| TC-STF-1 (e2e `theme.spec.ts`) | 추종을 켜고 `page.emulateMedia({colorScheme})` 로 다크→라이트를 건너면 `--bg` 가 라이트 슬롯의 `ui.bg` 로 바뀐다 — 새로고침 없이 (FR-STF-2) |
| TC-STF-2 (e2e) | 추종이 켜진 채 라이트 테마를 고르면 `themeNameLight` 가 바뀌고, 시스템이 다크면 화면은 다크 슬롯 그대로다 (FR-STF-3) |
| TC-STF-3 (e2e) | 추종을 켠 뒤 새로고침의 **첫 페인트** — 선주입만 돈 시점(`document.documentElement.style` 이 스크립트 로드 전에 세워진다)에 `--bg` 가 시스템 모드 슬롯의 값이다. `page.emulateMedia` 로 두 모드를 각각 확인한다 (FR-STF-5) |
| TC-CFG-1 (Go) | 스키마·접근자 키 집합 일치 — 기존 검사가 새 키 셋을 잡는다 |

## 6. 비목표

1. 슬롯마다 다른 사용자 정의 테마. 2. 시간대 기반 전환. 3. 터미널 ANSI 팔레트의 별도
추종.

## 7. 리스크

| 리스크 | 등급 | 완화 |
|---|---|---|
| 첫 페인트가 선주입 뒤 `_settingsApply` 에서 한 번 더 바뀐다(다른 모드로) | MEDIUM | 선주입과 런타임이 **같은 `matchMedia`** 를 읽는다. TC-STF-3 |
| 다른 창에서 슬롯이 바뀌면 SSE 로 온 블롭이 추종 상태를 따라 적용돼야 한다 | LOW | `_settingsApply` 의 테마 갈래가 추종을 먼저 본다 |

## 8. 변경 기록

| 날짜 | 내용 |
|---|---|
| 2026-09-13 | 초안·구현. TC-STF-1~3 GREEN (`theme.spec.ts`). 첫 페인트 측정은 `CSSStyleDeclaration.prototype.setProperty` 를 가로채 첫 `--bg` 를 읽는다 — 문서가 서기 전에 도는 init 스크립트라 요소를 볼 수 없다. TC-CFG-4 의 서술자 수 20 → 23 |
