# SRS: 리팩토링 3차 P3a 단계 9 — App mixin 을 주제별 `Controller` 로 — IEEE 29148

> **문서 상태**: 승인·구현중
> **남은 것**: 하위 이슈 9k-1~3 구현과 시험(§1.2 대로 나눈다)

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
| 9e | **공유 상태 설계** — 공유 필드의 주인과 읽기·쓰기 입구를 정하는 SRS 개정(이 문서 §2.2 를 채운다). 코드 변경은 시험이 보장하는 접근자 도입까지 | — | 설계 이슈. 실측 결과 접근자가 필요한 필드가 없어 코드 변경은 없다(§2.2 SH-6) |
| 9f | 상태 동기화·재로드 — `app-ws-sync.js` 459줄/13 · `app-reload.js` 138/6 (597줄) | 19 | 뿌리 `WsSyncController`(옛 `app-ws-sync.js`) + 부품 하나(재로드). 접근자 넷(`_sse` 등)은 파일 끝에 남는다. 남은 묶음이 부르는 수가 가장 적다(6) — 9e 의 입구를 처음 쓰는 소비자 |
| 9g | 포커스·창 소유 — `app-focus.js` 341/24 · `app-focus-hl.js` 92/6 · `app-focus-owner.js` 248/10 (681줄) | 40 | 뿌리(옛 `app-focus.js`) + 부품 둘(강조·창 소유). `focused` 쓰기 모음(§2.2) |
| 9h | 슬롯 — `app-slots.js` 776/41 | 41 | 둘로 나눈다: 상태·칸별 활성 탭·신원·영속(약 290줄) / 더하기·빼기·포커스·배치·창 전환·회수·배선·손잡이(약 460줄). 접근자 `slots`·`slotDir` 은 파일 끝에 남는다 |
| 9i | 레이아웃 — `app-layout.js` 967/45 · `app-dock.js` 105/10 · `app-dnd.js` 204/9 · `app-groups.js` 270/24 · `app-window-state.js` 106/5 · `app-presets.js` 51/2 · `app-tab-reopen.js` 121/11 (1,824줄) | 106 | **두 이슈로 나눈다.** 9i-1: `app-layout.js` 하나 — 뿌리(창: 되돌아갈 자리·이름·창 더하기·지우기·되돌리기·전환, 약 410줄) + 부품 둘(탭 더하기 약 160줄 / 탭 닫기·전환·분할·이동·사이드바 약 400줄). 9i-2: 나머지 여섯 파일을 9i-1 뿌리의 부품으로(프리셋 51줄은 창 상태와 한 부품). 남은 묶음 중 다른 묶음을 가장 많이 부른다(135곳) |
| 9j | 도구·커맨드·작업 — `app-tool.js` 591/24 · `app-cmd.js` 375/20 · `app-work.js` 75/7 · `app-search.js` 114/11 (1,155줄) | 62 | 뿌리(옛 `app-tool.js` 의 샌드박스·도구 만들기, 약 410줄) + 부품: 도구 수명(백그라운드·복원·죽이기, 약 180줄) · 커맨드 · 작업 표식 · 검색. 다른 묶음이 가장 많이 부르는 묶음 둘 중 하나(64곳) |
| 9k | 편집기 145 · Repo 창 19 — `app-editor*.js` 여덟 · `app-edsearch.js` · `app-docrender.js` (2,623줄) · `app-diff-tab.js` 174/14 · `app-preview.js` 71/5 (245줄) | 164 | **세 이슈로 나눈다.** 9k-1 편집기 창·탐색기(`app-editor.js` 115 · `-open` 445 · `-pane` 324 · `-section` 170 · `-sync` 334 · `-watch` 121 — 1,509줄, 86) · 9k-2 문서·파일·검색·문서 렌더(`-doc` 361 · `-file` 217 · `app-edsearch.js` 312 · `app-docrender.js` 224 — 1,114줄, 59) · 9k-3 Repo 창(Diff 탭·미리보기 — 245줄, 19). 끝나면 mixin 0 |

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

### 2.2 공유 상태 (9e, HEAD `76102202` 실측)

**잰 것.** 남은 mixin 29파일을 묶음 일곱(9f·9g·9h·9i·9j·9k 편집기·9k Repo 창)으로 나누고, 각 파일의 App 메서드 본문에서 `this.X`(메서드가 아닌 이름)를 acorn 으로 셌다 — 재대입(`=`·`++`·`delete`)은 **쓰기**, 속을 바꾸는 것(`this.X.y=`·`.set`·`.delete`·`.push` 등)은 **변경**, 나머지는 **읽기**다. 함께 센 것: `app.js` 의 App 본문 · 컨트롤러(9a~9d)의 `this.app.X` · 바깥(`ui/`·`git/`·`core/` 의 다른 클래스)의 `app.X`·`this.app.X` · e2e 의 `app.X`(덮어쓰기는 `app.X =`) · 계약(`app-testing.js`).

| 갈래 | 수 |
|---|---:|
| 남은 묶음이 닿는 App 필드 | 80 |
| 묶음 둘 이상이 닿는 필드 | 19 |
| 묶음 하나만 닿지만 App 본문·컨트롤러·바깥·e2e·계약이 읽거나 쓰는 필드 | 28 |
| **공유 필드(아래 표)** | **47** |
| 묶음 하나만 닿고 다른 누구도 닿지 않는 필드(그 묶음의 컨트롤러가 가져간다) | 33 |

§1.1 의 「공유 필드 43」 은 주제 일곱(git 포함)으로 센 것이다. git 이 9d 로 빠졌고 기준을 위처럼 넓혀 다시 셌다.

**원칙.**

| ID | 원칙 |
|---|---|
| SH-1 | **App 이 공용 상태의 주인이다(조립자).** 바깥(`ui/`·`git/`·컨트롤러)·계약·e2e 가 읽거나 덮어 쓰는 필드, 묶음 셋 이상이 읽는 필드, App 본문(`app.js` 의 저장·부팅 경로)이 쓰는 필드, 기반 시설(`timers`·`bus`·`renderer`·`clientId`·`isMobile`)은 App 에 남는다. 입구는 지금 그대로 `app.X`·`this.app.X` 다 |
| SH-2 | App 에 남는 필드라도 **쓰기는 한 묶음**이다. 쓰는 묶음이 하나면 그 묶음의 컨트롤러 메서드만 쓴다(다른 묶음은 읽기만). 쓰기가 여러 묶음에 흩어진 필드는 표의 「쓰기 모음」 칸이 정한다 — 모으면 주인 컨트롤러의 메서드 하나로 모으되 **본문은 옮기기만** 한다(동작 변경 없음). 판정이 자리마다 다르면 모으지 않는다 |
| SH-3 | 한 묶음만 쓰고 다른 묶음은 읽기만 하며 바깥·계약·e2e 가 닿지 않는 필드는 그 묶음이 주인이고, 읽는 묶음은 App 접근자(`Object.defineProperties`)로 읽는다. 이번 실측에서 이 갈래에 드는 필드는 없다 — 그런 후보(`_lastEditorWindow`)는 같은 자리에서 함께 쓰이는 짝(`_lastPlainWindow`, 계약)을 따라 App 에 둔다 |
| SH-4 | 묶음 하나만 닿는 필드는 그 묶음의 컨트롤러(또는 부품)가 소유한다(FR-FEA-2). App 생성자의 선언은 컨트롤러 생성자로 옮긴다 |
| SH-5 | 덮어쓰기 대상(e2e·단위가 `app.X =` 로 갈아 끼우는 필드)은 App 인스턴스의 필드로 남는다 — 접근자로 바꾸면 쓰기가 주인에 닿는지 시험으로 보여야 한다(INV-A2). 이번 표에서 그런 필드(`ws`·`focused`·`toolIds`·`wsETag`·`slotDir` 등)는 모두 App 에 남으므로 접근자가 필요 없다 |
| SH-6 | 9e 는 코드를 바꾸지 않는다. 표가 접근자를 요구하는 필드가 없고, 「쓰기 모음」 은 그 묶음의 하위 이슈가 옮길 때 한다 |

**입구 표기**: **A** App 에 남기고 그대로 읽고 쓴다 · **A/9x** App 에 남기고 쓰기는 9x 컨트롤러의 메서드만 · **C/9x** 9x 컨트롤러가 가져간다(App 에서 사라진다) · **M/9x** 쓰기를 9x 컨트롤러 메서드로 모은 뒤 9x 가 가져간다.

| 필드 | 주인 | 쓰는 묶음 (재대입·변경) | 읽는 묶음 | 바깥이 닿는가 | 입구 | 쓰기 모음 |
|---|---|---|---|---|---|---|
| `ws` | App | 9f(재대입 — 서버 스냅샷 채택) · `app.js`(생성자·저장) / 변경 9i·9k | 9g·9h·9j·9k Repo | 컨트롤러 9·`ui/` 5·`git/` 3·e2e 236 읽기·단위 덮어쓰기 | A/9f(재대입) | 모으지 않는다 — 속 변경은 레이아웃 트리 함수(9i)와 편집기 재조정(9k)이 각자 판정한다 |
| `focused` | App | 9g(`setFocus`) · 9i(탭·창을 닫을 때 `null` 둘) · `app.js` | 9j·9k·9k Repo | 컨트롤러 3·`ui/` 4·e2e 48 읽기·1 덮어쓰기 | A/9g | **모은다** — 9i 의 `null` 대입 둘을 9g 의 메서드 하나로(9g 가 만들고 9i 는 `this.app.X()` 로 부른다) |
| `tools` | App | 변경 9f·9j·9h · `app.js` | 9g·9i | 컨트롤러 3·`core/` 2·`ui/` 6·e2e 58 | A | 모으지 않는다 — 9f(서버가 모르는 도구)·9j(도구 하나의 칸 키 전부)·9h(사라진 칸의 사본)의 판정이 다르다 |
| `toolIds` | App | 변경 9f·9j · `app.js` | 9i·9k | 컨트롤러 1·`main.js`·e2e 3 읽기·1 덮어쓰기 | A | 위와 같다 |
| `_toolsBoot` | App | 변경 9f·9j · `app.js` | — | 없음 | A | `toolIds` 와 같은 줄에서 함께 지운다 — 짝을 가르지 않는다 |
| `timers` | App | `app.js` | 9h·9i·9j·9k | `core/` 6·컨트롤러·`ui/`·e2e | A | — |
| `bus` | App | `app.js` | 9f·9g·9h | `core/`·컨트롤러·`git/`·`ui/`·e2e 15 | A | — |
| `renderer` | App | `app.js` | 9f·9g·9k | `core/`·컨트롤러·`git/`·`ui/`·e2e 6 | A | — |
| `clientId` | App | `app.js` | 9f·9g·9h·9k | `core/` 3·컨트롤러 2·`git/`·e2e 7 | A | — |
| `isMobile` | App(접근자) | — | 9g·9h·9i | 컨트롤러 7·`core/` 2·`git/` 6·`ui/` 8·e2e | A | — |
| `gitPanels` | App | 9k Repo(Diff 탭 패널) · 9d `GitSurfaces` | 9g·9i | 계약·컨트롤러 3·`ui/` 2 | A | 모으지 않는다(9e) — 키 규칙(`_gitPanelKey`·`GIT_DIFF_TAB_SEP`)을 git 등록부와 Diff 탭이 함께 쓴다. 9k Repo 를 옮길 때 Diff 탭 패널의 생성·회수를 `GitSurfaces` 로 모을지 다시 본다 |
| `fileEditors` | App | 변경 9h(칸 회수)·9k Repo(미리보기 닫기) · `app.js` | 9k | 컨트롤러·`ui/` 4·e2e 110 | A | 모으지 않는다 — 회수 판정이 다르다 |
| `_slots` | App | 9h · `app.js` | 9g | 계약·컨트롤러(attn) | A/9h | — |
| `slotDir` | App(접근자) | 9h(접근자 정의) | 9h | `core/`·`ui/`·e2e 3 읽기·3 덮어쓰기 | A — 접근자 정의는 9h 컨트롤러 파일 끝으로 옮긴다(본문의 `this` 는 App) | — |
| `_edTrees` | App | 9k | 9f | 계약 | A/9k | — |
| `gitPanel` | App(접근자, 9d) | — | 9f·9k | 컨트롤러·`core/`·`git/` 4·e2e 155 | A | — |
| `editors` | App | 9k · `app.js` | 9f | 계약·`ui/` | A/9k | — |
| `focusHandoff` | App | 9k·9k Repo | — | `ui/` 3 | A/9k | 같은 이슈 안의 두 부품이 쓴다 — 9k 뿌리 컨트롤러의 메서드 하나로 모은다 |
| `fgNames` | App | 9f | 9j | 계약·컨트롤러·`ui/` 2 | A/9f | — |
| `_lastEditorWindow` | App | 9i · `app.js` | 9k | 없음 | A/9i | SH-3 후보지만 짝 `_lastPlainWindow` 와 같은 메서드(`_rememberReturn`)가 쓴다 — 짝을 가르지 않는다 |
| `_lastPlainWindow` | App | 9i · `app.js` | — | 계약·컨트롤러(git)·`core/`(설정 프리셋) | A/9i | — |
| `_edDocs` | App | 9k | — | 계약·`core/`(LSP)·단위 | A/9k | — |
| `edStores` | App | 9k | — | 계약·컨트롤러(claude-maps)·`ui/` | A/9k | — |
| `_edOff` | App | 9k · `app.js` | — | 계약 | A/9k | — |
| `_edGitPoll` | App | 9k | — | 계약 | A/9k | — |
| `_edGitHeld` | 9k | 9k(갚을 때 `null`) · 9d `GitSync._onGitChanged`(숨은 동안 쌓는다) | — | 컨트롤러(git-sync) | M/9k | **모은다** — `GitSync` 의 쌓기를 9k 메서드 하나(예: `_edGitHold(repo,mark)`, App 위임자)로 옮기면 필드는 9k 의 것이 된다 |
| `mPaneIdx` | App | 9i · `app.js` | — | 계약·컨트롤러(모바일 둘)·`ui/` 2·e2e | A/9i | — |
| `drawerOpen` | App | `app.js` · `ui/drawer-sheet.js` | 9i | 컨트롤러 4·`ui/` 2 | A | — |
| `sbTab` | App | `app.js` · `ui/sidebar-tab-bar.js` | 9i | 계약·컨트롤러 2·`ui/` | A | — |
| `_attn` | App | `app.js` | 9g | 계약·컨트롤러 3·`core/` | A | — (9b 가 App 에 남겼다) |
| `_activity` | App | `app.js` | 9j | 계약·컨트롤러 3 | A | — (9c 가 App 에 남겼다) |
| `_bg` | App | 9j · `app.js` | — | 계약·컨트롤러 2 | A/9j | — |
| `_runs` | App | `app.js`(지연 생성) | 9h | 단위 | A | — (9a 가 App 에 남겼다) |
| `windowFocused` | App | 9g · `app.js` | — | 계약·`ui/` | A/9g | — |
| `_windowFocusOwner` | App | 9g · `app.js` | — | 계약 | A/9g | — |
| `prevFocus` | App | 9g | — | `ui/`(renderer) | A/9g | — |
| `wsETag` | App | 9f · `app.js`(저장) | — | e2e 3 읽기·1 덮어쓰기 | A | 모으지 않는다 — 저장(App 본문)과 채택(9f)이 각자 받은 ETag 를 적는다 |
| `_wsDeferRev` | App | 9f · `app.js`(저장) | — | 없음 | A | 저장 경로(`app.js` `save`)가 함께 쓴다 — 저장이 App 본문에 있는 동안 App 에 둔다 |
| `_wsApplyPending` | App | 9f · `app.js`(저장) | — | 없음 | A | 위와 같다 |
| `_wsApplyInflight` | App | 9f | — | 계약 | A/9f | — |
| `_saveInflight` | App | `app.js`(저장) | 9f | 계약 | A | — |
| `_sseKick` | App | 9f | — | 계약 | A/9f | — |
| `_sse` | App(접근자) | — | 9f | 계약 | A — 접근자 넷(`_sse`·`_cmdES`·`_sseGen`·`_sseSeen`)의 정의는 9f 컨트롤러 파일 끝으로 옮긴다 | — |
| `_slotRenderPending` | App | 9h · `app.js` | — | 계약 | A/9h | — |
| `_slotIds` | 9h | 9h · `app.js`(선언만) | — | 없음 | C/9h | — |
| `_slotSse` | 9h | 9h · `app.js`(선언만) | — | 없음 | C/9h | — |
| `_winUndo` | 9i | 9i · `app.js`(선언만) | — | 없음 | C/9i | — |

**주인별 분포**: App 43(그중 쓰기를 한 묶음으로 정한 것 A/9x 21 — 9f 4·9g 4·9h 2·9i 3·9j 1·9k 7) · 9h 2 · 9i 1 · 9k 1(쓰기를 모은 뒤). 쓰기를 모으는 필드 셋: `focused`(9g) · `focusHandoff`(9k) · `_edGitHeld`(9k).

**묶음 하나만 닿는 필드 33**(SH-4 — 그 묶음의 컨트롤러로 옮긴다): 9f `_softReloading` · 9g `_navBack`·`_navFwd`·`_navCur`·`_navMoving`·`_fhlPend`·`_fhlAt`·`_fhlTarget`·`_afcAt` · 9h `_slotRenderArmed` · 9i `_tabClosed`·`_splitChain`·`_dockShown`·`_wgFold`·`_wgSeenActive`·`sidebarPanel`·`_sbTabs` · 9j `_workSig` · 9k `_edReveal`·`_edLastActive`·`_edTreeFsHits`·`_edTreeFsTimer`·`_edStampsBusy`·`_edStampsOff`·`_edHeldKey`·`_edWatchOff`·`_edWatchKey`·`_edWatchBusy`·`_edWatchAgain`·`_edWatchLive`·`_edDocReloads`·`_edPanelEl`·`_edClip`. 9k 는 부품이 여럿이므로 필드마다 쓰는 부품이 주인이고, 다른 부품은 `this.app.<뿌리>.<부품>.X` 로 읽는다(9c 의 `_chatStore` 와 같은 꼴).

**9f~9k 에 넘기는 함정.**

- 접근자를 정의하는 `Object.defineProperties(App.prototype,…)` 블록(`app-slots.js` 의 `slots`·`slotDir`, `app-ws-sync.js` 의 `_sse` 넷)은 컨트롤러 클래스로 옮기지 않는다. 컨트롤러 파일 끝에 두고 본문은 App 의 `this` 를 `const app=this` 로 받는다 — TC-FEA-2 의 소스 검사가 파일 안의 `this.X` 를 컨트롤러 것으로 읽는다(9d 의 `gitPanel`). `/tmp/fea/conv.mjs`·`plan.mjs` 는 9d 에서 `Object.assign` 블록만 읽도록 고쳤다
- `app.js` 의 저장 경로(`save`)가 `_wsDeferRev`·`_wsApplyPending`·`wsETag`·`_saveInflight` 를 쓴다 — 9f 가 이 필드들을 가져가면 저장이 깨진다
- 9d 의 `GitController.gitSignal` 이 편집기 후속 `_edAfterGitSignal` 을 App 에서 부른다 — 9k 는 이 이름을 위임자로 남겨야 한다. `GitSync._onGitChanged` 는 `_edOnGitChanged`·`_edGitHeld` 를 App 에서 부른다
- 단위 시험이 App 인스턴스에 필드를 바로 쓴다(`a.ws=`·`a.focused=`·`a.tools=` 등). 필드를 컨트롤러로 옮기면 그 시험을 함께 고친다
- `app.js`(759줄)는 이미 500줄을 넘는다 — 위임자는 컨트롤러 파일 끝의 표로 둔다(9a)
- e2e 를 고르는 셸이 zsh 면 `$S` 처럼 따옴표 없는 변수가 낱말로 갈리지 않는다 — 목록은 파일로 받아 `xargs` 로 넘긴다

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
| 9b | `8d302fd8` | 파일은 `git mv` 뒤 acorn 으로 `this.X` 를 갈랐다(자기 메서드·소유 필드 `this.X` · 같은 묶음의 다른 부품은 그 부품 경로 `this.center.X`·`this.maps.X`·`this.enc.X`, 부품에서 뿌리로는 위임자 `this.app.X` 또는 위임자가 없으면 `this.app.attn.X` · 덮어쓰기 대상·계약은 자기 메서드여도 `this.app.X` · 나머지 `this.app.X`). **알림** `AttnController`(`attn-controller.js` 487, 옛 `app-attn.js` 23 메서드) → `app.attn`, 부품 `AttnCenter`(`attn-center.js` 109, 6) `.center` · `AttnClaim`(`attn-claim.js` 54, 3) `.claim`. **Claude 계정** `ClaudeAccountsController`(`claude-accounts-controller.js` 279, 20) → `app.claude`, 부품 `ClaudeMaps`(`claude-maps.js` 261, 15) `.maps`. 옛 `app-claude-accounts.js` 의 순수 함수·상수(약 225줄)는 `claude-accounts-view.js`(237)로 갈랐다 — 그대로 두면 컨트롤러 파일이 500줄을 넘는다. **상태바** `StatusBarController`(`statusbar-controller.js` 469, 18) → `app.statusbar`, 부품 `StatusBarEnc`(`statusbar-enc.js` 80, 6) `.enc`. 셋 다 App 생성자가 만든다. **위임자 40**: attn 17 · claude 7 · claude.maps 6 · statusbar 10. 부품 메서드는 위임자가 없다(묶음 밖에서 부르지 않는다) — App 에서 걷은 이름 51(9b 커밋의 「54」 는 셈을 잘못했다). **옮긴 필드**: `_attnNotifs`(App 생성자에서 `AttnController` 생성자로)·`_attnTyped`·`_attnPermAsked`·`_attnInteractBound`·`_audioCtx` · `_claudeAcctActiveId`·`_claudeAcctPopEsc`·`_claudeAcctPopWired` · `_claudeNormMap`·`_claudeRepaintArmed`·`_claudeToolCwd`(maps) · `_bgConfirm`·`_bgError`·`_bgPending`·`_cwdTool`·`_sbRo`·`_statsPoll`. **App 에 남긴 필드**: `_attn`(포커스·제목·상태 등록부) · `_claudeAccts`·`_claudeMaps`·`_claudeAcctPopId`·`_claudeAcctAuto`·`_claudeAcctOtherSl`(활동 패널·시험이 갈아 끼운다) · `_stats`(계약)·`_latency`(모바일)·`_bg`. 주인: 팝오버 자리 잡기 `TIMERS.frame(…,{owner:this})` 는 `owner:this.app` 으로 두었다(종전 주인 그대로). `owner:'app'` 문자열은 건드리지 않았다. `SETTINGS_INIT` 의 `'initStatusBar'`·`'initAttn'` 은 App 위임자 이름 그대로라 표·`BOOT_ORDER` 가 바뀌지 않는다(FR-FEA-6). 몽키패치 해당 없음. `Object.assign(App.prototype` 47 → 40. **SRS 와 다르게 한 것**: ① 순수 함수 파일 `claude-accounts-view.js` 를 새로 두었다(크기) ② 부품 메서드를 부르던 단위 시험은 부품을 부르거나(`app.claude._claudeAcctPopToggle`·`app.claude.maps._claudeMapsLoad`·`app.attn.center._attnCenterClose`) 시험 안에서 앱에 이어 붙인다(`attn-center`·`attn-claim`). 시험: `app-controllers.test.mjs` 9b 7건(TC-FEA-1~3 — 덮어쓰기 표본 `_attnClear`·`_claudeAcctRestore`·`updateStatusBar`), `app-state-owners` 의 계약 검사를 위임자 표 훑기로 바꿨다, 경로·부품을 고친 단위 시험 10(`attn-center`·`attn-claim`·`claude-accounts-foot`·`claude-accounts-map`·`claude-accounts-settings`·`activity-state-subagent`·`app-git-lists`·`escape-menu`·`window-state`·`app-state-owners`). 단위 1275. e2e 23 spec 200 — 199 통과·1 흔들림(`settings.spec.ts` 이름 거절, 알려진 것)(attention 다섯·background 둘·bg-kill 둘·claude-accounts·editor-encoding·git-statusbar·perf-statusbar·status-bar-reflow·statusbar-xss·tooltips·update-notice·settings·window-groups·runs·sse-resilience·event-timer-hub-contract·tab-names) |
| 9c | `03b1717d` | 9b 와 같은 방식이다(`git mv` 뒤 acorn 으로 `this.X` 를 가른다 — 같은 묶음의 위임자 없는 이름은 부품 경로, 덮어쓰기 대상·계약은 `this.app.X`). 어느 이름에 위임자를 둘지는 실측했다 — 묶음 밖의 `web/`·`e2e` 가 `.이름`·`'이름'` 으로 쓰거나 계약·덮어쓰기 대상이면 둔다(주석만 있는 것은 빼고). **채팅** `ChatController`(`chat-controller.js` 229, 옛 `app-chat.js` 21) → `app.chat`, 부품 `ChatWindow`(`chat-window.js` 130, 9) `.window` · `ChatHuman`(`chat-human.js` 175, 12) `.human` · `ChatViews`(`chat-views.js` 176, 옛 `ui/chat-view.js` 12) `.views`. `ui/chat-view.js` 는 부품이 되면 `this.app._chat*` 를 부르므로 계층 게이트(`check-layer.sh`: `ui/`·`git/` 의 `app._x` 금지)에 걸린다 — `core/` 로 옮겼다. **활동·에이전트** `AgentsController`(`agents-controller.js` 454, 옛 `app-agents.js` 19) → `app.agents`, 부품 `AgentsSub`(`agents-sub.js` 98, 4) `.sub` · `ActivityList`(`activity-list.js` 349, 옛 `app-activity.js` 16) `.list`. **모바일** `MobileController`(`mobile-controller.js` 493, 24) → `app.mobile`, 부품 `MobileNav`(`mobile-nav.js` 142, 7) `.nav` · `MobileSheets`(`mobile-sheets.js` 149, 7) `.sheets`. 셋 다 App 생성자가 만든다. **위임자 53**: chat 6 · chat.window 4 · chat.views 2 · agents 12 · agents.sub 1 · agents.list 8 · mobile 15 · mobile.nav 3 · mobile.sheets 2. App 에서 걷은 이름 78. **옮긴 필드**: `_chatStore`·`_chatSeq`·`_chatRoomOrder`·`_chatRoomsSel`(chat, 앞의 둘은 `ChatHuman` 도 `this.app.chat.X` 로 쓴다) · `_chatViews`(views) · `_actFails`·`_agFold`(agents) · `activityPanel`(list) · `_drawer`·`_mKbOff`·`_mkbRO`(mobile) · `_settingsDetailEsc`·`_settingsOverlayMo`(sheets). **App 에 남긴 필드**: `_chat`(시험) · `_activity`·`_limits`·`_bg`(계약·작업 표식·시험) · `mPaneIdx`·`modKbd`·`_mKbH`(계약·e2e) · `drawerOpen`(렌더러·서랍). 맨 `this` 다섯: 구역 서술자 `sec.items(this.app)`·`sec.badge(this.app,…)` · `new ActivityPanel(this.app)` · `new DrawerSheet(this.app,…)` · 채팅 읽음 표시 `TIMERS.defer(…,{owner:this})` 는 `owner:this.app`(종전 주인 그대로). `SETTINGS_INIT` 의 `'initMobile'`·`'initMobileKeybar'` 는 App 위임자 이름 그대로라 표·`BOOT_ORDER` 가 바뀌지 않는다(FR-FEA-6). 몽키패치 해당 없음. `Object.assign(App.prototype` 40 → 30. 하네스에 묶음 상수 `AGENTS`·`CHAT`·`MOBILE` 과 `controllers(ctx, app)`(App 생성자가 세우는 뿌리 컨트롤러를 실은 것만 세운다)를 더했다. 다시 그리기 등록부(`PERFORMANCE_BUDGET.md`)의 `_mkbRender` 행 경로를 고쳤다. **SRS 와 다르게 한 것**: ① `ui/chat-view.js` 를 `core/chat-views.js` 로 옮겼다(계층) ② 단위 시험이 부르던 부품 메서드(`_actItems`·`_agSubagentEl`·`_agUsageEl`·`_chatS` 등)는 부품 경로로 고쳤다 — 위임자를 시험 때문에 두지 않는다. 시험: `app-controllers.test.mjs` 9c 7건(덮어쓰기 표본 `_chatRepaint`·`_chatViewsPaint`·`_runsPanel`·`_activityRestore`·`mobileChromeSync`), `app-state-owners` 계약 검사에 컨트롤러가 App 에 쓰는 필드(`this.app.X=`)를 더했다(`_mKbH`), 경로·부품을 고친 단위 시험 18. 단위 1282. e2e(9a·9b·9c 관련 전부 한 번) 68 spec 563 통과·재시도 0 — 9c 몫은 activity 셋·agent-card-focus·agent-render-env·chat-window·git-head-mobile·mobile 열·panel 다섯 |
| 9d | `76102202` | 9c 와 같은 방식이다(`git mv` 뒤 구간을 세 파일로 가르고 acorn 으로 `this.X` 를 가른다). **git** `GitController`(`git-controller.js` 356, 옛 `app-git.js` 23 — 창 종류 판정·Git 표면으로 가기·파일과 터미널 열기·GIT 섹션 배선·즉시 신호·허브) → `app.git`(이름이 비어 있었다), 부품 `GitSurfaces`(`git-surfaces.js` 271, 16 — 패널·관측기 등록부) `.surfaces` · `GitSync`(`git-sync.js` 361, 21 — Repo 목록 껍데기·변화 관측·핀·작업) `.sync`. App 생성자가 만든다. **위임자 42**: git 17 · git.surfaces 14 · git.sync 11. App 에서 걷은 이름 18(`_gitObsReap`·`_gitPanelOfTab`·`_gitLeaveIfRemoved`·`_gitLifecycle`·`_gitPlainTarget`·`_gitActiveRepo`·`_gitPaneOf`·`_anyTermToolId`·`_gitReposList`·`_startGitReposPoll`·`_gitReposOnChanged`·`_gitAddRepo`·`_gitRepoAt`·`_gitAddRepoRun`·`_gitReorder`·`_gitPinsSort`·`_gitJobsWanted`·`_gitJobsAdopt`). **옮긴 필드**: `_gitHub`(git) · `_reposList`·`_gitJobsDisplacer`(sync). **App 에 남긴 필드**: `gitPanels`·`_gitObservers`·`_gitWdAt`(계약·렌더러·e2e) · `_gitJobs`(상태바) · `_lastTermTool`·`_lastPlainWindow`·`gitRepos`·`_gitOff`(생성자 선언·바깥) · `_edGitHeld`(편집기가 쓴다). 접근자 `gitPanel` 은 App 원형에 남고 정의는 `git-controller.js` 끝이다(본문은 `const app=this` 로 읽는다 — TC-FEA-2 의 소스 검사가 접근자 안의 `this.X` 를 컨트롤러의 것으로 읽기 때문이다). 맨 `this` 셋: `new GitObserver(this.app)`·`new GitPanel(this.app,…)`·`new GitReposList(this.app)`. `owner:'git:lifecycle'` 문자열은 그대로다. **몽키패치(FR-FEA-5)**: `app-editor-pane.js` 끝의 IIFE 가 로드 시점에 `App.prototype.gitSignal` 을 감싸던 것을 없앴다. `GitController.gitSignal` 이 ① `gitStatusHub().invalidate()` ② 포커스 패널 `signal` ③ 편집기 후속 `app._edAfterGitSignal()`(`app-editor-pane.js` 의 mixin 메서드 — 활성 트리 `pollGit({now:true})`·열린 문서 `dd.refresh()`) 순으로 부른다. 효과와 순서는 감싸던 때와 같고 로드 순서 제약이 사라졌다(`index.html` 주석). 순서는 `app-controllers.test.mjs` 두 건이 고정한다. `Object.assign(App.prototype` 30 → 29. 500줄 초과 16 → 15(`FE_MODULE_BOUNDARY_SRS` §7.1 기준선 갱신). **SRS 와 다르게 한 것**: ① 감싸기를 컨트롤러 쪽에서 다시 감싸지 않고 호출 하나로 바꿨다(편집기 후속은 편집기 묶음의 이름 `_edAfterGitSignal` — 9k 가 옮길 때 위임자로 남겨야 한다) ② 창 종류 판정(`isGitWin`·`isChatWin`·`isKindWin`·`plainWindows`·`gitWindow`)은 주제로는 레이아웃이지만 파일 경계대로 `GitController` 에 두었다 ③ FR-ASE-8 시험의 「App 에 껍데기 넷과 지연 생성」 은 「`GitSync` 에 껍데기 넷과 지연 생성, App 에 위임자 둘(`gitReposKick`·`gitReposRefresh`)」 로 고쳤다 ④ 도구 `plan.mjs`·`conv.mjs` 가 `Object.defineProperty(App.prototype,…)` 를 mixin 블록으로 읽던 것을 `Object.assign` 만 읽게 고쳤다. 부르는 곳이 없는 `_gitAddRepo`·`_gitReorder` 는 그대로 옮겼다(지우는 것은 범위 밖). 시험: `app-controllers.test.mjs` 9d 10건(덮어쓰기 표본 `plainWindows`·`gitReposRefresh`·`gitSignal`·`_gitObservers`, FR-FEA-5 순서 둘), 하네스에 묶음 상수 `GIT` 과 `controllers` 의 `git`, 경로·부품을 고친 단위 시험 4(`app-git-lists`·`app-state-owners`·`chat-window`·`editor-git-changed`). 단위 1292. e2e(git 관련 63 spec + `editor-explorer`·`editor-link`) 702 — 701 통과·1 실패(`git-ui-metrics` V80, 알려진 것)·재시도 0 |
| 9e | `752facd8` | 설계만 — §2.2 를 채웠다(공유 필드 47·묶음 하나만 닿는 필드 33, 원칙 SH-1~6, 주인 App 43·9h 2·9i 1·9k 1, 쓰기 모음 셋 `focused`·`focusHandoff`·`_edGitHeld`). §1.2 의 9f~9k 를 실측 줄 수·메서드 수·부품 나누기로 고쳤다(9i 둘·9k 셋으로). 접근자가 필요한 필드가 없어 코드는 바꾸지 않았다(SH-6). 도구 `/tmp/fe9e/scan.mjs`(필드)·`calls.mjs`(묶음 사이 호출) |
| 9f | `baf3f9db` | 9d 와 같은 방식이다(`git mv` 뒤 acorn 으로 `this.X` 를 가른다). **상태 동기화** `WsSyncController`(`ws-sync-controller.js` 471, 옛 `app-ws-sync.js` 13) → `app.wsSync`(이름이 비어 있었다), 부품 `SoftReload`(`soft-reload.js` 143, 옛 `app-reload.js` 6) `.reload`. App 생성자가 만든다. **위임자 14**: wsSync 12 · wsSync.reload 2(`softReload`·`_initSoftReload`). App 에서 걷은 이름 5(`_wsDefer`·`_softStep`·`_softStepAsync`·`_softReconnectTools`·`_softReloadPaint`). **옮긴 필드**: `_softReloading`(reload, SH-4). **App 에 남긴 필드**(§2.2 그대로): `wsETag`·`_wsDeferRev`·`_wsApplyPending`·`_saveInflight`(저장 경로가 쓴다) · `_wsApplyInflight`·`_sseKick`·`fgNames`(A/9f — 쓰기는 이 컨트롤러만, `this.app.X=`). 접근자 넷(`_sse`·`_cmdES`·`_sseGen`·`_sseSeen`)은 App 원형에 남고 정의는 `ws-sync-controller.js` 끝이다(본문 `const app=this`). 맨 `this` 하나: `wireStateRegistry(this.app)`. `owner:'app'` 문자열 다섯은 그대로다(D-FEA-4). 주석의 `this.ws=sv` 는 `this.app.ws=sv` 로 고쳤다(TC-FEA-2 의 소스 검사가 주석도 읽는다). e2e 합성 페이지 둘(`event-timer-hub-contract`·`sse-resilience`)은 기반(`Component`·`Controller`)과 두 파일을 싣고 대역에 `wsSync` 를 세운다. `Object.assign(App.prototype` 29 → 27. 500줄 초과 15 그대로. 몽키패치 해당 없음. **SRS 와 다르게 한 것** 없음. 시험: `app-controllers.test.mjs` 9f 9건(덮어쓰기 표본 `_onWorkspaceChanged`·`gitReposRefresh`·`render`·`softReload`·`_fgMap`·`_restoreNote`, 저장 경로 필드가 App 에 남는 것, 접근자 넷), 하네스에 묶음 상수 `WS_SYNC` 와 `controllers` 의 `wsSync`, 경로를 고친 단위 시험 4(`app-cmd-fg`·`app-cmd-split`·`app-git-lists`·`window-state`). 단위 1301. e2e 22 spec 277 — 275 통과·1 흔들림(`slot-view-state` TC-SVS-56, 알려진 것)·1 실패(`version-autoreload` TC-RLC-25 — 단독으로 HEAD `752facd8` 에서도 4/4 실패, 이번 변경과 무관) |
| 9g | `474b4ce7` | 9f 와 같은 방식이다. **포커스** `FocusController`(`focus-controller.js` 361, 옛 `app-focus.js` 24 + `focusClear`) → `app.focus`(이름이 비어 있었다), 부품 `FocusHighlight`(`focus-highlight.js` 97, 옛 `app-focus-hl.js` 6) `.hl` · `FocusOwner`(`focus-owner.js` 253, 옛 `app-focus-owner.js` 10, 순수 함수 `ownersEq` 는 파일 맨 위 그대로) `.owner`. App 생성자가 만든다. **위임자 22**: focus 14 · focus.hl 2 · focus.owner 6. App 에서 걷은 이름 19(`_navSame`·`_navPush`·`_navHere`·`_navCursor`·`_navAlive`·`_navGo`·`_navMove`·`_navCursorGo`·`_navReachable`·`_navPaint`·`_persistFocusedPanes` · `_fhlRetry`·`_fhlFile`·`_fhlDiff`·`_fhlDiffSel` · `_focusReclaim`·`_onLifeResume`·`_focusClaim`·`_toolWindowId`). **옮긴 필드**(SH-4): `_navBack`·`_navFwd`·`_navCur`·`_navMoving`(focus) · `_fhlPend`·`_fhlAt`·`_fhlTarget`·`_afcAt`(hl). **App 에 남긴 필드**: `focused`·`windowFocused`·`_windowFocusOwner`·`prevFocus`(A/9g). **쓰기 모음(§2.2 `focused`)**: `FocusController.focusClear()`(본문 `this.app.focused=null`, App 위임자)를 두고 `app-layout.js` 의 `this.focused=null` 둘(창 닫기·창 전환)을 `this.focusClear()` 로 바꿨다 — 9i 가 옮기면 `this.app.focusClear()` 다. 이제 `focused` 에 쓰는 곳은 App 생성자와 이 묶음뿐이다(시험이 소스로 고정). 맨 `this`·`owner:this` 없음, `owner:'focus:resume'` 문자열 그대로. 주석의 `this.focused` 둘은 `this.app.focused` 로 고쳤다. `index.html` 은 세 파일을 옛 `app-focus.js` 자리에 함께 싣는다(옛 `app-focus-hl.js` 는 편집기 사이에 있었다 — 로드 시점 의존이 없다). `Object.assign(App.prototype` 27 → 24. 500줄 초과 15 그대로. 몽키패치 해당 없음. **SRS 와 다르게 한 것** 없음. 시험: `app-controllers.test.mjs` 9g 8건(덮어쓰기 표본 `setFocusState`·`updateStatusBar`·`save`·`slotFocused`·`_agFocusedTool`·`_attnClear`, `focused` 쓰기 모음), 하네스에 `FOCUS` 와 `controllers` 의 `focus`, 경로를 고친 단위 시험 2(`focus-size-owner`·`attn-focus-clear`). 단위 1309. e2e 19 spec 168 통과·재시도 0(focus 여섯·focus-highlight 둘·agent-card-focus·attention-focus-clear·panel-shortcuts·regression-focus·remote-close-focus·slot-view-state·tab-reopen·unfocused-edge·workspace-identity·layout·window-close-undo) |
| 9h | `b59d35dd` | 9g 와 같은 방식이다. `app-slots.js`(776)를 §1.2 대로 「더하기·빼기」 앞에서 갈랐다. **슬롯** `SlotsController`(`slots-controller.js` 369 — 상수 표, 상태·칸별 활성 탭·신원·영속 23 메서드, 끝에 위임자와 접근자) → `app.slot`, 부품 `SlotOps`(`slot-ops.js` 434 — 더하기·빼기·포커스·배치·창 전환·회수·배선·손잡이 18) `.ops`. App 생성자가 만든다. **필드 이름**: `app.slots` 는 접근자 이름이라 쓸 수 없어 `app.slot` 으로 했다(FR-FEA-1). **위임자 30**: slot 16 · slot.ops 14. App 에서 걷은 이름 11(`_slotTabMap`·`_slotTabsSeed`·`_slotIdentities`·`_slotSyncSubs`·`_slotCloseAllSubs`·`_slotsPersist`·`_slotFocusFallback` · `_slotPaintFocus`·`_slotRenderArm`·`_slotSyncActive`·`_slotReap`). **옮긴 필드**: `_slotIds`·`_slotSse`(§2.2 C/9h — App 생성자의 선언을 `SlotsController` 생성자로) · `_slotRenderArmed`(ops, SH-4). **App 에 남긴 필드**: `_slots`·`_slotRenderPending`(A/9h). 접근자 `slots`·`slotDir` 는 App 원형에 남고 정의는 `slots-controller.js` 끝이다(본문 `const app=this` — `slotDir` 의 쓰기는 `app.render()`). 맨 `this` 없음, `owner:'slots'` 문자열 그대로. 게이트 `scripts/check-editor-lookup.sh` 의 허용 경로를 `slots-controller.js` 로 고쳤다. `Object.assign(App.prototype` 24 → 23. **500줄 초과 15 → 14**(`FE_MODULE_BOUNDARY_SRS` §7.1 기준선 갱신). 몽키패치 해당 없음. **SRS 와 다르게 한 것**: ① App 필드 이름 `slot`(위) ② 줄 수가 §1.2 의 어림(약 290·460)과 다르다 — 상수 표와 접근자를 뿌리에 두어 369·434 다. 시험: `app-controllers.test.mjs` 9h 8건(덮어쓰기 표본 `slotFocused`·`_slotIdentity`·`slotWindow`·`slotRenderFlush`, 접근자 둘, `_slotIds`·`_slotSse` 가 App 생성자에서 빠진 것), 하네스에 `SLOTS` 와 `controllers` 의 `slot`, 경로를 고친 단위 시험 3(`editor-lookup`·`slot-keys`·`window-local-state`). 단위 1317. e2e(9f·9g·9h 관련 전부 + 레이아웃·편집기 기본) 73 spec 765 — 760 통과·3 건너뜀·1 흔들림(`slot-view-state` TC-SVS-3, 단독 3/3 통과)·1 실패(`version-autoreload` TC-RLC-25 — 9f 에서 본 대로 HEAD `752facd8` 에서도 실패) |
| 9i-1 | `6badc073` | 9h 와 같은 방식이다. `app-layout.js`(967)를 §1.2 대로 셋으로 갈랐다(「탭 찾기」 앞·「탭 닫기」 앞). **창** `LayoutController`(`layout-controller.js` 397 — 돌아갈 자리·탭 이름의 출처·창 더하기·지우기·닫기 되돌리기·창 전환 13) → `app.layout`(이름이 비어 있었다), 부품 `LayoutTabAdd`(`layout-tab-add.js` 200 — 표 `TAB_OPENERS` 와 탭 타입별 여는 길·창 타입 불변식 10) `.tabAdd` · `LayoutTabOps`(`layout-tab-ops.js` 407 — 탭 닫기·전환·분할·칸 이동·순회·사이드바 접기·`termIn` 22) `.tabOps`. App 생성자가 만든다. **위임자 30**: layout 8 · layout.tabAdd 5 · layout.tabOps 17. App 에서 걷은 이름 15(`_rememberReturn`·`_nextActiveWindow`·`_winUndoArm`·`_winUndoFinal`·`_winUndoRun` · `_tabTypeFits`·`_addRunTab`·`_addGitTab`·`_addEditorTab`·`_addTerminalTab` · `_closeTabAsk`·`_closeTabLastInPane`·`_splitInner`·`_paneNewToolRef`·`_cycleActive`). **옮긴 필드**: `_winUndo`(§2.2 C/9i — App 생성자의 선언을 `LayoutController` 생성자로) · `_splitChain`·`sidebarPanel`(tabOps, SH-4). **App 에 남긴 필드**: `_lastPlainWindow`·`_lastEditorWindow`·`mPaneIdx`(A/9i). `_sbTabs` 는 `app.js` 의 접근자라 `this.app._sbTabs` 다. `focused` 쓰기 모음(9g)은 `this.app.focusClear()` 둘로 그대로다. 표 `TAB_OPENERS` 는 App 을 받아 `app.layout.tabAdd._addXTab` 을 부른다(채팅은 위임자 `app._addChatTab`). 맨 `this` 셋: `open(this.app,…)`·`SidebarList.cycle(this.app,…)`·`new SidebarPanel(this.app)`. `owner:'app'` 문자열 그대로. 주석의 `this.focused`·`this.ws` 는 `this.app.X` 로 고쳤다(TC-FEA-2 의 소스 검사). `Object.assign(App.prototype` 23 → 22. **500줄 초과 14 → 13**(`FE_MODULE_BOUNDARY_SRS` §7.1 기준선 갱신). 몽키패치 해당 없음. **SRS 와 다르게 한 것**: 줄 수가 §1.2 의 어림(약 410·160·400)과 조금 다르다 — 397·200·407. 시험: `app-controllers.test.mjs` 9i-1 7건(덮어쓰기 표본 `aw`·`slotFocused`·`paneTabSet`·`setFocusState`·`render`·`save`·`_revealTab`, `_winUndo` 가 App 생성자에서 빠진 것), 9g 의 `focused` 쓰기 모음 시험이 읽는 파일을 `layout-controller.js` 로, 하네스에 `LAYOUT` 과 `controllers` 의 `layout`, 경로·부품을 고친 단위 시험 5(`close-tab-sync`·`peer-chat-ui`·`chat-window`·`method-size`·`window-state`). 단위 1324. e2e 51 spec 571 — 567 통과·3 건너뜀·1 흔들림(`slot-view-state` TC-SVS-50, 단독 3/3 통과)(이름에 layout·window·tab·pane·dock·group·close·reopen·undo·slot·focus 가 든 spec 과 sidebar-tabs·sidebar-collapse·a11y-keyboard·leave-confirm·skill-contract·mobile-ux-overhaul·git-head-mobile) |
| 9i-2 | `b928ea47` | 9i-1 과 같은 방식이다. 나머지 여섯 파일을 9i-1 뿌리의 부품 다섯으로 옮겼다(프리셋은 §1.2 대로 창 상태와 한 부품). `LayoutDock`(`layout-dock.js` 111, 옛 `app-dock.js` 10) `.dock` · `LayoutDnd`(`layout-dnd.js` 208, 옛 `app-dnd.js` 9) `.dnd` · `LayoutGroups`(`layout-groups.js` 278, 옛 `app-groups.js` 24 — 파일 끝의 상수 `WG_KEY`·함수 `_orderSpec` 는 그대로) `.groups` · `LayoutWindowState`(`layout-window-state.js` 160, 옛 `app-window-state.js` 5 + `app-presets.js` 2) `.winState` · `LayoutTabReopen`(`layout-tab-reopen.js` 127, 옛 `app-tab-reopen.js` 11) `.reopen`. `LayoutController`(404) 생성자가 만든다. **위임자 41**: dock 8 · dnd 6 · groups 17 · winState 7 · reopen 3. App 에서 걷은 이름 20(`_dockRefit`·`_layoutState` · `_winOfPane`·`_moveTabAcrossWindows`·`_windowTabCount` · `_groupsNormalizeWs`·`_groupsCommit`·`renameGroup`·`moveGroupTo`·`_orderPaneOf`·`_tabPosition`·`_wgFolded` · `_tabReopenNote`·`_tabViewState`·`_tabViewApply`·`_gitDiffPanelAny`·`_tabReopenIndex`·`_tabReopenWin`·`_tabReopenEntry`·`_tabReopenExisting`). 묶음 안 부품 사이 호출은 부품 경로다 — 창 되돌리기의 그룹 정규화 `this.groups._groupsNormalizeWs`(뿌리) · 탭 닫기의 기록 `this.app.layout.reopen._tabReopenNote`(tabOps) · 정규화의 `this.app.layout.groups._groupsNormalizeWs`(winState). **옮긴 필드**(SH-4): `_dockShown`(dock) · `_wgFold`·`_wgSeenActive`(groups) · `_tabClosed`(reopen). App 필드는 더 옮기지 않았다. 맨 `this`·`owner:this` 없음. 주석의 `this.aw()`·`this.ws` 는 `this.app.X` 로 고쳤다. `index.html` 은 다섯 파일을 `layout-tab-ops.js` 뒤에 함께 싣는다(옛 자리는 흩어져 있었다 — 로드 시점 의존이 없다). `Object.assign(App.prototype` 22 → 16. 500줄 초과 13 그대로. 몽키패치 해당 없음. **SRS 와 다르게 한 것**: 없음. 시험: `app-controllers.test.mjs` 9i-2 8건(덮어쓰기 표본 `aw`·`focused`·`setFocusState`·`paneTabSet`·`save`·`render`·`tools`·`slotFocused`·`gitPanels`, 부품이 든 필드 넷, 부품 경로 호출), 하네스 `LAYOUT` 에 다섯 파일, 경로·부품을 고친 단위 시험 4(`window-state`·`window-groups-sidebar`·`close-tab-sync` — 닫은 탭 기록 대역을 부품에 · `window-local-state` — 폭 이사의 `delete this.app.ws.X` 를 마이그레이션으로 읽는다). 단위 1332. e2e 56 spec 624 — 617 통과·3 건너뜀·3 흔들림(`slot-view-state` TC-SVS-13·56, `tab-names` V-TAN-2 — 단독 3/3 통과)·1 실패(`skill-contract` 「전용 창 Run …」 — `fgName` 이 `""` 대신 `"~"`, 단독으로 HEAD `b59d35dd` 에서도 실패한다. 이번 변경과 무관)(9i-1 의 목록 + workspace 셋·settings·ui-polish·optimistic-layout) |
| 9j | (이 커밋) | 9i 와 같은 방식이다. `app-tool.js`(591)를 §1.2 대로 「백그라운드 도구」 앞에서 갈랐다. **도구** `ToolController`(`tool-controller.js` 427 — 바쁨 묻기·알림·샌드박스 고르기와 런타임 창·닫기 확인 11) → `app.tool`(이름이 비어 있었다), 부품 `ToolLife`(`tool-life.js` 189 — 백그라운드·복원·만들기·죽이기·찾기 13) `.life` · `ToolCmd`(`tool-cmd.js` 379, 옛 `app-cmd.js` 20 — 표 `REMOTE_ACTIONS`·`_closeOpts` 는 파일 맨 위 그대로) `.cmd` · `ToolWork`(`tool-work.js` 79, 옛 `app-work.js` 7) `.work` · `ToolSearch`(`tool-search.js` 118, 옛 `app-search.js` 11) `.search`. App 생성자가 만든다. **위임자 33**: tool 9 · tool.life 10 · tool.cmd 3 · tool.work 5 · tool.search 6. App 에서 걷은 이름 29(`_sbxRuntimeStart`·`_sbxRecent` · `_restorePane`·`_killToolInstances`·`_isToolInActiveWindow` · 원격 처리기 `_remoteViaAction`·`_remoteFocus`·`_remoteOpenEditorTab`·`_remoteRename`·`_remoteNewWindow`·`_remoteNewTab`·`_remoteSplit`·`_remoteDetachTab`·`_remoteRestoreTool`·`_remoteCloseWindow`·`_remoteCloseTab`·`_viewMark`·`_viewRestore`·`_resolveLocation`·`_parseLocation`·`_locationAt`·`_focusLocation` · `toolWorking`·`windowWorking` · `_searchOpen`·`_searchOpt`·`_searchBindResults`·`_searchPaintCount`·`_searchDecorNow`). 표 `REMOTE_ACTIONS` 의 처리기는 App 을 받는다 — 이 부품의 것은 `app.tool.cmd._remoteX`, 창 그룹의 것(`_remoteNewGroup` 등)은 위임자다. 맨 `this` 하나: `h(this.app,args)`. **옮긴 필드**: `_workSig`(work, SH-4). **App 에 남긴 필드**: `_bg`(A/9j — 쓰기는 `ToolLife._bgRefresh` 만). `owner:'app'` 문자열 그대로. 게이트 `check-i18n.mjs` 의 예외 사유 글의 파일 이름을 고쳤다. e2e 합성 페이지 둘(`event-timer-hub-contract`·`sse-resilience`)은 `app-cmd.js` 대신 `tool-cmd.js` 를 싣고 대역에 `tool.cmd`(`ToolCmd`)를 세운다. `Object.assign(App.prototype` 16 → 12. **500줄 초과 13 → 12**(`FE_MODULE_BOUNDARY_SRS` §7.1 기준선 갱신). 몽키패치 해당 없음. **SRS 와 다르게 한 것**: ① §1.2 의 「뿌리 = 샌드박스·도구 만들기」 와 달리 `_newTool` 은 부품 `ToolLife` 에 있다 — 줄 경계(약 410·180)대로 갈랐고 `_newTool` 이 그 뒤쪽에 있다 ② 파일 이름은 `tool-*.js` 로 묶었다(`remote-*.js` 는 git 원격 파일과 헷갈린다). 시험: `app-controllers.test.mjs` 9j 8건(덮어쓰기 표본 `findToolLocation`·`aw`·`executeAction`·`tools`·`focused`, 원격 표가 부품을 부르는 것, `_workSig` 가 부품의 것), 하네스에 `TOOL` 과 `controllers` 의 `tool`, 경로·부품을 고친 단위 시험 9(`remote-actions` — 자리 풀이 대역을 부품에 · `search-decor` · `work-dot` · `app-git-lists` · `app-cmd-split` · `method-size` · `modal-unify` · `window-state` · `harness`). 단위 1340. e2e(9j 몫 — tool·cmd·work·search·runs·terminal·agent·background·sandbox·attention·event-timer-hub-contract·sse-resilience — 에 9f~9i 관련 전부와 편집기 기본을 더해 한 번) 93 spec 986 — 981 통과·3 건너뜀·1 흔들림(`tab` 「keyboard shortcut switches tabs」, 단독 3/3 통과)·1 실패(`version-autoreload` TC-RLC-25 — 9f 에서 본 대로 원래 실패) |
