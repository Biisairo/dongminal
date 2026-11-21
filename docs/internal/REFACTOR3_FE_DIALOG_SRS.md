# SRS: 리팩토링 3차 P3a 단계 3 — 대화상자 기반 클래스 `Dialog` — IEEE 29148

> **문서 상태**: 승인·구현완료

- 접수: 2026-11-21 (프로덕션 리팩토링 3차 · `docs/internal/refactor/FE_OBJECT_MODEL.md` §2 행 4·§6 단계 3 · `PROD3.md` FC-04·FU-13 일부)
- 사용자 결정(2026-11-21, `FE_OBJECT_MODEL.md` §7): 자체 클래스 계층을 쓴다. 클래스 하나 = 파일 하나. e2e 가 이름으로 쓰는 `GitConfirm`·`GitDialog`·`UIKit` 은 이름을 유지한다. 진행은 묻지 않고 끝까지 한다(인계서 `REFACTOR_PROD3_HANDOFF_2.md`).

## 1. 개요

### 1.1 목적

대화상자는 지금 골격이 세 벌이다.

| 골격 | 자리 | 여는 길 | 닫는 길 | Esc |
|---|---|---|---|---|
| 킷 모달 | `UIKit.modal`(호출 7곳)·`UIKit.ask`(호출 8곳, `modal` 위) | 함수 안의 지역 변수와 클로저 | 지역 `close(v)` | 문서 캡처, 대화상자 스택 맨 위일 때만 |
| Git 모달 | `GitModalBase` → `GitConfirm`·`GitDialog` | `_show()` → 약속 | `_close(v)` | 문서 캡처, **스택을 보지 않는다** |
| 설정 모달 | `app-settings.js` `initModal`(135줄, FC-04) | `#modal-overlay` 에 `open` 클래스 | 지역 `closeSettings()` | 문서 버블, 열림만 본다 |

세 벌 모두 같은 일(접근성 계약 `UIKit.dialogOpen` 걸기·풀기, Esc 를 받으면 맨 위 것만 닫기, 한 번만 닫기, 포커스 되돌리기)을 각자 적었다. 이 문서는 `Dialog` 기반 클래스를 세우고 세 벌을 그 하위로 옮긴다.

### 1.2 범위

| 항목 | 내용 |
|---|---|
| `Dialog` | `ui/dialog.js`. `View` 의 하위. 열기·닫기 수명, 접근성 계약, Esc 판정, 실행 상태기계, 앞으로 가져오기, 복사 |
| Git 모달 | `GitModalBase` 를 `Dialog` 의 하위로 바꾸고 git 고유 칠하기만 남긴다. 파일을 `git/git-modal-base.js`·`git/git-confirm.js`·`git/git-dialog.js` 로 옮긴다(`mv`) |
| 킷 모달 | `UIKit.modal` 의 본문을 `KitModal`(`ui/kit-modal.js`)로 옮긴다. `UIKit.modal`·`UIKit.ask` 는 얇은 입구로 남는다 |
| 설정 모달 | 열기·닫기·탭 고르기·탭 줄 접근성 속성을 `SettingsModal`(`core/settings-modal.js`)로 옮긴다. 열 때·탭을 고를 때 무엇을 다시 읽는지는 App 이 훅으로 준다 |

### 1.3 범위 밖

- Esc 처리기 15파일을 `EscapeStack` 으로 모으는 일(FC-13·14)은 단계 6 이다. 이 문서는 대화상자 세 벌의 Esc 를 `Dialog` 한 규칙으로 모으는 데까지만 한다. 모바일 시트·설정 모바일 상세의 Esc(`app-mobile-sheets.js`)는 건드리지 않는다.
- 설정 섹션·행의 그리기(단계 8), `UIKit` 의 메뉴·끌기·HUD 분할(FU-13 의 나머지).
- `FE_OBJECT_MODEL.md` §2 행 4 가 "손으로 짠 모달" 로 적은 `term-pane.js:600` 과 `app-claude-accounts.js:427` 은 대화상자가 아니다. 앞의 것은 터미널 위에 뜨는 연결 상태 오버레이(`role=status`, 포커스를 가두지 않는다)이고, 뒤의 것은 계정 묶음의 팝오버다. 옮기지 않는다(§6 문서 어긋남).

### 1.4 불변 조건

| ID | 조건 |
|---|---|
| INV-D1 | DOM id·클래스·속성(`#git-confirm`·`.gc-*`·`.git-dialog-*`·`.ui-modal*`·`.confirm-*`·`#modal-overlay`·`.open`·`#modal`·`.mtab`·`.mpanel`·`role`·`aria-*`)은 바뀌지 않는다 |
| INV-D2 | `GitConfirm`·`GitDialog`·`GitModalBase`·`UIKit.modal`·`UIKit.ask`·`UIKit.dialogOpen` 의 이름과 돌려주는 값(`{el, box, body, foot, close, defBtn}`, 약속의 값)은 그대로다 |
| INV-D3 | 사용자에게 보이는 동작(여는 순서, 기본 포커스, 닫는 길 셋, 포커스 복귀, 실행 중 막기, 오류 블록)은 바뀌지 않는다. 예외는 §5 다 |
| INV-D4 | 계층·로드 순서·크기·킷 게이트를 지킨다. 상속 깊이는 `Component` 아래 넷까지다(`Component → View → Dialog → GitModalBase → GitConfirm`) |

## 2. 요구사항

| ID | 요구 |
|---|---|
| FR-FED-1 | `Dialog extends View`(`ui/dialog.js`). 필드 `ov`(오버레이, `el` 과 같다)·`box`·`busy`·`err`. **한 번 여는 동안의 해제**를 따로 쌓는다(`_attach`/`_detach`) — 설정 모달처럼 여러 번 여는 인스턴스가 있기 때문이다 |
| FR-FED-2 | `_attach(spec)`: `UIKit.dialogOpen(this.box, spec)` 을 걸고, 문서 `keydown` 수신기를 단다. 수신기는 `isTop()` 이 거짓이면 아무것도 하지 않는다. 단계는 `_escCapture`(기본 참 = 캡처, 거짓 = 버블)가 정한다. `_detach()` 는 이번 열기에 쌓은 것을 거꾸로 푼다. 두 번 불러도 안전하다 |
| FR-FED-3 | `isTop()`: 대화상자 스택(`UIKit._dlgStack`)이 비었거나 맨 위가 자기 `box` 이면 참이다 |
| FR-FED-4 | `_onKey(e)` 의 기본은 Esc 를 받으면 `preventDefault`·`stopPropagation` 하고 `_dismiss()` 를 부르는 것이다. 하위는 `_onKey` 를 덮어쓴다(`GitDialog` 의 Enter) |
| FR-FED-5 | 한 번 쓰고 버리는 대화상자의 길: `_show()` 는 **지금 포커스를 먼저 잡고**(FR-KIT-24) `_build()` → `_beforePaint()` → `_paint()` → `_focus()` → `_attach({labelledBy: 머리, label: title, returnTo, focus: 지금 포커스})` 순으로 부르고 약속을 돌려준다. `_close(v)` 는 한 번만 돈다 — `_detach()`, 오버레이 떼기, `dispose()`, 약속을 `_result(v)` 로 푼다 |
| FR-FED-6 | `_exec(fn)`(실행 상태기계), `_front()`(맨 위로 올리고 포커스), `_copy(text)`(`ClipboardWriter`)를 `GitModalBase` 에서 `Dialog` 로 옮긴다. 계약은 그대로다 |
| FR-FED-7 | `GitModalBase extends Dialog`(`git/git-modal-base.js`)는 `_el(part)`·`_paintChanged`·`_paintErr`·`_paintActions` 만 갖는다(git 문자열 `GIT_CONFIRM_*` 을 쓰는 것). `GitConfirm`·`GitDialog` 는 `_listenKeys` 대신 `_onKey` 를 덮어쓴다. 한 번에 하나 규약(`_cur`)은 그대로다 |
| FR-FED-8 | `KitModal extends Dialog`(`ui/kit-modal.js`): `new KitModal(spec).open()` 이 지금 `UIKit.modal(spec)` 의 일 전부를 하고 같은 모양의 값을 돌려준다. 바깥 `mousedown`·닫기 단추·Esc 가 같은 `close` 로 가고, `close(v)` 는 한 번만 `onClose(v)` 를 부른다. 액션 줄의 `roving` 해제는 인스턴스 수명에 쌓는다. `UIKit.modal` 은 `KitModal` 에 맡기는 한 줄이 된다. `UIKit.ask` 는 그대로 `this.modal` 위에 선다 |
| FR-FED-9 | `SettingsModal extends Dialog`(`core/settings-modal.js`): `index.html` 의 `#modal-overlay`·`#modal` 을 `adopt` 한다. `init()` 은 탭 줄 접근성 속성(tablist·tab·tabpanel·`aria-controls`·`aria-labelledby`)을 세우고, 설정 단추·닫기 단추·바깥 클릭·탭 클릭을 잇는다. `open()` 은 `open` 클래스를 더하고 `_attach({labelledBy:'.modal-title', returnTo: #settings-btn})`, 본문 흐림 관측(`UIKit.fadeWatch`)을 이번 열기에 쌓고, 훅 `onOpen()` 을 부른다. `close()` 는 열려 있을 때만 `open` 을 빼고 `_detach()` 한다. `isOpen()` 은 DOM 의 `open` 클래스를 읽는다. `select(tab)` 은 모든 탭의 `active`·`aria-selected`·패널 `hidden` 을 함께 고치고 훅 `onTab(name)` 을 부른다. Esc 는 **버블**이다(`_escCapture=false`) — 모바일 상세의 캡처 Esc(FR-MUX-23)가 먼저 돌아야 한다 |
| FR-FED-10 | `App.initModal` 은 `SettingsModal` 을 만들어 `_settingsModal` 에 두고 훅 둘(열 때 다시 칠하기, 탭별 다시 읽기)을 준다. 만드는 시점은 지금 리스너를 걸던 시점과 같다 — `_initSettingsMobile` 의 리스너가 그 뒤에 붙어 뒤에 돈다는 순서가 그대로다 |
| FR-FED-11 | `index.html` 은 `ui/dialog.js` → `ui/kit-modal.js` 를 `ui/ui-kit.js` 뒤, `ui/panel.js` 앞에 싣는다. `core/settings-modal.js` 는 `core/app-settings.js` 앞에 싣는다. git 모달 세 파일은 새 이름으로 지금 자리에 싣는다. `harness.mjs` 에 `DIALOG` 묶음(`ui/dialog.js`·`ui/kit-modal.js`)을 둔다 |

## 3. 결정

| ID | 결정 | 이유 |
|---|---|---|
| D-FED-1 | `GitModalBase` 를 지우지 않고 `Dialog` 와 git 하위 사이의 얇은 층으로 남긴다 | git 문자열을 쓰는 칠하기 셋은 git 만의 것이다. 기존 단위 시험이 이 이름을 본다. 깊이는 넷으로 한계 안이다 |
| D-FED-2 | 킷 모달은 `KitModal` 이라는 새 클래스로 둔다. `FE_OBJECT_MODEL` 의 `ConfirmDialog`·`FormDialog` 라는 이름은 쓰지 않는다 | 그 둘은 `GitConfirm`·`GitDialog` 의 다른 이름이었고, 사용자 결정 3 이 이름 유지를 정했다 |
| D-FED-3 | 한 번 여는 동안의 해제(`_attach`/`_detach`)와 인스턴스 수명(`dispose`)을 나눈다 | 설정 모달은 한 인스턴스를 여러 번 연다. `dispose` 는 되돌릴 수 없다 |
| D-FED-4 | 설정 모달은 무엇을 다시 칠하고 읽을지 모른다. App 이 훅으로 준다 | `core/` 의 화면 부품이 App 내부 이름을 줄줄이 부르면 단계 9 에서 다시 끊어야 한다 |
| D-FED-5 | 설정 모달의 Esc 는 버블로 남긴다 | 모바일 상세 화면의 Esc 는 문서 캡처에서 먼저 목록으로 물러서고 전파를 끊는다. 캡처로 옮기면 등록 순서상 설정 닫기가 먼저 돈다 |

## 4. 검증

| ID | 시험 |
|---|---|
| TC-FED-1 | 단위: `Dialog._show` 의 순서 — 포커스를 잡은 뒤 `_build`, 그다음 `_beforePaint`·`_paint`·`_focus`·`dialogOpen`. 약속은 `_close(v)` 의 `_result(v)` 로 풀린다 |
| TC-FED-2 | 단위: `_close` 는 한 번만 돈다 — 두 번째는 `dialogOpen` 해제·약속 풀기를 다시 하지 않는다. 닫으면 키 수신기가 사라진다 |
| TC-FED-3 | 단위: 키 수신기는 자기가 스택 맨 위일 때만 `_onKey` 를 부른다(스택이 비었으면 부른다) |
| TC-FED-4 | 단위: `GitConfirm`·`GitDialog` 의 원형 사슬에 `GitModalBase`·`Dialog`·`View`·`Component` 가 있다. `GitModalBase` 는 `_show`·`_close`·`_exec`·`_front`·`_copy` 를 따로 갖지 않는다. 기존 `git-modal-base.test.mjs` 의 상태기계 시험이 그대로 통과한다 |
| TC-FED-5 | 단위: `UIKit.modal` 이 `KitModal` 을 거친다 — 값의 모양이 같고, 닫는 길 셋이 `onClose` 를 한 번만 부른다. 기존 `modal-unify.test.mjs` 가 그대로 통과한다 |
| TC-FED-6 | 단위: `SettingsModal` — `open` 이 클래스·`dialogOpen`(제목·설정 단추)·`onOpen` 을, `close` 가 해제 둘(대화상자·흐림 관측)을 한다. 열리지 않았을 때 `close` 는 아무것도 하지 않는다. `select` 가 모든 탭의 `active`·`aria-selected` 와 패널 `hidden` 을 같이 고치고 `onTab` 을 부른다. Esc 수신기는 버블이다 |
| TC-FED-7 | 정적: `app-settings.js` 에 `UIKit.dialogOpen(` 과 `classList.remove('open')` 이 없다. `git/git-modal-base.js` 에 `removeEventListener('keydown'` 이 없다 |
| TC-FED-8 | e2e(기존): git 확인창·대화상자·설정·모달 접근성·모바일 설정 spec 이 모양을 바꾸지 않고 통과한다 |

새 시험은 고치기 전 코드에서 실패한다(새 클래스가 없어 실패하는 것 포함). 그 밖에 `make gates` · `npm run -s unit` · `npm run -s typecheck`. e2e 전량은 모든 묶음이 끝난 뒤에 돌린다.

## 5. 동작 변경 기록

| 이전 | 새 | 이유 |
|---|---|---|
| `GitConfirm`·`GitDialog` 의 키 수신기는 대화상자 스택을 보지 않았다. 그 위에 킷 모달이 떠 있을 때 Esc 를 누르면, 먼저 달린 git 수신기가 같은 노드에서 먼저 돌아 git 창까지 닫혔다(`stopPropagation` 은 같은 노드의 수신기를 막지 못한다) | 맨 위 대화상자만 키를 받는다 | 킷 모달끼리는 이미 이 규칙이었다(FR-OPT-16-4). 세 골격이 한 규칙을 쓴다 |
| 설정 모달의 Esc 는 열려 있으면 언제나 닫았다 | 설정 모달이 스택 맨 위일 때만 닫는다 | 같은 규칙. 지금 설정 위에 뜨는 킷 모달은 캡처에서 전파를 끊으므로 보이는 차이는 없다 |
| 설정이 열린 채 `#settings-btn` 을 다시 누르면(코드의 `_openSettings`) 접근성 계약을 한 번 더 걸었다 — 대화상자 스택에 같은 상자가 둘 쌓이고, 앞의 해제 함수를 잃어 닫아도 하나가 남았다. 흐림 관측도 하나 더 걸렸다 | 이미 열려 있으면 `open()` 은 아무것도 하지 않는다(다시 칠하기도 하지 않는다). 탭 고르기는 그대로 돈다 | 열기·닫기를 한 자리(`SettingsModal`)에서 하며 드러났다. 사람이 누르는 길은 오버레이가 덮어 닿지 않는다 |
| 설정 모달의 Esc 수신기는 늘 달려 있고 열림을 보았다 | 열 때 달고 닫을 때 뗀다 | `Dialog` 의 한 번 여는 동안의 수명(D-FED-3) |

## 6. 문서 어긋남 (P7 에서 코드 기준으로 고친다)

- `FE_OBJECT_MODEL.md` §2 행 4 의 "손으로 짠 것(`term-pane.js:600`·`app-claude-accounts.js:427`)" — 둘 다 대화상자가 아니다(§1.3).

## 7. 구현 기록

| 커밋 | 요점 |
|---|---|
| (이 커밋) | `ui/dialog.js` `Dialog` · `ui/kit-modal.js` `KitModal`(`UIKit.modal` 은 한 줄 입구, `ui-kit.js` 934 → 817줄) · `git/git-modal-base.js`(칠하기 셋만) · `git/git-confirm.js`·`git/git-dialog.js`(`mv`, 키는 `_dismiss`·`_onKey`) · `core/settings-modal.js` `SettingsModal`(`initModal` 의 열기·닫기·탭 고르기·tablist 속성, `app-settings.js` 500 → 445줄). App 훅은 `_settingsOnOpen`·`_settingsOnTab`. **SRS 와 다른 점:** ① `Dialog` 의 이름 훅은 `_nameEl()` 이다 — `GitDialog` 에 이미 `_labelEl(text)` 가 있다 ② 설정 모달의 Esc 는 `preventDefault` 만 하고 전파는 끊지 않는다(종전과 같다) ③ 닫을 때 푸는 순서는 거꾸로다(흐림 관측 → 대화상자) — 둘은 서로 기대지 않는다 |
