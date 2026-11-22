# SRS: 「원래 실패」 로 받아들여 온 시험과 남은 품질 결함 — IEEE 29148

> **문서 상태**: 승인·구현완료

- 접수: 2026-11-22 (프로덕션 리팩토링 3차 마무리 · `REFACTOR_PROD3_HANDOFF_4.md` §3 넷째 · §4 「알려진 e2e 실패」, eslint 원래 2건)
- 사용자 지시: 오랫동안 「원래 실패」 로 받아들여 온 e2e 가 실제 결함인지 낡은 시험인지 가려 **고친다**. 시험을 약하게 만들어 통과시키지 않는다 — 시험이 틀렸다면 어느 SRS 요구·결정이 바뀌었는지 근거를 적는다.
- 실측 기준: HEAD `ab4a91f2`.

## 1. 개요

### 1.1 목적

다섯 e2e 가 지금 HEAD 에서 늘 실패한다. eslint 는 오류 2건을 「원래」 로 두었다. 부팅의 설정 적용과 설정창 세우기(`initModal`) 사이에는 코드가 정한 순서가 없고 null 가드가 그것을 덮는다. 이 문서는 이슈마다 원인을 밝히고, 판정(결함·낡은 시험·환경)과 고칠 방향을 정한다.

| 이슈 | 자리 | 지금 (HEAD `ab4a91f2`) | 판정 | 고칠 방향 |
|---|---|---|---|---|
| QF-1 | `e2e/sidebar-actions.spec.ts` TC-SBA-1 | `#add-group` 의 좌우 끝이 `#add-window` 와 다르다(`left` 126 ≠ 8) | 낡은 시험 | FR-UXF-96(D-32 개정)의 한 줄 배치로 단정을 고친다(§2.1) |
| QF-2 | `e2e/version-autoreload.spec.ts` TC-RLC-25 | 침묵을 흉내낸 뒤 20초 안에 다시 열리지 않는다 | 낡은 시험 | 흉내가 실제로 아무것도 받지 않게 한다(§2.2) |
| QF-3 | `e2e/git-ui-metrics.spec.ts` V80 | 사이드바 접기 단추 `.sb-collapse` 가 26×26 이라 하한 30 미달 | 결함 | 두 패널의 접기 단추를 30px(`lg`)로(§2.3) |
| QF-4 | `e2e/ui-kit-icons.spec.ts` V-GAP-1 | `Box` 상자의 오른쪽 변과 아이콘 오른쪽 변 사이가 5px(기대 > 6) | 낡은 시험 | 라벨이 보이는 폭에서 아이콘과 라벨 사이를 잰다(§2.4) |
| QF-5 | `e2e/skill-contract.spec.ts:451` | 전후 `/api/state` 의 도구 `fgName` 이 `""` → `"~"` | 낡은 시험 (경합) | 「전」 사진을 전경 이름이 자리잡은 뒤에 찍는다(§2.5) |
| QF-6 | `web/js/core/theme-vars.js` · `web/js/test/claude-accounts-foot.test.mjs` | eslint 오류 2건 | 결함(코드 품질) | 이름을 바꾸고 쓰지 않는 변수를 지운다(§2.6) |
| QF-7 | `web/js/core/settings-apply.js` · `settings-terminal.js` · `main.js` | 부팅 적용과 `initModal` 의 순서가 경합이고, 적용 길의 섹션 부름 둘이 「섹션이 없으면 아무것도 안 한다」 로 버틴다 | 결함(구조) | 적용은 상태만 바꾸고 칠하기는 선 섹션만 한다 — 두 순서의 결과가 같음을 구조로 보장한다(§2.7) |

### 1.2 정의

- **원래 실패**: 앞 세션들이 「앞 커밋에서도 남는다」 는 이유로 고치지 않고 둔 실패(`REFACTOR_PROD3_HANDOFF_4.md` §4).
- **낡은 시험**: 시험이 단정하는 동작을 뒤의 SRS 요구·결정이 바꿨는데 시험은 따라오지 않은 것. 고칠 때 그 요구·결정을 근거로 적는다.
- **침묵**: SSE 구독에 아무 수신도 없는 상태. 상한(`SSE_SILENCE_MS` 45초)을 넘으면 버스가 다시 연다(FR-RLC-25). 모든 수신이 생존의 증거다(FR-RLC-28).
- **부팅 적용**: `main.js` 가 `/api/settings` 를 받아 부르는 `_settingsApply(r.data,{boot:true})`.

### 1.3 범위 밖

- `kit-components` TC-CMP-19 — 같은 목록의 원래 실패지만 이번 지시에 들지 않았다(보고만 한다).
- 「흔들림」 목록(`REFACTOR_PROD3_HANDOFF_4.md` §4)의 시험들.
- `SETTINGS_SECTION_DELEGATES` 의 위임자(`_onAccessChanged` 등)가 쓰는 `_sectionCall` 의 「섹션이 없으면」 판정 — 설정 적용 길이 아니다(D-QFX-9).
- e2e 전량.

## 2. 요구사항

### 2.1 QF-1 — 그룹 단추의 여백·모양 (TC-SBA-1)

**원인.** TC-SBA-1(UX_BATCH12_SRS FR-SBA-1, 2026-11-11)은 `#add-group` 이 `#add-window` 와 **같은 좌우 끝**을 갖는다고 단정한다 — 두 단추가 세로로 쌓이던 때의 모양이다. `097d6a73`(2026-11-20, UX_AUDIT_FIX_SRS FR-UXF-96 · D-32 개정)이 데스크톱 `창` 패널의 단추를 한 줄로 바꿨다. 이제 두 단추는 한 줄에 나란히 서므로 좌우 끝이 같을 수 없다. 여백(`margin` 0)·높이(30px)는 지금도 같다.

**판정.** 낡은 시험. 바뀐 근거: FR-UXF-96 · D-32 개정.

| ID | 요구 |
|---|---|
| FR-QFX-1 | TC-SBA-1 은 FR-SBA-1 의 뜻(그룹 단추가 패널 폭을 꽉 채우지 않고 다른 단추와 같은 여백·모양을 쓴다)을 한 줄 배치에서 잰다: 두 단추의 좌우 여백·최소 높이가 같다 · 윗변이 같다(한 줄) · 단추 줄의 왼쪽 안쪽 여백(패널 왼쪽 → `#add-window` 왼쪽)과 오른쪽 안쪽 여백(`#add-group` 오른쪽 → 패널 오른쪽)이 같다 |

### 2.2 QF-2 — 침묵 감시 (TC-RLC-25)

**원인(실측).** 감시는 돈다 — 침묵을 흉내낸 직후 수신이 없으면 1.5초 안에 다시 연다(진단 시험, 세대 1 → 2). 실패하는 것은 흉내다: `waitSettled` 뒤 `sseSeen` 을 120초 전으로 밀어도, 다음 감시 틱(5초 주기) 전에 **실제 수신**(`tool_foreground {name:"~"}`)이 오면 FR-RLC-28 대로 `_seen` 이 지금으로 돌아온다. 그 수신은 `769a27c5`(2026-11-20, UX_AUDIT_FIX_SRS FR-UXF-65 — 쉬는 셸 탭 이름이 cwd 이름)부터 생겼다: 셸이 뜬 뒤 첫 전경 틱이 `"" → "~"` 를 알린다. 그 뒤로는 구독이 침묵하지 않으므로 다시 열 까닭이 없고, 앱은 옳게 동작한다.

**판정.** 낡은 시험. 흉내가 「아무것도 오지 않는다」 를 만들지 못한다. 바뀐 근거: FR-UXF-65 가 부팅 직후 수신을 하나 더했다.

| ID | 요구 |
|---|---|
| FR-QFX-2 | 침묵 흉내(`fakeSilence`)는 지금 구독의 수신 처리기를 떼어(`app.testing.cmdES.onmessage=null` — half-open 소켓처럼 아무것도 앱에 닿지 않는다) 마지막 수신 시각을 과거로 민다. 단정(세대가 오른다)은 그대로다. TC-RLC-26 도 같은 흉내를 쓴다 |

### 2.3 QF-3 — 사이드바 접기 단추의 하한 (V80)

**원인.** FR-GIT-226(`GIT_UI_REVISION_SRS`, 사용자 검토 "그게 최소야. 버튼들 크기도 그 높이에 맞춰서")은 하한을 WINDOWS 목록 행 `.si`(30px)로 올리고 범위를 사이드바 단추까지 넓혔다. V80 은 `#sidebar` 의 모든 단추 높이가 30 이상인지 본다. `.sb-collapse` 는 `43168017`(FR-UXF-30)에서 `lg`(30px)로 섰다가, `25f0bcc0`(D-38: 레일의 접기 단추를 맨 위로)에서 작업 패널의 `.ag-collapse`(26px)에 맞춰 표준(26px)으로 줄었다. 줄인 이유는 크기가 아니라 **두 레일의 탭 선이 4px 어긋난 것**이었다 — 큰 쪽을 작은 쪽에 맞췄고, 그 결과 하한을 깼다.

**판정.** 결함. 두 단추를 같게 하되 큰 쪽(30px)으로 맞춘다. 데스크톱 패널 머리는 32px(`--panel-head-h`), 레일은 40px 이라 30px 단추가 들어간다. 모바일은 `.sb-collapse` 를 감추고 `.ag-collapse` 는 터치 하한(44px)이 이긴다.

| ID | 요구 |
|---|---|
| FR-QFX-3 | 메인 패널의 `.sb-collapse` 와 작업 패널의 `.ag-collapse` 는 키트의 큰 단추(`ui-btn-lg`, `--ui-btn-h-lg` = 30px, 아이콘도 큰 단추의 비율)다. 두 단추의 크기는 같다 |
| FR-QFX-4 | 레일로 접힌 두 패널의 첫 탭 윗변이 같다(D-38 이 지키려던 것) |

화면 변화: §5.

### 2.4 QF-4 — 아이콘과 글자 사이 (V-GAP-1)

**원인.** V-GAP-1(UX_BATCH8 FR-GAP-1)은 `#add-sandbox-window` 의 「상자 오른쪽 변 − 아이콘 오른쪽 변 > 간격 토큰(6px)」 을 단정한다 — 아이콘 뒤에 `Box` 라벨이 서 있어야 참이다. `097d6a73`(FR-UXF-96 · D-32 개정)이 기본 폭(200px) 패널에서 `Box` 라벨을 감췄다(`@container (max-width:259px)`, TC-UXF-95 가 그것을 단정한다). 라벨이 없으니 재는 것은 상자의 오른쪽 안쪽 여백(5px)뿐이다(한 줄 배치의 상자는 왼쪽 테두리만 있다). R4b(`REFACTOR3_FE_REST4_SRS` 간격 토큰)는 이 자리와 무관하다 — `--ui-gap` 은 그대로 6px 이고 `#add-sandbox-window` 의 `gap` 은 그 토큰이다. 이 시험은 R4b 앞(`df15f347`)에서도 같은 값으로 실패했다(`REFACTOR3_FE_SETTINGS_SRS` 8e 기록).

**판정.** 낡은 시험. 바뀐 근거: FR-UXF-96 · D-32 개정 · TC-UXF-95.

| ID | 요구 |
|---|---|
| FR-QFX-5 | V-GAP-1 은 라벨이 보이는 폭(메인 패널 320px)에서 `Box` 의 아이콘 오른쪽 변과 라벨 왼쪽 변 사이가 간격 토큰(`--ui-gap`)과 같은지(±0.5px) 잰다. 상자가 flex 이고 `gap` 이 토큰이라는 단정(FR-GAP-3)은 그대로다 |

### 2.5 QF-5 — 전용 창 Run 의 「사용자 공간 그대로」 (skill-contract)

**원인(실측).** 시험은 브라우저가 뜬 직후 `/api/state` 를 「전」 으로 찍고, Run 을 열고 닫은 뒤의 「후」 와 통째로 견준다. 「전」 의 셸 도구는 `fgName:""`, 「후」 는 `"~"` 다. `fgName` 은 데몬의 전경 틱(2초 주기, `fgRefreshInterval`)이 채운다 — 셸이 뜬 직후에는 cwd 를 아직 모르고(셸 훅의 첫 보고 전), 그 다음 틱이 cwd 이름을 낸다(FR-UXF-65, 홈이면 `~`). 「환경 실패」 라 적힌 것은 이 기계에서 셸 cwd 가 서버 사용자의 홈이라 `~` 가 나온 것을 보고 붙인 이름이다. 실제 원인은 환경이 아니라 **「전」 을 이름이 자리잡기 전에 찍는 경합**이다 — cwd 를 읽을 수 있는 모든 기계에서 같다. FR-UXF-65(`769a27c5`) 전에는 쉬는 셸의 이름이 늘 `""` 라 경합이 드러나지 않았다.

**판정.** 낡은 시험(경합). skip 조건을 두지 않는다 — 환경 조건이 원인이 아니다.

| ID | 요구 |
|---|---|
| FR-QFX-6 | 「전」 사진은 도구의 런타임 값이 자리잡은 뒤에 찍는다: `/api/state` 를 전경 틱 주기보다 긴 간격(2.5초)으로 두 번 읽어 같을 때의 값이다(상한 20초). 「후」 와 통째로 견주는 단정은 그대로다 |

### 2.6 QF-6 — eslint 원래 2건

| ID | 요구 |
|---|---|
| FR-QFX-7 | `sanitizeCustomTheme(t)` 의 인자 이름을 `theme` 으로 바꾼다(전역 i18n `t()` 를 가리지 않는다, `local/no-shadow-i18n`). 동작 같음 |
| FR-QFX-8 | `claude-accounts-foot.test.mjs` 의 쓰지 않는 `const b` 를 지운다(`73207c0f` 부터 쓰이지 않았다). `make lint` 의 eslint 가 0 이다 |

### 2.7 QF-7 — 부팅 적용과 설정창 세우기의 순서

**원인.** `main.js` 의 부팅 적용(`/api/settings` 응답 뒤)과 `initModal`(`App.init` 의 `_bind` → `InputBinding.bind`, 워크스페이스를 받은 뒤)은 서로 다른 네트워크 응답을 기다리는 두 비동기 흐름이라 어느 쪽이 먼저일지 코드가 정하지 않는다. 적용이 먼저면 설정창의 섹션이 아직 없다. 적용 길은 그때를 이렇게 버틴다:

1. `_keybarApply` — `if(this.app.modKbd)`(모바일 키바가 섰는가) · `_sectionCall('terminal','_keybarPaint')`(섹션이 없으면 아무것도 안 한다)
2. `_pollMigrateAgents` — `_sectionCall('polling','paint')`
3. `_paintSettingControls` — 선 섹션만 돈다(없으면 빈 순회)

결과는 지금도 두 순서에서 같다 — 섹션의 `init` 과 `initMobileKeybar` 가 서면서 지금 상태로 칠하기 때문이다. 그러나 그 사실은 가드 셋이 우연히 맞물려 지키고, 어느 하나라도 빠지면 한쪽 순서에서만 터진다.

**판정.** 결함(구조). 동작은 바꾸지 않는다.

| ID | 요구 |
|---|---|
| FR-QFX-9 | 설정 적용(`_settingsApply`)은 값(상태)을 얹고, 설정창의 칠하기는 `_paintSettingControls` 한 자리(선 섹션의 `paint()`)로만 한다. 적용 길에서 `_sectionCall` 을 부르지 않는다 |
| FR-QFX-10 | `TerminalSection.paint()` 가 키바 구성 목록(`_keybarPaint`)도 칠한다. `_keybarApply` 는 모바일 키바만 다시 그린다(`_mkbRender`·`mkbRefresh` — 둘 다 키바가 서기 전에도 상태로 그리므로 `modKbd` 가드를 걷는다). 키바 구성을 사용자가 고치는 길(`_keybarSet`)은 목록을 스스로 칠한다 |
| FR-QFX-11 | `agentsPollMs` 이사(`_pollMigrateAgents`, 부팅만)는 `_paintSettingControls` **앞**에서 돈다 — 이사가 바꾼 값을 같은 칠하기가 싣는다. 이사 안의 섹션 칠하기를 걷는다 |
| FR-QFX-12 | 두 순서(적용 → 세우기 · 세우기 → 적용)에서 설정창 행·키바 목록·폴링 행·모바일 키바가 같은 값으로 칠해진다. 이 사실을 단위 시험이 두 순서로 잰다 |
| FR-QFX-13 | `settings-apply.js` · `settings-terminal.js` · `main.js` 의 주석이 이 규약을 적는다(「부팅 적용은 설정창보다 먼저 온다」 는 옛 주석은 사실이 아니다 — 고친다) |

## 3. 결정

| ID | 결정 | 이유 |
|---|---|---|
| D-QFX-1 | TC-SBA-1 을 지우지 않고 한 줄 배치의 단정으로 고친다 | FR-SBA-1 이 지키려던 것(그룹 단추가 패널을 꽉 채우지 않고 같은 여백·모양)은 한 줄에서도 뜻이 있다. 좌우 안쪽 여백이 같은지 보면 `#add-group` 이 규칙에서 빠졌을 때 그대로 잡힌다 |
| D-QFX-2 | 침묵은 수신 처리기를 떼어 흉내낸다. 서버 인사를 멈추거나 시각을 가짜로 돌리지 않는다 | half-open 소켓이 바로 「소켓은 OPEN 인데 아무것도 오지 않는다」 이다. 다시 연 구독은 새 `EventSource` 라 처리기가 새로 붙는다 — 흉내가 회복 뒤까지 새지 않는다 |
| D-QFX-3 | 접기 단추는 둘 다 30px 로 올린다. 26px 로 두고 시험의 대상에서 빼지 않는다 | FR-GIT-226 의 하한은 사용자 결정이고 사이드바 단추가 대상이다. D-38 이 줄인 이유(두 레일의 어긋남)는 두 단추를 같게 하면 풀린다 — 작은 쪽으로 맞출 까닭이 없다 |
| D-QFX-4 | 히트 영역만 넓히는 방법(가상 요소)을 쓰지 않는다 | V80 은 단추의 상자를 잰다. 보이는 단추와 누르는 자리가 다르면 다른 단추들(모두 30px 상자)과 규칙이 갈린다 |
| D-QFX-5 | V-GAP-1 은 패널 폭을 넓혀(`--sb-w` 320px) 잰다. 컨테이너 질의를 끄지 않는다 | 사용자가 패널을 넓히면 라벨이 서는 것이 실제 화면이다. 그때의 간격이 FR-GAP-1 의 대상이다. 기본 폭에서 라벨이 없다는 것은 TC-UXF-95 가 잰다 |
| D-QFX-6 | skill-contract 는 skip 조건을 두지 않는다 | 원인이 환경이 아니라 경합이다(§2.5). cwd 를 못 읽는 기계에서는 `fgName` 이 `""` 로 머물러 두 번 읽기가 곧바로 같다 — 거기서도 같은 시험이 돈다 |
| D-QFX-7 | 「전」 사진의 자리잡음은 두 번 읽기(2.5초 간격)로 판정한다. 특정 필드(`fgName`)를 빼고 견주지 않는다 | 필드를 빼면 Run 이 그 필드를 건드려도 못 잡는다. 두 번 읽기는 전경 틱(2초)보다 길어 그 사이의 변화를 놓치지 않는다 |
| D-QFX-8 | 순서는 「기다림」 이 아니라 「순서 무관」 으로 보장한다 — 적용은 상태, 칠하기는 선 섹션, 서는 섹션은 상태로 칠한다 | 부팅 적용이 `initModal` 을 기다리면 테마·글자 크기가 워크스페이스 뒤로 밀려 터미널이 기본 글자로 섰다가 다시 맞춰진다(동작 변경). `initModal` 이 적용을 기다리면 `/api/settings` 가 늦을 때 앱 배선이 멈춘다(새 의존). 순서 무관이면 둘 다 생기지 않는다 |
| D-QFX-9 | `_sectionCall` 의 「섹션이 없으면 아무것도 안 한다」 는 남긴다 | 그것을 쓰는 다른 길(`SETTINGS_SECTION_DELEGATES` — SSE 처리기·Claude 계정·간선·e2e 계약)은 설정 적용 길이 아니고, 부팅 중 부를 수 있는지 이번에 모두 증명하지 않았다. 이번 범위는 적용 길의 가드다 |
| D-QFX-10 | 키바 구성 목록 칠하기를 `TerminalSection.paint()` 로 옮겨 설정을 열 때도 칠한다 | 다른 행과 같은 계기(부팅·적용 뒤·열 때)로 맞춘다. 적용이 거의 늘 `keybar` 를 싣기 때문에 지금도 방송마다 다시 칠하고 있다 — 더해지는 것은 열 때 한 번이다 |
| D-QFX-11 | 이사를 앞당기지 않고 칠하기를 적용의 맨 끝으로 옮긴다 | 이사는 `saveSettings` 로 본문 전체를 보낸다. 테마 두 키는 표 밖에서 칠하기 뒤에 얹히므로, 이사를 칠하기 앞(표 바로 뒤)으로 당기면 옛 테마가 서버로 나간다. 칠하기는 값만 읽어 테마·주기를 얹은 뒤에 돌아도 결과가 같다 |

## 4. 검증

| ID | 시험 |
|---|---|
| TC-QFX-1 | e2e `sidebar-actions.spec.ts` TC-SBA-1(FR-QFX-1). 반증: `#add-group` 을 공통 규칙에서 빼면 실패한다 |
| TC-QFX-2 | e2e `version-autoreload.spec.ts` TC-RLC-25·26(FR-QFX-2), 같은 spec 의 나머지. 반증: 감시 job 을 멈추면 실패한다 |
| TC-QFX-3 | e2e `git-ui-metrics.spec.ts` V80(옛 코드에서 RED) · 레일의 두 첫 탭 윗변이 같다(`ux-audit-fix-6.spec.ts` TC-UXF-31b 에 더한다) · `ux-audit-fix` 접기 단추 · `sidebar-collapse` 등 관련 spec |
| TC-QFX-4 | e2e `ui-kit-icons.spec.ts` V-GAP-1(FR-QFX-5). 반증: `Box` 라벨에 왼쪽 여백을 더하면 실패한다 |
| TC-QFX-5 | e2e `skill-contract.spec.ts:451`(FR-QFX-6), `--repeat-each=3` |
| TC-QFX-6 | `npx eslint .` 0 · `make lint` |
| TC-QFX-7 | 단위(`settings-sections.test.mjs`): ① `settings-apply.js` 에 `_sectionCall` 이 없다 · `_keybarApply` 에 `modKbd` 가드가 없다(옛 코드에서 RED) ② `TerminalSection.paint` 가 키바 목록을 칠한다(옛 코드에서 RED) ③ 두 순서(적용 → `init` · `init` → 적용)에서 칠한 결과가 같다 ④ 이사는 칠하기 앞이다(옛 코드에서 RED) |
| TC-QFX-8 | 관련 e2e — 설정·키바·폴링·부팅 화면(`grep -rl` 로 고른다) |

## 5. 동작 변경 기록

| 이슈 | 이전 동작 | 새 동작 | 이유 |
|---|---|---|---|
| QF-3 | 메인 패널·작업 패널의 접기 단추가 26×26px(아이콘도 표준 크기) | 30×30px(키트 큰 단추, 아이콘도 큰 단추 비율). 레일에서 두 패널의 탭 선은 여전히 같다 | FR-GIT-226 의 하한(사이드바 단추 30px). D-38 의 어긋남은 두 단추를 같게 해서 푼다(D-QFX-3) |
| QF-7 | 키바 구성 목록(설정 ▸ 터미널 ▸ 모바일 키바)은 적용 뒤에만 다시 칠한다 | 설정을 열 때도 다시 칠한다 | 다른 행과 같은 계기(D-QFX-10). 보이는 값은 같다 |
| QF-1·2·4·5 | — (시험만) | — | 앱 동작은 바뀌지 않는다 |
| QF-6 | — | — | 이름·쓰지 않는 변수 |

## 6. 구현 기록

| 커밋 | 요점 |
|---|---|
| `2f141812` | 이 문서 |
| QF-1 | `sidebar-actions.spec.ts` TC-SBA-1 을 한 줄 배치의 단정으로(FR-QFX-1). 반증: `#add-group` 을 공통 규칙(`style-main-panel.css`)에서 빼면 실패한다(높이·여백이 갈린다). 관련 e2e 5 spec(`grep -rl "add-group\|sb-actions"`) 105 통과 |
| QF-2 | `version-autoreload.spec.ts` 의 `fakeSilence` 가 지금 구독의 `onmessage` 를 떼고 시각을 민다(FR-QFX-2) — TC-RLC-25·26 이 쓴다. 원인 실측: 진단 시험에서 시각만 민 직후 `tool_foreground {name:"~"}` 가 닿아 `_seen` 이 돌아왔고 세대가 1 에 머물렀다. 수신이 없으면 1.5초 안에 세대 1 → 2(감시는 돈다). 반증: 감시 job 의 `run` 을 비우면 TC-RLC-25 가 20초 시간 초과로 실패한다. `version-autoreload` 17건 `--repeat-each=2` 34 통과, 관련 e2e(`focus-owner`·`layout`) 34 통과 |
| QF-3 | `sbCollapsePaint`(`layout-dock.js`)의 `UIKit.button` 에 `size:'lg'`, `AgentsController` 머리의 `ag-collapse` 에 `ui-btn-lg`(FR-QFX-3). 시험: V80 이 옛 코드에서 RED(`.sb-collapse` 26×26) → 통과. TC-UXF-31b(`ux-audit-fix-6`)에 두 단추가 30×30 이고 두 레일의 첫 탭 윗변이 같다는 단정을 더했다(FR-QFX-4, 옛 코드에서 RED — 크기 단정). 관련 e2e 19 spec(`grep -rl "ag-collapse\|sb-collapse\|panel-head\|ui-panel-acts"` + `git-ui-metrics`) 226 — 통과 224 · 실패 2: `ui-kit-icons` V-GAP-1(QF-4 대상) · `activity-rail` TC-ACF-1(알려진 흔들림 — HEAD 에서도 `--repeat-each=6` 에 2 실패, 이 변경 뒤 1 실패. 실패 때 활동 카드가 사라져 있다. 원인은 이번 범위 밖이라 조사하지 않았다). 단위 1480 · typecheck · `make gates` 통과 |
| QF-4 | `ui-kit-icons.spec.ts` V-GAP-1 — `--sb-w` 를 320px 로 넓혀 `Box` 라벨이 선 뒤, 아이콘 오른쪽 변과 라벨 왼쪽 변 사이가 `--ui-gap`(6px)과 ±0.5px 안인지 잰다(FR-QFX-5). 실측: 넓힌 폭에서 사이가 6px. 반증: 라벨에 `margin-left:3px` 를 더하면 「아이콘과 라벨 사이 9px」 로 실패한다. 관련 e2e(`ui-kit-icons`·`ux-audit-fix-7`·`sandbox-pick`) 28 통과 |
| QF-5 | `skill-contract.spec.ts` — 도우미 `settledState`(`/api/state` 를 2.5초 간격으로 두 번 읽어 같을 때의 값, 상한 20초)로 「전」 을 찍는다(FR-QFX-6). 「후」 와의 통째 비교는 그대로다. 원인 실측: HEAD 에서 「전」 의 셸 도구 `fgName:""` · 「후」 `"~"`. 같은 기계의 진단 시험에서 부팅 직후 `tool_foreground {name:"~"}` 가 닿는 것을 봤다(QF-2 와 같은 알림). 「전용 창 Run」 `--repeat-each=3` 3 통과, spec 전체 23 통과 |
| QF-6 | `sanitizeCustomTheme(theme)` · `claude-accounts-foot.test.mjs` 의 `const b` 삭제(FR-QFX-7·8). `make lint` 를 돌리니 같은 오류가 `.claude/worktrees/<에이전트>/` 사본에서 한 벌 더 나왔다 — ESLint flat config 는 `.gitignore` 를 읽지 않는다. `eslint.config.mjs` 의 `ignores` 에 `.claude/**`(git 이 무시하는 로컬 도구 자리)를 더했다(요구에 적지 않은 자리). `make lint` — golangci-lint 0 · eslint 0. 단위 1480 · typecheck · `make gates` 통과, 테마 e2e(`theme`·`theme-seed`) 10 통과 |
| QF-7 `eb6487c6` | `SettingsApply._settingsApply` — 칠하기(`_paintSettingControls`)를 표를 돈 직후에서 맨 끝(이사 뒤)으로 옮겼다(D-QFX-11). `_keybarApply` 는 모바일 키바만 그린다(`modKbd` 가드와 `_sectionCall('terminal','_keybarPaint')` 를 걷음). `_pollMigrateAgents` 의 `_sectionCall('polling','paint')` 를 걷음. `TerminalSection.paint` = 행 + `_keybarPaint`; `_initKeybar` 끝의 `_keybarPaint` 는 `init` 의 `paint` 가 맡고, `_keybarSet` 이 목록을 칠한다. 주석: `settings-apply.js` 머리 · `settings-terminal.js` 머리 · `settings-table.js` `keybar` · `settings-controller.js` `_sectionCall` · `app.js` 생성자 · `main.js` 부팅 적용. 시험 `settings-sections.test.mjs` TC-QFX-7 넷 — 모두 옛 코드에서 RED(두 순서 · 이사 뒤 칠하기 · 정적 · terminal 칠하기). 가짜 문서에 `querySelector` 를 더했다(`settings-sections`·`settings-controls` — terminal 의 칠하기가 키바 목록을 찾는다). 단위 1484 · typecheck · `make gates` · `make lint` 통과. 관련 e2e 58 spec(설정·키바·폴링·부팅 화면·글자 크기·테마 등, `grep -rlE`) 636 통과 |

**SRS 와 다르게 한 것.**

1. QF-6 — `eslint.config.mjs` 의 `ignores` 에 `.claude/**` 를 더했다. 요구에 적지 않은 자리다(`make lint` 가 에이전트 worktree 사본의 같은 오류를 셌다).
2. QF-3 — TC-UXF-31b 에 단정을 더했다(요구는 V80·레일 정렬만 적었다).

**남긴 것.** `_sectionCall` 의 「섹션이 없으면」 판정(D-QFX-9 — 위임자 표의 다른 길). `activity-rail` TC-ACF-1 의 흔들림(HEAD 에서도 6회 중 2회 실패, 실패 때 활동 카드가 사라져 있다 — 범위 밖). `kit-components` TC-CMP-19(이번 지시 밖, 이번 QF-3 관련 e2e 에서는 통과).
