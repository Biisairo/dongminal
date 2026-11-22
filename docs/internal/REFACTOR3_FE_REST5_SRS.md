# SRS: 리팩토링 3차 PROD3 FE 나머지 R5 — 남은 큰 함수·큰 파일·FileTree 부품화 — IEEE 29148

> **문서 상태**: 승인·구현중
> **남은 것**: R5c(500줄 넘는 JS 파일) · R5d(FileTree 부품화, `FileTree` constructor 104줄 포함). R5a(CSS)·R5b(함수)는 닫혔다.

- 접수: 2026-11-22 (프로덕션 리팩토링 3차의 남은 부채 · `REFACTOR3_FE_REST3_SRS` §6 「남긴 것」 · `FE_MODULE_BOUNDARY_SRS` §7.1a 기준선 · `architecture.md` 「FileTree 는 아직 원형 확장이다」)
- 사용자 결정: "알아서 끝까지", 하위 묶음 하나가 끝나면 커밋한다. 동작을 바꿔야만 나눌 수 있거나 범위를 줄여야 하면 멈추고 묻는다. 코드와 설계 문서로 답이 나오는 갈림길은 권장안으로 정하고 §3 에 이유를 적는다.
- 실측 기준: HEAD `90ee3429`. 아래 `파일:줄` 은 그 커밋의 것이다. 함수 길이는 acorn 으로 잰 줄 수(주석·빈 줄 포함)다.
- e2e: 이 묶음을 만든 작업 트리에서는 e2e 를 돌리지 않는다(다른 세션이 같은 기계에서 e2e 를 돌린다 — 포트·부하 충돌). **e2e 는 합친 뒤 주 세션이 돌린다.** 돌릴 spec 목록은 §6 에 영역별로 적는다.

## 1. 개요

### 1.1 목적

동작을 바꾸지 않고 남은 큰 단위를 나눈다. 규약은 앞 묶음과 같다 — 위험한 곳은 먼저 지금 동작을 고정하는 단위 시험을 GREEN 으로 커밋하고 나눈다. 순수 판정은 함수로 빼서 시험한다. 나눈 함수는 `test/method-size.test.mjs` 의 상한 목록에 넣는다. 클래스 하나 = 파일 하나(`refactor/FE_OBJECT_MODEL.md`).

| 묶음 | 대상 | 지금 (HEAD `90ee3429`) | 목표 |
|---|---|---|---|
| R5a | CSS 500줄 초과 넷 | `style-git-views.css` 824 · `style-git.css` 679 · `style-editor.css` 575 · `style-kit.css` 565 | 원래 순서의 연속 구간 둘씩. CSS 500줄 초과 0 |
| R5b | 100줄 넘는 함수 | `ui/diag.js:25` 익명 338 · `ui/version-watch.js:30` 익명 126 · `ui/cm-sticky.js:41` `edCmStickyPlugin` 119 · `ui/cm-scrollbar.js:77` `edCmScrollbarPlugin` 118 · `ui/renderer-pane-wire.js:12` `_makeTab` 109 · `ui/cm-lsp.js:205` `edLspWorkspaceClass` 108 · `ui/file-tree.js:35` constructor 104 · `core/settings-theme.js:174` `_renderThemePanel` 100 | 100줄 넘는 함수 0 |
| R5c | 500줄 넘는 JS 파일 | `core/constants.js` 917 · `ui/file-editor.js` 818 · `core/app.js` 802 · `ui/term-pane.js` 776 · `git/git-poll.js` 718 · `ui/doc-render.js` 693 · `git/diff-view.js` 655 · `core/constants-editor.js` 633 · `ui/file-editor-diff.js` 606 · `ui/ui-kit.js` 582 | 500줄 아래. 못 줄이면 이유를 §6 에 |
| R5d | FileTree | `class FileTree`(`ui/file-tree.js` 285) + 원형 확장 여섯(`file-tree-{paint,edit,xfer,keys,marquee,download}.js`, `paint` 971) | 부품 클래스(GitPanel 단계 7 과 같은 꼴). `Object.assign(FileTree.prototype` 0 |

### 1.2 정의

| 말 | 뜻 |
|---|---|
| 조각 | 한 파일을 원래 순서의 연속 구간으로 자른 것. 조각 둘째부터는 첫 줄에 한 줄 머리 주석을 단다 |
| 부품 | 주인 클래스(`FileTree`·`FileEditor`·`TerminalTool` 등)가 생성자에서 만들어 드는 클래스. 주인을 필드로 든다(`this.t`·`this.ed`·`this.term` 등) |
| 위임자 | 주인 원형에 남는 한 줄 메서드. 같은 인자로 부품의 같은 이름을 부른다. 바깥·시험·e2e 가 부르는 이름만 남긴다 |
| 순수 판정 | DOM·앱 상태를 만지지 않고 입력만으로 답을 내는 함수 |

### 1.3 범위 밖

- 위임자 제거(부르는 쪽을 부품 경로로 옮기기). 다음 리팩토링이다(HANDOFF_4 §4).
- 동작·화면·요청·저장 값의 변경. 바꿔야만 나눌 수 있으면 멈추고 묻는다.
- `e2e/` 파일. 이 묶음은 e2e 를 고치지 않는다 — e2e 가 이름으로 읽는 것(메서드·필드·CSS 파일명)은 그대로 둔다.

### 1.4 불변 조건

| ID | 조건 |
|---|---|
| INV-R5-1 | 요청·저장 값·DOM·계산된 스타일이 그대로다. 메서드를 부르는 순서와 횟수가 그대로다 |
| INV-R5-2 | 시험·e2e 가 인스턴스에 갈아 끼우는 이름(HANDOFF_4 §4)은 부품 안에서도 주인 경로(`this.app.X()`·`this.t.X()`)로 부른다. 갈아 끼운 것을 부품도 본다 |
| INV-R5-3 | 바깥·시험·e2e 가 주인에서 읽는 이름(메서드·필드·접근자)은 주인에서 그대로 읽히고 불린다 |
| INV-R5-4 | `app.js` 에 위임자를 더하지 않는다. App 위임은 컨트롤러 파일 끝의 `Controller.delegate` 표로 한다(HANDOFF_4 §4) |
| INV-R5-5 | 기반 클래스(`Component`·`View`·`Dialog`·`ListView`)의 이름과 부딪치지 않는다(HANDOFF_3 §4). 이름을 바꾸면 그 이름을 읽는 공용 함수를 먼저 센다 |
| INV-R5-6 | 게이트 — 계층·로드 순서(`index.html`)·크기(`check-file-size` 기준선)·킷·i18n·다시 그리기 등록부(`PERFORMANCE_BUDGET.md` §2-5)·eslint 0 — 를 지킨다. 파일을 옮기거나 나누면 등록부·파일명을 읽는 단위 시험·하네스 묶음을 함께 고친다 |

## 2. 요구사항

### 2.1 R5a — CSS

| ID | 요구 |
|---|---|
| FR-FR5-1 | 500줄 넘는 CSS 넷을 원래 순서의 연속 구간 둘로 자른다: `style-kit.css` → `+ style-kit-controls.css`(스위치부터) · `style-git.css` → `+ style-git-commit.css`(커밋 영역) · `style-git-views.css` → `+ style-git-tabs.css`(Git 사이드바부터) · `style-editor.css` → `+ style-editor-tools.css`(찾기 패널부터). 둘째 조각은 첫 조각 바로 뒤에 `<link>` 로 싣는다. 둘째 조각의 첫 줄을 빼고 이어 붙이면 원본과 바이트까지 같다(첫 조각의 머리 주석 목록만 고친다) |
| FR-FR5-2 | 킷 파일을 이름으로 읽는 게이트·시험(`check-kit-components.mjs`·`kit-key`·`scrollbar-kit`·`literal-sweep`·`ux-scale`·`css-structure`)은 킷 두 조각을 함께 킷으로 본다. `check-spacing.mjs` 예외 표의 파일명은 규칙이 간 조각을 가리킨다. CSS 기준선을 `CSS 500줄초과=0 · 최대=M` 으로 갱신한다 |

### 2.2 R5b — 100줄 넘는 함수

| ID | 요구 |
|---|---|
| FR-FR5-10 | `ui/version-watch.js` 의 즉시 실행 함수를 클래스 `VersionWatch`(정적 `start()`)로 바꾼다. 판정(`saw`)·되풀이 막기(`tried`)·다시 열기(`reload`)·dirty 물러서기(`showHeldBanner`)·보조 계기(`check`)가 메서드가 된다. 바깥 표면(`window.__dmAssetVersion(next, live)`·`verReloadTried` 세션 키·`#ver-held` 배너·`__dmReloading`)은 그대로다. 판이 없으면 아무것도 걸지 않는다 |
| FR-FR5-11 | `cm-sticky.js`·`cm-scrollbar.js`·`cm-lsp.js` 의 팩토리 안에 이름 없이 적힌 클래스를 파일 최상위의 이름 있는 클래스로 올린다. 팩토리는 그 클래스를 `CM.ViewPlugin.fromClass` 등에 넘기는 몇 줄이 된다. 클래스 본문은 `CM` 을 메서드 안에서만 읽으므로 로드 시점에 `CM` 이 없어도 된다 |
| FR-FR5-12 | `_makeTab` 은 탭 요소 만들기와 수신기 배선을 이름 있는 단계로 나눈다(클릭·메뉴·더블클릭·끌기). 수신기를 거는 순서와 핸들러 본문은 그대로다 |
| FR-FR5-13 | `_renderThemePanel` 은 추종 스위치 배선 · 목록 골격(roving) · 그룹 하나 그리기 · 항목 하나 만들기로 나눈다. DOM 순서·속성·클릭 동작은 그대로다 |
| FR-FR5-14 | `ui/diag.js` 의 즉시 실행 함수를 클래스 `DiagOverlay` 로 바꾼다. `?diag=1` 이 아니면 아무것도 하지 않는다. 오버레이 DOM·기록 형식·전송 경로는 그대로다 |
| FR-FR5-15 | `FileTree` constructor 는 R5d 에서 부품을 세우는 생성자로 다시 쓰며 함께 100줄 아래가 된다(D-FR5-3) |
| FR-FR5-16 | 위 함수는 100줄 이하이고, 나눈 함수 가운데 코드가 큰 것은 `method-size.test.mjs` 의 상한(코드 50줄) 목록에 든다 |

### 2.3 R5c — 500줄 넘는 JS 파일

| ID | 요구 |
|---|---|
| FR-FR5-20 | `core/constants.js`·`core/constants-editor.js` 를 주제별 상수 파일로 나눈다. 새 파일은 원래 파일 바로 뒤에 원래 순서대로 싣는다. 값·이름은 그대로다. 단위 시험은 하네스의 묶음 상수(`CONSTANTS` 등)로 함께 싣는다. 상수 파일을 이름으로 읽는 게이트(`check-shared-constants`·`check-preinject.mjs`·`check-activity-vocab.sh`)는 값이 간 파일을 읽는다 |
| FR-FR5-21 | 클래스 파일(`file-editor.js`·`term-pane.js`·`git-poll.js`·`diff-view.js`·`doc-render.js`·`ui-kit.js`)은 주제 하나를 부품 클래스(파일 하나)나 순수 함수 파일로 뺀다. 부품은 주인을 필드로 들고, 주인 표면은 주인 경로로 부른다(INV-R5-2). 주인에 남는 위임자는 바깥·시험·e2e 가 부르는 이름뿐이다 |
| FR-FR5-22 | `core/app.js` 의 저장 기계(`save`·`_savePut`·`_saveAdoptRemote`·`_adoptRemote`·`_saveBackoff`·`_saveFlushDeferred` 와 순수 판정 `wsSaveBody`·`wsSaveSame`·`wsGitAdopt`·`wsSaveHoldMs`)를 컨트롤러로 옮긴다. 저장이 함께 쓰는 필드(`wsETag`·`_saveInflight` 등)는 App 에 남는다. 위임은 컨트롤러 파일 끝의 `Controller.delegate` 표다(INV-R5-4) |
| FR-FR5-23 | `ui/file-editor-diff.js` 의 `Object.assign(FileEditor.prototype, …)`(변경 표시 메뉴 `_dd*`)를 부품 클래스로 옮긴다 |
| FR-FR5-24 | 새 파일은 `index.html` 의 알맞은 자리에 싣고(`check-load-order`), 하네스 묶음·`PERFORMANCE_BUDGET.md` §2-5 등록부·파일명을 읽는 단위 시험을 고친다. JS 기준선(`500줄초과=N · 최대=M`)을 갱신한다 |

### 2.4 R5d — FileTree

| ID | 요구 |
|---|---|
| FR-FR5-30 | 나누기 전에 FileTree 의 바깥 표면(생성자 인자·`mount`·`destroy`·`refresh`·바깥과 e2e 가 부르는 메서드와 필드)과 주제별 대표 동작을 고정하는 단위 시험을 GREEN 으로 커밋한다 |
| FR-FR5-31 | 원형 확장 여섯을 부품 클래스로 옮긴다. 부품은 `FileTree` 를 필드로 든다. 혼자 쓰는 필드는 부품이 소유하고, 공용 상태와 다른 부품의 메서드는 주인 경로로 부른다 |
| FR-FR5-32 | 바깥·시험·e2e 가 부르는 이름은 `FileTree` 에 위임자로 남는다(클래스 본문). `static`(`FileTree._asUploadItems` 등)은 그대로 클래스에서 읽힌다 |
| FR-FR5-33 | 끝에서 `Object.assign(FileTree.prototype` 이 저장소에 없다. 모든 FileTree 파일이 500줄 아래다. `architecture.md` 의 FileTree 서술을 고친다 |

## 3. 결정

| ID | 결정 | 이유 |
|---|---|---|
| D-FR5-1 | (R5a) CSS 는 규칙을 옮기지 않고 자르기만 한다. 자를 곳은 절 머리 주석(`/* ── … ── */`) 앞이다 | 캐스케이드는 순서가 곧 의미다. 연속 구간을 바로 이어 실으면 규칙의 순서가 바뀌지 않아 계산된 스타일이 그대로다(R4a D-FR4-12 와 같은 판단). 바이트 비교로 확인할 수 있다 |
| D-FR5-2 | (R5a) 킷은 두 조각이 함께 "킷 파일" 이다. 시험·게이트는 목록(`KIT_FILES`)으로 본다 | "킷 밖에서 킷 값을 다시 적지 않는다" 는 규칙의 킷은 한 겹이다. 파일 이름 하나로 비교하면 둘째 조각이 "킷 밖" 이 된다 |
| D-FR5-3 | (R5b) `FileTree` constructor 는 R5d 에서 다룬다 | R5d 가 생성자를 부품 조립으로 다시 쓴다. 먼저 나누면 같은 자리를 두 번 고친다 |
| D-FR5-4 | (R5b) 팩토리 안의 이름 없는 클래스는 최상위로 올린다. 단 `EdLspWorkspace` 는 `extends CM.Workspace` 라 로드 때 정의할 수 없어 팩토리에 남기고, 부모가 없는 `EdLspFile` 만 올린다(팩토리 108 → 94줄) | 팩토리는 CM 이 늦게 실리기 때문에 있고, 클래스 본문은 메서드 안에서만 `CM` 을 읽는다. 클래스 정의는 로드 시점에 `CM` 이 필요 없다 — `extends` 절만 예외다 |
| D-FR5-5 | (R5b) `check-i18n.mjs` 의 진단 오버레이 예외(`put` 호출의 인자)는 `this.put` 도 받는다 | 예외의 뜻은 "진단 로그 줄은 개발자 출력이다" 이고 호출 꼴이 아니다. `DiagOverlay` 가 되며 `put` 이 메서드가 됐다 |
| D-FR5-7 | (R5c) e2e 가 파일을 홀로 싣는 하네스(`event-timer-hub-contract` 의 `git-part.js`+`git-poll.js`, `reconnect-storm` 의 `term-pane.js`·`term-input.js`·`ui-kit.js` 등)가 지나는 경로는 그 파일 안에 남긴다. `git-poll.js` 에서는 관측 한 번의 받아들이기(`_applyStatus` → `_applyNetFail`·`_applyError`·`_adoptObs`·`_paintObs`·`_fail`)를 옮기지 않고, 하네스가 부르지 않는 새로고침·뷰 다시 받기와 워치독을 옮긴다 | 이 작업 트리는 `e2e/` 를 고치지 않는다. 하네스가 싣지 않는 파일의 클래스를 그 경로가 부르면 하네스가 `ReferenceError` 로 깨진다. 처음에는 받아들이기를 `GitStatusApply` 로 옮겼다가, 하네스가 `_fail()` 경로로 백오프를 재는 것(T-5·T-7)을 보고 되돌렸다 |
| D-FR5-6 | (R5b) 100줄 상한은 새 단위 시험 `fn-size.test.mjs` 가 모든 함수(주석 포함 줄 수)에 건다. 아직 남은 것은 시험 안의 남김 목록에 이유와 함께 둔다 | `method-size.test.mjs` 는 이름으로 찾은 함수의 코드 줄만 잰다. 즉시 실행 함수·팩토리처럼 이름이 없는 자리는 거기 들 수 없어 다시 불어도 보이지 않는다 |

## 4. 검증

| ID | 시험 |
|---|---|
| TC-FR5-1 | 단위(`css-structure.test.mjs`): 나눈 CSS 조각 넷이 `<link>` 에서 바로 이어 실리고 각각 500줄 이하다. 기존 순서 시험(FEU-24·TC-FR4-7)이 조각 이름으로 지난다. 나눌 때 바이트 비교(FR-FR5-1)를 했다 |
| TC-FR5-2 | 게이트: `check-file-size` CSS 기준선 `500줄초과=0` |
| TC-FR5-10 | 단위(`version-watch.test.mjs`, 나누기 전에 GREEN): 같은 판이면 아무것도 하지 않는다 · 다른 판이면 세션 키를 적은 뒤 다시 연다 · 같은 쌍으로 이미 시도했으면 열지 않는다 · dirty 면 배너만 한 번 · 살아 있는 인사가 있으면 탭 복귀에 묻지 않는다 · 인사가 없으면 `/` 를 받아 판을 읽는다 |
| TC-FR5-11 | 단위: R5b 의 함수가 100줄 이하다(acorn). `method-size.test.mjs` 상한 |
| TC-FR5-20 | 단위: 상수 파일을 나눈 뒤 기존 시험 전부가 지난다. 나누기 전과 후의 전역 상수 이름·값 집합이 같다 |
| TC-FR5-21 | 단위: 부품마다 기존 시험이 지난다. 새 순수 함수에는 시험이 있다 |
| TC-FR5-30 | 단위(`file-tree-surface.test.mjs`, 나누기 전에 GREEN): FR-FR5-30 의 표면·대표 동작 |
| TC-FR5-31 | 게이트·단위: `make gates` · `npm run -s unit` · `npm run -s typecheck` · eslint 0 |
| TC-FR5-40 | e2e(합친 뒤 주 세션): §6 의 영역별 spec 이 HEAD 와 같은 결과다 |

## 5. 동작 변경 기록

없다. 자리와 이름만 바꾼다(INV-R5-1).

## 6. 구현 기록

| 커밋 | 요점 |
|---|---|
| `6e0b371c` | 이 SRS |
| (R5a 커밋) | FR-FR5-1·2 — CSS 넷을 연속 구간 둘씩으로: `style-kit.css` 565 → 301 + `style-kit-controls.css` 265 · `style-git.css` 679 → 274 + `style-git-commit.css` 406 · `style-git-views.css` 824 → 392 + `style-git-tabs.css` 433 · `style-editor.css` 575 → 240 + `style-editor-tools.css` 336. 둘째 조각의 첫 줄을 빼고 이어 붙이면 원본과 바이트까지 같다(첫 조각의 머리 주석 목록만 고쳤다). CSS 기준선 `500줄초과=4 · 최대=824` → `0 · 433`. 킷을 이름으로 읽는 게이트 하나·시험 다섯이 `KIT_FILES` 둘을 본다. `check-spacing.mjs` 예외 셋의 파일명 → `style-git-tabs.css`. 시험 TC-FR5-1 |
| `11894bfb` | R5b 시험 고정 — `version-watch.test.mjs` TC-FR5-10(10건). 나누기 전 코드에서 GREEN |
| (R5b 커밋) | FR-FR5-10~16 — `VersionWatch`(익명 126 → `start` 9 · 가장 긴 메서드 `saw` 18줄) · `DiagOverlay`(익명 338 → 가장 긴 메서드 `_hookEvents` 52줄, 상수 `MAX`·`HOOK_RETRY_MS`·`ENV_DELAY_MS`·`YDISP_POLL_MS` 는 클래스 정적 값) · `EdCmSticky`·`EdCmScrollbar`(팩토리 119·118 → 9) · `EdLspFile` 을 최상위로(`edLspWorkspaceClass` 108 → 94, D-FR5-4) · `_makeTab` 109 → 19(`_tabWirePointer`·`_tabWireDrag`·`_tabDrop`) · `_renderThemePanel` 100 → 19(`_themeFollowRow`·`_themeListPrep`·`_themeGroup`·`_themeItem`). 새 시험 `fn-size.test.mjs`(TC-FR5-11, D-FR5-6) · `method-size.test.mjs` 일곱 더함. 게이트 `check-i18n.mjs` 의 진단 예외(D-FR5-5). 이 판에서 100줄 넘는 함수는 `FileTree` constructor 하나(R5d)다 |
| (R5c-1 커밋) | FR-FR5-20 — 상수 파일. `constants.js` 917 → 455: 절째로 `constants-term.js`(264, 모바일 키바·터치 · 터미널 WS·보류·키 · 스크롤백·`TOPTS`·종료·검색 · 보고 정규식 · 파일 전송·알림 · 복사) · `constants-sandbox.js`(58) · `constants-tips.js`(94) · `constants-file.js`(75). `constants-editor.js` 633 → 285 + `constants-explorer.js`(353, 탐색기 절부터 끝까지). 넷은 `constants.js` 바로 뒤, 하나는 `constants-editor.js` 바로 뒤에 싣는다. 나누기 전과 후의 최상위 선언(이름 = 값 원문) 집합이 같다(TC-FR5-20, 371·전부). 하네스 묶음 `CONSTANTS` · 시험 27개가 그것을 싣고, 파일을 이름으로 읽는 시험 셋(`work-dot`·`server-meta` TC-FR2-2·`icon-glyph` TC-UXF-99)이 새 파일을 읽는다. JS 기준선 `500줄초과=11` → `9` |
| (R5c-2 커밋) | FR-FR5-21 — `doc-render.js` 693 → 463: 클래스 앞의 순수 함수 열넷과 모듈 변수 둘을 `ui/doc-render-util.js`(235)로(앞뒤 최상위 선언 집합이 같다). `diff-view.js` 655 → 492: 그림 보기 다섯(`_blobURL`·`_drawImage`·`_imgBar`·`_imgPane`·`_addImageToggle`)을 부품 `GitDiffImage`(`git/diff-image.js` 111, `this.image` — `blobURL`·`draw`·`bar`·`pane`·`addToggle`)로. 보기 방식 `_imgMode`·그릴 자리·안내는 뷰의 것이라 부품이 `this.v` 로 읽는다. 머리의 순수 함수 넷(`gitShQuote`·`gitFmtBytes`·`gitBlobMeta`·`gitBlobMetaLines`)은 여러 뷰가 부르므로 `git/view-util.js` 로. `git-poll.js` 718 → 480: 새로고침·뷰 다시 받기·refs 회차를 부품 `GitViewReload`(`git-view-reload.js` 150, `_refsRound` 소유)로, 워치독을 부품 `GitWatchdog`(`git-watchdog.js` 102, `run()`)으로. 패널 위임자 여섯이 새 부품을 가리킨다. `git-views.js` 의 `refsRound()` 경로. 하네스 `GITPANEL` · `git-panel-parts` PARTS 두 줄(D-FR5-7). JS 기준선 `9` → `6` |
