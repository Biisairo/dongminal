# SRS: 리팩토링 3차 P3a 단계 8 — 설정 섹션·행 클래스 — IEEE 29148

> **문서 상태**: 승인·구현중
> **남은 것**: 하위 단계 8a~8e 구현과 시험

- 접수: 2026-11-21 (프로덕션 리팩토링 3차 · `docs/internal/refactor/FE_OBJECT_MODEL.md` §2 행 6·§3·§6 단계 8 · `refactor/PROD3.md` FC-04)
- 사용자 결정(2026-11-21, `FE_OBJECT_MODEL.md` §7): 자체 클래스 계층, 클래스 하나 = 파일 하나, 0~9 단계 전부. 진행은 묻지 않고 끝까지 한다. 코드와 설계 문서로 답이 나오는 갈림길은 권장안으로 정하고 §3 에 이유를 적는다.

## 1. 개요

### 1.1 목적

설정 창의 탭은 열일곱이다(theme·shortcuts·statusbar·presets·profile·display·terminal·code·notify·polling·server·access·edges·telegram·claude·sandbox·backup). 모달 열기·탭 고르기·Esc 는 이미 `SettingsModal`(단계 3·6)이 한다. 남은 것은 **탭 안의 배선**이다.

- `initModal`(`core/app-settings.js` 약 415~447행)이 App mixin 함수 26개(`_init*`)를 순서대로 부른다(FC-04). 설정 init 은 `ui/input-binding.js` 17~34행에도 아홉 개가 더 있다.
- 블롭 설정 키 34개는 `SETTINGS_SCHEMA`(선언)·`SETTINGS_ACCESS`(전역 읽기·쓰기)·`_init*`(리스너)·칠하기, 네 자리에 나뉘어 적힌다. 체크박스 8행과 숫자 6행은 같은 모양을 손으로 반복한다(`uiFontSize` 는 같은 적용 본문이 `_initUiFontScale` 과 `SETTINGS_ACCESS.set` 에 두 번 있다).
- 서버 자원 패널(profile·server·sandbox·telegram·access·edges·claude)은 App 필드(`_srv`·`_tg`·`_tgPair`·`_egInvite`·`_pfSaving`·`_cacct*` 등)에 상태를 둔다.

이 문서는 탭 하나를 **`SettingsSection` 하위 클래스 하나**로, 단순한 행을 **`FormRow`** 로 옮기고, `initModal`·`_settingsOnOpen`·`_settingsOnTab` 의 나열을 **`SettingsController`** 의 섹션 배열 하나로 바꾼다.

### 1.2 범위 — 하위 단계

| 단계 | 내용 | 위험 |
|---|---|---|
| 8a | `SettingsSection`(`core/settings-section.js`) · `FormRow`(`core/settings-row.js`) · 체크·숫자 14행을 `FormRow` 선언으로 · `DisplaySection`·`TerminalSection`·`CodeSection` | L |
| 8b | 폴링(`POLL_SETTINGS` 표를 섹션으로 감싼다) · 범위 슬라이더 2행(`focusEdgeLevel`·`attnEdgeLevel`) · statusbar · notify | L~M |
| 8c | 서버 자원 패널: profile → server → sandbox → telegram → access → edges → claude(먼저 파일을 나눈다) | M |
| 8d | theme(미리보기·편집기 포함) · shortcuts · keybar · presets · backup | M |
| 8e | `SettingsController`(`core/settings-controller.js`, `Controller` 하위)가 `initModal` 의 `_init*` 나열·`input-binding.js` 의 설정 init·`_settingsOnOpen`·`_settingsOnTab` 을 섹션 배열로 대신한다. 쓰이지 않게 된 mixin 함수를 지운다 | M |

하위 단계마다 단위·게이트·관련 e2e 를 지난 뒤 커밋한다.

### 1.3 범위 밖

- 설정 블롭의 저장 파이프라인(`settings-sync.js` `saveSettings`·`_saveSettingsSoon`·`_saveSettingsNow`·`_settingsApply`·`_settingsBody`·키 집합 검사). `FormRow` 는 값의 읽기·쓰기를 `SETTINGS_ACCESS` 에 맡긴다.
- 단축키 녹화(`ui/input-binding.js` 250행). 녹화는 입력 바인딩의 일이다.
- 모바일 설정 두 화면(`_settingsView`·상세 Esc 항목)과 검색(`_bindSettingsSearch`). `SettingsController` 가 부르되 섹션은 모바일·검색을 모른다.
- 분석에서 드러난 결함(§6 「찾은 것」). 이 문서는 보이는 동작을 바꾸지 않는다.

### 1.4 불변 조건

| ID | 조건 |
|---|---|
| INV-S1 | DOM(`#panel-*`·`.ds-row` 구조·id·접근성 이름)과 저장 요청(블롭 PUT 본문·자원 PUT·`If-Match`)은 바뀌지 않는다 |
| INV-S2 | 각 행의 적용·디바운스·blur 확정·clamp·라벨(0=끔)·미리보기 타이머의 동작이 지금과 같다. 포커스된 입력란을 덮는지 여부도 행마다 지금과 같다 |
| INV-S3 | 설정을 열 때·탭을 고를 때 도는 일과 그 **순서**가 지금과 같다(검색 비우기 → 프로필 → 모바일 머리, 탭 리스너 뒤의 모바일 상세 등) |
| INV-S4 | 설정 밖·e2e·단위 시험이 부르는 App 이름(§2 FR-FES-9 의 표)은 그대로 불린다 |
| INV-S5 | 계층(`core/` 클래스, App 에 새 필드를 얹지 않는 대신 컨트롤러가 섹션을 든다)·로드 순서·크기(파일 500줄 이하, 넘는 파일 수를 늘리지 않는다)·`settings-source.test`(설정 전역은 `settings-defaults.js` 에서만 선언) 게이트를 지킨다 |

## 2. 요구사항

| ID | 요구 |
|---|---|
| FR-FES-1 | `SettingsSection extends View`: 생성자 `(app, tab)`, `adopt(#panel-<tab>)`. 훅: `init()`(한 번, 리스너는 `listen`·`own`), `onOpen()`(설정을 열 때), `onTab()`(그 탭을 고를 때), `paint()`(칠하기 한 자리). 섹션이 소유한 타이머·구독은 섹션이 주인이다(`after`·`every`·`on`) |
| FR-FES-2 | `FormRow`: 선언 `{key, id, kind:'check'|'number'|'range'|'select', after?, commit?, zeroLabel?, preview?}`. `bind(section)` 이 리스너를 걸고, 읽기·쓰기는 `SETTINGS_ACCESS[key]` 의 get/set 을 쓰며, clamp 는 `clampSetting(key, v)` 한 자리다. `commit` 은 지금 행의 저장 방식(`check`: 즉시, `number`: 입력 중 `_saveSettingsSoon`·blur 에 clamp 표시와 `_saveSettingsNow`)을 기본으로 한다. `paint()` 는 지금 행의 칠하기와 같은 일을 한다(포커스 가드를 새로 더하지 않는다, INV-S2) |
| FR-FES-3 | 8a 의 섹션은 행을 선언 배열로 갖고, 행마다 다른 뒤처리(편집기·탭 폭·fg 이름 다시 칠하기 등)는 `after` 로 준다. 지금 `_init*` 함수 가운데 행 하나만 배선하던 것은 지운다. 같은 적용 본문이 두 번 적힌 곳은 한 번으로 한다 |
| FR-FES-4 | 8b·8d 의 특이 행(범위 슬라이더·statusbar 동적 목록·폴링 select·theme·shortcuts·keybar·presets·locale·backup)은 섹션 메서드로 옮기고, `FormRow` 로 억지로 맞추지 않는다 |
| FR-FES-5 | 8c 의 서버 자원 섹션은 App 필드였던 패널 상태를 섹션 필드로 옮긴다. 설정 밖이 읽는 필드(`_edges` 등)는 옮기지 않는다. 섹션이 500줄을 넘으면(claude) 먼저 부품 클래스로 나눈다 |
| FR-FES-6 | `SettingsController extends Controller`(8e): 섹션 배열을 지금 `_init*` 호출 순서대로 들고, `init()` 이 그 순서로 섹션의 `init()` 을 부른다. 설정을 열 때·탭을 고를 때 각각 섹션의 `onOpen`·`onTab` 을 지금 순서대로 부른다. `initModal` 은 컨트롤러를 만드는 한 줄이 된다 |
| FR-FES-7 | App 은 컨트롤러 하나를 든다(`this.settings` — 이름이 부딪치면 다른 이름, §6). 섹션은 `this.settings.section('<tab>')` 로 찾는다 |
| FR-FES-8 | 단위 시험 하네스에 묶음 상수 `SETTINGS`(섹션 기반·행·섹션 파일)를 둔다. 파일을 이름으로 읽는 시험(약 19개 파일)·등록부의 경로를 고친다. `index.html` 은 섹션 파일을 지금 설정 mixin 자리 근처에, 기반을 하위보다 앞에 싣는다 |
| FR-FES-9 | 아래 이름은 App 에 위임자로 남는다: `saveSettings`·`_settingsApply`·`_settingsRestore`·`_onSettingsChanged`·`_openSettings`·`themeSlots`·`setThemeSlots`·`_renderPresets`·`_saveSettingsSoon`·`_saveSettingsNow`·`_paintSettingControls`·`_edApplyWordWrap`·`_edApplyMinimap`·`_edApplyFontSize`·`_termApplyFontSize`·`_showCustomEditor`·`_hideCustomEditor`·`_onAccessChanged`·`_onSandboxChanged`·`_onServerMoving`·`_edgesPaint`·`_egNodePaint`·`_egMeshPaint`·`_egInvitesPaint`·`_egNotify`·`_cacctPanelShown`·`_cacctRefreshSoft`·`_presetButtonPaint`·`_loadTelegramPanel`·`_tgRead`. 단위 시험이 부르는 `_init*`(예: `_initTelegramPanel`·`_initServerPanel`)는 시험을 섹션 경로로 고치고 위임자를 남기지 않는다 |

## 3. 결정

| ID | 결정 | 이유 |
|---|---|---|
| D-FES-1 | 값의 읽기·쓰기는 `SETTINGS_ACCESS` 에 남기고 `FormRow` 는 그것을 부른다 | 저장 파이프라인·키 집합 검사·`_settingsBody` 를 건드리지 않는다. 행 배선이 한 자리로 모이는 이득은 그대로다 |
| D-FES-2 | `FormRow.paint` 에 포커스 가드를 새로 더하지 않는다 | 숫자 행의 쓰기가 포커스된 입력란을 덮을 수 있다는 분석은 정적 추정이다. 가드를 더하면 동작이 바뀐다. 실측 뒤 따로 고친다(§6 찾은 것) |
| D-FES-3 | 섹션은 `core/` 의 `View`, 나열은 `Controller` 가 한다 | `FE_OBJECT_MODEL.md` §3: 화면 부품은 View, App 의 주제별 조정자는 Controller. 설정 섹션은 자기 패널 DOM 이 있는 화면 부품이고, 무엇을 언제 부를지는 조정이다 |
| D-FES-4 | 결합이 약한 행부터(8a→8e) 하나씩 옮긴다 | 8a 의 행들은 설정 밖에서 부르는 곳이 없다. 서버 자원 패널은 설정 밖(`app-edges*.js`·`state-registry.js`)이 부르므로 위임자와 함께 뒤에 옮긴다 |
| D-FES-5 | 섹션은 탭마다 하나다. 한 탭을 여러 파일이 배선하던 것(display: `initModal` 9개 + `app-mobile.js:150` + `app-slots.js:662`)은 그 섹션으로 모은다. 다만 설정 밖 주제의 일(슬롯 방향 등)이 섞여 있으면 섹션은 그 주제의 함수를 부르기만 한다 | 탭 하나의 배선이 한 파일에 있어야 "이 탭에서 무엇이 도는가" 가 보인다 |

## 4. 검증

| ID | 시험 |
|---|---|
| TC-FES-1 | 단위: `SettingsSection` 은 `View` 하위이고 `#panel-<tab>` 을 adopt 하며 `dispose` 가 그 요소를 떼지 않는다. 훅 기본은 빈 동작이다 |
| TC-FES-2 | 단위: `FormRow` — check 는 바꾸면 set·after·즉시 저장, number 는 input 에 set(clamp 적용)·after·`_saveSettingsSoon`, blur 에 입력란을 clamp 한 값으로 고치고 `_saveSettingsNow`. range 의 0 라벨. paint 는 get 값을 칠한다 |
| TC-FES-3 | 단위: 하위 단계마다 옮긴 섹션의 원형 사슬에 `SettingsSection`·`View` 가 있고, 옮긴 `_init*` 가 App 원형에 없다(위임자 표 FR-FES-9 는 남는다) |
| TC-FES-4 | 단위(8e): `SettingsController` 의 섹션 순서가 옛 `_init*` 호출 순서와 같다. `initModal` 에 `_init` 호출이 없다. 열기·탭 훅이 지금 순서로 돈다 |
| TC-FES-5 | e2e(기존): settings·settings-legibility·settings-backup·save-pipeline·theme·mobile-ux-overhaul·edges-settings·telegram·sandbox·access·server·claude-accounts·presets·statusbar·shortcuts·polling·i18n 관련 spec 이 모양을 바꾸지 않고 통과한다 |

## 5. 동작 변경 기록

없다.

## 6. 구현 기록

| 하위 단계 | 커밋 | 요점 |
|---|---|---|
| 8a | `9afbb9fe` | `SettingsSection`(`settings-section.js` 57) · `FormRow`(`settings-row.js` 66) · `DisplaySection`(`settings-display.js` 106) · `TerminalSection`(`settings-terminal.js` 33) · `CodeSection`(`settings-code.js` 45). 체크 9행·숫자 5행을 `FormRow` 선언으로(display 5 · terminal 7 · code 2). 지운 App 이름 16: `_initTabWidth`·`_initUiFontScale`·`_initFgNames`·`_initConfirmLeave`·`_initLocale`·`_initPanelLayout`(app-dock)·`_initClaudeFullscreen`·`_initTermGpu`·`_initTermFontSize`·`_initClaudeScrollSpeed`·`_initMigrationSettings`·`_initWordWrap`·`_initMinimap`·`_initNumSetting`·`_paintNumSettings`·`_initLSP`(App 껍데기와 `LspClient` 본문 둘 다). Display 탭의 다른 배선 둘(`initMobile` 의 표시 모드·경계 폭, `_initSlots` 의 슬롯 방향)도 `DisplaySection` 으로 모았다(D-FES-5, 슬롯은 `_slotDirPaint` 를 부르기만 한다). **섹션을 드는 자리(8e 전까지)**: App 필드를 새로 얹지 않고 `SettingsSection` 의 정적 `WeakMap`(앱 → 탭 → 섹션)이 든다 — `SettingsSection.start(app, section)` 이 등록하고 `init()` 을 부르며, `SettingsSection.of(app, tab)`·`all(app)` 으로 찾는다. `initModal` 은 옛 `_init*` 자리에서 `start` 를 부르고, `_settingsOnOpen` 은 `all(app)` 의 `onOpen()` 을, `_settingsOnTab` 은 `of(app, tab).onTab()` 을 부른다(code 탭의 `_lspRefresh`·진단 토글 칠하기가 `CodeSection.onTab` 으로). **SRS 와 다르게 한 것**: ① 칠하기 — `SETTINGS_ACCESS` 의 `ctl` 선언을 걷고 `_paintSettingControls` 가 섹션들의 `paint()` 를 돈다. 숫자 행 다섯의 set 이 하던 입력란 칠하기도 set 에서 빼서 같은 자리로 모았다 — set 이 칠하면 `FormRow` 가 입력마다 부르는 set 이 치는 글자를 고쳐 쓴다(FR-FSS-19). 그래서 `uiFontSize` 의 적용 본문이 set 한 벌만 남는다(FR-FES-3). 칠하는 때는 종전과 같다(부팅·`_settingsApply` 뒤·열 때) ② 포커스 가드는 종전 `ctl:'value'` 였던 탭 폭 행만 가진다 — 선언에 `guard:true` 를 더했다(FR-FES-2 의 선언에 없는 필드, D-FES-2 대로 다른 행에는 더하지 않았다) ③ 숫자 행의 `blur` 는 입력란을 `get()`(없으면 기본값)으로 고친다 — 종전 다섯은 `clamp(입력란)`, 탭 폭은 `tabWidthPx` 였는데 두 값은 언제나 같다(입력이 set 을 거치고, 가드 없는 행은 원격 값이 입력란을 덮는다). 탭 폭의 디바운스 키가 `'tabw'` 에서 행 id `'ds-tabw'` 로 바뀌었다(타이머 이름표만 다르다) ④ `after`·`kind:'check'|'number'` 만 만들었다 — 8a 행의 뒤처리는 전부 set 안에 이미 있어 `after` 를 쓰는 행이 없다. `commit`·`zeroLabel`·`preview`·`range`·`select` 는 쓰는 행이 생길 때 더한다 ⑤ 언어(`ds-locale`)·패널 레이아웃은 FR-FES-4 가 8d 에 두었으나 Display 탭이라 이 섹션으로 같이 옮겼다(동작 같음). 시험: `settings-sections.test.mjs`(TC-FES-1~3, 9건), `settings-controls.test.mjs`(FEC-26)를 섹션의 행 선언으로 고쳤다, `app-state-owners.test.mjs` 의 LSP 목록에서 `_initLSP` 를 뺐다. 단위 1244. e2e 23 spec 248 통과(settings·settings-legibility·settings-backup·settings-reset-revert·save-pipeline·font-size·tab-width·tab-names·editor-minimap·editor-lsp·leave-confirm·migration-settings·term-gpu·agent-render-env·panel-layout·i18n·window-slots·mobile-ux-overhaul·unfocused-edge·ux-batch10 등) |
| 8b | (이 커밋) | `PollingSection`(`settings-polling.js` 58) — `initPollingSettings` 의 행 만들기가 `init`, `_pollPaintRows` 가 `paint`. `StatusbarSection`(`settings-statusbar.js` 40) — `_renderStatusBarSettings` 가 `_render`(`init` 이 부른다. `paint` 는 두지 않는다 — 「찾은 것」 첫째를 고치지 않는다). `NotifySection`(`settings-notify.js` 54) — `initAttn` 의 데스크톱·소리 토글과 TLS 안내 부름, `initUpdateSettings` 의 판 확인. 레인지 두 행(포커스·주의 가장자리)은 `DisplaySection` 메서드다(`_initFocusEdge`·`_initAttnEdge`·`_paintFocusEdgeRow`·`_paintAttnEdgeRow`·미리보기 둘, `settings-display.js` 213). 지운 App 이름 9: `_pollPaintRows`·`_renderStatusBarSettings`·`initUpdateSettings`(`input-binding.js` 의 부름도)·`_initFocusEdge`·`_initAttnEdge`·`_focusEdgePaintRow`·`_attnEdgePaintRow`·`_focusEdgePreview`·`_attnEdgePreview`. 8e 전까지 섹션을 세우는 자리: `initPollingSettings`(한 줄로 남김)·`initStatusBar` 끝·`initAttn` 의 옛 토글 자리 — 모두 `SettingsSection.start`. **SRS 와 다르게 한 것**: ① 레인지는 FR-FES-2 의 `FormRow` `range` 가 아니라 FR-FES-4 대로 섹션 메서드다 — 포커스 행의 input 이 주의 행까지 칠하고, 주의 행은 `_attnRefresh` 를 부르는 등 두 행의 모양이 같지 않다. TC-FES-2 의 「range 0 라벨」 은 섹션의 `_paintRange` 로 잰다. 같은 본문이던 두 칠하기 함수는 `_paintRange(id, level, max)` 하나가 됐다 ② `SETTINGS_ACCESS.focusEdgeLevel`·`attnEdgeLevel` 의 set 이 하던 행 칠하기를 숫자 행처럼 `_paintSettingControls`(`DisplaySection.paint`)로 모았다. 그래서 설정을 열 때 주의 행도 칠한다(종전에는 포커스 행만 칠했다. 행이 값과 늘 같아 보이는 차이는 없다). 폴링 행도 같은 길로 칠하므로 열 때 한 번 더 칠한다(같은 이유로 차이 없음) ③ 미리보기 타이머의 주인이 `'app'` 에서 섹션으로 바뀌었고(FR-FES-1), 이름표(`ufe-preview`·`ae-preview`)는 없어졌다. 시험: TC-FES-2(범위 3건)·PollingSection·NotifySection 각 1건, TC-FES-3 표에 세 섹션. 다시 그리기 등록부(`PERFORMANCE_BUDGET.md`)의 상태바 행을 새 자리로 옮겼다. 단위 1249. e2e 20 spec 158 통과(attention 다섯·git-polling·git-statusbar·perf-statusbar·poll-interval·status-bar-reflow·statusbar-xss·settings·settings-legibility·settings-reset-revert·save-pipeline·unfocused-edge·update-notice·ui-layout-defaults·theme·mobile-ux-overhaul) |

**찾은 것(고치지 않음 — 보고 대상)**

- statusbar 탭의 행은 설정을 열 때·다른 창의 변경을 받을 때 다시 칠해지지 않는다(생성 1회).
- 숫자 행(`uiFontSize`·`termFontSize`·`migrationHookCtxPct`·`issueTreeCtxPct`·`claudeScrollSpeed`)의 set 이 포커스된 입력란의 값을 가드 없이 덮는다(정적 추정). 저장 뒤 재적용 때 입력 중인 값이 옛 값으로 바뀔 수 있다.
- `_settingsOnTab` 주석은 "열 때마다 서버에 묻는다" 고 적었으나 탭을 누를 때만 돈다 — 설정을 열 때 access·sandbox·edges·telegram·server 를 다시 읽지 않는다.
- 부팅 적용(`main.js:20` `_settingsApply`)과 `initModal` 사이에 코드상 순서가 없다(`app.js:169` `_bind` 와 경쟁, null 가드로 버틴다).
