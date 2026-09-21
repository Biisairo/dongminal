# SRS: 창은 창의 것 · 포커스는 돌아온다 · diff 는 편집기다 — 접수 일곱 건 — IEEE 29148

> **문서 상태**: 승인·구현완료

> **이 SRS 가 앞선 결정 셋을 개정한다.** 어긋나면 이 문서가 이긴다.
>
> | 개정되는 것 | 어떻게 | 어디서 |
> |---|---|---|
> | FR-WSL-84 (슬롯 방향은 **기기별 설정**이므로 localStorage) | 같은 브라우저의 탭·PWA 창이 localStorage 를 공유하고 `slotDir` getter 가 **매 render 마다 그것을 다시 읽으므로**, 한 창에서 바꾼 방향이 다른 창의 다음 렌더에 실렸다. 창별(sessionStorage)로 옮긴다 | 이 문서 FR-UXB-1~5 |
> | REPO_SIDE_WIDTH_SRS D-1·D-2 (사이드 폭은 **워크스페이스 하나**에 산다) | 워크스페이스는 서버의 것이고 전 기기가 공유한다 — 데스크톱에서 끈 폭이 휴대폰에 강제된다. 치수는 화면의 것이므로 창별로 옮긴다 | 이 문서 FR-UXB-6~11 |
> | M9_SRS FR-M9-5 / D-M9-5 (**diff 에 미니맵은 없다**) | 끄고 켜는 손잡이를 주고 기본을 끔으로 둔다 — 폐기가 아니라 **기본값으로 강등**이다. 켤 때도 좌우 양쪽이 아니라 수정 쪽 하나만 뜨므로 그 결정이 지키려던 폭은 지켜진다 | 이 문서 FR-UXB-42 |

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

사용자가 접수한 일곱 건을 고친다. 일곱은 네 주제로 묶인다.

| 묶음 | 접수 항목 | 한 줄 |
|---|---|---|
| W — 창별 상태 | 1·7 | 이 창의 치수가 저 창을 흔들지 않는다 |
| F — 포커스 | 2·6 | 돌아오면 즉시 보이고, 놓은 것은 되찾을 수 있다 |
| X — 탐색기 아이콘 | 3 | 눌러야 할 것이 눌릴 만큼 크다 |
| D — diff 동등성 | 4·5 | diff 는 편집기와 같은 것을 할 수 있다 |

### 1.2 범위 (Scope)

- 포함: `web/js/git/diff-view-parity.js`(신설) · `web/js/core/app-slots.js` · `app-focus.js` · `app-editor-pane.js` · `app-cmd.js` · `app.js` · `app-backup.js` · `app-settings*.js` · `settings-schema.js` · `web/js/ui/input-binding.js` · `file-editor-find.js` · `web/js/git/diff-view.js` · `constants-git-diff.js` · `constants-editor.js` · `web/style-editor.css` · `internal/webserver/hub/focus.go` · `internal/webserver/httpapi/focus.go` · `handlers_api.go` · `docs/external/features.md` · `docs/external/api.md`.
- 비포함: 창 안 분할 트리(`split.sizes`)의 저장 위치, 터미널 글자 크기·테마, 모바일 순회 규약, diff 의 hunk 툴바 동작, LSP 서버 선언·설치 경로.
- 사용자 결정(2026-09-21): 저장 단위는 **완전히 창별(sessionStorage 전용)** 이며 마지막 값 상속을 두지 않는다. 폭의 범위는 사이드바·탐색기 둘로 한정한다. diff 동등성은 표시 설정·키바인딩·LSP 까지 간다. 포커스 회수는 **반납 종단 신설**로 푼다. diff 미니맵은 **별도 설정 + 우측 하나**다.

### 1.3 정의 (Definitions)

- **창(window/tab)**: 브라우저의 탭 하나 또는 PWA 창 하나. `sessionStorage` 의 경계와 같다.
- **기기(device)**: 브라우저 프로필 하나. `localStorage` 의 경계와 같다. 같은 기기의 두 창은 localStorage 를 공유한다.
- **소유권(ownership)**: 서버 `FocusRegistry` 의 `windowId → clientId`. 화면의 dim 과 PTY 리사이즈 권한 둘의 근거다 (FR-XDF-4).
- **반납(release)**: 구독을 끊지 않은 채 소유권만 비우는 일. 이 문서가 신설한다.
- **수정 편집기(modified editor)**: `DiffEditor.getModifiedEditor()` — diff 의 오른쪽(또는 inline 의 본문).
- **편집 가능 축**: `GIT_AXIS_EDITABLE` 에 든 축. 오른쪽이 **디스크의 파일**인 경우다 (FR-RTU-50).

### 1.4 참조 (References)

WINDOW_SLOTS_SRS (FR-WSL-80~84) · REPO_SIDE_WIDTH_SRS (FR-RSW-1~5) · USER_CHECKLIST_FIXES_SRS §3.5 (FR-XDF-1~14) · SLOT_VIEW_STATE_SRS (FR-SVS-*) · EDITOR_FIND_PANEL_SRS (FR-EFP-4·8·25) · EDITOR_LSP_SRS (FR-LSP-39·60~65) · M9_SRS (FR-M9-5) · DIFF_HUNK_BAR_SRS · SETTINGS_PORTABILITY_SRS (FR-SPT-1·3) · CONFIG_MANAGEMENT_SRS (FR-CFG-1~5) · DESIGN_TOKENS_SRS §7.4 · GIT_LIVE_TRIGGERS_SRS (FR-GLW-1~8).

## 2. 현황 (Current State) — 실측

### 2.1 슬롯 방향은 기기의 것이다 (접수 1)

`app-slots.js:716` 의 접근자가 **읽을 때마다** localStorage 를 본다. 화면은 `renderer-layout.js:57` 에서 `area.dataset.slotdir=app.slotDir` 로 그 값을 매 render 에 다시 받는다. 렌더는 SSE(`workspace_changed` 등)로 수시로 돈다.

그러므로 같은 기기의 다른 창은 **자기가 아무것도 하지 않아도** 다음 렌더에서 방향이 바뀐다. 서버에는 `slotDir` 가 없으므로(Go 전수 검색 0건) 다른 기기로는 전파되지 않는다 — 접수의 "다른 브라우저" 는 같은 프로필의 다른 창·PWA 창이다.

### 2.2 폭은 서버의 것이다 (접수 7)

- `input-binding.js:97` 이 드래그 중 `this.app.ws.sidebarWidth=raw` 를 쓰고, `:112` 가 놓는 순간 `app.save()` 로 **워크스페이스를 서버에 올린다**.
- `app.js:181` 과 `app-cmd.js:446` 이 워크스페이스를 받을 때마다 `--sb-w` 를 그 값으로 덮는다. localStorage 사본은 있으나 **읽는 자리가 없다** — 진실은 서버다.
- 탐색기 폭도 같다: `app-editor-pane.js:141·148` 이 `ws.repoSideWidth` 하나를 읽고 쓴다.

결과: 데스크톱에서 끈 폭이 휴대폰 접속에 강제된다. `displayMode`·`mobileBreakpoint` 는 이미 같은 이유로 워크스페이스에서 걷어낸 전례가 있다 (`app.js:177`).

### 2.3 포커스 복귀가 화면을 갱신하지 않는다 (접수 2)

`_initFocusSync` 의 `focus` 리스너가 하는 일은 셋이다 — `windowFocused=true`, 가장자리 칠하기, `_focusWindow(activeWindow)`. **render 가 없고 폴링 되살림도 없다.**

`TimerHub._visibility()` 는 `visibilitychange` 만 듣는다. 두 브라우저 창을 오갈 때 `document.hidden` 은 **둘 다 거짓**이므로 `revalidateOnShow` job 이 하나도 다시 돌지 않는다. `EventBus.startLifecycle` 이 `LIFE_FOCUS` 를 발행하지만 구독자는 git 하나뿐이다 (`app-git.js:345`).

### 2.4 놓은 소유권을 아무도 돌려주지 않는다 (접수 6)

- 서버에 **반납 종단이 없다.** `hub/focus.go` 의 해제는 `Detach` 하나이며 그 계기는 SSE 구독이 끊길 때뿐이다 (FR-XDF-9).
- 클라이언트의 `blur` 리스너는 `windowFocused=false` 와 가장자리 칠하기가 전부다 (`app-focus.js:212`).
- 복귀 쪽도 온전하지 않다 — `focus` 리스너는 `_focusWindow(activeWindow)` 를 **포커스 칸 하나**로 부른다. 칸이 둘 이상이면 나머지 칸은 dim 인 채로 남는다. 전 칸 재주장(`_slotClaimAll`)은 SSE 재연결 경로(`_focusRestore`)에만 있다.
- 소유권이 바뀌어도 하는 일은 `applyFocusOverlay()` — 클래스만 토글한다. 그동안 멈춰 있던 표면은 다시 그려지지 않는다.

### 2.5 탐색기 머리의 아이콘 (접수 3)

`style-editor.css:113` 이 `.ed-head .ui-btn svg{width:14px;height:14px}` 로 치수를 **직접** 든다. 버튼은 `ui-btn-sm`(22px), 머리는 26px 다 (`file-tree.js:203`). 키트는 아이콘을 버튼 높이에서 파생하고(`--ui-icon-ratio:.68`) 그 값들은 `--fs-scale` 을 탄다 — 이 세 아이콘만 그 두 성질 밖에 있다. UI 글자 크기를 키워도 14px 이다.

### 2.6 diff 는 편집기가 아니다 (접수 4·5)

`GIT_DIFF_OPTIONS`(`constants-git-diff.js:11`)는 편집기의 옵션 덩이와 **다른 표**다. 그 표에 `wordWrap` 이 없으므로 `editorWordWrap` 은 diff 에 닿지 않는다. 글자 크기·줄간격·글꼴·탭 크기·괄호 색·가이드도 같다 — diff 는 Monaco 기본값을 쓴다.

찾기: 편집기는 Monaco 위젯을 인스턴스별로 죽이고 자체 패널을 쓴다 (FR-EFP-25). `file-editor-find.js:22` 의 주석이 그 자리에서 이미 적고 있다 — *"그 뷰(Git diff)에는 우리 패널이 없다."*

LSP: `_lspPathOfModel` 은 **열려 있는 FileEditor 들을 훑어** 모델을 경로로 되돌린다. diff 의 모델은 URI 없이 만들어지고(`diff-view.js:376`) 그 목록에도 없으므로 경로가 나오지 않는다 → 호버·정의이동이 조용히 아무 일도 하지 않는다.

### 2.7 구현 중 실측으로 드러난 두 고리 (스펙 착수 시점에는 몰랐다)

**(가) `Mod+F` 는 diff 에서 터미널 검색을 열고 있었다.** 원인은 Monaco 의 입력
표면이 `textarea` 가 아니라 `div.native-edit-context` 라는 것이다 —
`input-binding.js` 의 전역 keydown 은 `activeElement.tagName` 으로 "글자를 받는
자리" 를 판정하므로(§`inText`) diff 위의 포커스를 **텍스트 밖**으로 읽고,
`edTrySearchKey` 의 게이트(`_edFindReady`)가 거짓이 되자 그 아래
`BUILTIN_HOTKEYS` 의 터미널 검색이 키를 가져갔다 (실측: 키가 diff 의 그릇까지
내려오지 않았다).

그러므로 **diff 안에 리스너를 다는 것으로는 고칠 수 없다.** 판정이 있는 자리는
app 이고(FR-EKB-1·5), 고쳐야 할 것은 그 판정이 Diff 탭을 모른다는 사실이다.

**(나) 언어 provider 등록이 `FileEditor` 생성 경로에만 있었다.** `lspHoverRegister`
는 편집기가 설 때 불린다 — 편집기 탭을 한 번도 열지 않은 화면에서 diff 를 열면
provider 가 **하나도 걸려 있지 않고**, Monaco 는 그 언어에 대해 조용하다. 경로
되돌림(FR-UXB-47)만 고쳤다면 그 조용함은 남았을 것이다.

## 3. 요구사항 (Requirements)

### 3.1 묶음 W — 창별 상태 (접수 1·7)

| ID | 요구사항 | 우선 |
|----|---------|------|
| FR-UXB-1 | 슬롯 방향은 `sessionStorage['slotDir']` 하나에 산다. localStorage 를 읽지도 쓰지도 않는다. | 필수 |
| FR-UXB-2 | 새 창·새 탭은 `SLOT_DIR_DEFAULT`(horizontal) 로 시작한다. 다른 창의 값이나 옛 localStorage 값을 씨앗으로 삼지 않는다. | 필수 |
| FR-UXB-3 | 한 창에서 방향을 바꿔도 같은 기기의 다른 창은 바뀌지 않는다 — **렌더가 몇 번 돌아도** 그렇다. | 필수 |
| FR-UXB-4 | 부팅 시 localStorage 의 옛 `slotDir` 키를 1회 제거한다. 읽지 않는 키를 남기지 않는다. | 필수 |
| FR-UXB-5 | 설정 이식 표(`BACKUP_KEYS`)의 `slotDir` 는 `store:'session'` 으로 옮긴다 — `displayMode`·`mobileBreakpoint` 와 같은 칸이다. | 필수 |
| FR-UXB-6 | 사이드바 폭은 `sessionStorage['sidebarWidth']` 하나가 진실이다. `ws.sidebarWidth` 를 읽는 자리도 쓰는 자리도 남기지 않는다. | 필수 |
| FR-UXB-7 | 탐색기 사이드 폭은 `sessionStorage['repoSideWidth']` 하나가 진실이다. `ws.repoSideWidth` 를 읽는 자리도 쓰는 자리도 남기지 않는다. | 필수 |
| FR-UXB-8 | 워크스페이스에 두 키가 실려 오면 **지우고 저장한다**. 지우는 자리는 첫 로드(`app.js`)와 원격 반영(`app-cmd.js`) **둘 다**이며, 이는 `displayMode` 가 이미 선 규약이다. | 필수 |
| FR-UXB-9 | 새 창은 기본 폭으로 시작한다 — 사이드바는 CSS 의 `--sb-w` 초기값, 탐색기는 `REPO_SIDE_W_DEFAULT`. | 필수 |
| FR-UXB-10 | 읽어 들인 값은 언제나 범위로 강제된다 (`clampSidebarWidth`, `REPO_SIDE_W_MIN/MAX`). 손으로 고친 sessionStorage 하나가 화면을 못 쓰게 만들지 않는다. | 필수 |
| FR-UXB-11 | 다른 창·다른 기기의 폭 조절은 이 창의 폭을 바꾸지 않는다. `workspace_changed` 를 받아도 그렇다. | 필수 |
| FR-UXB-12 | 사이드바 접힘(`sidebarCollapsed`)의 저장 위치는 **바꾸지 않는다** (FR-SBC-4·6, localStorage). 접힘은 치수가 아니라 기기의 취향이다. | 필수 |

### 3.2 묶음 F — 포커스 (접수 2·6)

| ID | 요구사항 | 우선 |
|----|---------|------|
| FR-UXB-20 | 서버에 반납 종단을 신설한다: `POST /api/focus/release {clientId}`. 그 clientId 가 가진 모든 창의 소유권을 비운다. | 필수 |
| FR-UXB-21 | 반납은 **구독을 끊지 않는다.** `live`·`addrs` 는 그대로이고 `owners` 만 준다 — 실행자 선출(FR-SXE-4)의 후보에서 빠지지 않는다. | 필수 |
| FR-UXB-22 | 맵이 실제로 바뀐 반납만 전체 맵을 방송한다. 같은 반납의 반복은 방송을 만들지 않는다 (FR-XDF-14 의 멱등 규약 유지). | 필수 |
| FR-UXB-23 | 클라이언트는 `blur` 에서 **자기 모든 칸의 신원**에 대해 반납을 보낸다. 칸마다 clientId 가 다르므로(FR-WSL-10) 한 번으로 끝나지 않는다. | 필수 |
| FR-UXB-24 | 창이 포커스를 받으면 **모든 칸**을 재주장한다. 지금의 "포커스 칸 하나" 를 `_slotClaimAll` 과 같은 규약으로 올린다. | 필수 |
| FR-UXB-25 | 소유권 맵을 받아 dim 이 **풀린** 칸이 있으면 그 즉시 다시 그린다. 클래스만 갈고 끝내지 않는다. | 필수 |
| FR-UXB-26 | 포커스 복귀(`LIFE_FOCUS`)와 가시성 복귀(`LIFE_VISIBLE`)는 즉시 1회 render 를 만든다. | 필수 |
| FR-UXB-27 | 포커스 복귀는 `TimerHub` 의 `revalidateOnShow` job 도 되살린다 — 두 창을 오갈 때 `document.hidden` 은 거짓이라 지금은 아무 job 도 다시 돌지 않는다. | 필수 |
| FR-UXB-28 | 되살림은 job 당 1회다. 이미 실행 중(`inflight`)인 job 에 겹쳐 쏘지 않는다 (`overlap:'drop'` 규약 그대로). | 필수 |
| FR-UXB-29 | 포커스를 빠르게 오갈 때 주장·반납이 폭주하지 않는다 — 값이 바뀐 호출만 종단에 닿는다(클라이언트 측 `changed` 가드를 반납에도 적용). | 필수 |

### 3.3 묶음 X — 탐색기 아이콘 (접수 3)

| ID | 요구사항 | 우선 |
|----|---------|------|
| FR-UXB-30 | 탐색기 머리의 세 버튼(새 파일·새 폴더·새로고침)은 하드코딩 14px 을 버리고 **키트의 파생 치수**를 받는다. | 필수 |
| FR-UXB-31 | 세 버튼은 `ui-btn-sm`(22px) 대신 기본 크기(`--ui-btn-h`, 26px)를 쓰고, 머리 높이는 그 버튼이 들어가도록 30px 로 올린다. 아이콘은 그때 `26 × .68 ≈ 17.7px` 이다. | 필수 |
| FR-UXB-32 | 아이콘 치수는 `--fs-scale` 을 탄다 — UI 글자 크기 설정을 키우면 함께 커진다. | 필수 |
| FR-UXB-33 | 머리가 커져도 트리의 행 높이(22px / 모바일 `--touch-min`)는 바뀌지 않는다. | 필수 |
| FR-UXB-34 | `stroke-width` 는 새 치수에서도 선이 뭉개지지 않는 값으로 둔다 — 현재 1.3 을 그대로 쓰되 육안 검수로 확인한다. | 권장 |

### 3.4 묶음 D — diff 는 편집기다 (접수 4·5)

| ID | 요구사항 | 우선 |
|----|---------|------|
| FR-UXB-40 | 줄바꿈: `editorWordWrap` 이 diff 의 양쪽에 적용된다. 설정을 바꾸면 **열려 있는 diff 가 즉시** 따른다 (`updateOptions`, 모델·스크롤을 잃지 않는다). | 필수 |
| FR-UXB-41 | 표시 규약(글자 크기·줄간격·글꼴·탭 크기·공백 표시·괄호 색·가이드·커서)은 편집기와 **같은 한 덩이**에서 온다. 두 표에 적지 않는다. | 필수 |
| FR-UXB-42 | 미니맵: 설정 `diffMinimap`(bool, 기본 `false`)을 신설한다. 켜면 **수정 편집기에만** 미니맵이 뜨고 원본 쪽은 항상 꺼져 있다 — 화면 우측에 하나다. | 필수 |
| FR-UXB-43 | `diffMinimap` 은 `settings-schema.js` · `SETTINGS_ACCESS` · Display 탭의 행 · `docs/external/features.md` 네 표면에 함께 선다 (게이트가 강제한다). | 필수 |
| FR-UXB-44 | 찾기: `Mod+F`(설정의 `edFindInFile`)가 diff 에서 **편집기 탭과 같은 패널**(FR-EFP)을 연다. 판정은 app 한 자리이며(`_edFindReady`·`_edFindInFile`, FR-EKB-1·5) diff 는 여는 문(`findOpen`) 하나만 갖는다. Monaco 의 find 위젯을 여는 키는 양쪽 편집기에서 닫힌다. | 필수 |
| FR-UXB-45 | 찾기 패널은 diff 인스턴스마다 하나이며 그 인스턴스의 DOM 안에 산다 — 칸 둘이 서로의 질의를 흔들지 않는다 (FR-EFP-8 규약). | 필수 |
| FR-UXB-46 | 편집기의 키바인딩이 diff 에서 **같은 표**를 딛는다 — 찾기·다음/이전 일치는 우리 패널이, 저장은 `Mod+S`(FR-RTU-52)가, 정의로 이동은 Monaco 의 기본 경로(등록된 provider + `F12`·커맨드클릭)가 든다. | 필수 |
| FR-UXB-47 | LSP: **편집 가능 축**에서 수정 편집기의 호버·정의로 이동이 동작한다. 그러려면 둘이 필요하다 — 모델 → 절대경로 되돌림이 diff 의 모델도 답하고(`lspPathOf`), diff 가 설 때 **provider 등록**(`lspHoverRegister`)이 불린다 (§2.7 나). | 필수 |
| FR-UXB-48 | 편집 불가 축(커밋 간 비교 등)에서는 LSP 가 **조용히** 비활성이다 — 디스크에 없는 내용의 좌표를 서버에 묻지 않고, 오류도 띄우지 않는다. | 필수 |
| FR-UXB-49 | 원본(왼쪽) 편집기는 읽기 전용 규약을 유지한다 (`originalEditable:false`) — 찾기는 되고 편집은 되지 않는다. | 필수 |

### 3.5 비기능 요구사항 (Non-functional)

- NFR-UXB-1 옛 `workspace.json`(두 폭 키가 든 파일)을 읽어도 실패하지 않는다. 키는 조용히 제거된다.
- NFR-UXB-2 반납 종단은 인증·본문 한도·오류 카탈로그에서 기존 종단과 같은 규약을 따른다 (`readBodyHTTP`, `apierr`).
- NFR-UXB-3 diff 옵션의 단일 원천은 한 곳이다 — 편집기와 diff 가 같은 상수를 읽고, 어느 한쪽만 고쳐질 수 없다.
- NFR-UXB-4 `make gates` 전량 초록: srs-status · srs-progress · decisions · settings-docs · api-docs · font-size · css-vars · file-size.
- NFR-UXB-5 기존 e2e 는 수정 없이 통과한다. 슬롯·포커스·diff 의 기존 기대가 이 변경으로 깨지면 그것은 회귀다.

## 4. 검증 (Verification)

| ID | 대상 | 방법 |
|----|------|------|
| V-UXB-1 | FR-UXB-1~4 | e2e: 창 A 에서 방향을 vertical 로 바꾸고, 창 B 를 열어 `#area[data-slotdir]` 이 horizontal 임을 본다. 창 B 에서 렌더를 여러 번 유발(창 전환·탭 추가)한 뒤에도 그대로임을 본다. `localStorage.slotDir` 가 없음을 본다. |
| V-UXB-2 | FR-UXB-5 | 단위: `BACKUP_KEYS` 의 `slotDir` 항목이 `store:'session'` 이고, 내보내기 결과의 `session` 에 담긴다. |
| V-UXB-3 | FR-UXB-6~9·11 | e2e: 창 A 에서 사이드바·탐색기 폭을 끌고, 창 B 를 열어 기본 폭임을 본다. A 가 저장을 올린 뒤 B 에서 `workspace_changed` 를 받아도 B 의 폭이 그대로임을 본다. |
| V-UXB-4 | FR-UXB-8 | 단위: 두 키가 든 워크스페이스를 넣으면 로드 후 객체에서 사라지고 `save()` 가 한 번 불린다. 첫 로드와 원격 반영 두 경로 각각. |
| V-UXB-5 | FR-UXB-10 | 단위: 범위 밖 문자열·음수·NaN 을 sessionStorage 에 넣고 읽으면 기본값 또는 경계값이 나온다. |
| V-UXB-6 | FR-UXB-20~22 | Go 단위: 반납 후 `Snapshot()` 이 비고 `LiveCount()` 는 줄지 않는다. 같은 반납을 두 번 하면 두 번째는 방송을 만들지 않는다. `Executor()` 가 여전히 그 클라이언트를 후보로 든다. |
| V-UXB-7 | FR-UXB-23~25 | e2e(2 컨텍스트): B 가 창을 뺏고 → B 를 blur → A 의 `.pn-dimmed` 가 풀리는 것을 본다. A 가 칸 둘일 때 **둘 다** 풀리는 것을 본다. |
| V-UXB-8 | FR-UXB-26~28 | 단위 넷(`timer-hub.test.mjs` — 되살림·숨김·겹침·거부) + e2e 하나: 실제 앱에서 `focus` 한 번에 **render 가 늘고** 주기 1시간짜리 job 이 그 자리에서 1회 돈다. |
| V-UXB-9 | FR-UXB-30~33 | e2e: 세 버튼의 svg 실측 치수가 17±1px 이고, UI 글자 크기를 키우면 함께 커진다. 트리 행 높이는 22px 그대로. 스크린샷 육안 검수. |
| V-UXB-10 | FR-UXB-40 | e2e: 줄바꿈 설정을 켜고 diff 를 열어 긴 줄이 접히는 것을 본다. 열어 둔 채로 설정을 끄면 즉시 풀리고 스크롤 위치가 유지된다. |
| V-UXB-11 | FR-UXB-41 | 단위: 편집기와 diff 가 같은 상수 객체에서 값을 받는다(키 집합 대조). 글자 크기 설정 변경이 diff 에 닿는다. |
| V-UXB-12 | FR-UXB-42·43 | e2e: 기본 상태에서 diff 미니맵이 없다. 설정을 켜면 수정 쪽에만 뜨고 원본 쪽 `minimapWidth` 는 0 이다. `make gates` 의 settings-docs 초록. |
| V-UXB-13 | FR-UXB-44~46 | e2e: diff 에서 `Mod+F` 가 **우리 패널**을 열고 Monaco 위젯(`.find-widget`)은 뜨지 않는다. 일치 이동·저장 키가 편집기와 같게 동작한다. |
| V-UXB-14 | FR-UXB-47·48 | e2e: 편집 가능 축의 diff 에서 심볼 호버가 답을 준다. 커밋 간 비교에서는 호버가 조용하고 네트워크 요청이 나가지 않는다. |
| V-UXB-15 | NFR-UXB-5 | `make e2e` 전량. |

### 4.1 실행 결과 (2026-09-21)

| 검증 | 결과 |
|---|---|
| V-UXB-1·3 (창별 상태) | e2e 3건 통과 (`e2e/ux-batch10.spec.ts`) |
| V-UXB-2·4·5 (저장소 규약) | 단위 5건 통과 (`web/js/test/window-local-state.test.mjs`) |
| V-UXB-6 (반납) | Go 단위 4건 통과 (`internal/webserver/hub/focus_release_test.go`) |
| V-UXB-7 (dim 해제·재주장) | e2e 2건 통과 |
| V-UXB-8 (복귀의 렌더·되살림) | 단위 4 + e2e 1 통과. **RED 도 확인했다** — 버스 구독을 끄면 render 증가가 0 이다 |
| V-UXB-9 (아이콘) | e2e 1건 통과 (17.7px · 행 높이 22px 유지 · UI 배율 추종) |
| V-UXB-10·12·13·14 (diff) | e2e 4건 통과 (줄바꿈·미니맵 한쪽·찾기 패널·LSP 호버) |
| V-UXB-15 (회귀) | 관련 스펙 약 290건 통과 — focus·git-diff·git-hunk·editor-ops·editor-lsp·slots·polling·layout·settings |
| NFR-UXB-4 | `make gates` 전량 초록 (exit 0) |

**기준선을 세 곳 움직였다** (전부 근거와 함께):

- `e2e/baseline/ui-layout.*.json` — `.git-diff-host` 의 `position`·`inset`(FR-UXB-45 가 좌표계를 세웠다)과 탐색기 머리 버튼 세 키의 이름(`ui-btn-sm` 이 빠졌다, FR-UXB-31). 세 판 모두.
- `FE_MODULE_BOUNDARY_SRS §7.1a` — 최대 파일 1,178 → 1,174.
- `scripts/check-button-kit.mjs` 의 예외 줄 번호 61 → 71 (파일이 자랐다).

## 5. 결정 (Decisions)

- **D-UXB-1 저장 단위는 창이다 — 기기가 아니다.** 사용자 결정(2026-09-21). `slotDir`·`sidebarWidth`·`repoSideWidth` 셋 다 `sessionStorage` 전용이며 마지막 값 상속을 두지 않는다. 상속을 두면 "새 창은 기본값" 과 "다른 창을 따라가지 않는다" 중 하나가 흐려진다 — 둘을 다 지키는 값은 기본값뿐이다.
- **D-UXB-2 옛 키는 씨앗이 아니라 쓰레기다.** localStorage 의 `slotDir` 와 워크스페이스의 폭 두 키는 읽지 않고 **지운다**. 남겨 두면 다음 사람이 그것을 진실로 착각하고, 두 진실은 반드시 갈린다.
- **D-UXB-3 반납은 해제(Detach)와 다른 동사다.** 구독을 끊지 않고 소유권만 비운다. 해제로 대신하면 SSE 가 끊겨 명령·이벤트가 멎고, 실행자 선출에서도 빠진다 — blur 는 "떠났다" 가 아니라 "지금은 내 차례가 아니다" 이다.
- **D-UXB-4 유예 시간을 두지 않는다.** blur 즉시 반납한다. 유예는 "언제 돌려받는가" 를 시간에 맡기고, 그 시간은 사용자가 보는 화면과 무관하다. 폭주는 시간이 아니라 **변화 가드**로 막는다 (FR-UXB-29).
- **D-UXB-5 복귀의 계기는 버스 한 자리다.** `LIFE_FOCUS`·`LIFE_VISIBLE` 구독으로 render 와 되살림을 건다. 새 `focus` 리스너를 달지 않는다 — FR-BUS-8·FR-GLW-2 가 이미 "문서 이벤트는 앱당 한 벌" 을 세웠다.
- **D-UXB-6 아이콘 치수는 키트에서 파생한다.** 14px 을 16px 로 바꾸는 것은 같은 실수를 한 칸 옮기는 일이다. 버튼 크기를 올리고 파생을 그대로 받으면 `--fs-scale` 도 함께 따라온다.
- **D-UXB-7 diff 의 미니맵은 기본이 끔이다.** M9_SRS D-M9-5 가 지키려던 것은 좁은 칸의 폭이고, 그것은 기본값과 **한쪽만 켜기**로 지켜진다. 손잡이를 주되 켜는 쪽을 선택으로 둔다.
- **D-UXB-8 미니맵은 수정 쪽 하나다.** Monaco 의 diff 는 좌우가 독립 에디터라 내용이 합쳐진 미니맵은 존재하지 않는다. 양쪽에 두면 폭을 두 번 내주고, 우측 하나면 diff 개요 눈금(FR-DOR-1)과 나란히 서서 "어디가 바뀌었나" 와 "문서의 어디인가" 를 함께 읽는다.
- **D-UXB-9 옵션은 한 덩이에서 갈라진다.** 편집기와 diff 가 같은 기반 상수를 읽고, 서로 다른 것(읽기 전용·side-by-side·미니맵)만 덮어쓴다. 두 표를 두면 설정이 늘 때 한쪽만 고쳐진다 — 이 저장소가 `saveSettings`·`_settingsApply`·이식 표에서 이미 겪은 형태다 (FR-CFG-1).
- **D-UXB-10 diff 의 모델에 파일 URI 를 억지로 붙이지 않는다.** 같은 URI 의 모델은 Monaco 에 하나뿐이라, 편집기 탭이 이미 연 파일과 충돌한다. 대신 **모델 → 경로 되돌림**에 diff 를 후보로 더한다 — `_lspPathOfModel` 이 이미 "열려 있는 편집기를 훑는" 방식이므로 규약을 바꾸지 않고 자리만 는다.
- **D-UXB-12 `Mod+F` 의 판정은 app 이 든다 — diff 가 아니다.** 처음에는 diff 의 그릇에 capture 리스너를 달았고, 그것은 **한 번도 불리지 않았다** (§2.7 가). 전역 keydown 이 그보다 먼저 키를 가져가기 때문이며, 그 자리를 고치지 않고는 diff 안에서 무엇을 해도 닿지 않는다. FR-EKB-1·5 가 이미 세운 규약("판정은 한 자리")이 옳았다는 것을 결함이 증명한 셈이다.
- **D-UXB-11 LSP 는 편집 가능 축에서만 산다.** 커밋 간 비교의 본문은 디스크에 없는 과거의 내용이고, 언어 서버는 디스크를 딛는다. 없는 좌표로 답을 받으면 그 답이 더 나쁘다 — 조용한 비활성이 옳다.

## 6. 리스크

- **MEDIUM — 반납이 만드는 방송 증가.** alt-tab 마다 전체 맵이 방송된다. 완화: 변화 가드(FR-UXB-22·29), 맵은 이미 멱등이고 작다. 남는 리스크: 창이 많은 기기에서 짧은 순간의 dim 깜빡임.
- **MEDIUM — 폭의 저장 위치 이동.** 워크스페이스에서 키를 지우는 경로가 둘(첫 로드·원격 반영)이고, 한쪽만 고치면 다른 브라우저가 보낸 옛 모양이 다시 살아난다. 완화: FR-UXB-8 이 둘을 명시하고 V-UXB-4 가 각각을 센다.
- **MEDIUM — diff 의 찾기 패널 이식.** `FileEditor.prototype` 에 얹힌 패널이 `this._editor`·`this.el` 을 전제한다. diff 뷰의 그릇과 이름이 다르면 그대로 얹히지 않는다. 완화: 전제를 만족하는 얇은 어댑터로 붙이고, 패널 코드는 한 벌로 유지한다 (NFR-UXB-3).
- **LOW — 아이콘 치수 변경.** CSS 3줄. 머리 높이가 30px 로 커지면서 트리 첫 행의 위치가 4px 내려간다 — 좌표를 박은 e2e 가 있으면 그것이 드러난다.
- **LOW — sessionStorage 용량·가용성.** 셋 다 짧은 문자열이고, 접근은 전부 `try/catch` 로 감싼 기존 규약을 따른다.

### 6.1 남은 한계 (알고 남긴다)

- **정의로 이동의 "뒤로"**: diff 에서 `F12`·커맨드클릭으로 다른 파일에 가면 그 파일은 편집기 탭으로 열리지만(`_lspOpenerRegister`), app 의 되돌림 스택(`_lspBack`, FR-LSP-27)에는 **출발지가 diff 였다는 사실이 남지 않는다.** 되돌림은 편집기 탭들 사이에서만 온전하다.
- **읽기 전용 축의 LSP 침묵**은 코드 경로와 모델 판정(`lspPathOf(this._orig) === ''`)으로 확인했고, 커밋 간 비교 화면에서의 e2e 는 없다 (V-UXB-14 가 편집 가능 축을 잰다).

## 7. 비목표 (Non-goals)

1. 창 안 분할(`split.sizes`)의 저장 위치는 바꾸지 않는다 — 그것은 치수가 아니라 레이아웃 구조이며 워크스페이스의 것이다.
2. 슬롯 배치(`_slots`)의 저장 위치는 바꾸지 않는다 (이미 sessionStorage).
3. diff 에 편집기의 **탭·문서 수명**(dirty 배지·자동 저장 등)을 옮기지 않는다. 동등하게 하는 것은 보기·찾기·이동·언어 기능이다.
4. 합쳐진(양쪽 내용을 한 그림에 담는) 미니맵을 직접 그리지 않는다 — D-UXB-8.
5. 반납에 유예·하트비트를 두지 않는다 — D-UXB-4.
