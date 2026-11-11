# SRS: 화면 다듬기 — 크기·상태 표현·문구의 일관성과 막히는 곳 풀기 (IEEE 29148)

> **문서 상태**: 승인·구현완료
> **남은 것**: 없음 — 대장의 행이 모두 완료다. 커밋은 사용자 확인 뒤에 한다.

| 항목 | 값 |
|---|---|
| 문서 | UI_POLISH_SRS |
| 접수 | 2026-11-11 (`/unslop` — "전체 UI 를 깔끔하고 일관되게, UX 의 불편한 곳도 잡는다") |
| 관련 | `UIUX_OVERHAUL_SRS` FR-HIE-2 · `WORDING_COLOR_SRS` D-WRD-2·3·11 · `M8_UNIFIED_SRS` FR-B-5·9 · `UI_KIT_SRS` · `DESIGN_TOKENS_SRS` · `SERVER_DRIVEN_ACTIONS_SRS` FR-SDA-6·7 · `UX_BATCH10_SRS` FR-UXB-6 |
| FR 접두 | FR-UIP |

## 0. 요구사항 대장

| # | 요청 | 대응 | 상태 |
|---|---|---|---|
| U1 | 터미널 본문이 칸 테두리에 붙어 있다 | FR-UIP-1 | 완료 |
| U2 | 사이드바 기본 폭 150px 이 좁아 글이 잘린다 → 기본 200px (사용자 결정) | FR-UIP-2 | 완료 |
| U3 | 아이콘 크기가 섞여 있다 (Git 진입점 20px, 다른 곳 13~16px) | FR-UIP-3 | 완료 |
| U4 | Git Changes 패널의 블록 간격·구분선이 제각각이다 | FR-UIP-4 | 완료 |
| U5 | 칸 탭줄 높이가 4px 격자 밖이다 | — | 결함 아님 — 실측 28px(테두리 포함). 27px 은 탭 요소의 높이다 |
| U6 | 사이드바 아래 새로고침·설정만 테두리 상자다 | FR-UIP-5 | 완료 |
| U7 | 개수 배지가 accent 로 칠해지고 0 도 강조된다 (C-7 우측 레일 0 포함) | FR-UIP-6·7 | 완료 |
| U8 | 선택 상태를 세 가지 방식으로 그린다 | FR-UIP-8 | 완료 |
| U9 | 커밋 영역의 위계가 뒤집혔다 (꺼진 Commit 보다 ▾ 가 눈에 띈다) | FR-UIP-9 | 완료 |
| U10 | 칸이 하나일 때도 포커스 표식이 강하다 | FR-UIP-10 | 완료 |
| U11 | 한국어·영어가 섞인다 → 일반 버튼만 한국어, git 고유 용어·설정 탭은 영어 (사용자 결정) | FR-UIP-11·12 | 완료 |
| U12 | `+ 추가 로 경로를 추가하세요` 가 어색하고 잘린다 | FR-UIP-13 | 완료 |
| U13 | `커밋 메시지를 입력하세요` 가 늘 경고처럼 떠 있다 | FR-UIP-14 | 완료 |
| U14 | 설정 모달만 글자 체계가 다르다 | FR-UIP-15 | 완료 |
| U15 | `현재 테마 편집` 이 점선 상자다 | FR-UIP-16 | 완료 |
| U16 | Diff 툴바에서 버튼과 체크박스가 섞여 있다 | FR-UIP-17 | 완료 |
| A1 | Git 뷰 진입점 6개에 이름이 없다. 폭이 남으면 이름을 붙인다. fetch·pull·push 는 바꾸지 않는다 (사용자 결정) | FR-UIP-18 | 완료 |
| A2 | 빈 화면 안내가 지금 사이드 탭과 맞지 않는다 | FR-UIP-19 | 완료 |
| A3 | Commit 이 왜 꺼졌는지 모르고 키보드로 커밋할 수 없다 | FR-UIP-14·20 | 완료 |
| B4 | 저장소 추가가 경로 직접 입력뿐이다 | FR-UIP-21 | 완료 |
| B6 | 설정 탭 13개가 가로 한 줄이라 넘친다 → 세로 목록과 검색 | FR-UIP-22·23 | 완료 |
| C9 | Diff 머리의 `worktree ↔ index 1/2` 가 git 내부 용어다 | FR-UIP-24 | 완료 |
| U17 | 뒤로·앞으로 버튼의 툴팁이 한국어다 → 영어로 (2026-11-12) | FR-UIP-26 | 완료 |
| U18 | hunk 동작을 제대로 확인하고 기능을 고친다 (2026-11-12) | FR-UIP-25 | 완료 |
| U19 | fetch·pull·push 아이콘 크기를 맞춘다 — 이름은 붙이지 않는다 (2026-11-12). 키트 규칙과의 충돌은 "다른 버튼·아이콘과 통일" 로 정함 | FR-UIP-3 개정 | 완료 |
| U20 | stash·worktree·submodule 아이콘이 마음에 들지 않는다 — 실제로 쓰는 기호를 참고해 다시 만든다 (2026-11-12) | FR-UIP-27 | 완료 |
| — | 제외 (사용자 결정): B5 탭 자동 이름(이미 진행 중), C8 상태바 정보(설정으로 켜고 끈다), fetch·pull·push 합치기 | — | 제외 |

## 1. 개요

### 1.1 목적

2026-11-11 의 화면 진단(1440×900, 터미널·저장소·Git 변경·Diff·설정)에서 나온 결함을 고친다.
이 앱에는 장식성 결함(그라데이션·글로우·이모지)이 없다. 결함은 **같은 것을 다르게 그리는 자리**와
**쓰다가 막히는 자리**다. 테마 색, 글꼴, 레이아웃 구조는 바꾸지 않는다.

### 1.2 범위

- 포함: 사이드바, 칸(터미널) 본문과 탭줄, Repo 창의 Changes 사이드·Diff 툴바·빈 화면, 우측 레일, 설정 모달, 저장소 추가 다이얼로그, ko 카탈로그의 일반 동작 라벨.
- 비포함: 테마 색 값, 글꼴, 서버의 파일 접근 경계(`fsRootOf`), 툴팁 언어(D-WRD-3), fetch·pull·push 버튼, 상태바 항목, 탭 자동 이름.

### 1.3 방향 (설계 기준)

- 성격: 차분하다, 정확하다, 밀도가 높다.
- 크롬(테두리·버튼·배지)은 조용하게 두고, 색은 터미널과 코드 본문, 그리고 **살아 있는 상태**에만 쓴다.
- accent 는 "지금 선택된 것", "주 동작" 두 가지에만 쓴다.

## 2. 현재 상태 (실측)

| 자리 | 실측 | 근거 |
|---|---|---|
| 터미널 본문 | `.tp{padding:1px}` — 프롬프트가 칸 왼쪽 경계에서 1px | `style.css` `.tp` |
| 사이드바 폭 | `width:var(--sb-w,150px)` | `style.css` `#sidebar` |
| Git 진입점 아이콘 | 버튼 `ui-btn-lg` 30px, 아이콘 20.4px | 실측 |
| 사이드바 하단 버튼 | 63.5×30, 테두리 `1px solid var(--border)` | 실측 |
| 커밋 사유 줄 | 서버 사유 `empty_message` 를 입력 전부터 표시 | `git/commit.js` `_paint` |
| 설정 제목 | `font-weight:600`, `--fs-lg` | `style.css` `.modal-title` |
| Diff 비교 이름 | `'worktree ↔ index'` 등 코드에 박힌 영어 | `constants-git-changes.js:77` |
| 영어 라벨 | ko 카탈로그 값이 영어인 키 78개 (D-WRD-11 이 의도적으로 남김) | `i18n/ko.js` |
| 파일 목록 API | `/api/fs/list` 는 등록된 루트 아래만 답한다 | `handlers_fs.go` `fsRootOf` |

## 3. 기능 요구사항

### 3.1 간격·크기

- **FR-UIP-1** 터미널 본문은 칸의 위·아래 4px, 왼쪽·오른쪽 8px 안쪽 여백을 갖는다. 터미널의 열·행 수는 여백을 뺀 영역에서 계산한다.
- **FR-UIP-2** 사이드바의 기본 폭은 200px 이다. 이 창에 저장된 폭(`sessionStorage.sidebarWidth`)이 있으면 그 값이 이긴다(FR-UXB-6 그대로).
- **FR-UIP-3** (2026-11-12 개정 · 사용자 결정 "다른 버튼·아이콘과 통일") Git 진입점 버튼과 Changes 패널의 아이콘 버튼(fetch·pull·push, 보기 전환, 그룹·행 동작)의 아이콘은 키트 규칙(FR-UIK-3: 버튼 높이 × `--ui-icon-ratio`)을 따른다. 버튼이 모두 `lg`(30px, FR-GIT-226)이므로 패널 안의 아이콘은 한 크기(20px)다. 처음 판(16px 로 덮어씀)은 FR-UIK-3 과 충돌해 걷었다.
- **FR-UIP-4** Repo 사이드 Changes 탭의 블록(진입점 줄, 커밋, 브랜치·동기화 머리, 보기 전환 줄, 섹션 머리)의 가로 안쪽 여백은 모두 8px 이다. 섹션 머리 글자에 자간을 벌리지 않는다.
  - 실측(착수 시): 진입점 4px · 커밋 10px · 머리 10px · 보기 전환 6px · 섹션 머리 9/6px.
  - 섹션 사이의 굵은 구분선(`--git-sec-divider`)은 FR-GIT-216 의 의도(섹션의 시작을 행 구분선과 가른다)이므로 그대로 둔다.
- **FR-UIP-5** 사이드바 하단의 새로고침·설정 버튼은 테두리 없는 아이콘 버튼(`ui-btn-ghost`)이다. 히트 영역 높이 30px 는 유지한다.

### 3.2 색·상태 표현

- **FR-UIP-6** 개수 표시(사이드바 저장소 행, Changes 섹션 머리)는 배경과 테두리 없이 `--text-muted` 글자로, `tabular-nums` 로 그린다(키트 `.ui-count`). Activity 구역 머리의 개수는 살아 있는 상태라 배지로 남는다.
  - 개정: `WORDING_COLOR_SRS` FR-WRD-80 의 "개수는 배지 하나로" 는 Changes 섹션 머리에 한해 이 요구가 대신한다. 서식이 하나라는 취지는 그대로다(목록 머리의 개수는 모두 `.ui-count`).
- **FR-UIP-7** 개수가 0 이면 개수 표시를 감춘다. 대상: Changes 섹션 머리, Activity 구역 머리(펼친 패널과 레일 모두).
- **FR-UIP-8** 둘 이상 중 하나를 고르는 묶음(키트 `.ui-segment` 전부 — Changes 의 폴더·목록 보기 전환 포함)의 선택 상태는 `--accent-subtle` 배경과 `--text-bright` 글자, `--border-strong` 테두리로 그린다. accent 테두리를 쓰지 않는다. 설정의 세로 탭 목록과 `현재 테마 편집` 의 켜짐도 같은 말을 쓴다.
  - 개정: `KIT_COMPONENTS_SRS` FR-CMP-41 의 선택 외형(accent 테두리)을 이것으로 바꾼다. "선택은 등급이 아니라 상태다" 는 그대로다.
- **FR-UIP-9** 커밋 분할 버튼의 ▾ 는 중립 버튼 모양이다. 주 버튼(Commit)만 primary 다. ▾ 는 주 버튼이 꺼져도 눌린다(옵션이 활성 여부를 바꾸므로).
- **FR-UIP-10** (`UIUX_OVERHAUL_SRS` FR-HIE-2 개정) 칸이 하나뿐인 창에서는 탭줄의 포커스 표식(accent 아랫선)을 그리지 않는다. 칸이 둘 이상이면 FR-HIE-2 그대로 그린다.
  - 이전 동작: 칸 수와 관계없이 포커스 칸의 탭줄에 accent 2px 선
  - 새 동작: 칸이 하나면 선이 없다
  - 이유: 고를 칸이 하나면 표식이 전하는 정보가 없다

### 3.3 문구

- **FR-UIP-11** (`WORDING_COLOR_SRS` D-WRD-11 부분 개정) 일반 동작 라벨의 ko 값은 한국어다. 낱말은 부록 A 표를 따른다. en 값은 바꾸지 않는다.
- **FR-UIP-12** git 고유 용어(Fetch·Pull·Push·Commit·Checkout·Merge·Rebase·Cherry-pick·Revert·am·Bisect·Blame·Pop·Drop·Reset·Clean·Stash)와 설정 탭 이름(FR-B-5)은 ko 에서도 영어다. 코드에 박힌 라벨(`'Cancel'`·`'Copy'` 상수, 브랜치 충돌·미머지·dirty 선택지)은 카탈로그 키를 거친다. 툴팁(`title`)은 영어로 남는다(D-WRD-3).
- **FR-UIP-13** 저장소가 하나도 없을 때의 안내는 `등록된 저장소가 없습니다` 다.
- **FR-UIP-14** 커밋 사유 줄은 서버 사유가 `empty_message` 일 때와 답을 기다리는 동안(`loading`) 비어 있다. 기다리는 동안의 글이 섰다가 걷히면 아래 목록이 한 줄 뛰어오르기 때문이다. 그 사유는 Commit 버튼의 `title` 로만 알린다. 다른 사유(`nothing_staged` 등)는 지금처럼 줄에 보인다.

### 3.4 글자·세부

- **FR-UIP-15** 모달 제목(설정 모달과 키트 `.ui-modal-head`)은 `--fs-lg`, 굵기 500 이다. 설정 탭 이름은 `--fs-md` 다.
- **FR-UIP-16** 설정 Theme 의 `현재 테마 편집` 은 키트의 기본 버튼(`ui-btn`)이다. 점선 테두리를 쓰지 않는다.
- **FR-UIP-17** Diff 툴바의 보기 상태 셋은 같은 모양으로 그린다.
  - 보기 방식: `나란히`·`통합` 두 칸짜리 선택 묶음 (FR-UIP-8 의 모양). 지금 방식이 선택돼 보인다.
  - `공백 무시`·`변경 없는 줄 접기`: 지금처럼 체크박스 라벨.
  - `Blame` 은 동작 버튼이며 보기 상태 묶음과 구분선으로 나뉜다.

### 3.5 막히는 곳 풀기

- **FR-UIP-18** Git 진입점 버튼은 여섯이 아이콘과 이름을 달고 **한 줄에** 설 폭(진입점 줄 600px 이상)이면 이름을 아이콘 오른쪽에 보인다. 폭이 모자라면 아이콘만 보인다. 줄을 늘려 이름을 다는 것은 남는 폭이 아니므로 하지 않는다. 이름은 각 뷰 탭의 제목과 같다. fetch·pull·push 줄은 바꾸지 않는다.
- **FR-UIP-19** Repo 편집 영역이 비었을 때의 안내는 지금 사이드 탭을 따른다.
  - Changes: `변경 목록에서 파일을 고르면 여기에 Diff 가 열립니다`
  - Explorer: `탐색기에서 파일을 열면 여기에 나타납니다` (현행)
  - 안내 아래에 `파일 빠른 열기` 와 그 단축키를 키캡으로 보인다. 단축키가 비어 있으면 그 줄은 없다.
- **FR-UIP-20** 커밋 메시지 입력에서 `Ctrl+Enter` 또는 `⌘Enter` 를 누르면 Commit 버튼을 누른 것과 같다. 버튼이 꺼져 있으면 아무 일도 하지 않는다. 입력의 placeholder 가 이 키를 알린다(macOS 는 `⌘Enter`, 그 밖은 `Ctrl+Enter`). 한글 조합 중의 Enter 는 무시한다.
- **FR-UIP-21** 저장소 추가 입력은 후보 목록을 보인다. 입력의 첫 값은 지금처럼 포커스 터미널의 cwd 다(FR-EDT-28).
  - 후보 1: 열린 터미널들의 cwd 중 입력으로 시작하는 것 (중복 제거, 포커스 터미널이 맨 앞, 묻는 터미널은 8개까지).
  - 후보 2: 입력한 경로의 부모 디렉터리가 **등록된 루트 아래**이면 그 안의 하위 디렉터리 중 입력한 이름으로 시작하는 것. 서버 경계(`fsRootOf`)는 넓히지 않는다.
  - 숨은 폴더(`.`로 시작)는 입력한 이름이 `.` 으로 시작할 때만 보인다. 후보는 8개까지다.
  - `↑`·`↓` 로 고르고 `Tab` 으로 입력에 채운다. `Enter` 는 지금처럼 추가한다. `Esc` 는 목록을 먼저 닫는다.
- **FR-UIP-22** (`UI_KIT_SRS` FR-UIK-14 개정) 설정 모달의 탭 목록은 왼쪽 세로 목록이다. 탭 순서와 이름은 바꾸지 않는다. 모달의 폭과 높이(FR-UIK-12)는 그대로다. 모바일에서는 지금 배치를 유지하고 검색 입력은 보이지 않는다.
- **FR-UIP-23** 세로 목록 위에 검색 입력이 있다. 입력한 글이 탭 이름이나 그 탭 안의 글(선택지 `<option>` 의 글은 빼고)에 들어 있는 탭만 목록에 남는다. 지금 고른 탭이 걸러지면 남은 첫 탭을 고른다. 입력이 비면 전부 보인다. 모달을 열 때마다 검색을 비운다.
- **FR-UIP-24** Diff 머리의 비교 이름은 카탈로그를 거친다. ko 값: `작업 트리 ↔ 스테이지`·`스테이지 ↔ HEAD`·`작업 트리 ↔ HEAD`·`커밋 ↔ 부모`. 위치 표시는 `변경 1/2` 이다. en 값은 현행 문자열이다.

### 3.6 2026-11-12 추가

- **FR-UIP-25** (`UX_BATCH12_SRS` FR-HKB-1·3·4 개정) Diff 의 hunk 툴바가 판단하는 단위는 **화면이 한 덩어리로 칠한 변경**이다. 커서가 칠해진 덩어리 안의 줄에 있으면 툴바가 뜨고, 동작(stage·unstage·revert)은 그 덩어리가 닿은 git 블록 전부에 걸린다. 칠해지지 않은 줄에서는 뜨지 않는다.
  - 실측(결함): 화면(CodeMirror)은 `-7`(삭제)과 `+9b`(추가)를 새 7~9행 한 덩어리로 칠하는데, git 은 사이의 8·9행을 문맥으로 두고 블록 둘로 나눈다. 칠해진 8·9행에 커서를 두어도 툴바가 뜨지 않았다.
  - 이전 동작: git 블록만 봤다. 새 동작: 칠해진 덩어리 → 닿은 블록 전부. 이유: 보이는 조각과 동작의 대상이 같아야 한다(FR-HKB 의 취지).
- **FR-UIP-27** Git 진입점의 Stash·Worktrees·Submodules 는 git 전용 기호를 쓴다. 빌려 쓰던 기호는 다른 뜻으로 이미 쓰이고 있었다(`archive` = Activity 의 백그라운드 도구, `columns` = 분할, `box` = 샌드박스).
  - Stash: 쌓인 층(lucide `layers`). stash 는 `stash@{n}` 으로 쌓이는 스택이다. GitHub Octicons 도 쌓인 층(`stack`)을 쓴다.
  - Worktree: 브랜치 표식이 든 폴더(lucide `folder-git-2`). 브랜치 하나를 따로 꺼낸 폴더다. GitLens 의 worktree 기호도 폴더와 브랜치를 겹친다.
  - Submodule: 커밋 점이 꽂힌 폴더(lucide `folder-git`). 다른 저장소의 한 커밋에 고정된 폴더다. GitHub 도 submodule 을 폴더 계열 기호(`file-submodule`)로 그린다.
- **FR-UIP-26** 뒤로·앞으로 버튼의 툴팁은 ko 에서도 영어다(FR-TIP-2). 이웃한 슬롯 버튼과 같다.

## 4. 비기능 요구사항

- **NFR-UIP-1** 새 크기 값은 4px 격자 위에 있다(2px 미세 조정 제외).
- **NFR-UIP-2** 새 색은 기존 토큰만 쓴다. 하드코딩 색 게이트(`make gates`)를 통과한다.
- **NFR-UIP-3** 기존 접근성 하한(히트 30px, 포커스 링)을 낮추지 않는다.
- **NFR-UIP-4** 레이아웃 기준선(`ui-layout.*.json`)은 바뀐 키만 새로 잰다.

## 5. 검증

| TC | 대상 | 방법 |
|---|---|---|
| TC-UIP-1 | FR-UIP-1 | e2e: `.tp.vis` 의 계산된 padding 이 `4px 8px` |
| TC-UIP-2 | FR-UIP-2 | e2e: 저장된 폭이 없을 때 `#sidebar` 폭 200 |
| TC-UIP-3 | FR-UIP-3·18 | e2e: 진입점 아이콘 16px, 버튼 높이 ≥30; 사이드 폭 넓을 때 이름 보임, 좁을 때 숨김 |
| TC-UIP-4 | FR-UIP-5 | e2e: 하단 버튼 테두리 색이 투명 |
| TC-UIP-5 | FR-UIP-6·7 | e2e: 스테이지 0 이면 개수 숨김, 레일 0 숨김 |
| TC-UIP-6 | FR-UIP-10 | e2e: 칸 하나일 때 탭줄 box-shadow 없음, 분할하면 있음 |
| TC-UIP-7 | FR-UIP-11·12·24 | 단위: ko 카탈로그의 부록 A 키 값이 표와 같고, git 용어 키는 영어 |
| TC-UIP-8 | FR-UIP-14·20 | e2e: 빈 메시지에서 사유 줄 비어 있음; 메시지 입력 후 스테이지 상태에서 `Ctrl+Enter` 로 커밋 |
| TC-UIP-9 | FR-UIP-19 | e2e: Changes 탭에서 빈 편집 영역 안내 문구 |
| TC-UIP-10 | FR-UIP-21 | e2e: 터미널 cwd 후보가 보이고 `Tab` 으로 채워짐 |
| TC-UIP-11 | FR-UIP-22·23 | e2e: 탭 목록 세로 배치, 검색으로 거르기와 선택 이동 |
| TC-UIP-12 | FR-UIP-17 | e2e: 보기 방식 묶음에서 지금 방식이 선택 상태 |
| TC-UIP-13 | FR-UIP-4·8·9·15·16 | 화면 확인 (스크린숏 비교) |
| TC-UIP-14 | FR-UIP-25 | 단위: `gitHunkSpanAt`(덩어리가 블록 둘에 걸침·하나·문맥뿐) · e2e `git-hunk.spec.ts`: 삭제와 추가 사이의 칠해진 줄에 커서 → 툴바 → Revert 가 둘 다 되돌림 |
| TC-UIP-15 | FR-UIP-26 | e2e `tooltips.spec.ts` C3~C9 |

## 부록 A. 일반 동작 라벨의 ko 낱말

| en | ko |
|---|---|
| Cancel | 취소 |
| Close | 닫기 |
| Copy | 복사 |
| Copy Path | 경로 복사 |
| Copy Command | 명령 복사 |
| Copy Output | 출력 복사 |
| Create | 만들기 |
| Add | 추가 |
| Remove | 제거 |
| Delete | 삭제 |
| Delete (local) | 삭제 (로컬) |
| Delete (remote) | 삭제 (원격) |
| Delete local and remote | 로컬과 원격 삭제 |
| Delete remote branch | 원격 브랜치 삭제 |
| Rename | 이름 바꾸기 |
| Set | 설정 |
| Retry | 다시 시도 |
| Undo | 되돌리기 |
| Apply | 적용 |
| Apply (--index) | 적용 (--index) |
| Compare | 비교 |
| Run (확인창) | 실행 |
| Open File | 파일 열기 |
| Open File (HEAD) | 파일 열기 (HEAD) |
| Open Changes | 변경 열기 |
| File history | 파일 기록 |
| Show Reads | 읽기 보기 |
| Replay | 다시 실행 |
| Create Tag | 태그 만들기 |
| Add to .gitignore | .gitignore 에 추가 |
| Fold Unchanged | 변경 없는 줄 접기 |
| Ignore Whitespace | 공백 무시 |
| side-by-side / unified | 나란히 / 통합 |
| Drop files here | 여기에 파일을 놓으세요 |
| Checkout as local | 로컬로 Checkout |
| Merge into current | 현재 브랜치에 Merge |
| Fetch into local | 로컬로 Fetch |
| Unset upstream | upstream 해제 |
| Push to remote | 원격에 Push |
| Push all tags | 모든 태그 Push |
| Stash and continue | Stash 하고 계속 |
| Force (discard changes) | 강제 (변경 버림) |
| Checkout existing branch | 기존 브랜치로 Checkout |
| Create with another name | 다른 이름으로 만들기 |
| Delete anyway (-D) | 그래도 삭제 (-D) |

영어로 남는 것: git 고유 용어(FR-UIP-12), `Reset (mixed)`, 기능 이름(`Box`·`Slot`·`Split H/V`·`Run`), 검색 토글(`Aa`·`ab`), `CPU`, 설정 탭 이름.

## 6. 개정 기록

| 날짜 | 내용 |
|---|---|
| 2026-11-11 | 작성. 범위와 언어 정책은 사용자 결정 |
| 2026-11-11 | 구현·검증 완료. 회귀(관련 e2e 50개 스펙)가 잡은 것 둘을 고쳤다 — 커밋 영역의 가로 여백을 줄이며 짝인 음수 여백(`.git-commit-resize`·`.git-preflight`)이 남아 넘쳤고, 기다리는 동안의 사유 글이 걷히며 목록이 뛰었다(FR-UIP-14 에 `loading` 을 더함). 다이얼로그 실행 버튼의 툴팁을 라벨과 가름(`GIT_DIALOG_RUN_TITLE`, FR-TIP-2) |
| 2026-11-11 | 구현하며 정정: FR-UIP-4 의 범위를 가로 여백으로 좁힘(섹션 구분선은 FR-GIT-216 의 의도), FR-UIP-6·7 에 Activity 를 명시, FR-UIP-8 을 키트 세그먼트 전체로 넓힘, FR-UIP-15 를 키트 모달 머리까지 넓힘, FR-UIP-20 은 두 수식키를 모두 받음. 게이트(FR-WRD-43)가 이웃 라벨 다섯(브랜치 충돌·미머지·dirty 선택지)을 함께 카탈로그로 옮기게 했다 — 부록 A 에 더함 |
