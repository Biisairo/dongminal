# SRS: 리팩토링 3차 P3a 단계 4 — 목록 기반 클래스 `ListView` — IEEE 29148

> **문서 상태**: 승인·구현중
> **남은 것**: `ListView`·`SidebarList`·`GitListTab` 구현과 시험

- 접수: 2026-11-21 (프로덕션 리팩토링 3차 · `docs/internal/refactor/FE_OBJECT_MODEL.md` §2 행 3·§6 단계 4)
- 사용자 결정(2026-11-21, `FE_OBJECT_MODEL.md` §7): 자체 클래스 계층, 클래스 하나 = 파일 하나. 진행은 묻지 않고 끝까지 한다.

## 1. 개요

### 1.1 목적

목록은 모두 `reconcileList(container, items, {key, sig, build})` 를 부른다. 그 위의 일(행의 정체·서명·만들기, 키보드 배선)은 목록마다 따로 적혀 있다. 두 큰 목록이 특히 그렇다.

| 목록 | 자리 | 모양 |
|---|---|---|
| 사이드바 목록 | `ui/sidebar-list.js` `SidebarList` | 객체 리터럴. 함수마다 `(app, def)` 를 받는다. 탭 서술자(`SB_TAB_DEFS`)의 `list` 가 내용을 준다 |
| Git 목록 탭 | `git/list-tab.js` `GitListTab` | 클래스. `GitWorktrees`·`GitSubmodules` 가 하위다. 루트를 `_el` 에 든다 |

이 문서는 `ListView` 를 세우고 두 목록을 그 하위로 옮긴다.

### 1.2 범위

| 항목 | 내용 |
|---|---|
| `ListView` | `ui/list-view.js`. `View` 의 하위. 행의 정체(`key`)·서명(`sig`·`sigParts`)·만들기(`buildRow`), `reconcile(box, items)`, 키보드 배선(`bindKeys`) |
| `SidebarList` | 클래스로 바꾼다. 탭 서술자 하나에 인스턴스 하나. 지금 이름의 정적 입구(`SidebarList.paint`·`entries`·`dragAt`·`dragClear`·`commit`·`cycle`·`defByDragType`)는 남긴다 |
| `GitListTab` | `ListView` 의 하위로 바꾸고 `git/git-list-tab.js` 로 옮긴다(`mv`). 루트는 `el` 이다(`_el` 을 없앤다). 하위 훅 `_key`·`_sigParts`·`_rowEl` 은 `key`·`sigParts`·`buildRow` 가 된다 |

### 1.3 범위 밖

- `reconcileList` 를 부르는 나머지 자리(약 20곳)를 `ListView` 로 옮기는 일. 그 자리들은 저마다의 부품(작업 패널·git 탭·실행 트리)이 클래스가 될 때 함께 옮긴다(단계 5·7·9).
- `GitListTab` 의 `mount`·`unmount`·`paint`·`reload`·저장소 교체(`_adopt`)는 단계 5(`GitView`)가 정한다. 이 문서는 이름과 동작을 그대로 둔다.

### 1.4 불변 조건

| ID | 조건 |
|---|---|
| INV-L1 | DOM(클래스·`data-*`·`role`·`aria-*`·`.sbl-*`·`.git-wt-*`·`.git-sub-*`)과 행 서명의 바이트는 바뀌지 않는다 — 서명이 바뀌면 첫 회차에 모든 행이 다시 만들어진다 |
| INV-L2 | `SidebarList.paint(app, def)` 등 다른 파일이 부르는 정적 입구와 그 인자는 그대로다 |
| INV-L3 | 보이는 동작(빈 안내, 편집 중 그리지 않기, 포커스 되돌리기, 끌어 옮기기, 탭 받기, 순회)은 바뀌지 않는다 |
| INV-L4 | 계층·로드 순서·크기·킷 게이트를 지킨다 |

## 2. 요구사항

| ID | 요구 |
|---|---|
| FR-FEL-1 | `ListView extends View`(`ui/list-view.js`): `key(item)` 의 기본은 `item.key`, `sigParts(item)` 의 기본은 `[key]`, `sig(item)` 는 `sigParts` 를 `RPT_SEP` 로 잇는다(하위는 `sig` 를 통째로 덮을 수 있다), `buildRow(item)` 은 행 요소를 만든다. `reconcile(box, items)` 는 이 셋으로 `reconcileList` 를 부르고 그 값을 돌려준다 |
| FR-FEL-2 | `bindKeys(box, spec)` 는 상자마다 한 번만 `UIKit.roving` 을 걸고 해제를 인스턴스 수명에 쌓는다 |
| FR-FEL-3 | `SidebarList extends ListView`: 생성자가 `(app, def)` 를 받는다. 지금 객체의 일 전부(그리기·빈 안내·편집 중 멈춤·포커스 되돌리기·서명·행 만들기·탭 받기·끌어 옮기기·확정·순회)를 인스턴스 메서드로 한다. 서명은 지금 `_sig` 의 바이트 그대로다 |
| FR-FEL-4 | `SidebarList.of(app, def)` 는 `app` 과 `def.id` 별로 인스턴스 하나를 만들어 둔다. 정적 입구는 그 인스턴스에 맡긴다. `entries(app, d)` 와 `defByDragType(type)` 는 인스턴스가 필요 없어 정적으로 남는다 |
| FR-FEL-5 | `GitListTab extends ListView`(`git/git-list-tab.js`): `mount(el)` 은 패널이 준 칸을 `adopt` 하고 지금처럼 골격을 채운다. `unmount()` 는 `el` 을 비운다. `_paintList` 는 `reconcile` 을 지난다 |
| FR-FEL-6 | `index.html` 은 `ui/list-view.js` 를 `ui/kit-modal.js` 뒤(`ui/panel.js` 앞)에 싣는다. `git/git-list-tab.js` 는 지금 `list-tab.js` 자리에 싣는다. `harness.mjs` 의 `DIALOG` 뒤에 `LIST`(`ui/list-view.js`)를 둔다 |

## 3. 결정

| ID | 결정 | 이유 |
|---|---|---|
| D-FEL-1 | `SidebarList` 는 정적 입구를 남기고 인스턴스에 맡긴다 | 부르는 자리(`renderer-chrome.js`·`input-binding.js`·`app-layout.js`)는 단계 9 에서 App 이 부품을 들 때 바꾼다(INV-F2 와 같은 규약) |
| D-FEL-2 | View 의 `build()`(루트 만들기)와 행 만들기를 이름으로 가른다(`buildRow`) | 하위가 `build` 를 덮으면 `mount` 가 루트 대신 행을 만든다 |
| D-FEL-3 | `GitListTab.mount(el)` 은 `View.mount(host)` 를 덮어 "받은 칸이 곧 루트" 로 쓴다 | git 패널이 탭마다 칸을 주고 탭이 그 안을 채운다. 수명 이름의 통일(`mount(host)`)은 단계 5 가 git 탭 여섯과 함께 정한다 |

## 4. 검증

| ID | 시험 |
|---|---|
| TC-FEL-1 | 단위: `ListView.reconcile` 이 `key`·`sig`·`buildRow` 를 쓴다. 서명이 같으면 행을 다시 만들지 않고, 다르면 다시 만든다. `sig` 는 `sigParts` 를 `RPT_SEP` 로 잇는다 |
| TC-FEL-2 | 단위: `bindKeys` 는 같은 상자에 한 번만 걸고, `dispose` 가 해제한다 |
| TC-FEL-3 | 단위: `SidebarList` 는 `ListView` 의 하위이고, 같은 `(app, def)` 에 같은 인스턴스를 돌려준다. 정적 `paint` 가 그 인스턴스의 `paint` 를 부른다. 서명이 옛 `_sig` 와 같은 바이트다 |
| TC-FEL-4 | 단위: `GitListTab`·`GitWorktrees`·`GitSubmodules` 의 원형 사슬에 `ListView`·`View` 가 있다. `mount(el)` 뒤 `el` 이 그 칸이고, `dispose` 가 그 칸을 떼지 않는다. 세 파일에 `this._el`·`_rowEl`·`_sigParts` 가 없다 |
| TC-FEL-5 | e2e(기존): 사이드바 목록·창 끌기·Git 핀·편집기 탭·worktrees·submodules spec 이 모양을 바꾸지 않고 통과한다 |

## 5. 동작 변경 기록

없다.

## 6. 구현 기록

| 커밋 | 요점 |
|---|---|
| (구현 커밋) | |
