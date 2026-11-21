# SRS: 리팩토링 3차 P3a 단계 9 — App mixin 을 주제별 `Controller` 로 — IEEE 29148

> **문서 상태**: 승인·구현중
> **남은 것**: 하위 이슈 9a~9k 구현과 시험

- 접수: 2026-11-21 (프로덕션 리팩토링 3차 · `docs/internal/refactor/FE_OBJECT_MODEL.md` §2 행 17·§3·§5·§6 단계 9)
- 사용자 결정(2026-11-21): `FE_OBJECT_MODEL.md` §7 의 0~9 단계 전부. 단계 9 는 **하위 이슈로 나눠 전부 진행한다**(이번 세션의 사용자 답). 결합이 강한 묶음은 공유 상태 설계를 먼저 하나의 하위 이슈로 둔다.

## 1. 개요

### 1.1 목적과 현황 (HEAD `02293a32`, acorn 실측)

| 항목 | 값 |
|---|---|
| `Object.assign(App.prototype, …)` mixin 파일 | 57 (+ `core/app.js` 클래스, `core/app-testing.js` 계약) |
| 메서드 | 835 (`app.js` 32 포함), 접근자 8 |
| mixin 줄 수 | 약 16,075 |
| App 필드(`this.X`) | 148 — 생성자 선언 38, 생성자 밖에서 처음 씀 107 |
| 바깥 JS(`ui/`·`git/`·`main`·`renderer`·설정 클래스)가 쓰는 App 이름 | 298 |
| e2e·단위 시험이 쓰는 이름 / **덮어 쓰는 이름** | 207 / 88(메서드 54·필드 34) |
| 계약 `core/app-testing.js` | 150 |

주제 열여섯이 서로 부르는 하나의 순환이다. 그중 레이아웃·슬롯·포커스·도구·편집기·Repo 창·상태 동기화(메서드 453, 54%)는 공유 필드 43개(참조 697곳 — `ws` 13개 주제 165회, `_slots` 98, `focused` 45, `gitPanels` 40, `tools` 28, `fileEditors` 23, `_attn` 20)를 함께 쓴다.

### 1.2 범위 — 하위 이슈

| 이슈 | 묶음 | 메서드 | 비고 |
|---|---|---|---|
| 9a | 간선(edges) 10 · 폴링 1 · 업데이트 2 · 설정 잔여 55 · 얇은 셸 `app-lsp.js`·`app-runs.js` 정리 | 약 90 | 설정은 `SettingsController` 로 흡수 |
| 9b | 알림(attn) 32 · Claude 계정 35 · 상태바 24 | 91 | |
| 9c | 채팅 54 · 활동·에이전트 39 · 모바일 38 | 131 | `ui/chat-view.js` 의 위치는 계층 게이트에 맞춘다 |
| 9d | git(`app-git.js`) 60 | 60 | git 패널(단계 7)의 부품 방식 |
| 9e | **공유 상태 설계** — 공유 필드 43개의 주인과 읽기·쓰기 입구를 정하는 SRS 개정(이 문서 §2.2 를 채운다). 코드 변경은 시험이 보장하는 접근자 도입까지 | — | 설계 이슈 |
| 9f | 상태 동기화·재로드 19 | 19 | 9e 의 입구를 처음 쓰는 소비자 |
| 9g | 포커스·창 소유 40 | 40 | |
| 9h | 슬롯 41 | 41 | |
| 9i | 레이아웃 106 | 106 | 크기에 따라 둘 이상으로 나눈다 |
| 9j | 도구·커맨드·작업 73 | 73 | |
| 9k | 편집기 155 · Repo 창 19 | 174 | 크기에 따라 둘 이상으로 나눈다. 끝나면 mixin 0 |

하위 이슈마다 SRS §6 에 한 줄, 단위·게이트·관련 e2e 를 지난 뒤 커밋한다. 묶음 경계가 실측과 다르면(파일 헤더·접두어로 판정한 분류다) 구현이 §6 에 적고 고친다.

### 1.3 범위 밖

- 바깥 호출처(`ui/`·`git/`·e2e·계약)를 컨트롤러 경로로 옮기는 일. 위임자를 남긴다. 위임자 제거는 다음 리팩토링이다.
- 타이머·구독의 주인 문자열 `owner:'app'`(17곳)의 의미 변경. 주인을 바꾸면 수명이 바뀐다 — 그대로 둔다.

### 1.4 불변 조건

| ID | 조건 |
|---|---|
| INV-A1 | 보이는 동작·DOM·요청·부팅 순서는 바뀌지 않는다 |
| INV-A2 | 계약(`app-testing.js`) 150개와 바깥·e2e 가 쓰는 이름은 App 인스턴스에서 그대로 읽히고 쓰이고 불린다. **덮어쓰기**(e2e·시험이 `app.X = …` 로 갈아 끼우는 것)도 지금처럼 효과가 있다 |
| INV-A3 | 계층·로드 순서·크기(500줄 이하, 넘는 파일 수를 늘리지 않는다)·`check-e2e-private`·킷 게이트를 지킨다 |

## 2. 요구사항

### 2.1 공통 (모든 하위 이슈)

| ID | 요구 |
|---|---|
| FR-FEA-1 | 묶음 하나는 `Controller` 하위 클래스 하나 이상이다(`core/<주제>-controller.js`, 크면 부품 클래스로 나눈다, 클래스 하나 = 파일 하나). App 생성자(또는 지금 그 묶음이 처음 서는 부팅 자리)에서 만들어 App 필드 하나(`this.<주제>`)로 든다. 이름이 부딪치면 다른 이름을 쓰고 §6 에 적는다 |
| FR-FEA-2 | 컨트롤러는 그 묶음만 쓰는 필드를 소유한다. 바깥·e2e·계약·다른 묶음이 읽는 필드는 App 에 남기거나 App 에 접근자(`Object.defineProperties` — `app-slots.js`·`app-ws-sync.js` 의 기존 방식)를 둔다 |
| FR-FEA-3 | 컨트롤러 안에서 **덮어쓰기 대상 이름**(e2e·단위 시험이 `app.X =` 로 갈아 끼우는 54개 메서드와 계약 이름)과 다른 묶음의 메서드는 `this.app.X()` 로 부른다 |
| FR-FEA-4 | 바깥·다른 묶음·e2e·계약이 부르는 메서드는 App 에 한 줄 위임자로 남는다. 묶음 안에서만 쓰는 메서드는 위임자를 두지 않는다 |
| FR-FEA-5 | 로드 시점에 App 원형을 감싸는 몽키패치(`core/app-editor-pane.js:320` 의 `gitSignal` 감싸기 등)는 컨트롤러 쪽에서 같은 효과를 내도록 다시 짠다. 감싸는 순서를 시험으로 고정한다 |
| FR-FEA-6 | `SettingsController` 의 부팅 순서표 `SETTINGS_INIT`(단계 8)가 이름으로 부르는 App init(`initSaveButtons`·`initStatusBar`·`initMobile`·`initMobileKeybar`·`initAttn`)이 컨트롤러로 옮겨 가면 표와 시험(`BOOT_ORDER`)을 함께 고친다 |
| FR-FEA-7 | 하위 이슈가 끝날 때마다 `Object.assign(App.prototype` 의 수가 줄고, 9k 뒤에는 0 이다(`app-testing.js` 의 계약 정의 방식은 별개) |

### 2.2 공유 상태 (9e 가 채운다)

9e 가 공유 필드 43개마다 주인 컨트롤러(또는 App)·읽기 입구·쓰기 입구·쓰는 묶음을 표로 정한다. 그 표가 정해지기 전에는 9f~9k 를 시작하지 않는다.

## 3. 결정

| ID | 결정 | 이유 |
|---|---|---|
| D-FEA-1 | 단계 9 를 하위 이슈 열하나로 나누고 결합이 약한 것부터 한다 | 주제 열여섯이 한 순환이다. 결합이 약한 묶음(9a~9d)은 위임자 몇 개로 떨어지고, 강한 덩어리는 공유 상태의 주인을 먼저 정해야 쪼갠 뒤에도 서로 `this.app.X` 로 얽힌 채 남지 않는다 |
| D-FEA-2 | 공유 상태 설계를 별도 하위 이슈(9e)로 둔다 | 공유 필드 43개·참조 697곳의 주인을 코드 옮기기와 함께 정하면 실패 원인을 좁힐 수 없다 |
| D-FEA-3 | 위임자를 남긴다 | 바깥 298 이름·덮어쓰기 88·계약 150 을 함께 바꾸면 위험이 두 배다(단계 7·8 과 같은 규약) |
| D-FEA-4 | `owner:'app'` 문자열 주인을 바꾸지 않는다 | 바꾸면 `disposeOwner` 의 대상이 바뀌어 수명이 바뀐다 |

## 4. 검증

| ID | 시험 |
|---|---|
| TC-FEA-1 | 단위: 하위 이슈마다 컨트롤러가 `Controller`·`Component` 하위이고 App 이 든다. 위임자가 컨트롤러 메서드를 같은 인자로 부르고 값을 돌려준다 |
| TC-FEA-2 | 단위: 덮어쓰기 대상 이름을 App 인스턴스에서 갈아 끼우면 컨트롤러 경로에서도 갈아 끼운 것이 불린다(표본: 하위 이슈마다 그 묶음이 부르는 덮어쓰기 대상 전부) |
| TC-FEA-3 | 단위(소스 검사): 옮긴 mixin 파일이 없다. `Object.assign(App.prototype` 의 수가 하위 이슈마다 준다. 계약 150 이름이 App 인스턴스에서 그대로 읽힌다(`app-state-owners.test.mjs` 갱신) |
| TC-FEA-4 | e2e(기존): 하위 이슈마다 그 묶음의 spec, 9k 뒤에는 전량(마지막에 할 것과 함께) |

## 5. 동작 변경 기록

없다.

## 6. 구현 기록

| 하위 이슈 | 커밋 | 요점 |
|---|---|---|
| 9a | `b0e3b411` | **위임자 표** `Controller.delegate(host, to, names)`(`base/controller.js`) — 이름마다 같은 인자로 대상의 같은 이름을 부르고 답을 돌려주는 한 줄 메서드를 원형에 둔다. `to` 는 점 경로(`'settings.live'`)나 `(self, name, args) => 답` 이고 부를 때 대상을 찾는다(인스턴스에 갈아 끼운 `_runsPanel` 등이 지난다). 컨트롤러 파일 끝에 그 파일의 표를 둔다. **컨트롤러**(App 생성자가 만든다 — 부팅의 `_settingsApply` 가 `initModal` 보다 먼저다): `EdgesController`(`edges-controller.js` 237, 옛 `app-edges.js` + `app-edges-mesh.js` 의 메서드 8; 망 그림의 순수 함수는 `edges-mesh.js` 102) → `app.edges` · `UpdateController`(`update-controller.js` 66) → `app.update` · `SettingsController`(`settings-controller.js` 226) → `app.settings`(종전 `initModal` 에서 만들던 것을 생성자로, `initModal` 은 `init` 의 위임자) 가 부품 셋을 든다 — `SettingsApply`(`settings-apply.js` 278: 옛 `app-settings.js` 의 저장·적용·복원 7 + `app-settings-init.js` 11 + 옛 `app-polling.js` 의 `_pollMigrateAgents`) `.apply` · `SettingsLive`(`settings-live.js` 83) `.live` · `SettingsSaveState`(`settings-save-state.js` 61) `.saveState`. 설정창 쪽(`_openSettings`·`_labelSettingsRows`·`_bindSettingsSearch`·`_sectionCall`)은 컨트롤러 본문이다. 표만 남은 파일: `settings-table.js`(옛 `app-settings.js`, `SETTINGS_ACCESS`) · `poll-settings.js`(옛 `app-polling.js`, `POLL_SETTINGS`). 얇은 셸 `app-lsp.js`·`app-runs.js` 는 지웠다 — 지연 생성 `_lspClient`·`_runsPanel` 과 가드가 있는 넷(`_runsListRestore`·`_runViewsOpen`·`_runViewsRestore`·`_onRunMemberActivity`)은 `app.js` 본문, 나머지 열여섯은 `app.js` 끝의 위임자 표. **위임자 71**: edges 6 · update 2 · apply 16 · live 6 · saveState 2 · settings 3(`_openSettings`·`initModal`→`init`·`_paintSettingControls`→`paint`) · 섹션 20(표 `SETTINGS_SECTION_DELEGATES` → `_sectionCall`) · LSP 10 · Run 6. **App 에서 걷은 이름 13**(묶음 안에서만 부른다): `_egMeshSelect`·`_egMeshActPaint`·`_egInviteAccept`·`_egInviteReject`·`_diffApplyOptions`·`_settingsSync`·`_pollMigrateAgents`·`_liveOf`·`_liveTag`·`_liveDirty`·`_labelSettingsRows`·`_bindSettingsSearch`·`_sectionCall`. **옮긴 필드**: `_egMeshSel`(edges) · `_setSync`(apply) · `_live`(live) · `_settingsSearchReset`(settings). **App 에 남긴 필드**: `_edges`(섹션·채팅) · `_update`(`settings-notify.js` 가 쓴다) · `_lsp`·`_runs`(e2e·`app-slots.js`). `this.X` 는 acorn 으로 갈랐다(자기 메서드·소유 필드는 `this.X`, 덮어쓰기 대상·계약 이름은 자기 메서드여도 `this.app.X` — `_edgesRestore`·`_liveOpen`·`_liveNotice`·`saveSettings`·`_saveBtnsPaint`). 맨 `this` 넷은 `this.app` 으로(`new SettingsSync(this.app)`·표의 `get`/`set` 의 `call(this.app)`·저장 단추 판정 `d.dirty(this.app)`). 판정 `SETTINGS_SAVE_LIVE` 는 `app.settings.live` 를 부른다. 함수 안 `this`·계산된 이름 0. `owner` 를 쓰는 자리 없음. `Object.assign(App.prototype` 57 → 47. 몽키패치(FR-FEA-5) 해당 없음. **SRS 와 다르게 한 것**: ① 위임자는 App 의 한 줄 메서드가 아니라 표(`Controller.delegate`)다 — `app.js`(759)가 이미 500줄을 넘고 9k 까지 위임자 수백을 더하면 최대 파일 기준(971)을 넘는다 ② 폴링(1)은 따로 컨트롤러를 두지 않고 `SettingsApply` 로 흡수했다(부르는 곳이 `_settingsApply` 하나) ③ `SETTINGS_INIT` 의 `'initSaveButtons'` 는 이름 그대로 둔다 — App 위임자가 부품을 부르므로 표·`BOOT_ORDER` 가 바뀌지 않는다(FR-FEA-6) ④ `_applyPageTitle` 은 주제로는 알림(9b)이지만 파일 경계대로 `SettingsApply` 에 두었다. 시험: `app-controllers.test.mjs`(TC-FEA-1~3, 10건), `app-state-owners.test.mjs`(LSP 껍데기·설정 저장 경로, 계약 150 이름이 App 의 메서드·위임자·필드인지 — 없는 둘 `_gitJobChip`·`_focusCh` 는 원래 없다), 경로·부품을 고친 단위 시험 15(`settings-sections`·`settings-controls`·`settings-save`·`settings-save-state`·`telegram-settings`·`edges-mesh`·`edges-notice`·`profile-panel`·`profile-fp`·`peer-chat-ui`·`activity-runs-refresh`·`dialog`·`escape-menu`·`settings-source`·하네스 `SETTINGS` 에 부품 셋). 단위 1268. e2e 32 spec 291 통과·재시도 0(edges-settings·settings 다섯·save-pipeline·poll-interval·git-polling·migration-settings·telegram-settings·update-notice·editor-lsp 둘·runs 다섯·unfocused-edge·theme 둘·font-size·tab-width·agent-render-env·leave-confirm·i18n·a11y-dialog·access-allowlist·sandbox-pick·claude-accounts·mobile-keybar·mobile-ux-overhaul) |
| 9b | (이 커밋) | 파일은 `git mv` 뒤 acorn 으로 `this.X` 를 갈랐다(자기 메서드·소유 필드 `this.X` · 같은 묶음의 다른 부품은 그 부품 경로 `this.center.X`·`this.maps.X`·`this.enc.X`, 부품에서 뿌리로는 위임자 `this.app.X` 또는 위임자가 없으면 `this.app.attn.X` · 덮어쓰기 대상·계약은 자기 메서드여도 `this.app.X` · 나머지 `this.app.X`). **알림** `AttnController`(`attn-controller.js` 487, 옛 `app-attn.js` 23 메서드) → `app.attn`, 부품 `AttnCenter`(`attn-center.js` 109, 6) `.center` · `AttnClaim`(`attn-claim.js` 54, 3) `.claim`. **Claude 계정** `ClaudeAccountsController`(`claude-accounts-controller.js` 279, 20) → `app.claude`, 부품 `ClaudeMaps`(`claude-maps.js` 261, 15) `.maps`. 옛 `app-claude-accounts.js` 의 순수 함수·상수(약 225줄)는 `claude-accounts-view.js`(237)로 갈랐다 — 그대로 두면 컨트롤러 파일이 500줄을 넘는다. **상태바** `StatusBarController`(`statusbar-controller.js` 469, 18) → `app.statusbar`, 부품 `StatusBarEnc`(`statusbar-enc.js` 80, 6) `.enc`. 셋 다 App 생성자가 만든다. **위임자 40**: attn 17 · claude 7 · claude.maps 6 · statusbar 10. 부품 메서드는 위임자가 없다(묶음 밖에서 부르지 않는다) — App 에서 걷은 이름 54. **옮긴 필드**: `_attnNotifs`(App 생성자에서 `AttnController` 생성자로)·`_attnTyped`·`_attnPermAsked`·`_attnInteractBound`·`_audioCtx` · `_claudeAcctActiveId`·`_claudeAcctPopEsc`·`_claudeAcctPopWired` · `_claudeNormMap`·`_claudeRepaintArmed`·`_claudeToolCwd`(maps) · `_bgConfirm`·`_bgError`·`_bgPending`·`_cwdTool`·`_sbRo`·`_statsPoll`. **App 에 남긴 필드**: `_attn`(포커스·제목·상태 등록부) · `_claudeAccts`·`_claudeMaps`·`_claudeAcctPopId`·`_claudeAcctAuto`·`_claudeAcctOtherSl`(활동 패널·시험이 갈아 끼운다) · `_stats`(계약)·`_latency`(모바일)·`_bg`. 주인: 팝오버 자리 잡기 `TIMERS.frame(…,{owner:this})` 는 `owner:this.app` 으로 두었다(종전 주인 그대로). `owner:'app'` 문자열은 건드리지 않았다. `SETTINGS_INIT` 의 `'initStatusBar'`·`'initAttn'` 은 App 위임자 이름 그대로라 표·`BOOT_ORDER` 가 바뀌지 않는다(FR-FEA-6). 몽키패치 해당 없음. `Object.assign(App.prototype` 47 → 40. **SRS 와 다르게 한 것**: ① 순수 함수 파일 `claude-accounts-view.js` 를 새로 두었다(크기) ② 부품 메서드를 부르던 단위 시험은 부품을 부르거나(`app.claude._claudeAcctPopToggle`·`app.claude.maps._claudeMapsLoad`·`app.attn.center._attnCenterClose`) 시험 안에서 앱에 이어 붙인다(`attn-center`·`attn-claim`). 시험: `app-controllers.test.mjs` 9b 7건(TC-FEA-1~3 — 덮어쓰기 표본 `_attnClear`·`_claudeAcctRestore`·`updateStatusBar`), `app-state-owners` 의 계약 검사를 위임자 표 훑기로 바꿨다, 경로·부품을 고친 단위 시험 10(`attn-center`·`attn-claim`·`claude-accounts-foot`·`claude-accounts-map`·`claude-accounts-settings`·`activity-state-subagent`·`app-git-lists`·`escape-menu`·`window-state`·`app-state-owners`). 단위 1275. e2e 23 spec 200 — 199 통과·1 흔들림(`settings.spec.ts` 이름 거절, 알려진 것)(attention 다섯·background 둘·bg-kill 둘·claude-accounts·editor-encoding·git-statusbar·perf-statusbar·status-bar-reflow·statusbar-xss·tooltips·update-notice·settings·window-groups·runs·sse-resilience·event-timer-hub-contract·tab-names) |
