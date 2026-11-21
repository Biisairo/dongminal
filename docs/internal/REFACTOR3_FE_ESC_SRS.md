# SRS: 리팩토링 3차 P3a 단계 6 — `Menu` 와 `EscapeStack` 으로 Esc 한 자리 — IEEE 29148

> **문서 상태**: 승인·구현완료

- 접수: 2026-11-21 (프로덕션 리팩토링 3차 · `docs/internal/refactor/FE_OBJECT_MODEL.md` §2 행 5·11·§6 단계 6 · `refactor/PROD3.md` FC-13·14)
- 사용자 결정(2026-11-21, `FE_OBJECT_MODEL.md` §7): 자체 클래스 계층, 클래스 하나 = 파일 하나. 진행은 묻지 않고 끝까지 한다. 코드와 설계 문서로 답이 나오는 갈림길은 권장안으로 정하고 §3 에 이유를 적는다.

## 1. 개요

### 1.1 목적

"Esc 를 누르면 맨 위에 떠 있는 것 하나만 닫힌다" 는 규칙이 여러 처리기에 흩어져 있고, 처리기 사이의 순서는 **리스너를 붙인 순서와 단계(캡처·버블)** 에 기댄다. 그 순서는 주석으로만 적혀 있다(FC-14).

| 처리기 | 자리 | 단계 | 지금 하는 일 |
|---|---|---|---|
| 대화상자 | `ui/dialog.js` `Dialog._attach`·`_onKey` | 캡처(설정 모달만 버블, D-FED-5) | 대화상자 스택 맨 위(`isTop`)일 때 닫는다 |
| 메뉴 | `ui/ui-kit.js` `UIKit.menu` 의 `_menuOff` | 캡처 | Esc·화살표·Enter·바깥 누름 |
| 모바일 시트 | `core/app-mobile-sheets.js` `_initSheetEscape` | 버블 | 모바일이고 설정이 닫혀 있으면 서랍, 그다음 작업 패널을 닫는다 |
| 모바일 설정 상세 | `core/app-mobile-sheets.js` `_initSettingsMobile` | 캡처 + `stopImmediatePropagation` | 상세 화면이면 목록으로 물러선다. 설정 닫기(버블)보다 먼저 돌아야 한다 |
| 계정 팝오버 | `core/app-claude-accounts.js` `_claudeAcctPopDismiss` | 캡처, 전파를 끊지 않음 | 팝오버를 닫는다. 그 뒤 모바일 시트 처리기도 돌아 작업 패널까지 닫힌다 |
| 파일 트리 끌기 | `ui/file-tree-xfer.js` | 버블 | 끌기 상태를 푼다 |

설정 창을 여는 일도 같은 모양이다(FC-13). `#settings-btn` 에 클릭 리스너가 넷 붙어 있고(`settings-modal.js` 열기 · `app-settings.js` 검색 비우기 · `app-settings-profile.js` 프로필 읽기 · `app-mobile-sheets.js` 모바일 목록 화면), 열기 절차가 그 순서에 기댄다. 그래서 `_openSettings(tab)` 은 함수를 부르지 않고 단추를 **누른다**.

이 문서는 Esc 의 순서를 리스너 순서가 아니라 **연 순서(스택)** 로 정하고, 메뉴를 클래스로 옮기며, 설정 열기를 함수 하나로 모은다.

### 1.2 범위

| 항목 | 내용 |
|---|---|
| `EscapeStack` 두 층 | 항목마다 층(`capture`·`bubble`)을 둔다. 문서에 캡처 리스너와 버블 리스너를 하나씩 걸고, 각 층은 **스택 맨 위의 살아 있는 항목이 자기 층일 때만** 처리한다 |
| `Menu` | `ui/menu.js`. `View` 의 하위. `UIKit.menu`·`UIKit.closeMenu` 의 본체를 옮긴다(한 번에 하나). `UIKit.menu`·`closeMenu` 는 한 줄 입구로 남는다(단계 3 의 `KitModal` 과 같은 방식). Esc 는 `EscapeStack` 캡처 층을 지난다 |
| `Dialog` | Esc 를 `EscapeStack` 에 맡긴다. 열 때 넣고 닫을 때 뺀다. 층은 지금의 `_escCapture` 를 따른다. Esc 말고 다른 키(`GitDialog` 의 Enter 등)는 지금 처리기에 남는다 |
| 이주하는 처리기 넷 | 모바일 시트(서랍·작업 패널 → `Panel.escapable`), 모바일 설정 상세, 계정 팝오버, 파일 트리 끌기 |
| 설정 열기 | `SettingsModal.open()` 한 함수가 열기 절차 전부를 고정된 순서로 돈다. `#settings-btn` 의 클릭 리스너는 하나(`open()`)다. `_openSettings(tab)` 은 함수를 부른다 |

### 1.3 범위 밖

- 입력 칸·편집기 안의 Esc(이름 바꾸기 입력 되돌리기, 찾기 막대 닫기, 경로 후보, 파일 트리 키, 클립보드 상자, 편집기 드롭다운, 단축키 녹화). 포커스가 있는 그 요소의 일이고 "떠 있는 것 중 맨 위" 의 판정이 아니다. 그대로 둔다.
- `GitMenu`(`git/menu.js`)의 데이터 층. 지금처럼 `UIKit.menu` 를 지난다.
- `UIKit.dialogOpen` 의 Tab 가두기(`_dlgOnKey`). Esc 가 아니다.
- 데스크톱 작업 패널을 Esc 로 닫는 일. 지금 닫히지 않는다(INV-F3).

### 1.4 불변 조건

| ID | 조건 |
|---|---|
| INV-E1 | 한 번의 Esc 는 떠 있는 것 **하나만** 닫는다 |
| INV-E2 | 지금 Esc 로 닫히는 것은 그대로 닫히고, 닫히지 않는 것(데스크톱 작업 패널·사이드바)은 그대로 닫히지 않는다 |
| INV-E3 | 캡처 층 항목(대화상자·메뉴·모바일 설정 상세·계정 팝오버)은 포커스 요소보다 먼저 Esc 를 받는다 — 터미널(xterm)이 키 전파를 끊어도 닫힌다. 버블 층 항목(모바일 시트·설정 모달·파일 트리 끌기)은 포커스 요소가 Esc 를 먼저 쓰게 둔다 |
| INV-E4 | DOM·접근성 속성·포커스 복귀·메뉴의 키 이동(화살표·Home·End·Enter·Space)과 바깥 누름 닫기·스크롤과 크기 바꾸기 닫기는 그대로다. 메뉴를 연 직후에도 Esc 는 바로 먹는다 |
| INV-E5 | 설정 창의 열기 절차(패널 칠하기·검색 비우기·프로필 읽기·모바일 목록 화면)가 지금과 같은 순서로 돈다 |
| INV-E6 | 계층·로드 순서·크기·킷 게이트를 지킨다 |

## 2. 요구사항

| ID | 요구 |
|---|---|
| FR-FEE-1 | `EscapeStack.push(entry)` 의 항목은 `{close(), phase?, active?(), propagate?}` 모양이다. `phase` 의 기본은 `'capture'`. `active()` 가 거짓인 항목은 없는 것으로 보고 건너뛴다(걷어 내지 않는다). 같은 항목을 다시 넣으면 맨 위로 올라간다 |
| FR-FEE-2 | 처음 넣을 때 문서에 `keydown` 리스너를 캡처·버블 하나씩 건다. Esc 가 오면 각 층은 살아 있는 맨 위 항목을 보고, 그 항목의 층이 자기 층이면 빼고 `preventDefault()` 한 뒤 `close()` 한다. `propagate` 가 참이 아니면 `stopPropagation()` 한다. 다른 층이면 아무것도 하지 않는다. 이미 `defaultPrevented` 인 Esc 는 버블 층이 처리하지 않는다(포커스 요소가 먼저 썼다) |
| FR-FEE-3 | `Menu extends View`(`ui/menu.js`): `Menu.open(items, opts)` 이 지금 `UIKit.menu` 와 같은 요소를 같은 자리에 만들고, 열려 있던 메뉴는 먼저 닫는다. `Menu.close()` 는 지금 `closeMenu` 와 같다. Esc 는 `EscapeStack` 캡처 층 항목으로 연 즉시 넣는다. 화살표·Enter·바깥 누름·스크롤·크기 바꾸기는 지금처럼 메뉴 자신의 리스너가 한다. `UIKit.menu`·`UIKit.closeMenu`·`UIKit._menu` 는 그대로 쓸 수 있다(입구) |
| FR-FEE-4 | `Dialog` 는 열 때 자기 항목(`phase` 는 `_escCapture` 가 참이면 `capture`, 아니면 `bubble`, 설정 모달은 `propagate:true`)을 넣고 닫을 때 뺀다. 항목의 `close()` 는 하위 훅 `_escape()` 를 부르고 그 기본은 `_dismiss()` 다. `GitDialog` 는 `_escape()` 를 `_cancel()` 로 덮고, 실행 중(`busy`)이면 아무것도 하지 않는다. `_onKey` 에서 Esc 처리를 지운다 |
| FR-FEE-5 | 모바일 서랍(`DrawerSheet`)과 작업 패널(`ActivityPanel`)은 `escapable` 이고 항목의 `active()` 는 `app.isMobile` 이다. 층은 `bubble`. `_initSheetEscape` 를 지운다 |
| FR-FEE-6 | 모바일 설정 상세: 상세 화면으로 갈 때(모바일일 때만) 캡처 층 항목을 넣고, 목록으로 돌아가거나 설정이 닫히면 뺀다. 항목의 `active()` 는 지금 처리기의 조건(모바일·설정 열림·`mview==='detail'`)이다. `close()` 는 목록으로 물러선다. 문서 캡처 리스너를 지운다 |
| FR-FEE-7 | 계정 팝오버: 열 때 캡처 층 항목을 넣고 닫을 때 뺀다. 바깥 누름 닫기는 지금 리스너가 한다. 문서 `keydown` 리스너를 지운다 |
| FR-FEE-8 | 파일 트리 끌기: 끌기를 시작할 때 버블 층 항목(`propagate:true`)을 넣고 끌기가 끝나면 뺀다. 문서 `keydown` 리스너를 지운다 |
| FR-FEE-9 | 설정 열기: `SettingsModal.open()` 이 열기 훅 `onOpen` 하나를 부르고, App 의 `_settingsOnOpen` 이 지금 `#settings-btn` 클릭 리스너 셋의 일(검색 비우기 · 프로필 읽기 · 모바일 머리와 목록 화면)을 지금 실행 순서대로 부른다. 그 셋의 클릭 리스너를 지운다. `_openSettings(tab)` 은 `open()` 을 부르고, 탭은 지금처럼 탭 요소를 눌러 고른다 |
| FR-FEE-10 | `index.html` 은 `ui/menu.js` 를 `ui/list-view.js` 뒤에 싣는다. 단위 시험 하네스에 묶음 상수 `MENU` 를 `LIST` 뒤에 둔다. 주석의 "FC-14 는 단계 6" 류 안내(`escape-stack.js`·`drawer-sheet.js`·`activity-panel.js`·`panel.js`)를 지금 모양으로 고친다 |

## 3. 결정

| ID | 결정 | 이유 |
|---|---|---|
| D-FEE-1 | `EscapeStack` 은 두 층이다. 맨 위 하나만 보고, 그 항목의 층에서만 처리한다 | 한 층이면 동작이 바뀐다. 캡처 하나로 모으면 입력 칸의 Esc(이름 되돌리기 등)보다 서랍 닫기가 먼저 돈다. 버블 하나로 모으면 xterm 이 전파를 끊어 터미널에 포커스가 있을 때 메뉴·대화상자가 닫히지 않는다. 지금 처리기들이 단계를 둘로 나눈 이유가 바로 이것이다 |
| D-FEE-2 | 순서는 연 순서(스택)다. 리스너를 붙인 순서에 기대지 않는다 | FC-14. 모바일 설정 상세가 설정 닫기보다 먼저 도는 것(D-FED-5)도 "상세가 나중에 열렸다" 로 설명된다. `SettingsModal` 을 `initModal` 과 같은 시점에 만들어야 하던 제약(둘째 인계서 §4)이 Esc 에서는 사라진다 |
| D-FEE-3 | 살아 있는지(`active()`)를 항목이 말한다. 죽은 항목은 건너뛰고 걷어 내지 않는다 | 모바일·데스크톱 전환처럼 지금 해당하지 않는 항목이 Esc 를 삼키면 안 된다. 걷어 내면 데스크톱에서 건너뛴 작업 패널이 모바일 폭이 된 뒤 Esc 로 닫히지 않는다(구현 중 발견). 빼는 것은 항목의 주인이다 |
| D-FEE-4 | 메뉴의 화살표·바깥 누름은 메뉴 리스너에 남긴다 | Esc 만 "맨 위 하나" 판정이다. 화살표는 메뉴가 열려 있는 동안 메뉴의 것이다 |
| D-FEE-5 | 입력 칸·편집기 안의 Esc 는 옮기지 않는다 | 떠 있는 것이 아니라 포커스 요소의 일이다. 버블 층이 `defaultPrevented` 를 존중하므로 이 처리기들이 먼저 쓴 Esc 를 스택이 다시 쓰지 않는다 |

## 4. 검증

| ID | 시험 |
|---|---|
| TC-FEE-1 | 단위: 캡처 항목만 있으면 캡처 리스너가 닫고 전파를 끊는다. 버블 항목만 있으면 캡처는 아무것도 하지 않고 버블이 닫는다. 맨 위가 버블이고 아래가 캡처면 캡처 층은 아무것도 하지 않는다. `propagate` 항목은 전파를 끊지 않는다. `active()` 가 거짓인 맨 위는 건너뛰고(남긴다) 그 아래가 처리된다. `defaultPrevented` 인 Esc 는 버블 층이 처리하지 않는다. Esc 가 아니면 아무것도 하지 않는다 |
| TC-FEE-2 | 단위: `Menu` 는 `View` 하위다. `UIKit.menu` 가 `Menu` 를 지나 같은 마크업을 만든다. 열면 `EscapeStack` 에 들어가고 닫으면 빠진다. 새 메뉴를 열면 앞 메뉴가 닫힌다 |
| TC-FEE-3 | 단위: `Dialog` 가 열면 들어가고 닫으면 빠진다. 층이 `_escCapture` 를 따른다. `GitDialog` 의 Esc 가 `_cancel` 을 부르고 `busy` 면 부르지 않는다 |
| TC-FEE-4 | 단위(소스 검사): `app-mobile-sheets.js`·`app-claude-accounts.js`·`file-tree-xfer.js` 에 `document.addEventListener('keydown'` 이 없다. `#settings-btn` 에 `addEventListener('click'` 을 거는 자리는 `settings-modal.js` 하나다 |
| TC-FEE-5 | e2e(기존): 메뉴·대화상자·Git 대화상자·설정(모바일 상세 포함)·모바일 시트·계정 팝오버·파일 트리·단축키 spec 이 모양을 바꾸지 않고 통과한다 |

## 5. 동작 변경 기록

| 이전 | 새 | 이유 |
|---|---|---|
| 모바일에서 계정 팝오버가 열린 채 Esc 를 누르면 팝오버와 작업 패널이 **함께** 닫혔다(팝오버 처리기가 전파를 끊지 않아 시트 처리기도 돌았다) | 팝오버만 닫힌다 | INV-E1. 한 번의 Esc 는 하나만 닫는다 |
| 포커스 요소가 Esc 를 쓰고(`preventDefault`) 전파를 끊지 않으면 버블 처리기(모바일 시트·설정 모달)도 돌아 둘이 함께 반응했다(예: 모바일 서랍 안 편집기 찾기 막대) | 버블 층은 이미 쓴 Esc 를 다시 쓰지 않는다 | INV-E1 · D-FEE-5 |
| 모바일에서 서랍과 작업 패널이 함께 열려 있으면 Esc 가 서랍을 먼저 닫았다(처리기 안의 고정 순서) | 나중에 연 것을 먼저 닫는다 | D-FEE-2. 둘이 함께 열리는 길은 드물다 |
| 설정이 이미 열린 채 `_openSettings(tab)`(단축키 도움말 등)를 부르면 단추를 눌러 검색 비우기·프로필 읽기·모바일 목록 화면이 다시 돌았다 | 탭 고르기만 돈다(`open()` 은 열린 창에서 아무것도 하지 않는다) | FR-FEE-9. 열린 창의 검색어를 지우지 않는다 |
| 대화상자 위에 메뉴가 떠 있을 때 Esc 는 둘 다 닫았다(같은 노드의 캡처 리스너 둘이 차례로 돌았다) | 메뉴만 닫는다 | INV-E1 |

## 6. 구현 기록

| 커밋 | 요점 |
|---|---|
| (이 커밋) | `core/base/escape-stack.js` 두 층(`handle(e, phase)` · `top()` 은 죽은 항목을 건너뛴다) · `ui/menu.js` `Menu`(`UIKit.menu`·`closeMenu` 는 한 줄 입구, `UIKit._menu` 는 읽기 입구, `ui-kit.js` 817 → 696줄) · `Dialog._attach` 가 항목을 넣고 `_escape()` 훅(기본 `_dismiss()`) · `GitDialog._escape`(busy 면 무시, `_onKey` 는 Enter 만) · `KitModal`·`GitConfirm`·`SettingsModal` 의 Esc 동작을 `_escape()` 로 · `DrawerSheet`·`ActivityPanel` 은 `escapable`·버블·`active()=isMobile` · 모바일 설정 상세·계정 팝오버·파일 트리 끌기의 문서 `keydown` 리스너를 항목으로 · `#settings-btn` 클릭 리스너는 `settings-modal.js` 하나, 나머지 셋의 일은 `_settingsOnOpen` 끝에서 부른다. 시험 `web/js/test/escape-menu.test.mjs`(TC-FEE-1~4, 20건) |

**설정 열기 순서(INV-E5).** 클릭 리스너가 붙던 실제 순서는 `InputBinding` 의 `initModal()` → `initMobile()` 호출 순서를 따른다: ① `SettingsModal.init`(열기 → `onOpen` = 패널 칠하기·모바일 서랍 닫기) ② `_bindSettingsSearch`(검색 비우기) ③ `_initProfilePanel`(Profile 탭이면 읽기, `initModal` 끝) ④ `_initSettingsMobile`(모바일 머리·목록 화면, `initMobile` → `_initMobileSheets`). `_settingsOnOpen` 은 칠하기·서랍 닫기 뒤에 ②`_settingsSearchReset` → ③`_profileOnSettingsOpen` → ④`_settingsMobileOnOpen` 을 이 순서로 부른다.

**SRS 와 다르게 한 것.**

1. `Panel` 의 항목은 패널 자신이다. 층은 생성 인자 `phase`(기본 `capture`)를 필드로 두고, `active()` 는 하위(`DrawerSheet`·`ActivityPanel`)가 덮는다. `Menu` 의 항목도 메뉴 자신이고, 인스턴스 `close()` 는 자기가 지금 메뉴일 때만 닫는다.
2. `Dialog` 의 항목은 `_escape()` 뒤에도 창이 열려 있으면(실행 중 `busy`) 스택에 다시 들어간다. FR-FEE-4 는 이것을 적지 않았다. 다시 넣지 않으면 실행 중에 누른 Esc 가 항목을 잃고, 실행이 끝난 뒤의 Esc 가 창을 닫지 못한다(종전에는 닫았다).
3. `KitModal`·`GitConfirm` 은 Esc 에만 쓰이던 `_dismiss()` 를 `_escape()` 로 이름을 바꿨다. 기본 `_escape()` → `_dismiss()` 는 SRS 대로 둔다. `KitModal` 의 Esc 는 `close()`(값 없음 → `UIKit.ask` 의 `escValue`)이고 그대로다.
4. 파일 트리 끌기 항목은 `dragstart` 말고 바깥에서 온 파일이 드롭 자리를 처음 표시할 때(`_markDrop`)에도 넣는다. 종전 처리기가 바깥 끌기의 표시(`_dropDir`)도 풀었다.
5. 모바일 설정 상세 항목은 목록 화면으로 갈 때와, 설정이 닫힌 것을 기존 `MutationObserver`(`#modal-overlay` 의 클래스)가 볼 때 뺀다. `SettingsModal` 에 닫기 훅을 더하지 않았다.
6. 메뉴의 가장자리 여백 상수 `UIK_MENU_EDGE_PX` 는 `ui/menu.js` 로 옮겼다.

**구현 중 드러난 차이.** 앞의 둘은 §5 에 올렸다. 셋째(처음 구현은 `top()` 이 죽은 항목을 걷어 내, 데스크톱에서 Esc 를 누른 뒤 모바일 폭이 되면 열린 작업 패널이 Esc 로 닫히지 않았다)는 건너뛰기로 고쳤다(D-FEE-3).
