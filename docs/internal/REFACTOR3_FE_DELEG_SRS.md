# SRS: 리팩토링 3차 위임자 걷기 — 컨트롤러·부품의 옛 이름을 부르는 쪽에서 새 경로로 — IEEE 29148

> **문서 상태**: 승인·구현중
> **남은 것**: DL-3(GitPanel)·DL-7(FileTree) — 다른 작업 트리에서 병렬 진행 중. 합친 뒤 D-DLG-9(`Controller.delegate` 삭제)와 게이트 기준선 제거(§6)

- 접수: 2026-11-22. 리팩토링 3차의 마지막 구조 부채다. 근거: `REFACTOR3_FE_APPCTL_SRS` FR-FEA-4(위임자 표) · `REFACTOR3_FE_GITPANEL_SRS` FR-FEP-4·5(패널 본문의 위임자) · `REFACTOR3_FE_SETTINGS_SRS` FR-FES-9(섹션 위임자) · `REFACTOR3_FE_REST5_SRS` §1.3·D-FR5-8·D-FR5-9(FileTree·TerminalTool 부품 표) · `REFACTOR_PROD3_HANDOFF_4.md` §4("위임자 제거는 다음 리팩토링이다").
- 사용자 결정: "알아서 끝까지". 큰 일은 범위를 줄이지 않고 하위 이슈로 나눈다. 하위 이슈 하나가 끝나면 커밋한다. 동작은 바꾸지 않는다.
- 실측 기준: HEAD `9a3d8e30`. 수는 TypeScript 파서(`typescript` 패키지의 `createSourceFile`)로 `web/js`·`e2e`·`scripts` 를 훑어 셌다.

## 1. 개요

### 1.1 목적

P3a 단계 7·8·9 와 REST5 는 App·GitPanel·FileTree·TerminalTool 의 메서드를 컨트롤러·부품 클래스로 옮겼다. 그때 바깥 코드·e2e·단위 시험·계약이 부르던 옛 이름을 **위임자**로 남겼다. 위임자는 주인 원형에 있는 한 줄 메서드이고, 같은 인자로 컨트롤러·부품의 같은 이름을 부른다.

이 SRS 는 위임자를 걷는다. 부르는 쪽(앱 코드·e2e·단위 시험·계약·문자열로 부르는 표)을 새 경로로 옮기고, 위임자를 지운다. 그리고 위임자가 되살아나지 않게 정적 게이트를 둔다.

### 1.2 정의

| 말 | 뜻 |
|---|---|
| 주인 | 위임자가 붙은 클래스. `App` · `GitPanel` · `FileTree` · `TerminalTool` 넷이다 |
| 위임자 | 주인 원형의 한 줄 메서드. 같은 인자로 대상의 같은 이름(또는 정해진 다른 이름)을 부르고 답을 돌려준다. 두 꼴이 있다: `Controller.delegate(host, to, names)` 표, 클래스 본문의 `name(a){ return this.part.name(a) }` |
| 소유 경로 | 주인 인스턴스에서 이름의 본체까지의 경로. 예: `app.slot.slotFocused` · `app.editor.open.edOpenFile` · `panel.files.dirtyCount` · `tree.loader.reload` · `tool.sizer.doFit` |
| 갈아 끼우기 | e2e·단위 시험이 인스턴스의 메서드를 다른 함수로 바꿔 넣는 것(`app.X = …`). 위임자를 남긴 까닭이 이것이다(D-FR5-8): 부품끼리도 원형을 지나 불러야 시험이 갈아 끼운 것을 보았다 |
| 계약 | `core/app-testing.js` 의 `window.app.testing`. e2e 가 보는 이름의 목록이다(APP_TESTING_CONTRACT_SRS) |

### 1.3 범위

| 꼴 | 자리 | 수 (HEAD `9a3d8e30`) |
|---|---|---|
| `Controller.delegate` 표 | 컨트롤러·부품 파일 끝 69 · `app.js` 2 (LSP·Run) · `settings-controller.js` 의 섹션 표 1(반복문) | 호출 72, 이름 606 (App 490 · FileTree 96 · TerminalTool 20 — App 의 섹션 위임자 20 포함) |
| GitPanel 본문의 위임자 | `git/panel.js` | 메서드 157 · 정적 1(`headHTML`) · 부품 필드 읽기 접근자 4(`_hunkBarEd`·`_hunkBarPos`·`_fileView`·`_knownRefs`, FR-FEP-5) |
| 합계 | | **768** (메서드 763 · 정적 1 · 필드 접근자 4) |

부르는 쪽의 수(그 이름을 그 주인 수신자로 읽는 자리, 문자열·가짜 객체 키 제외)는 하위 이슈 표(§2.9)에 적는다.

### 1.4 범위 밖

- **필드 접근자**: `GitPanel` 의 관측 통로 24쌍(`_gen`·`_status` … → `this.obs`, FR-SVS-30 — 패널이 여럿이어도 관측이 하나라는 설계다), `FileTree` 의 저장소 읽기 13개(`_kids`·`_busy` … → `this.store`), `TerminalTool` 의 소켓 읽기 넷(`ws`·`_retryDelay`·`_sendQueue`·`_sendDropCount` → `this._sock`). 값이 어디 사는지를 감추는 접근자이고 메서드 위임자가 아니다. 필드 소유를 옮기는 일은 따로 한다.
- **이름이 다른 전달 메서드**: `FileEditor._write`→`saver.write` 등, `TerminalTool._send`→`_sock.send`, `App._bind`→`inputBinding.bind`, `TabBar.saveScroll`→`memo.save`. 이 SRS 의 앞 묶음들이 남긴 위임자가 아니다. 단, 이름이 같은 `FileEditor.note`·`offer` 는 게이트 예외 표(§3 D-DLG-8)에 적는다.
- 동작·화면·요청·저장 값의 변경.
- 계약의 **키**(e2e 가 쓰는 `app.testing.<키>`)의 변경. 키는 그대로 두고 계약 안에서 새 경로를 부른다.

### 1.5 불변 조건

| ID | 조건 |
|---|---|
| INV-DLG-1 | 동작 불변. 부르는 순서·인자·돌려주는 값이 같다 |
| INV-DLG-2 | 갈아 끼우기 경로가 산다: 시험이 소유 인스턴스의 메서드를 갈아 끼우면 앱 안의 모든 호출이 그것을 본다. 소유 클래스 안의 호출은 `this.X()`, 밖의 호출은 소유 경로로 부른다 — 둘 다 같은 인스턴스를 지난다 |
| INV-DLG-3 | 시험의 단정·의도를 약하게 만들지 않는다. 갈아 끼우는 자리만 소유 인스턴스로 옮긴다 |
| INV-DLG-4 | 계약의 키가 그대로다. e2e 의 `app.testing.*` 호출은 바뀌지 않는다 |

## 2. 요구사항

### 2.1 공통

| ID | 요구 |
|---|---|
| FR-DLG-1 | 위임자 이름을 그 주인 수신자로 부르는 자리(앱 코드·e2e·단위 시험)는 소유 경로로 부른다. 소유 클래스 안에서 자기를 가리키는 경로(`this.app.slot.X` 를 `SlotsController` 안에서)는 `this.X` 로 쓴다 |
| FR-DLG-2 | `.bind`·`.call`·`.apply` 로 위임자를 넘기는 자리는 대상도 소유 인스턴스로 바꾼다(`p.doFit.bind(p)` → `p.sizer.doFit.bind(p.sizer)`) |
| FR-DLG-3 | 이름을 문자열로 들고 부르는 표는 소유 경로를 점 경로 문자열로 든다: 상태 등록부(`state-registry.js` 의 `restore`·`events`) · 편집기 앱 동작표(`ED_APP_ACTIONS`) · 설정창 세우기 순서(`SETTINGS_INIT`) · 설정 저장 단추 판정(`SETTINGS_SAVE_LIVE`). 부를 때 경로를 풀어 마지막 이름의 주인을 `this` 로 부른다 |
| FR-DLG-4 | 계약(`app-testing.js`)의 이름 목록은 위임자였던 이름에 소유 경로를 적는다(`'slot.slotFocused'`). 키는 마지막 이름에서 앞의 `_` 를 뗀 것으로 그대로다. 읽기는 읽는 시점에 경로를 풀어 주인에 바인딩하고, 쓰기는 주인에 쓴다 |
| FR-DLG-5 | 단위 시험이 만드는 가짜 앱·패널·트리·터미널은 소유 경로 모양을 갖는다(`{ slot: { slotFocused(){…} } }`) |
| FR-DLG-6 | 위임자를 지운다: `Controller.delegate` 호출 72 · GitPanel 본문의 위임자 162(메서드 157 · 정적 1 · 필드 접근자 4). 지울 수 없는 것은 §3 예외 표에 이유와 함께 남긴다 |
| FR-DLG-7 | 정적 게이트 `scripts/check-delegates.mjs` 를 `make gates` 에 잇는다. ① `Controller.delegate(` 호출 ② 클래스 본문에서 같은 이름을 같은 인자로 `this.<필드>.<같은 이름>(…)` 에 넘기기만 하는 메서드(정적 포함)를 잡는다. 예외는 게이트 안의 표(이 SRS §3 D-DLG-8)의 이름뿐이다 |
| FR-DLG-8 | 위임자를 고정하던 단위 시험(`app-controllers`·`git-panel-parts`·`settings-sections`·`term-pane-surface`·`file-tree-surface` 등)은 "이름이 소유 클래스 원형에 있고 주인 원형에는 없다" 와 "소유 인스턴스에 갈아 끼운 것을 앱 경로가 부른다" 를 단정한다 |

### 2.2 이름이 바뀌는 위임자

위임자 몇은 대상의 다른 이름을 불렀다. 부르는 쪽이 대상의 이름을 쓴다.

| 옛 이름 | 새 경로 |
|---|---|
| `app.initModal()` | `app.settings.init()` (돌려주는 값을 버렸다 — 부르는 쪽이 값을 쓰지 않는다) |
| `app._paintSettingControls()` | `app.settings.paint()` |
| 섹션 위임자 20(`_onAccessChanged` 등) | `app.settings.section('<탭>')?.<이름>(…)` — 섹션이 없으면(`init` 전) 아무것도 하지 않는다(`_sectionCall` 과 같다) |
| LSP 10(`_lspRefresh` 등) | `app._lspClient().<이름>(…)` (지연 생성) |
| Run 6(`_runsModalToggle` 등) | `app._runsPanel().<이름>(…)` (지연 생성) |
| `panel._watchdog()` | `panel.watchdog.run()` |
| `GitPanel.headHTML(o)` | `GitChanges.headHTML(o)` |

### 2.3 하위 이슈

수는 HEAD `9a3d8e30` 에서 codemod 를 마른 채로 돌려 셌다. "부르는 자리" 는 주인 수신자로 읽는 자리, "손볼 자리" 는 문자열·가짜 객체 키·값으로 넘기기처럼 사람이 보고 고친 자리다.

| 이슈 | 묶음 | 위임자 파일 | 이름 | 부르는 자리 · 파일 | 손볼 자리 |
|---|---|---|---|---|---|
| DL-1 | 설정·간선·업데이트 | `settings-controller`·`settings-apply`·`settings-live`·`settings-save-state`·`edges-controller`·`update-controller` | 55 | 156 · 38 | 225 |
| DL-2 | git (App 쪽) | `git-controller`·`git-surfaces`·`git-sync` | 42 | 188 · 77 | 116 |
| DL-3 | GitPanel 부품 | `git/panel.js` 본문 | 162 | 334 · 63 | 355 |
| DL-4 | 레이아웃·슬롯·포커스·워크스페이스 동기화 | `layout-*` 7 · `slot-ops`·`slots-controller` · `focus-*` 3 · `ws-sync-controller`·`ws-save-controller`·`soft-reload` | 147 | 908 · 135 | 497 |
| DL-5 | 도구·편집기·Repo 창·LSP·Run | `tool-*` 5 · `editor-*` 10 · `repo-win-controller`·`repo-preview` · `app.js`(LSP·Run) | 154 | 656 · 105 | 367 |
| DL-6 | 채팅·활동·모바일·상태바·알림·계정 | `chat-*` 3 · `agents-*` 2 · `activity-list` · `mobile-*` 3 · `statusbar-controller` · `attn-controller` · `claude-*` 2 | 92 | 388 · 83 | 238 |
| DL-7 | FileTree | `ui/file-tree-*` 8 | 96 | 269 · 9 | 98 |
| DL-8 | TerminalTool | `ui/term-{fit,held,output,transfer}` | 20 | 175 · 33 | 15 |
| DL-9 | 게이트·문서 | `scripts/check-delegates.mjs` · `make gates` · 문서 | — | — | — |

순서: DL-8 → DL-1 → DL-2 → DL-3 → DL-6 → DL-5 → DL-4 → DL-7 → DL-9. 작은 것으로 도구를 다듬고, 이름이 많은 것을 뒤에 둔다.

## 3. 결정

| ID | 결정 | 이유 |
|---|---|---|
| D-DLG-1 | 부르는 쪽은 소유 경로를 쓴다. 소유 클래스 안에서는 `this.X` 다 | 갈아 끼우기는 인스턴스의 속성을 바꾸는 일이다. 소유 경로와 소유 클래스의 `this` 는 같은 인스턴스이므로 둘 다 갈아 끼운 것을 본다(INV-DLG-2). 위임자가 하던 일 — "원형을 지나 인스턴스를 본다" — 은 소유 인스턴스가 직접 한다 |
| D-DLG-2 | 계약은 키를 바꾸지 않고 목록에 소유 경로를 적는다 | e2e 수백 곳을 고치지 않고 내부 이름의 자리만 한 파일에서 바뀐다 — 계약이 있는 이유다(FR-ATC-2). 쓰기를 주인에 하므로 `app.testing.X = f` 로 갈아 끼운 것을 앱 경로가 본다 |
| D-DLG-3 | 이름을 문자열로 부르는 표는 점 경로를 든다. 경로를 푸는 공용 함수를 `core/helpers.js` 에 두지 않고 쓰는 자리에서 짧게 푼다. `section(tab)` 마디는 설정 섹션(없으면 아무것도 하지 않는다), `x()` 마디는 지연 생성 본체다 | 표 넷이 각각 몇 줄로 푼다. `state-registry.js` 는 e2e 합성 페이지(`sse-resilience`)가 홀로 싣는다 — 공용 함수에 기대면 하네스가 깨진다 |
| D-DLG-4 | 섹션 위임자는 `section(tab)?.X(…)` 로 부른다 | `_sectionCall` 의 "섹션이 없으면 아무것도 하지 않는다" 를 그대로 옮긴다. 저장 단추 판정의 표(`SETTINGS_SAVE_LIVE`)는 `_sectionCall` 을 그대로 부른다 |
| D-DLG-5 | e2e 는 계약 밖의 공개 이름(앞에 `_` 가 없는 이름)을 지금처럼 `window.app` 에서 직접 읽되 소유 경로로 읽는다. 계약 키로 옮기지 않는다 | 계약에 넣으면 계약이 커지고 e2e diff 가 늘어 "무엇이 바뀌었나" 가 흐려진다. 사설 이름(`_x`)은 이미 계약만 지난다(게이트 `check-e2e-private.sh`) |
| D-DLG-6 | 부품 사이의 호출(FileTree·TerminalTool·GitPanel 부품)도 소유 경로로 부른다 — `this.tree.loader.reload()` | D-FR5-8 은 부품끼리 원형을 지나야 갈아 끼운 것을 본다고 했다. 이제 시험이 소유 부품을 갈아 끼우므로 소유 경로가 그것을 본다 |
| D-DLG-7 | 기계 변환(TypeScript 파서 codemod)으로 바꾸고, 수신자의 종류를 모르는 자리는 사람이 파일을 보고 정한다 | 이름 가운데 `split`·`save`·`paint`·`init`·`reload`·`refresh`·`load` 처럼 흔한 것이 있어 글자 바꾸기로는 문자열·다른 객체의 같은 이름을 건드린다. 수신자가 주인일 때만 바꾼다 |
| D-DLG-8 | 게이트의 예외 표: `FileEditor.note`·`FileEditor.offer`(→ `notice`) · `GitRemote.run`(→ `router`, REST3 FU-12 의 공개 입구) · `DocRender.focus`(→ DOM 요소의 `focus`, 부품이 아니다). 이 SRS 범위 밖(§1.4)의 전달 메서드다 | 범위 밖의 것을 게이트가 막으면 게이트를 끄게 된다. 이름 단위로 적어 새 위반은 잡는다 |
| D-DLG-9 | `Controller.delegate` 정적 메서드와 그 단위 시험을 지운다(예외 표가 비면) | 쓰는 곳이 없어진 코드다. 게이트가 같은 꼴의 재도입을 막는다. 이 작업 트리에서는 FileTree 표(DL-7)가 아직 써서 남긴다 — DL-7 을 합칠 때 지운다 |
| D-DLG-10 | 위임자를 지운 뒤 지연 생성 접근자 `_lspClient`·`_runsPanel` 을 `lspClient`·`runsPanel` 로 승격한다 | 옛 위임자(`lspClickDef` 등)는 공개 이름이었는데, `ui/`·`git/` 이 `app._lspClient()` 로 부르면 계층 경계 게이트(`check-layer.sh`, FR-FMB-40)가 막는다. 경계를 넘는 이름은 승격하는 것이 규약이다. 계약 키 `runsPanel` 은 그대로다 |
| D-DLG-11 | 주인이 없을 수 있는 자리의 존재 확인(`if(app&&app.edDoc)`·`typeof app.attnUserIsWatching`)은 소유 경로의 첫 마디 뒤에 `?.` 를 넣는다(`app.editor?.doc.edDoc`). 부름 자체는 `?.` 없이 쓴다 | 그 확인은 앱이 덜 선 페이지(문서 렌더·편집기를 홀로 싣는 e2e 하네스·단위 시험의 대역)를 위한 것이다. 확인이 주인의 부재에서 던지면 가드가 뜻을 잃는다. 본 앱에서는 주인이 늘 있으므로 동작은 같다 |
| D-DLG-12 | 단위 시험 하네스 `controllers()` 는 싣지 않은 뿌리 컨트롤러를 빈 주인(부품 필드 포함)으로 세운다 | 시험의 대역이 소유 경로(`app.git.plainWindows = …`)에 들어갈 자리가 있어야 한다. 실은 컨트롤러는 종전처럼 진짜로 선다 |
| D-DLG-13 | (2026-11-22 주 세션 지시로 개정) 하위 이슈마다 e2e 를 돌리지 않는다. 대신 ① `make gates`·`npm run -s unit`·`npm run -s typecheck`·`make lint` 0 ② 걷은 이름이 옛 수신자(`app.X`·`this.app.X`·`w.app.X`·`window.app.X`·문자열 표의 옛 이름)로 남지 않았는지 정적 검사(TypeScript 파서 codemod 를 마른 채로 돌려 바꿀 자리 0) ③ 바꾼 e2e 파일은 `npx playwright test --list` 로 문법만. e2e 전량은 세 작업 트리를 합친 뒤 주 세션이 한 번 돈다 | 속도. DL-8·DL-1(e2e 전량 2,305 통과·흔들림 0)·DL-2(관련 54 spec 757 통과)는 앞의 방식으로 돌았다 |

## 4. 검증

| ID | 시험 |
|---|---|
| TC-DLG-1 | 하위 이슈마다: 그 이슈의 이름이 주인 원형에 없고 소유 클래스 원형에 함수로 있다(단위) |
| TC-DLG-2 | 하위 이슈마다: 소유 인스턴스에 갈아 끼운 메서드를 앱 경로(다른 컨트롤러·부품)가 부른다 — 옛 TC-FEA-2·TC-FR5-50 의 갈아 끼우기 단정을 소유 인스턴스로 옮긴다(단위) |
| TC-DLG-3 | 계약: 위임자였던 계약 이름을 `app.testing` 으로 읽으면 소유 인스턴스에 바인딩된 함수이고, 쓰면 소유 인스턴스에 쓰인다(단위) |
| TC-DLG-4 | 게이트 `check-delegates.mjs` 가 ① `Controller.delegate(` ② 같은 이름 전달 메서드를 잡고 예외 표의 이름은 지난다(단위, `scripts/test`) |
| TC-DLG-5 | 하위 이슈마다 `make gates` · `npm run -s unit` · `npm run -s typecheck` · `make lint` 0 · 정적 검사 0 · 바꾼 e2e 의 `--list` (D-DLG-13) |

## 5. 동작 변경 기록

없다(INV-DLG-1).

## 6. 구현 기록

| 이슈 | 커밋 | 내용 |
|---|---|---|
| SRS | `4775b395` | 이 문서 |
| DL-8 | `3df763ff` | TerminalTool 20 — 부품 `sizer`·`heldBar`·`output`·`xfer`. 부품 안의 `this.pane.X` 는 `this.X`. 표면 시험 TC-FR5-50 은 부품을 갈아 끼우고 TC-DLG-1 을 더했다. e2e 관련 11 spec 102 통과 |
| DL-1 | `e33c131b` | 설정·간선·업데이트 55. 문자열 표 넷(등록부·`ED_*_ACTIONS`·`SETTINGS_INIT`·`SETTINGS_SAVE_LIVE`)과 계약 `app-testing.js` 전체를 점 경로로(다른 묶음의 이름까지 이때 한 번에). `SETTINGS_ACCESS` setter 의 `this`(앱)도 소유 경로. Go 시험 `derive_test.go` 의 문자열 대조 하나. e2e 전량(`make e2e`) 2,305 통과·흔들림 0 |
| DL-2 | `251ff01e` | git(App 쪽) 42. 시험 하네스 `controllers()` 의 빈 주인(D-DLG-12). e2e 관련 54 spec 757 통과 |
| DL-6 | `98a81965` | 채팅·활동·모바일·상태바·알림·계정 92. 홀로 실리는 `term-output.js`·`term-clipboard.js` 의 가드는 주인 부재를 견딘다 |
| DL-5 | `7267abdc` | 도구·편집기·Repo 창·LSP·Run 154. `lspClient`·`runsPanel` 승격(D-DLG-10), 가드의 `?.`(D-DLG-11) |
| DL-4 | `352958af` | 레이아웃·슬롯·포커스·동기화 147. 옛 위임자를 말하던 코드 주석을 지금 모양으로 |
| DL-9 | `e6b2da61`…(이 커밋) | 게이트 `check-delegates.mjs`(+ 단위 시험 다섯, `make gates`·CI 연결) · 문서(`architecture.md`·`FE_OBJECT_MODEL.md`·PROD3 §7.1·CHANGELOG) |
| DL-3 | `7c041bf7` · `584b0771` · `a8bf84df` | GitPanel 본문의 위임자 162(메서드 157 · 정적 `headHTML` · 접근자 `_hunkBarEd`·`_hunkBarPos`·`_fileView`·`_knownRefs`)를 세 묶음(43 · 53 · 66)으로 걷었다. 남긴 것 없음. 부르는 쪽은 `panel.<부품>.X`, 부품 안의 자기 이름은 `this.X`, 다른 부품은 `this.p.<부품>.X`, `_watchdog()` 은 `watchdog.run()`, `GitPanel.headHTML` 은 `GitChanges.headHTML` 이다. e2e 의 문자열 `evaluate`(`git-observe-revive`·`git-live-triggers`)도 옮겼다. 갈아 끼우는 시험은 부품 인스턴스를 갈아 끼운다(`git-polling` 의 `changes._paint`, `git-menu-targets` 의 `files`). `git-panel-parts` 의 위임자 단정은 TC-DLG-1·2 로 바꿨다. 관측 통로 24쌍은 범위 밖(§1.4)이라 남는다 |

**수.** 위임자 768 → 258(GitPanel 162 · FileTree 96, 병렬 진행 중). App 490 · TerminalTool 20 은 0.

**남긴 위임자.** 없다(App·TerminalTool). 게이트 예외 넷(D-DLG-8)은 이 SRS 가 세는 위임자가 아니다.

## 부록 A. 위임자 표 (HEAD `9a3d8e30`)

"갈 곳" 은 주인 인스턴스에서의 경로다. `settings.section:<탭>` 은 섹션 위임자, `x:y` 는 이름이 바뀌는 것, `static:` 은 정적 메서드다.

| 이슈 | 파일 | 주인 | 갈 곳 | 수 | 이름 |
|---|---|---|---|---|---|
| DL-1 | `core/edges-controller.js` | App | `edges` | 6 | `_edgesRestore` `_onEdgesChanged` `_egMeshPaint` `_egInvitesPaint` `_egInviteSend` `_egNotify` |
| DL-1 | `core/settings-apply.js` | App | `settings.apply` | 16 | `_applyPageTitle` `_saveSettingsSoon` `_saveSettingsNow` `_localeMirror` `_edApplyWordWrap` `_edApplyMinimap` `_edApplyFontSize` `_termApplyFontSize` `_applyThemeChoice` `_keybarApply` `saveSettings` `_onSettingsChanged` `_settingsBody` `_settingsLocalPending` `_settingsApply` `_settingsRestore` |
| DL-1 | `core/settings-controller.js` | App | `settings` | 1 | `_openSettings` |
| DL-1 | `core/settings-controller.js` | App | `settings:init` | 1 | `initModal` |
| DL-1 | `core/settings-controller.js` | App | `settings:paint` | 1 | `_paintSettingControls` |
| DL-1 | `core/settings-controller.js` | App | `settings.section:access` | 2 | `_onAccessChanged` `_aclCollect` |
| DL-1 | `core/settings-controller.js` | App | `settings.section:claude` | 2 | `_cacctPanelShown` `_cacctRefreshSoft` |
| DL-1 | `core/settings-controller.js` | App | `settings.section:edges` | 3 | `_edgesPaint` `_egNodePaint` `_egNodeCollect` |
| DL-1 | `core/settings-controller.js` | App | `settings.section:presets` | 2 | `_renderPresets` `_savePreset` |
| DL-1 | `core/settings-controller.js` | App | `settings.section:profile` | 2 | `_pfCollect` `_pfFollow` |
| DL-1 | `core/settings-controller.js` | App | `settings.section:sandbox` | 2 | `_onSandboxChanged` `_sbxCollect` |
| DL-1 | `core/settings-controller.js` | App | `settings.section:server` | 1 | `_onServerMoving` |
| DL-1 | `core/settings-controller.js` | App | `settings.section:telegram` | 2 | `_loadTelegramPanel` `_tgRead` |
| DL-1 | `core/settings-controller.js` | App | `settings.section:theme` | 4 | `themeSlots` `setThemeSlots` `_showCustomEditor` `_hideCustomEditor` |
| DL-1 | `core/settings-live.js` | App | `settings.live` | 6 | `_liveMark` `_liveOpts` `_liveOpen` `_liveChanged` `_liveStale` `_liveNotice` |
| DL-1 | `core/settings-save-state.js` | App | `settings.saveState` | 2 | `_saveBtnsPaint` `initSaveButtons` |
| DL-1 | `core/update-controller.js` | App | `update` | 2 | `_updateRestore` `_updateRender` |
| DL-2 | `core/git-controller.js` | App | `git` | 17 | `gitWindow` `isGitWin` `isChatWin` `isKindWin` `plainWindows` `gitBackTarget` `_migrateGitWindow` `openGitWindow` `_initGitSection` `gitSignal` `gitStatusHub` `gitOpenFile` `gitOpenFileHead` `gitOpenTerminal` `gitBadgeFor` `gitPinEntry` `_gitTermToolId` |
| DL-2 | `core/git-surfaces.js` | App | `git.surfaces` | 14 | `gitObs` `_gitRescheduleAll` `gitWatchdogAll` `_gitNotifyPinsAll` `gitPanelAt` `_gitDropView` `_gitViewDirty` `_gitDiffDocPaths` `_gitViewSave` `gitSurfaceOn` `_gitPanelKey` `_gitPanelRoot` `_gitPanelReap` `_gitRootOfActive` |
| DL-2 | `core/git-sync.js` | App | `git.sync` | 11 | `gitReposKick` `_gitObserveOk` `_onGitChanged` `_gitObserveRestore` `gitReposRefresh` `gitPin` `gitUnpin` `_gitPinsApply` `_pollGitJobs` `_gitJobsBegin` `_gitJobsSettle` |
| DL-3 | `git/panel.js` | GitPanel | `blame` | 3 | `openBlame` `blameStale` `_paintBlame` |
| DL-3 | `git/panel.js` | GitPanel | `changeRows` | 6 | `_paintGroup` `_actCols` `_actGap` `_toggleGroup` `_watchMore` `revealRow` |
| DL-3 | `git/panel.js` | GitPanel | `changes` | 6 | `_renderChanges` `_paint` `_wireHead` `_paintHeadIn` `paintHeads` `_treeMode` |
| DL-3 | `git/panel.js` | GitPanel | `changes (접근자)` | 1 | `_fileView` |
| DL-3 | `git/panel.js` | GitPanel | `diffPane` | 12 | `_renderDiff` `_diffInvalidate` `_fileList` `_diffIndex` `_diffMove` `reloadDiff` `_destroyViews` `diffTabApply` `diffViewKeep` `diffViewRestore` `diffTabViewState` `diffTabViewApply` |
| DL-3 | `git/panel.js` | GitPanel | `files` | 16 | `untrackedPaths` `uncommittedReset` `uncommittedClean` `ignorePath` `openFileHistory` `openFileAtHead` `dirtyCount` `isDirty` `showCommitDiff` `_target` `_selected` `_rowTargets` `_bulk` `_dirBulk` `_run` `_op` |
| DL-3 | `git/panel.js` | GitPanel | `hunks` | 9 | `_paintHunks` `_hunkText` `_hunkNote` `_hunkBarWire` `_hunkBarDispose` `_hunkBarHide` `_hunkBarPaint` `_hunkAct` `_diffChanged` |
| DL-3 | `git/panel.js` | GitPanel | `hunks (접근자)` | 2 | `_hunkBarEd` `_hunkBarPos` |
| DL-3 | `git/panel.js` | GitPanel | `poll` | 14 | `_foldPref` `_setFold` `absPath` `repoTop` `openFileDiff` `copyText` `init` `signal` `_pollOk` `_cadence` `_applyCadence` `_reschedule` `_stop` `collect` |
| DL-3 | `git/panel.js` | GitPanel | `selection` | 9 | `_diffTarget` `_selKey` `_noBaseline` `_openInEditor` `_select` `_openDiff` `openView` `_dirEntryNote` `_dirEntryActs` |
| DL-3 | `git/panel.js` | GitPanel | `static:GitChanges.headHTML` | 1 | `headHTML` |
| DL-3 | `git/panel.js` | GitPanel | `viewReload` | 5 | `refresh` `_reloadViews` `_staleTake` `_inRefsRound` `_reloadStaleViews` |
| DL-3 | `git/panel.js` | GitPanel | `viewRoots` | 11 | `elFor` `viewDirty` `viewSave` `dropView` `_render` `_paintStaleIn` `paintStale` `_enterMissing` `_enterMissingView` `_leaveMissing` `_paintAllViews` |
| DL-3 | `git/panel.js` | GitPanel | `views` | 40 | `_commit` `_remote` `adoptJobs` `expandGroup` `_history` `_branches` `_console` `_worktrees` `_stash` `_renderView` `_emptyHint` `statusOf` `actionOf` `rowActionOf` `_viewFp` `headName` `checkoutRef` `checkoutRemote` `branchRename` `branchDelete` `branchDeleteTargets` `branchMerge` `branchRebase` `branchSetUpstream` `branchUnsetUpstream` `branchPush` `branchFetchInto` `branchDeleteRemote` `branchDeleteBoth` `branchDeletePair` `adoptRefs` `fetchRefs` `branchNote` `notifyPins` `createBranchFrom` `createTag` `tagDelete` `tagDeleteRemote` `tagPush` `tagPushAll` |
| DL-3 | `git/panel.js` | GitPanel | `views (접근자)` | 1 | `_knownRefs` |
| DL-3 | `git/panel.js` | GitPanel | `watchdog:run` | 1 | `_watchdog` |
| DL-3 | `git/panel.js` | GitPanel | `write` | 25 | `afterCommitOp` `noteCompareMark` `afterRefWrite` `afterRemoteJob` `afterJobSlots` `stashApply` `stashPop` `stashDrop` `afterStashWrite` `stashBranch` `stashCreate` `afterStashRefWrite` `applyWriteFail` `removeIndexLock` `post` `bumpWrite` `wqPost` `busyNote` `postJob` `writeReason` `writeError` `adopt` `_paintOp` `runOperation` `_paintNote` |
| DL-4 | `core/focus-controller.js` | App | `focus` | 14 | `setFocusState` `focusClear` `_navPlace` `_navNote` `navJump` `_navRetab` `navCan` `navBack` `navForward` `_navCounts` `setFocus` `_initFocusSync` `_paintFocusEdge` `_paintAttnEdge` |
| DL-4 | `core/focus-highlight.js` | App | `focus.hl` | 2 | `attnFocusSync` `focusHighlightSync` |
| DL-4 | `core/focus-owner.js` | App | `focus.owner` | 6 | `_focusWindow` `_onWindowFocus` `_focusRestore` `resizeCheck` `applyFocusOverlay` `resendWindowSizes` |
| DL-4 | `core/layout-controller.js` | App | `layout` | 8 | `_restoreReturn` `_tabToManual` `_tabToAuto` `renameTab` `_mkWindow` `addWindow` `delWindow` `switchWindow` |
| DL-4 | `core/layout-dnd.js` | App | `layout.dnd` | 6 | `getDragZone` `showBodyDropIndicator` `clearBodyDropIndicator` `moveTabToPane` `moveTabToWindow` `splitPaneWithTab` |
| DL-4 | `core/layout-dock.js` | App | `layout.dock` | 8 | `panelDock` `setPanelDock` `applyPanelDock` `sbCollapsePaint` `repoSideDock` `setRepoSideDock` `saveLayout` `resetLayout` |
| DL-4 | `core/layout-groups.js` | App | `layout.groups` | 17 | `windowGroups` `newGroup` `deleteGroup` `moveWindowTo` `moveTabTo` `wgFoldToggle` `sidebarWindowEntries` `sidebarReorder` `wgEdgeGroup` `addGroupInteractive` `groupHasAttn` `_remoteNewGroup` `_remoteRenameGroup` `_remoteDeleteGroup` `_remoteMoveWindow` `_remoteMoveGroup` `_remoteMoveTab` |
| DL-4 | `core/layout-tab-add.js` | App | `layout.tabAdd` | 5 | `findGitViewTab` `_findEditorTab` `addTab` `_revealTab` `_pushTab` |
| DL-4 | `core/layout-tab-ops.js` | App | `layout.tabOps` | 17 | `closeTab` `switchTab` `split` `switchTabPrev` `switchTabNext` `switchWindowPrev` `switchWindowNext` `paneNavigate` `addTabFocused` `closeTabFocused` `closeWindowActive` `sidebarCollapsed` `setSidebarCollapsed` `sbPanel` `_toggleSidebar` `sbRail` `termIn` |
| DL-4 | `core/layout-tab-reopen.js` | App | `layout.reopen` | 3 | `tabReopen` `tabReopenCan` `tabReopenAt` |
| DL-4 | `core/layout-window-state.js` | App | `layout.winState` | 7 | `_normalizeIncomingWorkspace` `_fallbackActiveWindow` `_stripDeviceKeys` `_activateWindow` `_persistActiveWindow` `_loadPreset` `_presetButtonPaint` |
| DL-4 | `core/slot-ops.js` | App | `slot.ops` | 14 | `slotAdd` `slotRemove` `slotFocusTo` `slotNav` `slotRenderFlush` `slotOpen` `_slotClaimAll` `_slotOnSwitch` `_slotOnWindowGone` `slotNavigate` `_initSlots` `_slotDirPaint` `slotHandleBind` `slotApplySizes` |
| DL-4 | `core/slots-controller.js` | App | `slot` | 16 | `slotCount` `slotFocused` `slotKey` `slotKeysOf` `editorsOf` `editorAny` `editorsDrop` `_slotOf` `slotBase` `paneTab` `paneTabSet` `_slotTabsToWs` `slotWindow` `windowVisible` `_slotIdentity` `_slotsRestore` |
| DL-4 | `core/soft-reload.js` | App | `wsSync.reload` | 2 | `softReload` `_initSoftReload` |
| DL-4 | `core/ws-save-controller.js` | App | `wsSave` | 10 | `_etagOf` `_wsMarkSaved` `_wsIdsOf` `_wsSeen` `save` `_savePut` `_saveAdoptRemote` `_adoptRemote` `_saveBackoff` `_saveFlushDeferred` |
| DL-4 | `core/ws-sync-controller.js` | App | `wsSync` | 12 | `_restoreBegin` `_restoreLive` `_restoreNote` `_restoreVoid` `_restoreEnd` `_subscribeCommands` `_onWorkspaceChanged` `_onToolForeground` `_fgMap` `_fgApply` `_fgRepaint` `_applyRemoteWorkspace` |
| DL-5 | `core/app.js` | App | `_lspClient()` | 10 | `_lspRefresh` `_lspGotoDef` `_lspFindRefs` `_lspRootOfPath` `lspClickDef` `lspExtFor` `lspOfferFor` `lspOfferInstall` `lspOfferPending` `lspOfferReopen` |
| DL-5 | `core/app.js` | App | `_runsPanel()` | 6 | `_runsModalToggle` `_findRunTab` `runViewEl` `_runDisposeView` `_onRunChanged` `_runPaint` |
| DL-5 | `core/editor-controller.js` | App | `editor` | 13 | `isEditorWin` `edWindows` `edRootOf` `edWindowFor` `edOn` `_edHome` `edNotes` `edBase` `edName` `edEntries` `edFixed` `edRoots` `edFocusHandoff` |
| DL-5 | `core/editor-doc-render.js` | App | `editor.docRender` | 4 | `docRenderMount` `docRenderRootOf` `_docRenderOpen` `docRenderToSource` |
| DL-5 | `core/editor-doc.js` | App | `editor.doc` | 11 | `edDocAt` `edDocLoad` `edDocRefresh` `edDocDirtySync` `edDocReopen` `edDocConvertUtf8` `edDocSave` `edDocWrite` `edConfirmConflict` `edDocLeaveConfirm` `edDocMove` |
| DL-5 | `core/editor-file.js` | App | `editor.file` | 7 | `edOpenFile` `edClipSet` `edClipGet` `edFs` `edFsActions` `_edConfirm` `edConfirmDelete` |
| DL-5 | `core/editor-open.js` | App | `editor.open` | 16 | `_migrateEditorTabs` `edActivateTarget` `edOpenWindow` `edDoc` `tabDirty` `edDocDrop` `edDirtyDiff` `edDirtyDiffRepaint` `edPollDocStamps` `_edOnGitChanged` `edStore` `edTree` `_edTreeFor` `edActiveTree` `edRefreshTreesFor` `_edVisibleTrees` |
| DL-5 | `core/editor-pane.js` | App | `editor.pane` | 14 | `_edKeepActive` `edPinTabFor` `edSideTabs` `edSideOf` `edSetSide` `edSideWidth` `edSetSideWidth` `_edMigrateSideWidth` `edEnsurePane` `edDirtyUnder` `edRetargetTabs` `edCloseTabsUnder` `_edAfterGitSignal` `_edGitHold` |
| DL-5 | `core/editor-search.js` | App | `editor.search` | 8 | `_edSearchRoot` `_edActiveDiff` `_edQuickOpen` `_edSearchOpen` `_edFindInFile` `_edGotoLine` `_edActiveEditor` `edTrySearchKey` |
| DL-5 | `core/editor-section.js` | App | `editor.section` | 7 | `_initEditorSection` `_edTermCwd` `_edPathCandidates` `edRemove` `edReorder` `edMutate` `edRefresh` |
| DL-5 | `core/editor-sync.js` | App | `editor.sync` | 9 | `_edLoad` `_edPatchList` `edMirror` `_edApplyLinked` `_edReconcile` `_edWinDirty` `edAnyDirty` `_edWinSaveDirty` `_edSaveAll` |
| DL-5 | `core/editor-watch.js` | App | `editor.watch` | 3 | `edWatchSync` `_edWatchRestore` `_onFsChanged` |
| DL-5 | `core/repo-preview.js` | App | `repoWin.preview` | 3 | `pinPreviewTab` `_findEditorTabIn` `_retargetPreview` |
| DL-5 | `core/repo-win-controller.js` | App | `repoWin` | 10 | `diffTabKey` `gitDiffOpen` `gitDiffStep` `gitDiffPin` `gitDiffTabPin` `gitDiffPanelFor` `_gitDiffPanelOf` `gitDiffPanelActive` `_gitDiffPanelsDrop` `_gitDiffTabIds` |
| DL-5 | `core/tool-cmd.js` | App | `tool.cmd` | 3 | `_echoResult` `_execRemote` `_findTabById` |
| DL-5 | `core/tool-controller.js` | App | `tool` | 9 | `_isToolBusy` `_toolsBusy` `_notify` `_sbxProgress` `_sbxRuntime` `_sbxRuntimeModal` `_sbxRemember` `_pickSandbox` `_confirmClose` |
| DL-5 | `core/tool-life.js` | App | `tool.life` | 10 | `_setToolBackground` `_bgRefresh` `_restoreTool` `_newTool` `_focusedCwd` `_kill` `_killTool` `aw` `_toolName` `findToolLocation` |
| DL-5 | `core/tool-search.js` | App | `tool.search` | 6 | `toggleSearch` `closeSearch` `clearAllSearchDecorations` `researchIfOpen` `focusedTerminal` `doSearch` |
| DL-5 | `core/tool-work.js` | App | `tool.work` | 5 | `workingToolIds` `tabWorkDot` `windowWorkDot` `_workSync` `_workRefresh` |
| DL-6 | `core/activity-list.js` | App | `agents.list` | 8 | `actPanel` `_actTabSelect` `actPanelOpen` `_actRefresh` `_actBgRows` `_actCellsEl` `_actUsageWinEl` `_actRunsRows` |
| DL-6 | `core/agents-controller.js` | App | `agents` | 12 | `_onToolActivity` `_activityRestore` `agentsToggle` `setAgentsPanelOpen` `agentsPanelOpen` `_agentsPanelShown` `reorderAgents` `_pruneAgentOrder` `_agentOrderSync` `agentsRender` `_agWindowItems` `_agFolded` |
| DL-6 | `core/agents-sub.js` | App | `agents.sub` | 1 | `_onToolSubagentActivity` |
| DL-6 | `core/attn-controller.js` | App | `attn` | 17 | `attnHas` `_agFocusedTool` `_isToolFocusedActive` `_onToolAttention` `attnUserIsWatching` `_onToolAttentionClear` `_attnRestore` `_attnDrop` `_attnClear` `windowHasAttn` `_attnNoteInteraction` `jumpToTool` `_attnRefresh` `_attnSecurityNotice` `_attnDetail` `_attnBeep` `initAttn` |
| DL-6 | `core/chat-controller.js` | App | `chat` | 6 | `_chatRestore` `_onChatChanged` `_onChatMessage` `chatUnreadTotal` `_chatItems` `_addChatTab` |
| DL-6 | `core/chat-views.js` | App | `chat.views` | 2 | `chatViewEl` `_chatViewsPaint` |
| DL-6 | `core/chat-window.js` | App | `chat.window` | 4 | `chatWindowOpen` `_chatNormalize` `_chatRepaint` `chatPanelRender` |
| DL-6 | `core/claude-accounts-controller.js` | App | `claude` | 7 | `_claudeAcctRestore` `_onClaudeAccountsChanged` `_onClaudeAccountAlert` `_claudeAcctFold` `_claudeAcctSmartMenu` `_claudeAcctHistory` `_claudeAcctEl` |
| DL-6 | `core/claude-maps.js` | App | `claude.maps` | 6 | `claudeTabTint` `claudeOnCwd` `claudeRepoChip` `claudeFolderChip` `claudeTabMenuItem` `claudeFolderMenu` |
| DL-6 | `core/mobile-controller.js` | App | `mobile` | 15 | `applyMobileMode` `_toggleDrawer` `mobileSideSlots` `mobileOnSide` `mobileShowPane` `mobilePaneCount` `initMobile` `initMobileKeybar` `mTopPaint` `_mkbRender` `_scheduleFit` `_scheduleMobileFit` `_mobileVvApply` `_kbSuppressAll` `mkbRefresh` |
| DL-6 | `core/mobile-nav.js` | App | `mobile.nav` | 3 | `actSheetLeave` `mobileActSync` `mobileRepoSegSync` |
| DL-6 | `core/mobile-sheets.js` | App | `mobile.sheets` | 2 | `mobileChromeSync` `_settingsMobileOnOpen` |
| DL-6 | `core/statusbar-controller.js` | App | `statusbar` | 9 | `initStatusBar` `_startStatsPoll` `_pollStats` `updateStatusBar` `_bgPanelPaint` `_bgRow` `_shortCwd` `_fmtMemSize` `updateCwd` |
| DL-7 | `ui/file-tree-download.js` | FileTree | `dl` | 4 | `download` `downloadMany` `_dlOf` `_dragDownloadURL` |
| DL-7 | `ui/file-tree-edit.js` | FileTree | `edits` | 25 | `startCreate` `startRename` `cancelEdit` `_commitEdit` `_askName` `_nameReset` `_showNameWhy` `_snap` `_restore` `_optimAdd` `_optimDel` `_optimMove` `_rekey` `_rekeyView` `_forget` `_forgetView` `doCreate` `doRename` `doDelete` `_recoverable` `_repoRel` `doPasteInto` `doDuplicate` `doMoveMany` `_retargetOrFail` |
| DL-7 | `ui/file-tree-keys.js` | FileTree | `keys` | 1 | `_onKey` |
| DL-7 | `ui/file-tree-load.js` | FileTree | `loader` | 19 | `load` `_loadOnce` `loadIgnored` `_isIgnored` `reload` `refresh` `pollStamp` `pollGit` `paintGitCached` `gitDue` `_applyGit` `_gitBack` `_prefixOf` `_setStatus` `_stKey` `_rollup` `_isPartial` `_stOf` `_inherit` |
| DL-7 | `ui/file-tree-marquee.js` | FileTree | `marquee` | 6 | `_initMarquee` `_mqDown` `_mqY` `_mqMove` `_mqPaint` `_mqScroll` |
| DL-7 | `ui/file-tree-paint.js` | FileTree | `painter` | 13 | `_items` `paint` `_rowId` `_focusInput` `_pad` `_el` `_elInput` `_base` `_parent` `_kindOf` `_targetDir` `_fail` `_clearErr` |
| DL-7 | `ui/file-tree-select.js` | FileTree | `selector` | 14 | `revealPath` `toggle` `_selOnly` `_selToggle` `_selRange` `_selAll` `_selMarquee` `_selHas` `_selTargets` `_selOrdered` `_selectRoot` `_onClick` `_moveSel` `_onDbl` |
| DL-7 | `ui/file-tree-xfer.js` | FileTree | `xfer` | 14 | `doUpload` `_uploadOne` `_askUploadFailure` `pickUpload` `_after` `_onCtx` `copyPath` `_initDnd` `_dropUpload` `_dropDirAt` `_markDrop` `_dropClear` `_springSchedule` `_springCancel` |
| DL-8 | `ui/term-fit.js` | TerminalTool | `sizer` | 7 | `_followsPty` `_applyPtySize` `_onSize` `doFit` `applyFontSize` `ptySize` `_refreshForWidth` |
| DL-8 | `ui/term-held.js` | TerminalTool | `heldBar` | 5 | `_heldMaybeShow` `_heldBanner` `_heldHide` `_heldSend` `_heldDiscard` |
| DL-8 | `ui/term-output.js` | TerminalTool | `output` | 4 | `_handleOutput` `_oscCarryAt` `_doFlush` `_onCwd` |
| DL-8 | `ui/term-transfer.js` | TerminalTool | `xfer` | 4 | `_wireDnd` `_downloadFile` `_uploadFiles` `_fmtSize` |
