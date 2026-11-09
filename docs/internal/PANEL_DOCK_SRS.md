# SRS: 패널 좌우 도킹 — IEEE 29148

> **문서 상태**: 승인·구현완료

## 1. 개요

### 1.1 목적

접수한 요청은 다음 한 줄입니다.

> **"좌우측에 있는 패널들(window/repo, activity, repo-changes/explorer)을 원하는 방향에 둘 수 있도록 하고 싶어."**

지금 세 패널은 자리가 고정되어 있습니다.

| 패널 | 요소 | 지금 자리 |
|---|---|---|
| 사이드바 (Windows/Repo) | `#sidebar` + `#sb-handle` | `#app` 맨 왼쪽 |
| Activity | `#agents-panel` + `#agents-handle` | `#app` 맨 오른쪽 |
| Repo 사이드 (Changes/Explorer) | `.ed-side` + `.ed-ex-handle` | Repo 창(`.ed-win`) 안, 편집기 왼쪽 |

이 SRS는 사용자가 각 패널을 끌어서 왼쪽이나 오른쪽에 둘 수 있게 합니다.

### 1.2 범위

**포함**
- 사이드바·Activity의 좌/우 위치와, 같은 쪽에 있을 때의 순서(바깥/안쪽)
- Repo 사이드의 좌/우 위치 (모든 Repo 창 공통)
- 드래그 앤 드롭으로 위치를 바꾸는 손짓과 드롭 표시
- 위치의 저장(`localStorage`)과 복원
- 위치에 따라 바뀌는 폭 조절 방향·접기 방향·경계선

**미포함** — §6 비목표를 봅니다.

### 1.3 인터뷰 결정 (2026-11-10)

| # | 질문 | 결정 |
|---|---|---|
| D-1 | 방향 범위 | 좌/우만 |
| D-2 | 사이드바와 Activity를 같은 쪽에 둘 수 있는가 | 있다. 같은 쪽이면 순서(바깥/안쪽)도 정한다 |
| D-3 | 바꾸는 방법 | 드래그 앤 드롭 |
| D-4 | Repo 사이드의 적용 범위 | 모든 Repo 창 공통 (`repoSideWidth` 와 같은 규약) |
| D-5 | 저장 위치 | `localStorage` (이 브라우저 전체, 재시작 후에도 유지) |

### 1.4 용어

| 용어 | 뜻 |
|---|---|
| 앱 패널 | `#app` 바로 아래에 있는 패널. `sidebar`, `activity` 둘이다 |
| 도크 상태 | 앱 패널의 배치. `{left:[], right:[]}` 이며 각 배열은 **바깥 → 안쪽** 순서다 |
| 바깥 | 화면 가장자리에 가까운 쪽 |
| 안쪽 | `#content` 에 가까운 쪽 |
| Repo 사이드 위치 | `'left'` 또는 `'right'`. Repo 창 안에서 편집기 기준의 자리다 |
| 손잡이(drag source) | 패널을 끌기 시작하는 요소 |

---

## 2. 현재 상태 (코드 근거)

- `#app` 은 `display:flex` 가로 줄이고, 자식 순서가 곧 화면 순서다 (`web/index.html:131-254`, `web/style.css:251`).
- 폭 손잡이는 `_bindWidthHandle(handle,{side:'left'|'right',...})` 하나가 처리한다. `side` 는 바인딩 때 한 번 정해진다 (`web/js/ui/input-binding.js:118-158`).
- 사이드바 접기는 손잡이를 안쪽 끝까지 끌 때 일어난다 (`input-binding.js:85-112`).
- Repo 사이드는 `.ed-win` 안에서 `[.ed-side, .ed-ex-handle, .ed-area]` 순서로 놓인다 (`web/js/ui/renderer-layout.js:355-382`). 손잡이는 오른쪽으로 끌면 넓어진다고 가정한다 (`web/js/ui/renderer-chrome.js:384-408`).
- 기존 드래그는 HTML5 DnD와 `app.drag` 상태를 쓴다. 문서 전역 `dragover`/`drop` 수락은 `_bindDocDnd` 에 있다 (`input-binding.js:61-81`).

---

## 3. 요구사항

### 3.1 상태와 저장

- **FR-PDK-1** 도크 상태는 `{left:string[], right:string[]}` 이다. 두 배열을 합치면 `sidebar` 와 `activity` 가 정확히 한 번씩 들어 있어야 한다. 각 배열은 바깥 → 안쪽 순서다.
- **FR-PDK-2** 기본 도크 상태는 `{left:['sidebar'], right:['activity']}` 이다. 이것은 지금 화면과 같다.
- **FR-PDK-3** 도크 상태는 `localStorage` 키 `panelDock` 에 JSON으로 저장한다.
- **FR-PDK-4** 저장된 값을 읽을 수 없거나 FR-PDK-1을 어기면(모르는 이름, 중복, 누락, 형식 오류) 기본값(FR-PDK-2)을 쓴다. 오류를 사용자에게 알리지 않는다.
- **FR-PDK-5** Repo 사이드 위치는 `'left'` 또는 `'right'` 다. 기본값은 `'left'` 다. `localStorage` 키 `repoSideDock` 에 저장한다. 다른 값이면 기본값을 쓴다.
- **FR-PDK-6** Repo 사이드 위치는 모든 Repo 창에 함께 적용된다.

### 3.2 화면 배치

- **FR-PDK-10** 데스크톱에서 `#app` 의 가로 순서는 다음과 같다: `left[0]` … `left[n-1]` → `#content` → `right[n-1]` … `right[0]`. 즉 `left` 는 왼쪽 가장자리부터, `right` 는 오른쪽 가장자리부터 안쪽으로 놓인다.
- **FR-PDK-11** 각 앱 패널의 폭 손잡이는 패널의 **안쪽**에 붙는다. 왼쪽 패널은 `[패널, 손잡이]`, 오른쪽 패널은 `[손잡이, 패널]` 순서다.
- **FR-PDK-12** 각 패널의 경계선은 안쪽 면에 그린다. 왼쪽 패널은 오른쪽 경계선, 오른쪽 패널은 왼쪽 경계선을 갖는다.
- **FR-PDK-13** Repo 사이드 위치가 `'right'` 이면 Repo 창은 `[편집기, 손잡이, 사이드]` 순서로 보인다. `'left'` 이면 지금과 같다. 경계선 규칙은 FR-PDK-12와 같다.
- **FR-PDK-14** 위치가 바뀌면 보이는 터미널을 다시 맞춘다(`doFit`). 패널의 열림·접힘·폭은 그대로 유지한다.
- **FR-PDK-15** 모바일(`body.mobile`)에서는 도크 상태와 Repo 사이드 위치를 적용하지 않는다. 지금의 모바일 배치를 그대로 쓴다. 저장된 값은 지우지 않는다.

### 3.3 폭 조절과 접기

- **FR-PDK-20** 폭 손잡이의 방향은 드래그를 **시작할 때의** 패널 위치를 따른다. 왼쪽 패널은 오른쪽으로 끌면 넓어지고, 오른쪽 패널은 왼쪽으로 끌면 넓어진다. Repo 사이드 손잡이도 같은 규칙을 따른다.
- **FR-PDK-21** 사이드바 접기(SIDEBAR_COLLAPSE_SRS FR-SBC-7)는 위치와 상관없이 "화면 가장자리 쪽으로 끝까지 끌면 접힌다"는 뜻을 유지한다. 오른쪽에 있으면 오른쪽으로 끌어 접는다.
- **FR-PDK-22** 폭 HUD의 좌우 값 순서는 화면의 실제 좌우 순서를 따른다.

### 3.4 드래그 앤 드롭

- **FR-PDK-30** 손잡이는 다음 셋이다: 사이드바의 탭 줄 `#sb-tabs`, Activity 머리 `.ag-head`, Repo 창의 탭 줄 `.ed-side-tabs`. 손잡이 안의 버튼(탭, 새로고침, 닫기)에서 시작해도 끌린다. 끌지 않고 누르면 지금처럼 버튼이 동작한다.
- **FR-PDK-31** 앱 패널을 끌면 `#app` 위가 드롭 영역이다. 포인터가 `#app` 가로 중앙보다 왼쪽이면 왼쪽, 아니면 오른쪽에 놓는다.
- **FR-PDK-32** 앱 패널을 놓을 쪽에 다른 앱 패널이 이미 있으면 순서를 정한다. 포인터가 그 패널의 가로 중앙보다 가장자리 쪽이면 바깥, 아니면 안쪽이다.
- **FR-PDK-33** 끄는 동안 놓일 자리를 세로 막대(accent 색)로 보인다. 막대는 패널이 들어갈 경계 위에 선다.
- **FR-PDK-34** Repo 사이드를 끌면 아무 `.ed-win` 위가 드롭 영역이다. 포인터가 그 `.ed-win` 가로 중앙보다 왼쪽이면 `'left'`, 아니면 `'right'` 다. 놓일 쪽 절반을 반투명 accent로 표시한다.
- **FR-PDK-35** 드롭 영역 밖에서 놓거나 Esc로 취소하면 아무것도 바뀌지 않는다. 표시도 사라진다.
- **FR-PDK-36** 결과가 지금 상태와 같으면 저장하지 않는다.
- **FR-PDK-37** 모바일에서는 손잡이가 끌리지 않는다.
- **FR-PDK-38** Repo 사이드는 앱 패널의 자리로 옮길 수 없다. Repo 창(`.ed-win`) 밖에 놓으면 아무것도 바뀌지 않는다. 앱 패널은 Repo 창 위에 놓아도 FR-PDK-31·32를 따른다 (Repo 창도 `#app` 안에 있기 때문이다).

### 3.5 비기능

- **NFR-PDK-1** 배치·드롭 계산은 DOM에 의존하지 않는 순수 함수로 둔다. 단위 테스트로 검증한다.
- **NFR-PDK-2** 기본값에서는 화면이 지금과 픽셀 단위로 같아야 한다. 기존 e2e가 그대로 통과해야 한다.

---

## 4. 설계 개요

| 자리 | 내용 |
|---|---|
| `web/js/core/panel-dock.js` (신규) | 순수 함수: `dockNormalize`, `dockMove`, `dockOrders`, `dockDropTarget`, `repoSideNormalize`. 저장 키 상수 |
| `pref-store.js` `STORE_KEYS` | `panelDock`, `repoSideDock` 추가 |
| `web/style.css` | `body:not(.mobile)` 에서 `order` 와 경계선을 CSS 변수·속성으로 받는다 |
| `web/style-editor.css` | `.ed-win[data-side="right"]` → `flex-direction:row-reverse`, 경계선 교체 |
| `input-binding.js` | `_bindWidthHandle` 의 `side` 를 함수로도 받는다. 손잡이 드래그 배선, 드롭 수락 |
| `renderer-layout.js` / `renderer-chrome.js` | `.ed-win` 에 `data-side`, Repo 사이드 손잡이 방향 반전 |

배치는 DOM 노드를 옮기지 않고 flex `order` 로 정합니다. 노드를 옮기면 스크롤·포커스·진행 중인 드래그를 잃기 때문입니다 (renderer-chrome.js `_keep` 의 근거와 같습니다).

---

## 5. 검증

| 요구 | 방법 |
|---|---|
| FR-PDK-1~6 | 단위: 정규화·기본값·잘못된 값 |
| FR-PDK-10~11 | 단위: `dockOrders` 가 모든 배치(4가지 쪽 조합 × 순서)에서 올바른 `order` 를 낸다 |
| FR-PDK-31~32, 36, 38 | 단위: `dockDropTarget`·`dockMove` 의 경계값(정확히 중앙, 다른 패널 중앙) |
| FR-PDK-12~14, 20~22, 30, 33~35 | e2e: 사이드바를 오른쪽으로 끌어 놓기 → 위치·저장·새로고침 후 복원, Repo 사이드 좌우 이동, 폭 손잡이 방향 |
| NFR-PDK-2 | 기존 e2e 전체 통과 |

---

## 6. 비목표

1. 위·아래 도킹 (D-1).
2. 설정 화면·우클릭 메뉴로 위치 바꾸기 (D-3).
3. 키보드만으로 위치 바꾸기. 위치는 한 번 정하면 자주 바꾸지 않는 취향이라, 이번 범위에서 뺍니다. 필요하면 단축키를 따로 추가합니다.
4. 서버 워크스페이스 저장·기기 간 동기화 (D-5).
5. Repo 창마다 다른 위치 (D-4).
6. 패널을 떠 있는 창(floating)으로 떼어 내기.
7. 모바일 배치 변경 (FR-PDK-15).

---

## 7. 위험

| 위험 | 등급 | 대응 |
|---|---|---|
| 손잡이 안 버튼의 클릭과 드래그가 충돌한다 | MEDIUM | HTML5 DnD는 움직임이 없으면 `click` 을 그대로 낸다. e2e로 탭 클릭이 여전히 되는지 확인한다 |
| 사이드바가 오른쪽일 때 접힘 레일 CSS가 왼쪽을 가정한다 | MEDIUM | 경계선·레일 규칙을 `data-sb-side` 로 나눈다 |
| Activity 카드 드래그(FR-AAP-21)와 섞인다 | LOW | 손잡이는 `.ag-head` 뿐이고, `app.drag.type` 이 다르다 |
| 기존 e2e가 사이드바의 x 좌표를 가정한다 | LOW | 기본값이 지금과 같으므로 영향이 없다 (NFR-PDK-2) |
