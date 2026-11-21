# SRS: 리팩토링 3차 P3a 단계 0~2 — 프론트 기반 클래스와 두 패널 — IEEE 29148

> **문서 상태**: 승인·구현중
> **남은 것**: 단계 2(FR-FEB-20~26)의 구현과 검증. 단계 0·1 은 `6a30fc80` 에서 닫혔다.

- 접수: 2026-11-21 (프로덕션 리팩토링 3차 · `docs/internal/refactor/FE_OBJECT_MODEL.md` 단계 0~2 · `PROD3.md` P3a·FU-20)
- 사용자 결정(2026-11-21): 외부 프레임워크 없이 자체 클래스 계층을 세운다. 화면 부품은 모두 `View` 의 파생, App 의 주제별 일은 `Controller` 의 파생, 둘 다 `Component` 에서 나온다. 클래스 하나 = 파일 하나. FU-20 의 라벨 표시 규칙은 지금처럼 패널별이다.

## 1. 개요

### 1.1 목적

프론트는 프레임워크 없이 `App.prototype` mixin 과 파일마다 따로 만든 헬퍼로 짜여 있다. 같은 종류의 부품(패널, 탭 줄 …)이 제각각 구현돼 동작이 갈린다. 사이드바 탭 줄과 작업 패널 탭 줄이 그 예다. 이 문서는 계층의 뿌리(`Component`·`View`·`Controller`)를 세우고, 첫 적용으로 두 패널과 두 탭 줄을 같은 기반 클래스의 하위로 옮긴다.

### 1.2 범위

| 단계 | 내용 | PROD3 ID |
|---|---|---|
| **0** 선행 정리 | DOM 생성 헬퍼 한 벌, 죽은 함수, 해제 경로 없는 관측 | FU-1 · FU-2~6 · FE_OBJECT_MODEL 행 12 |
| **1** 기반 클래스 | `Component` · `View` · `Controller` · `EscapeStack` · `ScrollMemo` · `badgeOf` | FE_OBJECT_MODEL 단계 1 |
| **2** 패널·탭 줄 | `Panel` · `TabBar` 와 하위 `SidebarPanel` · `ActivityPanel` · `DrawerSheet` · `SidebarTabBar` · `ActivityTabBar` | FU-20 · FC-01·02 · FE_OBJECT_MODEL 행 1·2·9·10·13 |

### 1.3 범위 밖

대화상자·목록·메뉴·git 뷰·App 컨트롤러 분해는 단계 3 이후의 SRS 가 맡는다. Esc 처리기 15파일을 모으는 일(FC-14)은 단계 6 이다. 이 문서는 `EscapeStack` 을 세우고 단계 2 의 패널만 등록한다.

### 1.4 불변 조건

| ID | 조건 |
|---|---|
| INV-F1 | DOM id·클래스·`data-*`(`#sb-tabs`·`.sb-tab`·`data-panel`·`#agents-head`·`.ag-tab`·`data-sec`·`#agents-panel`·`.open`·`drawer-open` …)는 바뀌지 않는다. CSS 와 e2e 가 그 위에 서 있다 |
| INV-F2 | `window.app` 에서 e2e·다른 파일이 부르는 이름(`actPanelOpen`·`setSidebarCollapsed`·`sidebarCollapsed`·`sbTab`·`setAgentsPanelOpen`·`_toggleDrawer`·`drawerOpen` 등)은 남는다. 옮긴 것은 새 부품에 맡기는 위임자가 된다. 위임자를 지우는 일은 단계 9 다 |
| INV-F3 | 사용자에게 보이는 동작(탭 고르기·배지·라벨 맞춤·직행 키 토글·접기·스크롤 자리·영속 키)은 바뀌지 않는다. 예외는 §5 다 |
| INV-F4 | 계층 게이트(`check-layer`)·로드 순서 게이트(`check-load-order`)·크기 게이트(`check-file-size`)·킷 게이트를 지킨다 |

## 2. 요구사항

### 2.1 단계 0 — 선행 정리

| ID | 요구 |
|---|---|
| FR-FEB-1 | `core/helpers.js` 에 `domEl(tag, cls, text)` 와 `svgEl(tag, attrs)` 를 둔다. 파일마다 따로 있던 생성 헬퍼(`actEl`·`chatEl`·`runDiv`·`runSvg`·`meshSvg`·`runTreeSpan`·`_span`·`add`·`mk`·`span` 등 PROD3 FU-1 의 자리)는 그것을 쓰고 지운다. 생성 결과(태그·클래스·글자·속성·네임스페이스)는 같다 |
| FR-FEB-2 | 호출처가 없는 함수 `_rWinTitle`(renderer-chrome.js) · `reloadRefs`(history-load.js) · `menuOpen`(ui-kit.js) · `_submodules`(panel-views.js)를 지운다. 지우기 전에 동적 호출(`this[…]`·문자열 키)이 없음을 확인한다. `cm-lsp.js` 의 `unsubscribe` 는 라이브러리 계약이면 남기고 이유를 주석에 적는다 |
| FR-FEB-3 | `UIKit.tabsFitWatch` 와 `UIKit.roving` 은 해제 함수를 돌려준다. 같은 호스트에 두 번 걸지 않는 규약은 그대로다 |

### 2.2 단계 1 — 기반 클래스 (`web/js/core/base/`, 클래스 하나 = 파일 하나)

| ID | 요구 |
|---|---|
| FR-FEB-10 | `Component`(`component.js`): `own(disposer)` 는 해제 함수를 쌓는다. `listen(target, type, fn, opts)` 는 리스너를 달고 해제를 쌓는다. `observe(observer, target, opts)` 는 Resize·MutationObserver 를 걸고 해제를 쌓는다. `after(ms, fn)`·`every(ms, fn)` 은 `TimerHub` 에 이 인스턴스를 주인으로 넘긴다. `on(topic, fn)` 은 `EventBus` 에 주인으로 넘긴다. `dispose()` 는 쌓인 해제를 거꾸로 부르고, 시간 허브(`TIMERS`/`app.timers`)와 이벤트 버스(`app.bus`) 인스턴스의 `disposeOwner(this)` 를 부르고, `disposed` 를 참으로 둔다. 두 번 불러도 안전하다 |
| FR-FEB-11 | `View extends Component`(`view.js`): `el` 은 자기 루트 요소다. `mount(host)` 는 처음 한 번 `build()` 로 `el` 을 만들고(이미 있는 DOM 을 쓰는 하위는 `adopt(el)`), `host` 에 붙이고, `render()` 를 부른다. `render()` 는 하위가 덮어쓴다. `dispose()` 는 상위 정리 뒤 `el` 을 떼되, `adopt` 한 요소는 떼지 않는다(그 요소의 주인은 `index.html` 이다) |
| FR-FEB-12 | `Controller extends Component`(`controller.js`): 생성자 인자로 `app` 을 받아 `this.app` 에 둔다. 화면 요소를 갖지 않는다 |
| FR-FEB-13 | `EscapeStack`(`escape-stack.js`, 정적): `push(entry)`/`remove(entry)`, Esc 를 받으면 맨 위 항목 하나의 `close()` 만 부른다. 이 단계에서는 단계 2 의 패널만 등록한다. 기존 Esc 처리기는 건드리지 않는다 |
| FR-FEB-14 | `ScrollMemo`(`scroll-memo.js`): 키별로 스크롤 자리를 적고 되돌린다. 값은 요소에 적는 기존 규약(`UIKit.scrollSave/Restore`, FR-SBT-11)을 쓴다 |
| FR-FEB-15 | `badgeOf(n, opts)`(`badge.js`, 함수): `{shown, text, dot}` 를 돌려준다. 0·null 이면 숨김, 점 지원(FR-PCH-81)은 옵션이다. 두 패널의 배지 판정이 이것을 쓴다 |
| FR-FEB-16 | `index.html` 은 `core/base/*` 를 `timer-hub.js`·`event-bus.js`·helpers 묶음(`git-path.js` 까지 — `helpers-split.test.mjs` 가 그 묶음 안의 순서를 고정한다) 뒤, 그것을 쓰는 첫 파일(`repaint.js`) 앞에 싣는다. `web/embed.go` 의 go:embed 패턴은 한 단계 아래만 담으므로 `js/core/base/*.js` 를 더한다(`TestBaseClassesEmbedded`). 순서는 `component.js` → `view.js` → `controller.js` → 나머지다. `harness.mjs` 에 같은 순서의 묶음 상수 `BASE` 를 둔다 |

### 2.3 단계 2 — 패널과 탭 줄

| ID | 요구 |
|---|---|
| FR-FEB-20 | `TabBar extends View`(`ui/tab-bar.js`): 서술자 배열(`id`·`label`·`title`·`icon`·`badge`), 영속 키(`persistKey`, PrefStore), 단추는 처음 한 번만 만든다(`UIKit.tab`), `paint()` 는 활성·`aria-selected`·숨김·배지를 고친다, 라벨 맞춤은 `UIKit.tabsFit` 을 **이 클래스 한 자리에서** 부른다(배지 변화·`paint`·폭 변화 모두 같은 경로), 탭별 스크롤 자리는 `ScrollMemo`, `select(id)` 는 하위 훅 `onLeave(prev)`·`onEnter(next)`·`onSelect(next)` 를 차례로 부른다, `jump(n)` 은 FR-UXF-122 의 토글(펼친 채 보는 탭이면 접고, 아니면 고르고 펼친다)을 하위 훅 `isFolded()`·`setFolded(v)`·`canFold()` 로 한다 |
| FR-FEB-21 | `SidebarTabBar extends TabBar`(`ui/sidebar-tab-bar.js`): 지금 `SidebarTabs` 의 동작 전부 — `SB_TAB_DEFS`·`visible`·`labelForWindow`·`restore`·`setTab`(재진입 가드 `sbBusy`, `silent`, `onActivate`)·`syncToWindow`·`jumpTo`(직행 키는 서술자 배열 인덱스, FR-SBT-26·29)·`updateBadges`·`panelOf`·`saveScroll`·`restoreScroll` 을 맡는다. `SidebarTabs` 는 이 인스턴스에 맡기는 얇은 입구로 남는다(INV-F2) |
| FR-FEB-22 | `ActivityTabBar extends TabBar`(`core/activity-tab-bar.js`): 지금 `app-activity.js` 의 `_actTab`·`_actTabSelect`·`_actTabsEl`·`_actTabsPaint`·`_actScroll` 이 하던 일을 맡는다(점 배지 FR-PCH-81, 수 배지 FR-UIP-7, 보이는 구역만, 영속 키 `STORE_KEYS.activityTab`). 그 App 메서드는 위임자로 남는다 |
| FR-FEB-23 | `Panel extends View`(`ui/panel.js`): 열림의 기준은 **DOM 하나**(루트 요소의 클래스)다. `open()`·`close()`·`toggle()`·`isOpen()`·`onOpen()`/`onClose()` 훅, 영속 키 옵션, 열면 `EscapeStack` 에 등록하고 닫으면 뺀다(등록 여부는 하위가 정한다) |
| FR-FEB-24 | `SidebarPanel`·`ActivityPanel`(`ui/sidebar-panel.js`·`core/activity-panel.js`)은 접힘(레일)·열림을 `Panel` 로 한다. 각자 자기 `TabBar` 하위 인스턴스를 든다. App 의 `setSidebarCollapsed`·`sidebarCollapsed`·`setAgentsPanelOpen`·`actPanelOpen`·`agentsToggle` 은 위임자가 된다 |
| FR-FEB-25 | `DrawerSheet extends Panel`(`ui/drawer-sheet.js`): 모바일 서랍이다. 서랍 상태가 필드(`drawerOpen`)·`body.drawer-open`·`#sidebar.open` 세 곳에서 따로 바뀌던 것을 이 클래스 하나가 함께 바꾼다(FC-02). 상단바 다시 그리기(P1 FR-RD3-80)도 여기서 한다. App 의 `_toggleDrawer`·`drawerOpen`·`_drawerSheetSync`·`applyMobileMode` 의 서랍 부분은 이 인스턴스에 맡긴다 |
| FR-FEB-26 | 두 탭 줄의 라벨 판정 **시점**이 지금 어떻게 다른지 표로 적고(사이드바: `paint`→`updateBadges`→`tabsFit` + `#sb-tabs` 관측 / 작업 패널: `agentsRender` 마다 + `#agents-head` 관측 등), 공통 경로로 옮긴 뒤 두 패널에서 같은 사건(배지 변화·폭 변화·탭 전환·다시 그리기·레일에서 펼치기·모바일 진입)이 같은 판정을 부르는지 시험한다. 판정 규칙(자기 탭 줄에 라벨이 다 들어가면 보인다)은 패널별 그대로다 |

## 3. 결정

| ID | 결정 | 이유 |
|---|---|---|
| D-FEB-1 | 기반 클래스는 `core/base/` 에 둔다 | `ui/`·`git/`·`core/` 가 모두 쓴다. 계층 규칙(FR-FMB-40)에서 core 는 가장 아래다 |
| D-FEB-2 | 기존 App 메서드·`SidebarTabs` 는 위임자로 남긴다 | e2e 와 다른 파일이 그 이름을 부른다(INV-F2). 한꺼번에 지우면 변경이 수백 줄로 퍼진다 |
| D-FEB-3 | `View.adopt(el)` 을 둔다 | 두 패널의 DOM 은 `index.html` 에 이미 있다. 새로 만들면 CSS·e2e·첫 페인트(`sb-collapsed` 선주입)가 깨진다 |
| D-FEB-4 | 상속 깊이는 `Component` 아래 넷까지 | 읽는 사람이 따라갈 수 있는 한계 |

## 4. 검증

| ID | 시험 | 단계 |
|---|---|---|
| TC-FEB-1 | 단위: `domEl`·`svgEl` 의 결과(태그·클래스·글자·SVG 네임스페이스) | 0 |
| TC-FEB-2 | 단위: `tabsFitWatch`·`roving` 이 해제 함수를 돌려주고, 부르면 관측·리스너가 사라진다 | 0 |
| TC-FEB-10 | 단위: `Component` — `own`·`listen`·`observe`·`after`·`on` 이 `dispose` 에서 모두 풀린다, 두 번 `dispose` 해도 안전하다 | 1 |
| TC-FEB-11 | 단위: `View` — `mount` 가 `build` 를 한 번만 부른다, `adopt` 한 요소는 `dispose` 가 떼지 않는다 | 1 |
| TC-FEB-12 | 단위: `EscapeStack` — 맨 위 하나만 닫는다, 뺀 항목은 닫지 않는다 | 1 |
| TC-FEB-13 | 단위: `badgeOf` — 0·null 숨김, 수, 점 | 1 |
| TC-FEB-20 | 단위: `TabBar` — 단추를 한 번만 만든다, `select` 의 훅 순서, `jump` 토글 세 갈래(펼친 채 같은 탭 → 접기 / 다른 탭 → 고르기 / 접힘 → 고르고 펼치기) | 2 |
| TC-FEB-21 | 단위: 같은 사건이 두 탭 줄에서 같은 라벨 판정 경로를 부른다(FR-FEB-26) | 2 |
| TC-FEB-22 | 단위: `DrawerSheet` — 열고 닫으면 필드·`body.drawer-open`·`#sidebar.open` 이 함께 바뀌고 상단바를 다시 그린다 | 2 |
| TC-FEB-23 | e2e(기존): `sidebar-tabs.spec.ts` · `panel-tabs-unify.spec.ts` · `ux-audit-fix-6.spec.ts`(FR-UXF-98) · `sidebar-collapse.spec.ts` · 활동 패널 탭 관련 spec · 모바일 서랍 spec 이 모양을 바꾸지 않고 통과한다 | 2 |

새 시험은 고치기 전 코드에서 실패한다(새 클래스가 없어 실패하는 것 포함). 그 밖에 `make gates` · `npm run -s unit` · `npm run -s typecheck`. e2e 전량은 사용자 결정대로 모든 묶음이 끝난 뒤에 돌리고, 이 단계에서는 TC-FEB-23 의 관련 spec 만 돌린다.

## 5. 동작 변경 기록

| 단계 | 이전 | 새 | 이유 |
|---|---|---|---|
| 2 | (FR-FEB-26 의 표가 차이를 찾으면 여기에 적는다) | 두 패널이 같은 사건에서 같은 라벨 판정 경로를 부른다 | FU-20 — 사용자가 "두 패널 상단 탭의 동작이 하나 다르다"고 했다 |

## 6. 구현 기록

| 단계 | 커밋 | 요점 |
|---|---|---|
| 0·1 | `6a30fc80` | `domEl`·`svgEl` 로 헬퍼 여덟을 지웠다(`runTreeSpan`·`mk` 는 합성 헬퍼라 본문만 `svgEl`/`domEl` 을 쓴다). 죽은 함수 넷 삭제(`cm-lsp` `unsubscribe` 는 라이브러리 Transport 계약이라 남기고 주석). `tabsFitWatch`·`roving` 은 해제 함수를 돌려준다. `core/base/` 여섯 파일. `badgeOf` 는 두 탭 줄의 배지 판정에 이미 쓰인다. 단위 1178 · 게이트 · typecheck · e2e 78건(activity·sidebar-tabs·panel-tabs-unify·run-tree·git-repo-missing·claude-accounts·git-diff) 통과. **단계 2 에 넘긴 것:** `EscapeStack` 은 버블 단계에서 받고 `stopPropagation` 을 하지 않는다 — 패널을 등록할 때 기존 Esc 처리기와의 순서를 정한다 |
