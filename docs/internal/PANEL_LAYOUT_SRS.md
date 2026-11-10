# SRS: 패널 레이아웃 — 탭별 상태와 저장 레이아웃 — IEEE 29148

> **문서 상태**: 승인·구현완료

## 1. 개요

### 1.1 목적

패널 배치 값이 저장되는 자리가 값마다 다르다. 사용자가 확인한 동작과 코드가 같다(§2). 그래서 같은 화면을 두 탭에서 쓰면, 어떤 값은 따라오고 어떤 값은 따라오지 않는다. 또 어떤 값은 새로고침해야 따라온다.

이 SRS 는 규칙을 하나로 정한다.

- 패널 배치는 **브라우저 탭마다** 따로다.
- 사용자는 지금 탭의 배치를 **레이아웃으로 저장**할 수 있다. 새 탭은 그 레이아웃으로 시작한다.
- 폭은 화면 폭에 대한 **비율**로 저장한다.

### 1.2 범위

**포함:** 사이드바 폭·접힘, Repo 사이드 폭·좌우, Activity 폭·열림, 앱 패널의 좌우·순서(도크). 데스크톱 화면.

**미포함:** §6.

### 1.3 정의

| 용어 | 정의 |
|---|---|
| **탭** | 브라우저 탭 하나. `sessionStorage` 의 범위와 같다. 새로고침하면 유지되고, 탭을 닫으면 사라진다 |
| **탭 상태** | 이 탭의 패널 배치 값. `sessionStorage` 에 둔다 |
| **저장 레이아웃** | 사용자가 저장한 배치. `localStorage` 키 `panelLayout` 에 둔다. 이 브라우저의 모든 탭이 함께 읽는다 |
| **씨앗 넣기** | 탭 상태가 없는 탭이 처음 열릴 때 저장 레이아웃을 탭 상태로 옮기는 일 |

### 1.4 참고

`PANEL_DOCK_SRS`(FR-PDK-3·5·7) · `SIDEBAR_COLLAPSE_SRS`(FR-SBC-4·6) · `UX_BATCH10_SRS`(FR-UXB-6) · `REPO_SIDE_WIDTH_SRS`(FR-RSW-5)

## 2. 현재 상태 (코드 근거)

| 값 | 저장 | 다른 탭에 반영 | 근거 |
|---|---|---|---|
| 사이드바 폭 | `sessionStorage` `sidebarWidth` | 안 됨 (탭별) | `constants.js` `sidebarWidthStore`, `index.html` 첫 페인트 |
| Repo 사이드 폭 | `sessionStorage` `repoSideWidth` | 안 됨 (탭별) | `app-editor-pane.js` `edSetSideWidth` |
| Activity 폭 | `localStorage` `agentsWidth` | 새로고침해야 | `input-binding.js` |
| 사이드바 접힘 | `localStorage` `sidebarCollapsed` | 새로고침해야 | `app-layout.js` `setSidebarCollapsed` |
| Activity 열림 | `localStorage` `agentsPanelOpen` | 새로고침해야 | `app-agents.js`, `input-binding.js` |
| 도크(좌우·순서) | `localStorage` `panelDock` | **즉시** (`storage` 이벤트) | `app-dock.js` `watchPanelDock` |
| Repo 사이드 좌우 | `localStorage` `repoSideDock` | **즉시** | 같은 곳 |

## 3. 요구사항

### 3.1 탭 상태

- **FR-PLY-1** 위 일곱 값은 모두 탭 상태다. `sessionStorage` 에 둔다. 키 이름은 지금 이름을 그대로 쓴다.
- **FR-PLY-2** 한 탭에서 바꾼 값은 다른 탭에 반영하지 않는다. 도크의 `storage` 이벤트 반영(FR-PDK-7)을 없앤다.
- **FR-PLY-3** 새로고침해도 탭 상태는 유지된다.

### 3.2 저장 레이아웃

- **FR-PLY-10** 저장 레이아웃의 모양은 다음과 같다. 없는 필드는 기본값이다.

  ```
  { v: 1,
    dock: {left:[…], right:[…]},       // FR-PDK-1 모양
    repoSide: 'left'|'right',
    sidebar:  {ratio, collapsed},
    repoSideW:{ratio},
    activity: {ratio, open} }
  ```

- **FR-PLY-11** `ratio` 는 저장할 때의 `패널 폭(px) ÷ window.innerWidth` 다. 0 보다 크고 1 보다 작은 수만 유효하다. 폭을 모르면(값이 없고 화면에도 없음) 필드를 뺀다.
- **FR-PLY-12** 설정 ▸ Display 에 「패널 레이아웃」 줄을 둔다. 버튼은 둘이다.
  - **저장**: 지금 탭의 배치를 저장 레이아웃으로 쓴다.
  - **기본값으로**: 저장 레이아웃을 지운다. 지금 탭의 화면은 바꾸지 않는다. 그 뒤 새 탭은 기본값으로 시작한다.
- **FR-PLY-13** 버튼을 누른 뒤 결과를 같은 줄에 짧게 보인다(저장함 / 지움).

### 3.3 씨앗 넣기

- **FR-PLY-20** 탭이 열릴 때, 이 탭에 씨앗 표지(`sessionStorage` `layoutSeeded`)가 없으면 씨앗을 넣고 표지를 세운다. 표지가 있으면(새로고침) 아무것도 하지 않는다.
- **FR-PLY-21** 씨앗은 저장 레이아웃의 값을 탭 상태 키에 쓴다. 비율은 `round(ratio × window.innerWidth)` px 로 바꾼다. 저장 레이아웃이 없거나 읽을 수 없으면 아무것도 쓰지 않는다(기본값).
- **FR-PLY-22** 씨앗 넣기는 첫 페인트 전에 끝난다. 사이드바 폭·접힘을 읽는 첫 페인트 스크립트(FR-SBC-5)보다 먼저 돈다.
- **FR-PLY-23** 폭을 읽는 자리는 범위를 벗어난 값을 **범위 끝으로 접는다.** 버리지 않는다. 다른 크기의 화면에서 비율을 px 로 바꾸면 범위를 벗어날 수 있기 때문이다. 범위는 지금 값 그대로다(사이드바 100~400, Activity 160~480, Repo 사이드 100~520).
- **FR-PLY-24** 비율은 탭이 열릴 때 한 번만 px 로 바꾼다. 그 뒤 브라우저 창 크기가 바뀌어도 px 를 유지한다(지금 동작).

### 3.4 옛 값 옮기기

- **FR-PLY-30** 저장 레이아웃이 없고 옛 `localStorage` 값(`panelDock`·`repoSideDock`·`sidebarCollapsed`·`agentsPanelOpen`·`agentsWidth`)이 하나라도 있으면, 씨앗 넣기 전에 그 값으로 저장 레이아웃을 한 번 만든다. `agentsWidth` 는 그때의 `window.innerWidth` 로 비율을 낸다. 그 뒤 옛 키를 지운다.
- **FR-PLY-31** 그래서 업데이트 뒤 첫 탭은 지금과 같은 배치로 열린다.

### 3.5 비기능

- **NFR-PLY-1** 저장 레이아웃의 해석·씨앗 계산·옛 값 옮기기는 DOM 이 없는 순수 함수로 두고 단위 시험한다.
- **NFR-PLY-2** 저장 레이아웃이 없는 첫 탭의 화면은 지금 기본값과 같다. 기존 e2e 가 통과한다.
- **NFR-PLY-3** 모바일(`body.mobile`)은 지금처럼 도크·Repo 사이드 좌우를 적용하지 않는다(FR-PDK-15). 값은 저장된다.

## 4. 설계

| 자리 | 내용 |
|---|---|
| `web/js/core/panel-layout.js` (새 파일) | 순수 함수: `layoutParse`·`layoutSeed`(저장 레이아웃 → 탭 상태 키·값)·`layoutFromLegacy`·`layoutCapture`(탭 상태 → 저장 레이아웃). 브라우저에서는 첫 페인트 전에 씨앗 넣기를 한 번 돈다 |
| `index.html` | `panel-layout.js` 를 `<head>` 의 첫 페인트 스크립트 **앞**에 동기로 싣는다. 첫 페인트 스크립트는 접힘을 `sessionStorage` 에서 읽고 폭을 범위로 접는다 |
| `pref-store.js` `STORE_KEYS` | 다섯 키를 "session — 이 탭의 시선" 쪽으로 옮긴다 |
| `app-layout.js`·`app-agents.js`·`app-dock.js`·`input-binding.js` | `PrefStore.local` → `PrefStore.session`. `watchPanelDock` 를 지운다. Activity 폭은 범위로 접는다 |
| `app-settings*.js`·`index.html`·i18n | 설정 ▸ Display 의 「패널 레이아웃」 줄과 두 버튼 |

`panel-layout.js` 는 다른 스크립트보다 먼저 돌기 때문에 `constants.js`·`PrefStore` 를 쓸 수 없다. 키 이름은 그 파일 안에 적고, `STORE_KEYS` 와 같은지 단위 시험이 확인한다.

### 결정

| ID | 결정 | 이유 |
|---|---|---|
| D-PLY-1 | 패널 배치는 탭마다 따로다 | 사용자 결정 (2026-11-10). 값마다 범위가 달라 동작을 예측할 수 없었다 |
| D-PLY-2 | 새 탭은 사용자가 **명시적으로 저장한** 레이아웃으로 시작한다 | 사용자 결정. 자동 저장이면 여러 탭을 오갈 때 무엇이 저장됐는지 알기 어렵다 |
| D-PLY-3 | 저장 레이아웃은 이 브라우저(`localStorage`)에 둔다 | 사용자 결정. 기기마다 원하는 배치가 다르다 |
| D-PLY-4 | 폭은 비율로 저장하고, 탭을 열 때 한 번만 px 로 바꾼다 | 사용자 결정. 화면 크기가 달라도 모양이 유지된다. 창 크기 변경을 따라가면 끌어서 정한 폭이 움직인다 |

## 5. 검증

| TC | 대상 | 방법 | 기대 |
|---|---|---|---|
| TC-PLY-1 | FR-PLY-10·11 | 단위: `layoutCapture`·`layoutParse` 왕복, 잘못된 값 | 비율이 저장되고, 잘못된 필드는 빠진다 |
| TC-PLY-2 | FR-PLY-20·21·23 | 단위: `layoutSeed` 를 다른 `innerWidth` 로 | px 로 바뀌고 범위로 접힌다. 표지가 있으면 쓰지 않는다 |
| TC-PLY-3 | FR-PLY-30 | 단위: 옛 키만 있는 저장소 | 저장 레이아웃이 생기고 옛 키가 지워진다 |
| TC-PLY-4 | FR-PLY-2 | e2e: 두 탭, 한 탭에서 도크·폭·Activity 를 바꿈 | 다른 탭은 그대로다 |
| TC-PLY-5 | FR-PLY-12·20 | e2e: 저장 → 새 탭 | 새 탭이 저장한 배치로 열린다. 기본값으로 → 새 탭은 기본값 |
| TC-PLY-6 | FR-PLY-3 | e2e: 바꾸고 새로고침 | 유지된다 |

## 6. 비목표

- 저장 레이아웃을 서버·다른 기기와 나누기 (D-PLY-3)
- 레이아웃 여러 개 (이름 붙인 프리셋)
- 창 크기 변경에 따라 폭을 비율로 다시 맞추기 (D-PLY-4)
- 모바일 배치

## 7. 위험

| ID | 위험 | 등급 | 대응 |
|---|---|---|---|
| R-PLY-1 | 첫 페인트 전 스크립트가 늘어 첫 화면이 늦어진다 | LOW | 작은 동기 스크립트 하나다. 저장소 읽기 몇 번이다 |
| R-PLY-2 | 옛 값을 옮기지 못하면 사용자의 배치가 기본값으로 돌아간다 | MEDIUM | FR-PLY-30 과 TC-PLY-3 |
| R-PLY-3 | 기존 e2e 가 `localStorage` 의 옛 키로 배치를 세운다 | MEDIUM | 그런 e2e 를 찾아 탭 상태로 바꾼다 |

## 8. 변경 기록

- 2026-11-10 초안·승인 (사용자 결정 D-PLY-1~4). 구현
