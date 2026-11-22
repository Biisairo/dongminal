# SRS: 메인색 — 색 하나로 테마 전체를 그 방향으로 계산 (IEEE 29148 준수)

> **문서 상태**: 승인·구현완료
>
> 근거: `web/js/core/theme-vars.js` `seedTheme`·`web/js/test/seed-color.test.mjs`·`e2e/theme-seed.spec.ts`·`scripts/check-contrast.mjs`(메인색 조합 432개). FR-SEED-14 실측에서 미달은 Everforest Light 의 `accent2` 대비뿐이었다 — 조화 강도가 아니라 파생 규칙의 문제라 `UX_AUDIT_FIX_SRS` FR-UXF-126 을 개정했다(끌어올림)

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)
사용자가 **메인색** 하나를 고르면, 지금 테마의 모든 색이 그 메인색 방향으로 계산되어 화면에 적용된다. 테마의 성격(밝기·채도·색들 사이의 관계)은 유지된다. 계산된 색은 저장하지 않고 실행 중에 만든다.

### 1.2 범위 (Scope)
- 포함: 메인색 설정 한 값(서버 설정), 테마 변환 함수, 설정 ▸ 테마 탭 맨 위의 메인색 행, 테마 목록·미리보기·사용자 정의 테마·시스템 테마 따르기와의 결합, 시험·게이트
- 비포함: 테마 데이터(`themes.js`) 수정, 테마마다 다른 메인색, 변환 강도 설정, 회색(무채색) 테마 생성, 계정 색(`deriveAccountColors`) 변경

### 1.3 정의 (Definitions)
- **OKLCH**: 지각 균일 색공간. `L`(밝기 0~1), `C`(채도 0~), `h`(색상 0~360°). 이 문서의 색상·밝기·채도는 모두 OKLCH 기준이다
- **메인색**: 사용자가 고른 색. **색상 `h` 만** 쓴다
- **기준 색상**: 그 테마의 원래 `ui.accent` 의 `h`
- **회전각** `Δ`: 메인색 `h` − 기준 색상 (−180°~180° 로 정규화)
- **테마색**: 테마마다 성격이 다른 색. `ui` 의 `bg·sidebarBg·border·accent·text·textMuted·textBright·textDim·accentBorder`, `terminal` 의 `background·foreground·cursor·cursorAccent·selectionBackground·selectionForeground`
- **의미색**: 어느 테마에서나 같은 계열인 색. `ui.danger`, `terminal` 의 ANSI 16색(`black…white`, `brightBlack…brightWhite`)
- **회전**: 색의 `L`·`C` 를 두고 `h` 에 `Δ` 를 더한다
- **조화(harmonize)**: 색의 `L`·`C` 를 두고 `h` 를 새 accent 의 `h` 쪽으로 `min(|차이|/2, 15°)` 만큼 옮긴다 (Google Material Color Utilities `Blend.harmonize` 와 같은 식)
- **색역 맞춤**: 계산한 OKLCH 색이 sRGB 밖이면 `L`·`h` 를 두고 `C` 를 sRGB 안에 들 때까지 줄인다

### 1.4 사용자 결정 (2026-11-21)

| # | 결정 |
|---|---|
| D-SEED-1 | 메인색에 맞춰 **모든 색**을 계산한다. 테마색은 회전하고, 의미색(터미널 ANSI·경고)은 회전하지 않되 메인색에 어울리게 세부 조절한다 |
| D-SEED-2 | 메인색은 **색상만** 쓰고 밝기·채도는 테마 원래 accent 에 맞춘다 — 같은 색을 골라도 테마답게 나온다 |
| D-SEED-3 | 메인색은 **하나**이고 모든 테마에 적용된다. 계산 결과는 저장하지 않고 실행 중에 계산한다. 메인색은 테마 바깥의 설정이다 |
| D-SEED-4 | 정하는 자리는 설정 ▸ 테마 탭 **맨 위의 따로 된 행**이다 |
| D-SEED-5 | 사용자 정의 테마도 **같이 회전**한다. 편집기는 회전 전 원본 값을 고친다 |
| D-SEED-6 | 의미색 조절 강도는 위임받았다 — Material 기준(차이의 절반, 최대 15°)을 쓰고 54종 실측으로 확인한다 (FR-SEED-14) |

### 1.5 가정 (Assumptions)
- A-1: 메인색의 채도가 0.02 미만(회색)이면 색상이 정해지지 않으므로 메인색이 없는 것과 같다
- A-2: `accent2`·알림색은 변환된 테마에서 기존 규칙(`pickAccent2`·`pickAttnColor`)으로 다시 고른다. 테마의 `accent2` 명시값은 메인색이 있을 때 쓰지 않는다 — 기준 accent 에 맞춰 고른 값이라 새 accent 와 겹칠 수 있다
- A-3: 글자 대비는 기존 파생(`deriveContrastTokens`)이 변환된 색 위에서 그대로 보장한다

## 2. 현황 (Current State)
- 테마 적용은 `applyThemeObj(theme)`(`web/js/core/theme-vars.js`) 한 자리이고, 변수 맵은 `themeVarsOf(theme)` 가 만든다. 첫 페인트는 이 맵의 캐시를 선주입한다(FR-BTS-1, FR-STF-5)
- `accent` 에서 이미 파생되는 색: `--accent-hover/active/subtle`, `--slot-edge`, `--focus-ring`, `--accent-text`, 알림색 선택. 따로 적힌 값: `accentBorder`, `accent2`
- 사용자 정의 편집기에서 accent 만 바꾸면 `accentBorder`·`accent2` 가 옛 색에 남는다 — 이 기능이 그 빈틈도 메운다
- OKLCH 계산 함수가 없다

## 3. 요구사항 (Specific Requirements)

### 3.1 설정

**FR-SEED-1** — 서버 설정에 `seedColor` 키(`type:string`)를 둔다. 값은 `#rrggbb` 또는 `""`(끔). 기본은 `""`. `#rrggbb` 꼴이 아닌 값은 끔으로 본다. 다른 테마 설정과 같은 경로(`SETTINGS_ACCESS`, `/api/settings`)로 실리고 모든 기기가 같이 쓴다.

**FR-SEED-2** — `seedColor` 가 끔이거나 채도가 0.02 미만이면 테마는 원본 그대로 적용된다(지금과 같은 결과, 비트 단위로 같다).

### 3.2 변환

**FR-SEED-3** — `seedTheme(theme, seed)` 는 테마의 사본을 돌려준다. 원본 객체를 바꾸지 않는다. FR-SEED-2 의 경우 원본과 같은 값의 사본이다.

**FR-SEED-4** — 새 accent: `L`·`C` 는 원래 `ui.accent` 의 것, `h` 는 메인색의 것. 색역 맞춤을 거친다.

**FR-SEED-5** — 테마색(새 accent 제외)은 `Δ` 만큼 회전하고 색역 맞춤을 거친다. 채도 0.02 미만인 색은 색상이 정해지지 않으므로 그대로 둔다.

**FR-SEED-6** — 의미색은 새 accent 쪽으로 조화하고 색역 맞춤을 거친다. 채도 0.02 미만인 색은 그대로 둔다.

**FR-SEED-7** — 변환된 테마는 `ui.accent2` 를 갖지 않는다. `--accent2` 는 변환된 테마에서 `pickAccent2` 로, 알림색은 `pickAttnColor` 로 고른다(A-2).

**FR-SEED-8** — 알파가 붙은 값(`#rrggbbaa`, 예: `selectionBackground`)은 색 부분만 변환하고 알파를 보존한다. 읽지 못하는 값은 그대로 둔다.

### 3.3 적용

**FR-SEED-9** — `applyThemeObj` 는 받은 테마에 메인색 변환을 거친 결과를 적용한다 — 화면 변수, 터미널, 편집기, git 그래프가 모두 같은 변환 결과를 쓴다. 시스템 테마 따르기의 두 슬롯 캐시도 변환 결과다.

**FR-SEED-9a** — 지금 화면의 테마를 읽는 자리는 변환 결과를 돌려주는 `getAppliedTheme()` 를 읽는다. 대상(2026-11-21 조사): `git/history.js:90`(레인 팔레트), `app-settings-theme.js:136`(미리보기). 사용자 정의 편집기를 열 때 복사하는 자리(`app-settings-theme.js:231`)는 원본 `getCurrentTheme()` 그대로다(D-SEED-5).

**FR-SEED-10** — 메인색을 바꾸면 즉시 다시 적용한다. 색 입력을 끄는 동안(`input`)은 화면만 따라가고, 놓을 때(`change`) 저장한다(테마 편집기 FEC-5 와 같다).

**FR-SEED-11** — 사용자 정의 테마도 변환된다(D-SEED-5). 편집기의 색 입력은 원본(`customTheme`) 값을 보이고 고친다. 메인색이 켜져 있으면 편집기 위에 안내 한 줄을 둔다(ko `메인색이 적용 중입니다 — 화면 색은 이 값에서 계산됩니다` · en 같은 뜻).

### 3.4 화면 — 설정 ▸ 테마 탭 맨 위

**FR-SEED-12** — 테마 목록 위에 `메인색` 행을 둔다.
- 켜기 스위치(`ui-switch`, TC-CMP-3). 끄면 `seedColor=""`. 다시 켜면 마지막으로 쓴 색(이 브라우저에서 기억, 없으면 지금 테마 accent)
- 색 입력(`input type=color`). 꺼져 있으면 비활성
- 견본 8개: 색상 0°·45°·…·315° 를 **지금 테마에 맞춘**(FR-SEED-4 와 같은 `L`·`C`) 색으로 칠한 단추. 누르면 그 색이 메인색이 된다. `aria-label`(영어)은 색상 이름
- 툴팁·`aria-label` 은 영어, 보이는 글자는 로케일

**FR-SEED-13** — 테마 목록의 색 점과 미리보기는 메인색 변환 결과를 보인다 — 고르기 전에 결과를 볼 수 있다.

**FR-SEED-15** — 메인색 행의 견본·색 입력·스위치는 설정 본문 폭 안에 든다. 견본은 터치 하한(`--touch-min`)을 지킨 채 줄을 바꾼다. 좁은 폭(행 문법 기준 440px, `UX_AUDIT_FIX_SRS` FR-UXF-50)에서는 손잡이 묶음이 라벨 아래 줄로 내려가고 견본은 넷씩 두 줄이다. 넓은 폭의 모양은 바뀌지 않는다.

> 개정(2026-11-22) — 이전 동작: 손잡이 묶음이 줄지 않아, 390px 모바일에서 견본(44px × 8)이 카드 오른쪽 밖으로 넘쳐 잘렸고 색 입력·스위치가 보이지 않았다.
> 새 동작: 견본이 줄을 바꿔 카드 안에 들고, 색 입력·스위치가 보인다. 데스크톱은 픽셀 단위로 같다.
> 이유: 모바일에서 메인색을 고를 수 없었다(스크린샷 `mobile-settings-theme-after.png`).

### 3.5 품질

**FR-SEED-14** — 54종 × 견본 8 색상 모두에서:
1. 의미색 ANSI 6색(red·green·yellow·blue·magenta·cyan)의 색상이 원래에서 15° 넘게 벗어나지 않는다
2. 기존 대비 게이트(`check-contrast.mjs` 의 글자 토큰·구문 6색·UI 3:1)를 넘는다
3. `--accent2` 의 배경 대비가 3:1 이상이다

어기는 조합이 있으면 그 목록을 사용자에게 보이고, 조화 강도를 낮출지 묻는다.

**NFR-SEED-1** — 변환 한 번(테마 하나)은 데스크톱에서 2ms 안이다(색 약 35개). 첫 페인트는 캐시된 변환 결과를 쓰므로 변환 비용이 실리지 않는다.

## 4. 검증 (Verification)

| TC | 요구 | 방법 |
|---|---|---|
| TC-SEED-1 | FR-SEED-2·3 | unit: `seed` 가 `""`·형식 밖·회색이면 결과가 원본과 깊은 비교로 같고, 원본 객체는 바뀌지 않는다 |
| TC-SEED-2 | FR-SEED-4 | unit: 새 accent 의 `h` 가 메인색 `h`(±1°), `L`·`C` 가 원래 accent(±0.01, 색역 맞춤이 없는 경우) |
| TC-SEED-3 | FR-SEED-5 | unit: 테마색의 `h` 가 `Δ` 만큼(±1°) 돌고 `L` 이 유지된다. 무채색은 그대로다 |
| TC-SEED-4 | FR-SEED-6 | unit: 의미색 `h` 이동량이 `min(|차|/2, 15°)`(±1°)이고 방향이 새 accent 쪽이다 |
| TC-SEED-5 | FR-SEED-7 | unit: 메인색이 있으면 `--accent2` 가 테마 명시값이 아니라 변환 테마의 `pickAccent2` 값이다 |
| TC-SEED-6 | FR-SEED-8 | unit: `#rrggbbaa` 의 알파가 보존된다. 색역 맞춤 결과가 모두 sRGB 안이다 |
| TC-SEED-7 | FR-SEED-14 | 게이트: `check-contrast.mjs` 가 54종 × 8 색상을 잰다 |
| TC-SEED-8 | FR-SEED-1·9·10·12 | e2e: 스위치를 켜고 견본을 누르면 `--accent` 의 색상이 그 견본으로 바뀌고, 터미널 `background` 도 바뀌며, 설정에 `seedColor` 가 저장된다. 끄면 원본 변수와 같다 |
| TC-SEED-9 | FR-SEED-11 | e2e: 사용자 정의 테마에서 메인색이 켜져 있으면 안내가 보이고, 편집기 입력은 원본 값이며, 입력을 바꾸면 화면은 변환된 값이다 |
| TC-SEED-10 | FR-SEED-9a·13 | e2e: 메인색을 바꾸면 테마 목록의 accent 점 색과 미리보기 accent 가 변환 결과다. unit: git 그래프 레인 색이 변환된 팔레트에서 나온다 |
| TC-SEED-11 | NFR-SEED-1 | unit: 54종 변환 평균 시간 기록(실패 조건 아님, 기록만) |
| TC-SEED-12 | FR-SEED-15 | e2e: 390×844 모바일에서 견본·색 입력·스위치의 오른쪽 끝이 행의 안쪽 오른쪽 끝을 넘지 않고, 견본의 짧은 변이 `--touch-min` 이상이다 |

## 5. 리스크

| 리스크 | 등급 | 대응 |
|---|---|---|
| 색역 맞춤으로 채도가 줄어 회전 뒤 색이 탁해진다 (특히 밝은 노랑·청록 방향) | MEDIUM | 화면 확인, FR-SEED-14 실측 |
| 터미널 앱이 이미 칠한 화면은 xterm 팔레트가 바뀌면 다시 칠해진다 — 기존 테마 전환과 같다 | LOW | 없음 |
| 원본 테마 객체를 직접 읽는 코드가 있으면 변환이 새어 나간다 | MEDIUM | 조사 완료 — 두 자리를 FR-SEED-9a 로 옮긴다. 테마 목록의 점(`THEMES[name]`)은 FR-SEED-13 이 덮는다 |
| 시험이 `applyThemeObj(THEMES[n])` 뒤 원본 값을 단정한다 | LOW | 기본 `seedColor=""`(끔)라 영향 없음 |

## 6. 비목표 (Non-goals)
- 테마마다 다른 메인색, 변환 강도 설정
- 메인색에서 밝기·채도 가져오기(D-SEED-2 로 하지 않는다)
- 테마 데이터 자체를 바꾸거나 변환 결과를 저장하기
- 계정 색·git 그래프 레인 팔레트의 별도 조정(레인은 이미 테마 팔레트에서 파생한다 — 변환된 팔레트를 따라간다)

## 7. 구현 위치 (계획)
- `web/js/core/contrast.js`: OKLCH 변환·색역 맞춤 (게이트도 같은 함수를 부른다, D-TOK-5)
- `web/js/core/theme-vars.js`: `seedTheme`, `applyThemeObj` 진입에서 변환
- `web/js/core/app-settings.js`·`app-settings-theme.js`: `seedColor` 설정·메인색 행·편집기 안내
- `web/js/i18n/ko.js`·`en.js`, `web/style.css`
- 시험: `web/js/test/seed-color.test.mjs`, `scripts/check-contrast.mjs`, `e2e/theme-seed.spec.ts`
