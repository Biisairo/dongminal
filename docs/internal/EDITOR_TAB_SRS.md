# SRS: Editor 탭 — 파일 탐색기와 편집기 창 — IEEE 29148

> **후속 문서가 이 SRS 의 일부를 개정했다.** 어긋나면 후속이 이긴다.
>
> | 개정된 것 | 어떻게 | 어디서 |
> |---|---|---|
> | FR-EDT-54 (Editor 창에는 편집기 탭만) | **git 뷰 탭도 산다** — 본문에 Diff·History 등이 편집기 탭과 같은 자격으로 뜬다 | REPO_TAB_UNIFY_SRS FR-RTU-16·30 |
> | FR-EDT-69 (루트가 저장소 **루트**일 때만 색) | 루트가 저장소 **안**이어도 색을 입힌다 | GIT_DIR_ENTRY_SRS FR-DIR-40 |
> | FR-EDT-75 (폴더는 자기 상태를 갖지 않는다) | 서브모듈·중첩 저장소는 폴더가 상태의 단위다 | GIT_DIR_ENTRY_SRS FR-DIR-11 |
> | Editor 창의 좌측 = 탐색기 | 좌측은 **사이드**이고 `Explorer`·`Changes` 두 탭을 갈아 끼운다 | REPO_TAB_UNIFY_SRS FR-RTU-11·12 |
> | 사이드바 `Editor` 탭 | `Git` 과 합쳐 `Repo` 한 탭이 됐다 (`Ctrl+Shift+2`) | REPO_TAB_UNIFY_SRS FR-RTU-1·7 |

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

접수한 요구는 열한 줄 + 연동 네 줄이다. 요지는 하나다.

> **편집기를 일반 창의 탭에서 걷어내고, 경로마다 하나씩 서는 "Editor" 라는 제3의
> 사이드바 탭으로 옮긴다. 그 창은 좌측에 파일 탐색기를, 우측에 편집기를 갖는다.**

지금 편집기는 `edit <path>` 나 Git 창의 `Open File` 로 **일반 창의 탭**에 열린다
(`app-layout.js:252-275`). 그래서 편집기는 터미널과 자리를 다투고, "이 저장소의
파일들"이라는 묶음이 화면 어디에도 없다. 파일을 찾는 수단도 없다 — 경로를 이미
알고 있어야만 열 수 있다.

본 SRS 는 편집기를 **자기 공간**으로 옮긴다. Git 이 리포마다 핀을 갖듯 Editor 는
경로마다 행을 갖고, 행 하나가 창 하나다. 그 창은 탐색기로 파일을 찾고, 편집기
칸을 드래그로 쪼갠다.

### 1.2 범위 (Scope)

**포함**

| 묶음 | 내용 |
|---|---|
| **T** 사이드바 | 세 번째 탭 `Editor` 신설. 행 목록 + 최하단 고정 root 행 |
| **E** 엔티티 | Editor 행의 영속·순서·추가·제거. 서버 권위 |
| **L** 연동 | Git 핀 ↔ Editor 행의 상호 생성·제거 (요구 "git/editor 통합" 4줄) |
| **W** 창 | `WINDOW_TYPE_EDITOR` — 탐색기 + 편집기 영역. 분할은 드래그드롭만 |
| **X** 탐색기 | dot 파일 포함 전량 표시, 지연 로드, git 색 |
| **F** 파일 조작 | 새 파일·새 폴더·이름 변경·삭제·드래그 이동 |
| **R** 라우팅 | `edit` 명령과 Git `Open File` 이 어느 Editor 로 가는가 |
| **M** 마이그레이션 | 일반 창에 남은 편집기 탭 제거 |
| **S** 서버 표면 | 디렉터리 조회·파일 조작·Editor 목록 API |

**미포함:** §6 비목표. 특히 **Git 창 내부의 동작과 Monaco 편집기 자체의 동작은 한
줄도 바뀌지 않는다** — `FileEditor` 는 붙는 자리만 달라진다.

### 1.3 정의 (Definitions)

| 용어 | 정의 |
|------|------|
| **Editor 행 (editor entry)** | 사이드바 Editor 탭의 한 항목. 절대경로 하나를 가리킨다 |
| **root 에디터** | 홈 디렉터리에서 생성된 특수 행. 최하단 고정, 삭제 불가 |
| **Editor 창** | 행 하나에 대응하는 `type==='editor'` 창 |
| **탐색기 (explorer)** | Editor 창 좌측의 파일 트리. 분할에 참여하지 않는다 |
| **편집기 영역 (edit area)** | Editor 창 우측. 기존 window 의 분할 트리를 그대로 쓴다 |
| **연결된 Editor** | 어떤 절대경로를 자기 root 아래에 포함하는 Editor 창 |

### 1.4 참조 (References)

- [`./GIT_SIDEBAR_TABS_SRS.md`](./GIT_SIDEBAR_TABS_SRS.md) — FR-SBT-18~21 (탭 서술자 인터페이스), FR-SBT-22~25 (탭↔창 연동), FR-SBT-26~33 (단축키)
- [`./GIT_SRS.md`](./GIT_SRS.md) — FR-GIT-25~31 (Git 창 = 특수 창의 유일한 선례), FR-GIT-10~17 (좌측 리포 목록. FR-GIT-9 는 철회됐다)
- [`./ENTITY_MODEL_RESTRUCTURE_SRS.md`](./ENTITY_MODEL_RESTRUCTURE_SRS.md) — Window ─ Pane ─ Tab ─ Tool 계층
- [`./UX_REVISION_SRS.md`](./UX_REVISION_SRS.md) — FR-STC-2/3 (상태문자 → CSS 클래스, 색은 한 자리에서)
- [`./GIT_REVIEW4_SRS.md`](./GIT_REVIEW4_SRS.md) — FR-RPT-* (바깥 계기의 다시 그리기가 요소 상태를 깨지 않게)
- [`./architecture.md`](./architecture.md) — 파일 편집기 절, 사이드바 탭 절, 커맨드 브로드캐스트 절

---

## 2. 현재 상태 (조사로 확정한 사실)

착수 전 조사와 스펙 1차 검증에서 확인한 것이다. **설계 판단의 근거이므로 추측이
아닌 파일:줄로만 적는다.**

### 2.1 사이드바 탭은 이미 서술자 인터페이스다

`SB_TAB_DEFS` (`web/js/ui/sidebar-tabs.js:32-180`) 배열이 단일 진실이고, 아래 넷이
배열에서 **파생**된다 — 탭 버튼·직행 키 `Ctrl+Shift+Digit{n}`(`:192-198`)·
`executeAction('sidebarTab{n}')`(`web/js/core/app.js:191`)·설정 화면 단축키
그룹(`web/js/core/app-settings.js:239`).

**파생되지 않는 것이 둘 있다.**

1. **패널 래퍼** — `index.html` 의 `.sb-panel` 은 정적 마크업이다 (`:31` windows,
   `:38` git). 이것은 결함이 아니라 설계다 — `architecture.md:126-128` 이 새 탭의
   비용을 "서술자 1개 **+ 패널 래퍼 1개**" 로 못박고 있고,
   `e2e/sidebar-tabs.spec.ts:388-390` 도 데모 탭 테스트에서 패널 div 를 직접 만든다.
2. **목록 렌더 호출** — `renderer.js:52`·`:60` 에 탭 id 문자열로 **두 번
   하드코딩**돼 있다. 이쪽은 파생될 수 있는데 되지 않은 것이다.

```js
_rSidebar(){ SidebarList.paint(this.app,SB_TAB_DEFS.find(d=>d.id==='windows')) }
_rGitSection(){ SidebarList.paint(this.app,SB_TAB_DEFS.find(d=>d.id==='git')) }
```

세 번째 탭이 목록을 가지는 순간 걸린다. e2e T16(`e2e/sidebar-tabs.spec.ts:377-409`)이
이것을 못 잡는 이유는 그 데모 탭에 `list` 가 없기 때문이다.

### 2.2 특수 창의 선례는 Git 창 하나다

`WINDOW_TYPE_GIT` 창은 워크스페이스에 1개인 "닫힌 창"이고, 그 특수성은 **게이트**로
표현돼 있다. 창 조건과 탭 타입 조건이 **다른 자리**임에 유의한다.

| 게이트 | 위치 | 판정 |
|---|---|---|
| 분할 금지 | `app-layout.js:402` | 창 (`_isGitWin`) |
| 탭 추가 금지 | `app-layout.js:220` | 창 |
| pane 간 이동 | `app-dnd.js:16` | 창 |
| 창 간 이동 (출발·도착) | `app-dnd.js:44`·`:46` | 창 |
| 드롭 분할 | `app-dnd.js:91` | 창 |
| 탭 자체가 못 움직임 | `app-dnd.js:22`·`:50`·`:96` | **탭 타입** (`TAB_TYPE_GIT`) |
| 툴바 분할 버튼 숨김 | `renderer.js:69-74` | 창 |
| 사이드바 창 목록 제외 | `app-git.js:14` (`_plainWindows`) | 창 |

**Editor 창의 조건은 창 판정 자리에만 더한다** — 탭 타입 자리에 넣으면 편집기 탭이
자기 창 안에서도 못 움직이게 된다 (FR-EDT-40 이 깨진다).

### 2.3 분할 트리의 소유자는 브라우저다

Go 서버에 split 로직이 없다. 서버는 workspace blob 을 rev/ETag 와 함께 보관하고
(`internal/shared/workspace/manager.go:200`), 명령을 SSE 로 브로드캐스트할 뿐이다.
저장은 **raw blob 보존**이므로(`manager.go:217`) Go 가 선언하지 않은 필드
(`sizes`·`tab.type`·`tab.filePath`·`window.git`)도 그대로 왕복한다.

> **따라서 `window.editor` 필드와 새 탭 필드를 더하는 데 Go 변경이 필요 없다.**
> 서버가 트리를 변형하는 유일한 지점(`handlers_runs.go:564 applyRunMarks`)도
> `map[string]any` 로 걸어 모르는 필드를 손대지 않는다.

### 2.4 **`layout` 이 없는 창은 지워진다** — 이번 작업의 최대 제약

로드 경로와 SSE 동기화 경로가 **같은 필터**를 돌린다.

```js
web/js/core/app.js:104      this.ws.windows=this.ws.windows.filter(s=>s&&s.layout);
web/js/core/app-cmd.js:210  sv.windows=sv.windows.filter(s=>s&&s.layout);
```

그리고 `app-cmd.js:210` 은 `workspace_changed` SSE 경로인데, 그 이벤트는
`gitapi/git_pins.go:105` 가 **핀 하나만 바뀌어도** 쏜다.

> **FR-EDT-42(pane 이 없는 Editor 창)는 이 필터를 고치지 않으면 성립하지 않는다.**
> 갓 만든 Editor 창이 다음 git pin 한 번에 사라진다. FR-EDT-49 가 이 필터를 고친다.

같은 두 자리에 창 마이그레이션 호출도 있다 — `_migrateGitWindow`
(`app-git.js:51`, 호출 `app.js:106`·`app-cmd.js:212`). **Editor 창 재조정과 편집기
탭 마이그레이션이 들어갈 자리가 여기다.**

### 2.5 Git 핀의 영속 규약이 Editor 목록의 본이다

| 관심사 | Git 핀의 방식 | 위치 |
|---|---|---|
| 저장 위치 | `workspace.json` 최상위 `git.pinned[]` (창 트리 밖) | `gitapi/git_pins.go:14-20` |
| 부분 변경 | 다른 키를 보존하는 read-modify-write + 낙관적 동시성 2회 시도 | `git_pins.go:36-76` |
| 권위 | **서버**. 클라이언트는 응답을 로컬 사본에 반영만 | `app-git.js:406-412` |
| 409 충돌 | 서버의 `git` 을 채택하되 `drafts`·`favorites` 만 로컬 우선 | `app.js:226-232` |
| 다중 창 동기화 | `Broadcast({"action":"workspace_changed","args":{"rev"}})` | `git_pins.go:101-112` |
| 정규화 | 저장 전 `RepoRoot` 로 정규화. 삭제는 문자열 일치(정규화 없음) | `handlers_git.go:275`,`:307` |
| 재정렬 | 전체 배열이 아닌 `(src, target, before)` 델타 | `handlers_git.go:327-331` |

**409 병합 코드는 `git` 키만 안다** (`app.js:226-232`). `editors` 를 더하려면 그
분기를 함께 고쳐야 한다 (FR-EDT-18a).

### 2.6 파일 표면은 둘뿐이고 디렉터리 조회는 없다

- `GET /api/file/read?path=<abs>` — 절대경로 필수, `text/plain` 스트리밍 (`handlers_files.go:132`)
- `POST /api/file/write` — `{path, content}` → `os.WriteFile(…, 0o644)` (`:166`)
- **디렉터리 목록·생성·이름변경·삭제 종단은 존재하지 않는다.** 라우트 표
  (`handlers_api.go:70-153`)와 git 라우트(`gitapi/routes.go:20-112`) 전량 확인.
- 경로 가드는 `safeResolve("/", userPath)` — base 가 `/` 라 사실상 절대경로 전체가
  대상이다 (`handlers_files.go:35`,`:142-146`).
- `apiFileRead` 는 디렉터리에 400 `not a file` 을 낸다 (`:153`). **심볼릭 링크된
  디렉터리를 파일로 착각해 클릭하면 여기에 걸린다** (FR-EDT-60 이 막는다).

### 2.7 파일 단위 git 상태는 이미 나온다

`GET /api/git/status?repo=<abs>` 가 `staged`·`changes`·`untracked`·`conflicts` 네
배열로 준다. 항목 타입은 `query.FileEntry` (`domain/git/query/status.go:15-25`)이며
`XY` 에 porcelain v2 원문 2문자를 보존한다. 캐시는 TTL 200ms
(`domain/git/store/store.go:15-20`) + single-flight (`:31`,`:136-148`)이므로
**탐색기가 얹혀도 git 실행이 늘지 않는다.**

### 2.8 상태색은 한 자리에 있으나 **스코프가 Git 패널에 묶여 있다**

```css
web/style.css:1119  .git-files{--git-st-add:#9ece6a}
web/style.css:1120  .git-file-st.st-mod{color:var(--accent)}
web/style.css:1122  .git-file-st.st-del{color:var(--danger)}
web/style.css:1125  .git-file-st.st-ren{color:var(--text-bright)}
web/style.css:1128  .git-file-st.st-new{color:var(--git-st-add)}
```

초록값 `--git-st-add` 는 `.git-files` **조상에만** 있고 색 규칙은 전부
`.git-file-st` 로 스코프됐다. 탐색기 트리에는 그 조상이 없다.

> **따라서 "색 정의 자리를 늘리지 않는다"(D-4)를 지키려면 변수를 `:root` 로
> 올려야 한다** (FR-EDT-70). 값은 그대로이므로 Git 패널의 표시는 바뀌지 않는다.

`R`·`C` 가 `--attn` 을 쓰지 않는 이유가 CSS 주석(`:1123-1124`)에 있다 — `--attn` 은
부분 스테이지(FR-GIT-190)의 색이고, 겹치면 두 사실이 같은 노랑이 된다. 탐색기도
같은 제약을 받는다.

### 2.9 `clean()` 은 편집기 탭을 **보존하도록** 만들어져 있다

```js
web/js/core/helpers.js:280
  if(t.type==='editor'||t.type==='run'||t.type===TAB_TYPE_GIT) return true;
```

주석(`:274-279`)이 그 이유를 못박는다 — "editor·git·run 탭은 toolId 가 없어 그대로
두지 않으면 로드마다 사라진다". 게다가 시그니처가 `clean(n, ok)` 라 **창 타입을
알지 못한다.**

> **편집기 탭 마이그레이션(FR-EDT-97)을 `clean` 에 넣을 수 없다.** 창을 순회하는
> 자리(§2.4)에서 창 타입을 보고 해야 한다.

### 2.10 탐색기 폭은 워크스페이스에 넣는 것이 기존 규약이다

`sidebarWidth` 는 **워크스페이스에 산다** — `input-binding.js:46` 이
`this.app.ws.sidebarWidth=w` 로 쓰고 `_save()` 한다(`:47`). `localStorage` 는 첫
페인트를 위한 **사본**일 뿐이다 (`index.html:17`, `app.js:94-97`,
`app-cmd.js:246-249`).

### 2.11 편집기는 붙는 자리만 바꾸면 된다

`FileEditor` (`web/js/ui/file-editor.js:181`)는 Monaco 를 CDN 에서 받아 `.file-editor`
DOM 하나를 만들고, `app.fileEditors` Map(`app.js:7`)에 tab.id 로 산다. 마운트는
`renderer.js:225-230` 한 곳이다. **이 클래스는 이번 작업에서 바뀌지 않는다.**

---

## 3. 요구사항 (Requirements)

### 3.1 묶음 T — 사이드바 Editor 탭

**FR-EDT-1.** `SB_TAB_DEFS` 에 세 번째 서술자를 더한다 — `id:'editor'`,
`label:'Editor'`, `panelId:'sb-panel-editor'`, 그리고 `list` 객체. 배열 순서는
**Windows · Git · Editor** 이며 이 순서가 곧 탭 순서이자 직행 키 번호다.

**FR-EDT-2.** 서술자의 `list` 는 기존 둘과 같은 계약을 갖는다 — `containerId` ·
`itemClass` · `xClass` · `emptyText` · `items(app)` · `key(e)` · `row(app,e)` ·
`reorder` (`sidebar-tabs.js:42-85`,`:102-178`). 여기에 **`fixed(app)` 하나를
더한다** — 목록 뒤에 고정으로 붙는 항목들이며 root 행이 그것이다 (FR-EDT-14).

**FR-EDT-3.** `index.html` 에 패널 래퍼 하나를 더한다 — `<div class="sb-panel"
id="sb-panel-editor" hidden>` 안에 `.sb-actions`(`#editor-add`)와 목록 컨테이너
`#editor-entries` **하나**. root 행은 별도 컨테이너를 갖지 않는다 (FR-EDT-14).

> 패널 래퍼를 손으로 두는 것은 결함이 아니라 기존 규약이다 (§2.1).

**FR-EDT-4.** `renderer.js:52`·`:60` 의 목록 렌더 하드코딩을 **서술자 배열 순회로
일반화**한다. `list` 를 가진 서술자 전부에 대해 `SidebarList.paint` 를 부른다.
이는 Editor 탭이 **드러낸** 기존 결함이며, 하드코딩으로 셋째를 더하면 넷째에서 같은
일이 반복된다.

**FR-EDT-5.** 직행 키 `Ctrl+Shift+Digit3` 은 배열 인덱스에서 **파생**된다.
`SHORTCUT_DEFAULTS`·`SHORTCUT_LABELS`·`shortcuts`·`executeAction` 맵·설정 화면
그룹 어디에도 손으로 넣지 않는다 (FR-SBT-26~30).

**FR-EDT-6.** 순회 키(`Ctrl+Shift+[`·`]`)가 Editor 탭에서는 **Editor 행**을 돈다
(FR-SBT-31~33). 순회 대상은 `items(app)` 뒤에 `fixed(app)` 을 이어 붙인 순서이므로
root 행이 **마지막 자리로 포함**된다 — 제외하면 키만으로는 root 에 갈 수 없다.

**FR-EDT-7.** 서술자의 `onActivate` 는 Editor 탭을 고를 때 **콘텐츠 창까지
전환**한다 (FR-SBT-22). 대상은 마지막으로 활성이었던 Editor 창이고, 그런 창이
없으면 root 에디터 창이다.

**FR-EDT-8.** 역방향도 성립한다 — Editor 창이 활성이면 사이드바 탭이 `editor` 로
따라온다 (FR-SBT-14). 재진입은 기존 `_sbBusy` 가드가 그대로 끊는다.

**FR-EDT-9.** 행을 클릭하면 그 행의 Editor 창이 활성화된다.

**FR-EDT-10.** 행의 표시 이름은 경로의 마지막 조각이고 툴팁은 절대경로 전체다.
root 행의 표시 이름은 `~` 다.

**FR-EDT-11.** Editor 탭에는 배지가 없다. 관측할 수치가 없고, Git 탭이 배지를
폐기한 근거(FR-GOB-13)가 여기에도 그대로 걸린다.

**FR-EDT-12.** 일반 행은 드래그로 순서를 바꿀 수 있다. 델타는 Git 핀과 같은
`(src, target, before)` 다 (FR-EDT-27).

### 3.2 묶음 T — root 에디터 행

**FR-EDT-13.** root 에디터는 **서버가 알려주는 홈 디렉터리**에서 생성된 Editor 이며
항상 존재한다. 사용자가 지운 적이 없어도, 워크스페이스가 비어 있어도 있다.

**FR-EDT-14.** root 행은 **패널의 최하단**에 고정된다 — 목록의 끝이 아니라
설정 버튼 바로 위다. 서술자의 `fixed(app)` 이 돌려주는 항목이며 **별도
컨테이너**(`fixedContainerId`)에 그려진다. 목록이 남은 높이를 전부 쓰므로
(`.sbl-list` 가 `flex:1 1 auto`) 고정 블록은 자연히 바닥에 붙고, 목록이 길어
스크롤이 생겨도 그 아래에 남는다.

순회(FR-EDT-6)는 여전히 `entries()`(= `items` 뒤에 `fixed`) 하나를 지나므로
그리는 순서와 도는 순서가 어긋나지 않는다.

**FR-EDT-15.** root 행에는 제거 버튼(`×`)이 없고 드래그 순서 변경의 출발점도,
**대상**도 아니다. 일반 행을 root 행 위로 끌어도 순서가 바뀌지 않는다.

**FR-EDT-16.** 일반 행은 홈 디렉터리와 같은 경로를 가질 수 없다. 그 경로의 추가
요청은 **성공으로 처리하되 목록을 바꾸지 않는다** — root 행이 이미 그 경로를
대표하므로 오류가 아니다 (FR-EDT-25 의 멱등과 같은 규약).

**FR-EDT-17.** root 에디터의 경로는 워크스페이스에 저장하지 않는다. 서버의 홈에서
**파생**한다 — 저장하면 홈이 바뀐 환경에서 지울 수도 고칠 수도 없는 행이 남는다.

**FR-EDT-18.** root 에디터는 연동으로 사라지지 않는다 (FR-EDT-38).

### 3.3 묶음 E — Editor 엔티티와 영속

**FR-EDT-19.** Editor 목록은 `workspace.json` 최상위 `editors.list[]` 에 절대경로
문자열 배열로 산다. Git 핀(`git.pinned[]`)과 같은 층위이며 창 트리 밖이다.

**FR-EDT-20.** **권위는 서버다.** 클라이언트는 응답을 로컬 사본에 반영만 한다.

**FR-EDT-20a.** **창이 하나도 없는 워크스페이스에서도 서버 소유 키를 채택한다.**
로드 경로는 `sv.windows.length` 가 0 이면 서버 스냅샷을 통째로 버리는데
(`app.js`), `git.pinned`·`editors.list` 는 **창과 무관하게 서버가 권위**이고 창이
없는 워크스페이스에도 들어 있다. 버린 채로 `_mkWindow()` 와 재조정이 `_save()` 를
부르면 그 PUT 이 두 키를 **지운다** — 핀을 걸어 둔 채 브라우저를 처음 열면 핀이
사라진다(실측). 두 키는 창 분기 **밖에서** 반영한다.

**FR-EDT-21.** 409 충돌 시 서버의 `editors` 를 그대로 채택한다. **`app.js:226-232`
의 병합 분기는 지금 `git` 키만 안다 — `editors` 분기를 함께 더한다.** `editors` 에는
클라이언트가 소유하는 하위 키가 없으므로 병합 없이 서버 값을 통째로 쓴다.

**FR-EDT-22.** 목록 변경은 **다른 키를 보존하는 read-modify-write** 로 하고,
`ErrStale` 이면 1회 재시도한다. 성공 시 `workspace_changed` 를 브로드캐스트한다.

**FR-EDT-23.** 추가는 절대경로만 받는다. 존재하지 않거나 디렉터리가 아니면 거부한다.

**FR-EDT-24.** **경로 정규화는 `filepath.EvalSymlinks` + `filepath.Clean` 하나로
통일한다.** Editor 추가와 Git 핀 추가가 같은 함수를 지나야 연동의 "같은 경로"
짝짓기가 성립한다 (FR-EDT-31~35). macOS 의 `/tmp` → `/private/tmp` 처럼 두 정규화
결과가 갈리면 짝이 **조용히** 깨진다.

**FR-EDT-25.** 추가는 멱등이다. 이미 있는 경로는 오류가 아니라 그대로 성공이며 목록이
변하지 않는다.

**FR-EDT-26.** 제거는 **문자열 완전 일치**로 한다. 경로를 다시 정규화하지 않는다 —
사라진 디렉터리의 행도 지울 수 있어야 한다 (Git unpin 과 같은 근거,
`handlers_git.go:307`).

**FR-EDT-27.** 순서 변경은 전체 배열이 아니라 `(src, target, before)` 델타로 보낸다.
목록에 없는 `src`·`target` 은 배열을 그대로 둔다. **빈 문자열 `target` 만 예외다** —
그것은 사라진 대상이 아니라 "맨 끝" 이라는 의도이므로(FR-EDT-111) `src` 를 끝으로
옮긴다.

**FR-EDT-28.** `+ Add` 는 **지금 터미널의 cwd** 를 미리 채운 다이얼로그를 연다.
터미널이 없거나 cwd 를 얻지 못하면 빈 칸으로 연다 (`_gitRepoAt` 와 같은 규약,
`app-git.js:297-303`).

**FR-EDT-29.** 목록 조회는 `{home, list[]}` 를 준다. `home` 은 root 행의 경로이며
`list` 에는 들어 있지 않다 (FR-EDT-17).

**FR-EDT-30.** 서버는 `editors` 를 파싱할 때 배열이 아니거나 문자열이 아닌 항목을
**조용히 버린다.** 손상된 워크스페이스가 종단 전체를 죽이지 않는다.

**FR-EDT-120.** `/api/editors` 가 실패하면(404·503 등) 클라이언트는 `_edOff` 로 보고
**Editor 탭 자체를 숨긴다** — Git 탭이 `_gitOff` 로 하는 것과 같다 (FR-SBT-8,
`app-git.js:227`). `home` 을 모르면 root 행을 만들 수 없고, 추측한 홈으로 창을
만들면 나중에 서버가 알려준 홈과 어긋난 창이 남는다.

### 3.4 묶음 L — Git / Editor 연동

**FR-EDT-31.** Git 핀을 추가하면 **같은 경로의 Editor 행이 함께 생긴다.** 이미 있으면
아무 일도 하지 않는다.

**FR-EDT-32.** Git 핀을 제거하면 **같은 경로의 Editor 행이 함께 사라진다.** 없으면
아무 일도 하지 않는다.

**FR-EDT-33.** Editor 행을 추가할 때 그 경로가 **git 저장소의 루트이면** 같은 경로의
Git 핀이 함께 생긴다. 저장소 안이지만 루트가 아닌 경로는 연동하지 않는다 — 핀은
루트로 정규화되므로(`handlers_git.go:275`) 경로가 어긋나 대칭이 깨진다.

**FR-EDT-34.** Editor 행을 제거하면 같은 경로의 Git 핀이 함께 사라진다.

**FR-EDT-35.** 위 넷은 **서버 한 곳에서 한 번의 workspace 저장 안에** 일어난다.
두 목록이 따로 저장되면 그 사이에 다른 브라우저가 읽어 절반만 반영된 상태를 본다.

**FR-EDT-36.** 연동으로 인한 변경은 **다시 연동을 부르지 않는다.** 규칙은 사용자
조작 한 번에 한 겹만 적용된다. 구현은 순수 함수 4개(`LinkPinAdd`·`LinkPinRemove`·
`LinkEditorAdd`·`LinkEditorRemove`)로 하고 서로를 호출하지 않는다.

**FR-EDT-37.** **홈 경로의 핀은 Editor 행을 만들지 않는다.** 홈이 git 저장소여서
`git pin ~` 이 성립하더라도 root 행이 이미 그 경로를 대표하므로 목록은 변하지
않는다 (FR-EDT-16 과 같은 규약).

**FR-EDT-38.** 홈 경로의 핀을 제거해도 root 행은 남는다. FR-EDT-13 이 이긴다.

**FR-EDT-38a.** 대칭 케이스 — **홈을 Editor 로 추가하면 핀도 생기지 않는다.**
FR-EDT-16 이 그 추가를 "목록을 바꾸지 않는" 무동작으로 규정하므로 FR-EDT-33 의
전제("Editor 행을 추가할 때")가 성립하지 않는다. 워크스페이스 rev 도 오르지 않는다.

**FR-EDT-39.** `add`·`remove` 응답은 **두 목록을 함께** 돌려준다. 대칭으로
`/api/git/repos/pin`·`unpin` 도 응답에 `editors` 를 싣는다 (FR-EDT-116).

### 3.5 묶음 W — Editor 창

**FR-EDT-40.** 창 타입에 `WINDOW_TYPE_EDITOR='editor'` 를 더한다. 창은 자기 루트를
`editor:{root:'<abs>'}` 로 갖는다.

**FR-EDT-41.** **행 하나에 창 하나다.** 행과 창은 `editor.root` 로 짝지어진다.

**FR-EDT-42. 창의 생성·소멸은 재조정(reconcile)으로 한다.** 브라우저가 다음을
수행하며, **멱등**이다.

1. 있어야 할 루트 집합은 `[home, ...editors.list]` 다 (FR-EDT-29).
2. 그 집합에 있는데 창이 없으면 만든다 — `layout:null`, `editor:{root}`.
3. `type==='editor'` 인데 루트가 그 집합에 없으면 창을 지운다.
4. 같은 루트의 창이 둘 이상이면 **id 사전순으로 앞선 하나만 남긴다.**

**FR-EDT-43.** 재조정이 도는 자리는 **둘**이며 §2.4 가 지목한 그 자리다 —
로드(`app.js:106` 부근)와 SSE 동기화(`app-cmd.js:212` 부근). 그리고 `editors` 를
바꾼 API 응답을 반영한 직후에도 돈다.

> **FR-EDT-42(4)의 이유.** 창 생성 주체는 브라우저이고(§2.3) `editors` 목록 변경은
> 모든 브라우저에 SSE 로 도달한다. 게이팅이 없으면 브라우저 수만큼 같은 루트의
> 창이 생긴다. 단일 실행자 지명(`singleExecutorActions`)은 `POST /api/commands`
> 경로에만 있어 여기 쓸 수 없다. 결정론적 중복 제거가 그 자리를 대신한다 — 어느
> 브라우저가 먼저 쓰든 수렴하는 값이 같다.

**FR-EDT-44.** 창 이름은 경로의 마지막 조각이고, root 에디터 창의 이름은 `~` 다.

**FR-EDT-45.** Editor 창은 **Windows 탭의 창 목록에 나오지 않고 창 순회의 대상도
아니다** — `_plainWindows`(`app-git.js:14`)가 Git 창과 함께 거른다.

**FR-EDT-46.** 창은 좌우 둘로 나뉜다. 좌측은 **탐색기**, 우측은 **편집기 영역**이다.
탐색기는 분할 트리 **밖**의 고정 영역이며 어떤 드롭으로도 쪼개지지 않는다.

**FR-EDT-47.** 탐색기 폭은 드래그로 조절하고 `window.editor.explorerWidth` 로
**워크스페이스에 저장한다** — `sidebarWidth` 와 같은 규약이다 (§2.10). 창마다 따로
기억된다.

**FR-EDT-48.** 편집기 영역은 기존 pane · tab · split 모델을 **그대로** 쓴다.
`doSplit`·`doRemove`·`findPane`·`firstPane`·`findPath` 는 타입을 가리지 않으므로
고치지 않는다.

**FR-EDT-49. `layout` 이 없는 Editor 창은 지워지지 않는다.** §2.4 의 두 필터를
아래로 바꾼다.

```js
windows.filter(s => s && (s.layout || s.type === WINDOW_TYPE_EDITOR))
```

이것이 FR-EDT-55 의 전제다. 다른 창 타입의 동작은 바뀌지 않는다.

**FR-EDT-50.** **분할 단축키와 분할 버튼은 Editor 창에서 동작하지 않는다.**
`Ctrl+Shift+H`·`Ctrl+Shift+V` 는 무시되고(`app-layout.js:402` 자리) 툴바의 분할
버튼은 감춰진다(`renderer.js:69-74` 자리).

**FR-EDT-51.** **분할이 생기는 유일한 길은 드래그드롭이다.** 탭을 pane 의
가장자리(좌·우·상·하)로 끌어다 놓을 때만 새 pane 이 생기고, 그 pane 은 끌어온 탭을
담은 채로 태어난다 (`_splitPaneWithTab`, `app-dnd.js:88`).

**FR-EDT-52.** **빈 pane 은 존재하지 않는다.** pane 은 언제나 탭을 하나 이상 갖고,
탭이 0이 되면 기존 붕괴 규약(`doRemove`)대로 사라진다. `empty` 같은 표식을 두지
않는다.

> 접수한 요구 8은 "단축키·버튼 분할 시 빈 pane 을 연다" 였으나, 인터뷰에서 분할
> 수단을 드래그드롭 하나로 좁히기로 하면서 빈 pane 이 생길 경로 자체가 없어졌다
> (D-8).

**FR-EDT-53.** 탭 드래그는 **같은 Editor 창 안에서만** 가능하다. 다른 Editor 창으로도,
일반 창으로도 나가지 못하고, 밖에서 들어오지도 못한다.

게이트가 들어가는 자리는 **창 경계를 넘는 경로 둘뿐**이다 —
`_moveTabToWindow` 의 출발·도착 검사(`app-dnd.js:44`·`:46`).

**나머지 둘에는 넣지 않는다.** `_moveTabToPane`(`:16`)은 활성 창 **안**의 분할 칸끼리
옮기는 경로이고, `_splitPaneWithTab`(`:91`)은 FR-EDT-51 이 허용한 **유일한 분할
경로**다. 여기에 Editor 창 조건을 더하면 창 안의 이동과 분할이 함께 막혀
FR-EDT-51·FR-EDT-36(V-EDT-33·36)이 깨진다.

대신 그 두 함수에 있는 `if(!s.layout){ this._mkWindow() }` 폴백만 Editor 창에서
제외한다 — Editor 창은 layout 이 없는 것이 정상 상태이므로(FR-EDT-55) 그 폴백이
돌면 엉뚱한 일반 창이 생긴다.

탭 타입 자리(`:22`·`:50`·`:96`)에는 어떤 조건도 넣지 않는다.

**FR-EDT-54.** Editor 창에는 **편집기 탭만** 있다. 터미널·run·git 탭을 만들 수 없고
`addTab`(`app-layout.js:220` 자리)이 그 요청을 거부한다.

**FR-EDT-55.** **창에 pane 이 하나도 없을 수 있다.** 갓 만든 Editor 창은 탐색기만
보이고 우측은 안내문이다. 이것은 빈 pane 이 아니라 pane 이 **없는** 것이다.

**FR-EDT-56.** Editor 창을 닫는 별도의 길은 없다. 창의 수명은 행의 수명이다
(FR-EDT-42). 떠나는 길은 사이드바 탭이 상시 제공한다 (FR-SBT-34 와 같은 근거).

### 3.6 묶음 X — 파일 탐색기

**FR-EDT-57.** 탐색기는 창의 `editor.root` 를 뿌리로 하는 트리다. 뿌리 위로는 올라갈
수 없다.

**FR-EDT-58.** **dot 파일과 dot 폴더를 포함해 전부 보인다.** 숨김 규칙도 필터도 없다.

**여기에는 `..b` · `...` 처럼 점 둘로 시작하는 이름도 포함된다.** 루트 경계 검사를
`strings.HasPrefix(rel, "..")` 로 하면 그 이름들이 이탈로 **오인된다** — 기존
`safeResolve`(`handlers_files.go:35`)가 그렇게 판정하므로 **그것을 재사용하지
않는다.** 경계는 경로 **조각**으로 본다: `rel == ".."` 또는
`rel` 이 `".."+separator` 로 시작할 때만 이탈이다.

**FR-EDT-59.** **지연 로드다.** 폴더를 펼칠 때 그 폴더 한 겹만 조회한다. 홈 전체를
훑지 않는다.

**FR-EDT-60.** 항목의 종류는 세 가지로 갈린다 — **폴더 · 파일 · 링크**.

| 종류 | 판정 (`os.Lstat` + 링크 대상 `os.Stat`) | 동작 |
|---|---|---|
| 폴더 | `dir:true` | 클릭 시 펼침 토글 |
| 파일 | `dir:false, link:false` | 클릭 시 편집기에서 연다 |
| 링크 | `link:true` | **펼치지도 열지도 않는다.** 표시만 한다 |

링크는 `linkDir` 로 대상이 디렉터리인지 알린다 — 아이콘을 가르기 위해서다.
**링크를 따라가지 않는 이유**는 순환과 뿌리 이탈(FR-EDT-85)을 한 규칙으로 막기
위해서다. 링크된 디렉터리를 파일로 취급하면 클릭 시 `apiFileRead` 가
`not a file` 400 을 낸다 (§2.6).

**FR-EDT-61.** 정렬은 **폴더 먼저, 그 다음 파일·링크**이고 각각 이름 오름차순이다.
비교는 대소문자를 무시한다. **정렬 주체는 서버다** — 잘림(FR-EDT-65)의 경계가
요청마다 달라지지 않으려면 순서가 서버에서 결정돼야 한다.

**FR-EDT-62.** 펼침 상태와 선택은 **창별 런타임 상태**다. 워크스페이스에 저장하지
않는다.

**FR-EDT-63.** 조회 실패(권한 없음 등)는 **그 폴더 행에만** 표시하고 트리를 깨뜨리지
않는다.

**FR-EDT-64.** 탐색기 상단에 새로고침이 있다. 누르면 **펼쳐져 있는 폴더만** 다시
읽고 펼침 상태는 보존한다.

**FR-EDT-65.** 한 폴더의 항목 수 상한은 `FS_LIST_MAX` 다. 상한을 넘으면 잘라내고
`truncated:true` 로 알리며, 탐색기가 그 자리에 "N개 이상 — 잘림" 을 표시한다.
**조회는 실패하지 않는다.**

**FR-EDT-66.** 바깥 계기(폴링·SSE)로 인한 다시 그리기는 펼침·선택·hover·인라인 입력
상태를 깨뜨리지 않는다 (FR-RPT-* 규약, `web/js/ui/repaint.js`).

**FR-EDT-67.** 탐색기는 파일 감시를 하지 않는다. 갱신 계기는 새로고침(FR-EDT-64) ·
조작 후 재조회(FR-EDT-88) · git 색 폴링(FR-EDT-77) 셋뿐이다.

**FR-EDT-68.** 탐색기가 그리는 행 수가 많아도 스크롤이 끊기지 않아야 한다. 구현은
DOM 재사용(`reconcileList`, `repaint.js:61`)을 쓰고 매 갱신마다 트리를 새로 만들지
않는다.

### 3.7 묶음 X — 탐색기의 git 색

**FR-EDT-69.** 색은 **Editor 루트가 git 저장소의 루트일 때만** 입힌다. 아니면 색이
없다. root 에디터(`~`)는 보통 여기 해당한다.

판정은 `GET /api/git/status?repo=<root>` **한 번으로 색과 함께** 받는다 — 응답의
`repo` 가 요청한 `root` 와 다르거나 조회가 실패하면 색을 입히지 않는다.
`/api/git/repo-at` 을 쓰지 않는 이유는 그 종단이 `tool=<toolId>` 만 받아 **임의
경로를 판정하지 못하기 때문**이다 (`gitToolCwd`, `handlers_git.go:169`).

**판정이 되는 답과 그렇지 않은 실패를 가른다.**

| 응답 | 처리 |
|---|---|
| 4xx | 판정 — 이 경로로는 저장소를 물을 수 없다 (`not_repo` 는 404) |
| 503 | 판정 — git 자체가 없다. 다시 물어도 같고, 그대로 두면 3초마다 영영 묻는다. Git 패널이 503 을 `_gitOff` 로 굳히는 것과 같은 관례다 (`app-git.js:264`) |
| 200 인데 `repo !== root` | 판정 — 여기는 저장소의 **루트**가 아니다 |
| 전송 실패 · 그 밖의 5xx · 본문 파싱 실패 | **판정이 아니다.** 이번 회차만 건너뛴다 — 한 번 끊겼다고 창의 색이 영구히 죽으면 안 된다 |

**FR-EDT-70. 색값의 정의 자리를 늘리지 않는다** (D-4). 그러려면 `--git-st-add` 를
`.git-files` 에서 **`:root` 로 올려야 한다** (§2.8). 값은 그대로이므로 Git 패널의
표시는 바뀌지 않는다. 탐색기는 같은 변수와 같은 상태 클래스를 참조한다.

| 상태문자 | 클래스 (`GIT_ST_CLASS`) | 색 |
|---|---|---|
| `?` 미추적 · `A` 추가 | `new` · `add` | `--git-st-add` (초록) |
| `M` 수정 | `mod` | `--accent` |
| `R` 이름변경 · `C` 복사 | `ren` · `cpy` | `--text-bright` |
| `D` 삭제 | `del` | `--danger` |
| `U` 충돌 | `conf` | `--danger` |

> 접수한 요구 5는 "수정 = 노란색" 이었으나, 인터뷰에서 **기존 Git 패널의 색을 그대로
> 쓰기로** 확정했다 (D-4). 이 저장소에서 수정은 `--accent` 이고 노랑(`--attn`)은 부분
> 스테이지의 색이다 (`style.css:1123-1124`) — 겹치면 두 사실이 한 색이 된다.

**FR-EDT-71.** 근거는 `GET /api/git/status?repo=<root>` **하나**다. 폴더를 펼칠 때마다
중첩 저장소를 찾지 않는다 — 펼침마다 `rev-parse` 가 붙는다.

**FR-EDT-72.** 한 파일이 staged 와 unstaged 를 함께 가지면 **unstaged 쪽 문자**를
쓴다.

**FR-EDT-72a.** 그런 파일(부분 스테이지)의 **색은 `--attn`(노랑)이며 상태색을
이긴다.** Git 패널이 `.git-file.partial` 을 그렇게 칠하므로(FR-GIT-190·FR-STC-4)
탐색기도 같아야 한다 — 같은 사실을 두 화면이 다른 색으로 말하지 않는다.

> 이것이 요구 5의 "수정된 파일의 이름은 노란색" 과 실물이 어긋나 보였던 이유다.
> Git 패널에서 눈에 띄는 **노란 `M` 은 "수정" 이 아니라 "일부만 스테이지됨"** 이고,
> 순수 수정은 처음부터 `--accent` 였다 (실측: `mod.txt` M → `#7aa2f7`,
> `partial.txt` M → `#e0af68`).

**FR-EDT-72b.** 부분 스테이지는 **폴더로 접어 올리지 않는다.** 파일 하나의
사실이며 Git 패널도 행 단위로만 표시한다.

**FR-EDT-73.** 폴더는 **하위의 상태를 접어 올린다.** 하위에 상태를 가진 항목이 하나도
없으면 색이 없다. 접어 올림은 `status` 응답의 경로들로 계산하므로 **펼쳐지지 않은
폴더에도 색이 나온다.**

**FR-EDT-74.** 폴더 색의 우선순위는 다음과 같다.

```
충돌(U)  >  신규(A · ?)  >  수정(M)  >  이름변경·복사(R · C)
```

**삭제(D)는 폴더로 전파하지 않는다.**

> **근거.** 요구가 정한 것은 "초록이 노랑을 이긴다" 하나이고, 그 위에 충돌만 얹었다 —
> 먼저 손봐야 하는 상태이기 때문이며 Changes 탭이 conflicts 를 맨 위에 두는 것과
> 같은 판단이다 (`GIT_GROUPS`, `constants.js:139-144`).
>
> **VSCode 를 모사하지 않는다.** 조사 결과 VSCode 의 git 확장에는 폴더 색
> 우선순위 비교가 **없다** — 확장은 파일별 데코레이션 맵만 만들고
> (`extensions/git/src/decorationProvider.ts` 의 `collectDecorationData`), 폴더 전파는
> 코어 `DecorationsService` 가 한다. 그런데 확장 데코레이션의 weight 가 10 으로
> 고정돼(`mainThreadDecorations.ts`) 정렬이 no-op 이 되고, `reduceRight` 로 CSS 변수를
> 중첩해 **경로 사전순 DFS 의 첫 원소**가 색을 정한다. 결과적으로 "그 폴더 아래에서
> 이름순으로 가장 앞선 변경 파일"의 색이 폴더 색이며, 이는 우선순위가 아니라 우연이다.
> 그대로 따르면 요구의 "초록이 노랑을 이긴다" 가 성립하지 않는다.
>
> **VSCode 에서 가져온 것은 하나다** — 삭제의 전파 제외. `Resource.resourceDecoration`
> 이 `propagate = type !== DELETED && type !== INDEX_DELETED` 로 삭제를 버블링에서
> 빼며(`extensions/git/src/repository.ts`), 삭제된 파일은 애초에 탐색기에 없으므로
> 그 상태가 폴더 색을 정하는 것은 근거가 없다.

**FR-EDT-75.** 폴더 자신이 상태를 갖는 일은 없다 — git 은 폴더를 추적하지 않는다.

**FR-EDT-76.** 상태 갱신은 **Editor 창이 활성일 때만** 돈다. 비활성 창은 git 을
호출하지 않는다 (FR-GIT-24 와 같은 근거).

**FR-EDT-77.** 활성일 때의 주기는 `EDITOR_GIT_POLL_MS` 이며 **`GIT_REPOS_POLL_MS` 와
같은 3000ms** 다 (`constants.js:114`). 같은 사실을 보는 두 화면이 다른 속도로
갱신될 이유가 없다. 캐시 TTL 200ms + single-flight(§2.7) 위에 얹히므로 Git 패널과
동시에 떠 있어도 git 실행이 겹치지 않는다.

**FR-EDT-78.** 위 주기 외에 **즉시 갱신하는 계기가 셋** 있다 — 파일 저장
(`FileEditor.save` 의 `_gitSignal('write')`), 파일 조작 완료(FR-EDT-89), 창 활성화.

### 3.8 묶음 F — 파일 조작

**FR-EDT-79.** 탐색기는 다섯 조작을 제공한다 — **새 파일 · 새 폴더 · 이름 변경 ·
삭제 · 드래그 이동.**

**FR-EDT-80.** 진입점은 둘이다. 행 우클릭 컨텍스트 메뉴, 그리고 탐색기 상단의 버튼
(새 파일 · 새 폴더 · 새로고침).

**FR-EDT-81.** 새 파일·새 폴더는 **선택된 폴더 아래**에 만든다. 선택이 파일이면 그
부모 폴더, 선택이 없으면 루트다. 이름은 그 자리 인라인 입력으로 받는다.

**FR-EDT-82.** 이름 변경도 인라인 입력이다. 파일이면 확장자 앞까지를 미리 선택한다.

**FR-EDT-83.** **삭제는 영구 삭제다.** 휴지통으로 보내지 않는다. 확인창이 필수이며,
폴더면 **재귀 삭제라는 사실과 그 안의 항목 수**를 확인창이 밝힌다.

**FR-EDT-84.** 삭제 대상에 저장되지 않은(dirty) 편집기 탭의 파일이 있으면 확인창이
그 사실을 함께 밝힌다.

**FR-EDT-85.** 드래그 이동은 탐색기 안에서 항목을 폴더 위로 끌어 옮긴다. **자기
자신과 자기 하위로는 옮길 수 없다.**

> **확장됨** — 드롭 존은 폴더 행뿐이 아니다. 탐색기 헤더와 트리의 빈 여백이
> **루트 드롭 존**이고, 접힌 폴더는 드래그 중 자동으로 펼쳐진다
> ([`./FILE_TRANSFER_SRS.md`](./FILE_TRANSFER_SRS.md) FR-FTR-20~24).

**FR-EDT-86.** 대상에 같은 이름이 이미 있으면 **거부한다.** 덮어쓰지 않고 이름을
자동으로 바꾸지도 않는다.

**FR-EDT-87.** 모든 조작은 **Editor 루트 아래로 제한한다.** 서버가 `root` 를 함께
받아 검사한다 (FR-EDT-112). 심볼릭 링크를 푼 뒤에도 루트 아래여야 한다.

**FR-EDT-88.** 조작 뒤에는 **영향받은 폴더만** 다시 읽는다. 이동이면 출발·도착 둘
다다. 트리 전체를 새로 만들지 않는다.

**FR-EDT-89.** 조작 뒤 git 색을 다시 읽는다 (FR-EDT-78).

**FR-EDT-90.** 열려 있는 탭의 파일이 이름 변경·이동되면 그 탭의 `filePath` 와 이름이
따라 바뀐다. 탭이 닫히지 않는다. 폴더가 옮겨지면 그 아래 모든 탭의 경로가 따라간다.

**FR-EDT-91.** 열려 있는 탭의 파일이 삭제되면 **그 탭을 닫는다.** 폴더 삭제면 그
아래의 모든 탭이 닫힌다. dirty 여도 확인창을 다시 띄우지 않는다 — FR-EDT-84 에서
이미 밝혔다.

**FR-EDT-92.** 실패는 그 자리에 사유를 표시하고 낙관적 반영을 되돌린다.

**FR-EDT-93.** 조작은 편집기의 저장(`/api/file/write`)과 경합할 수 있다. 서버는
조작을 **원자적 시스템 콜 하나**(`os.Mkdir`·`os.WriteFile`·`os.Rename`·
`os.RemoveAll`)로 수행하고 그 이상의 잠금을 두지 않는다.

### 3.9 묶음 R — 파일 열기 라우팅

**FR-EDT-94.** **편집기 탭은 Editor 창에서만 열린다.** 일반 창에서는 어떤 경로로도
열리지 않는다.

**FR-EDT-95.** **연결된 Editor** 는 그 절대경로를 자기 루트 아래에 포함하는 Editor
창이다. 둘 이상이면 **루트가 가장 깊은** 것을 고른다 — 가장 구체적인 것이 이긴다.

**FR-EDT-96.** `edit <path>` 는 연결된 Editor 에서 연다. 없으면 **root 에디터**에서
연다.

**FR-EDT-97.** Git 창의 `Open File` 은 **활성 리포 경로에 연결된 Editor** 에서 연다.
파일 경로가 아니라 **리포 경로**로 고른다. 연동(FR-EDT-31)으로 그 Editor 는 항상
존재한다.

**FR-EDT-98.** `Open File (HEAD)` 의 임시 파일도 같은 규약이다 — 임시 경로가 어디에
있든 리포의 Editor 에서 연다. FR-EDT-97 이 파일이 아니라 리포로 고르는 이유가
이것이다.

**FR-EDT-99.** **탐색기 루트 밖의 파일이 그 창에 열릴 수 있다** — FR-EDT-96 의 폴백과
FR-EDT-98 의 임시 파일이 그렇다. 이때 탐색기는 그 파일을 가리키지 못하며, 그것이
정상이다. 탐색기는 루트의 트리이지 열린 탭의 목록이 아니다.

**FR-EDT-100.** 파일이 붙을 pane 은 다음 순서로 고른다 — ① 대상 창의
`focusedPane`, ② 없으면 `firstPane`, ③ 그것도 없으면 pane 을 새로 만든다
(FR-EDT-55). `this.focused` 를 쓰지 않는다 — 대상 창이 비활성일 수 있다
(`_gitPaneOf`, `app-git.js:157` 와 같은 규약).

**FR-EDT-101.** 이미 열려 있는 파일이면 **그 탭으로 이동하고 새로 읽는다.** 중복 탭을
만들지 않는다. 탐색 범위는 Editor 창 전체다 (`_findEditorTab`, `app-layout.js:190`).

**FR-EDT-102.** 파일을 열면 대상 Editor 창으로 창이 전환되고, 사이드바 탭이 `editor`
로 따라온다 (FR-EDT-8).

### 3.10 묶음 M — 마이그레이션

**FR-EDT-103.** 워크스페이스를 읽을 때 **일반 창의 `type==='editor'` 탭을 제거한다.**
확인창은 띄우지 않는다 (D-9) — 로드 시점이라 확인이 걸릴 자리가 아니고, 파일 자체는
디스크에 그대로 있다.

**FR-EDT-104.** 제거는 **`clean()` 에 넣지 않는다.** `clean` 은 편집기 탭을 보존하도록
만들어져 있고 창 타입을 알지도 못한다 (§2.9). 창을 순회하는 자리 —
`_migrateGitWindow` 옆(`app-git.js:51`, 호출 `app.js:106`·`app-cmd.js:212`) — 에
같은 모양의 함수를 둔다.

**FR-EDT-105.** 그 결과 탭이 0이 된 pane 은 붕괴 규약(`doRemove`)대로 사라지고,
layout 이 빈 **일반** 창은 사라진다. Editor 창은 FR-EDT-49 로 남는다.

**FR-EDT-106.** 이것은 1회성 변환이 아니라 **상시 불변식**이다. 어떤 경로로도 일반
창에 편집기 탭이 생기지 않는다.

**FR-EDT-107.** `normalizeTab` 의 "type 이 없으면 `toolId` 유무로 terminal/editor"
규칙은 유지한다 (`helpers.js:133-136`). 그렇게 editor 로 떨어진 탭도 FR-EDT-103 이
걷어낸다.

### 3.11 묶음 S — 서버 표면

**FR-EDT-108.** 디렉터리 조회 종단을 신설한다. **`root` 를 함께 받아 그 아래로
제한한다.**

```
GET /api/fs/list?root=<abs>&path=<abs>
→ 200 {"path":"<abs>",
       "entries":[{"name":"…","dir":false,"link":false,"linkDir":false}],
       "truncated":false}
```

- `dir` 는 `os.Lstat` 기준이므로 심볼릭 링크는 언제나 `dir:false` 다.
- `link` 가 참이면 `linkDir` 이 링크 **대상**이 디렉터리인지 알린다 (FR-EDT-60).
  대상을 열거나 따라가지는 않는다.
- 항목이 `FS_LIST_MAX` 를 넘으면 잘라내고 `truncated:true` 를 준다. **실패가
  아니다** (FR-EDT-65).
- 크기·수정시각은 주지 않는다. 소비하는 요구가 없다.

**FR-EDT-109.** 파일 조작 종단 셋을 신설한다. **모두 본문에 `root` 를 받는다.**

```
POST /api/fs/create  {"root":"<abs>","path":"<abs>","dir":false}   → {"ok":true}
POST /api/fs/rename  {"root":"<abs>","from":"<abs>","to":"<abs>"}  → {"ok":true}
POST /api/fs/delete  {"root":"<abs>","path":"<abs>"}               → {"ok":true}
```

이름 변경과 이동은 같은 연산이므로 종단을 나누지 않는다. `rename` 은 **`from` 과
`to` 를 둘 다** 루트 아래로 검사한다.

**FR-EDT-110.** Editor 목록 종단 넷을 신설한다.

```
GET  /api/editors                                → {"home":"<abs>","list":[…]}
POST /api/editors/add      {"path":"<abs>"}      → {"list":[…],"pinned":[…]}
POST /api/editors/remove   {"path":"<abs>"}      → {"list":[…],"pinned":[…]}
POST /api/editors/reorder  {"src":"…","target":"…","before":true} → {"list":[…]}
```

**FR-EDT-111.** 모든 경로 인자는 **절대경로여야 한다.** 아니면 400 이다.

**FR-EDT-112.** 루트 검사는 `safeResolve(root, path)` (`handlers_files.go:35`)로
하되, **`root` 와 대상 양쪽을 `filepath.EvalSymlinks` 로 푼 뒤** 비교한다. 링크를
통한 이탈을 `..` 검사만으로는 막지 못한다.

**해석 방식은 종단에 따라 갈린다.**

| 종단 | 대상 경로를 어떻게 푸는가 | 이유 |
|---|---|---|
| `list` | 경로 **전체**를 `EvalSymlinks` | 그 디렉터리 **안으로** 들어간다 |
| `create` · `rename` · `delete` | **부모까지만** 푼다 | 아직 없는 이름을 다루고, 링크 **자체**를 지우거나 옮길 수 있어야 한다. 중간 링크를 통한 이탈은 부모 해석에서 그대로 걸린다 |

`NormalizePath` 는 `EvalSymlinks` 가 실패하면 `Clean` 결과로 **폴백한다** — 실패를
오류로 올리면 사라진 디렉터리의 행을 유지·제거할 수 없어 FR-EDT-26 이 깨진다.
존재 검사는 추가 경로의 `os.Stat` 이 따로 한다 (FR-EDT-23).

> 기존 `/api/file/{read,write}` 의 가드가 `safeResolve("/", …)` 라 사실상 무제한인
> 것과 **다르다.** 읽기·쓰기는 사용자가 경로를 이미 알고 지목한 것이지만, 조작은
> 트리 탐색에서 파생된 경로를 지우고 옮긴다. 상한이 없으면 버그 하나가 홈 밖을
> 지운다.

**FR-EDT-113.** `root` 는 **서버가 신뢰하지 않는다.** 클라이언트가 보낸 값이므로
`editors.list` 또는 홈에 실재하는 루트인지 대조한 뒤에만 검사 기준으로 쓴다.

**FR-EDT-114.** 삭제는 루트 **자신**과 홈, 파일시스템 루트를 거부한다.

**FR-EDT-115.** `to`·`path` 가 이미 존재하면 거부한다 (FR-EDT-86).

- `create` 는 `os.Mkdir` / `os.OpenFile(O_EXCL)` 의 **원자성**으로 막는다 —
  `Stat` 후 생성하지 않는다.
- `rename` 은 **종류마다 다른 수단**으로 닫는다.

| 대상 | 수단 | 원자성 |
|---|---|---|
| 일반 파일 | `os.Link` 로 이름을 잡고 원래 이름을 지운다 | **원자적** — 이미 있으면 그 자리에서 EEXIST 라 창이 없다 |
| 디렉터리 | `os.Rename` | **이미 막힌다** — Go 는 대상이 디렉터리면 시스템 콜에 가기 전에 EEXIST 를 돌려준다 (`os/file_unix.go` 의 `rename`). 대상이 파일이면 ENOTDIR |
| 심볼릭 링크 · 폴백(EXDEV 등) | `Lstat` 검사 뒤 `os.Rename` | 창이 남는다 |

링크에 `os.Link` 를 쓰지 않는 이유는 플랫폼마다 링크를 따라가는지가 갈리기
때문이다 — 따라가면 링크가 아니라 그 대상이 옮겨져 뜻이 달라진다.

폴백에 남는 창은 `fsOpMu` 가 **우리 자신끼리의 경합**에 한해 없앤다(조작 셋을
직렬화한다). **dongminal 밖의 프로세스**와의 경합은 남으며, 그것까지 닫으려면
플랫폼별 시스템 콜을 들여야 해서 cross-platform 보류 방침(§6 비목표)과 충돌한다.

**FR-EDT-116.** 연동(FR-EDT-31~39)은 **새 패키지
`internal/webserver/domain/wsentry`** 가 소유한다.

- `git.pinned` 와 `editors.list` 를 **한 번의 read-modify-write** 로 함께 바꾼다.
- `RepoRootFn func(ctx, path) (root string, err error)` 을 **주입받는다** —
  이렇게 해야 `httpapi` 가 `gitapi` 를 import 하지 않고도 FR-EDT-33 을 판정한다.
  조립은 `httpapi/server.go` 가 이미 만든 git `store.Store` 의 `RepoRoot` 를 넘겨
  한다.
- `gitapi/git_pins.go` 의 `gitPinsMutate` 는 이 패키지로 위임한다. Git 핀의 기존
  동작(멱등·문자열 일치 제거·2회 재시도·`workspace_changed` 브로드캐스트)은
  그대로다.
- 연동 규칙 4개는 **순수 함수**로 두고 서로를 호출하지 않는다 (FR-EDT-36).

**FR-EDT-117.** 오류는 Git API 와 같은 형태를 쓴다 — `{"code":"…","message":"…"}`.
코드와 HTTP 상태의 대응은 다음과 같다.

| 코드 | 상태 | 쓰임 |
|---|---|---|
| `bad_request` | 400 | 인자 결여·상대경로·`FS_DELETE_MAX` 초과·FR-EDT-114 거부 |
| `outside_root` · `permission_denied` | 403 | 루트 이탈·권한 |
| `not_found` | 404 | 대상 없음 |
| `exists` | 409 | FR-EDT-115 |
| `io_failed` | 500 | 그 밖의 시스템 콜 실패 |

**FR-EDT-118.** 재귀 삭제는 항목 수 상한 `FS_DELETE_MAX` 를 갖는다. 상한을 넘으면
**아무것도 지우지 않고 실패한다** — 세다가 중간에 멈추지 않는다.

**셀 수 없어도 지우지 않는다.** 하위에 읽을 수 없는 디렉터리가 하나라도 있으면
세기가 실패하고 삭제는 거부된다. 그대로 `os.RemoveAll` 을 부르면 걷다가
권한에서 막혀 **절반만 지워진 트리**가 남는데, 그것이 거부보다 나쁘다.

**FR-EDT-119.** 새 종단은 `shouldLogRequest` 의 스킵 목록에 넣지 않는다. 조회는
사용자 조작당 한 번이고 조작은 드물다.

### 3.12 비기능 요구 (NFR)

**NFR-EDT-1.** `GET /api/fs/list` 는 항목 1,000개 폴더에서 100ms 이내에 응답한다
(로컬 SSD, `FS_LIST_MAX` 이하). Go 벤치마크로 잰다.

**NFR-EDT-2.** Editor 창이 열려 있어도 **git 프로세스 실행 횟수**가 Git 패널만
열었을 때보다 늘지 않는다 — 같은 `store.Store` 캐시를 지난다 (FR-EDT-71·77).
`core.Service` 의 실행 기록으로 잰다.

**NFR-EDT-3.** 기본 사이드바 폭에서 탭 3개의 라벨이 **잘리지 않고** 보인다.

**균등 분할(`flex:1 1 0`)은 지킨다** (V-SBT-16). 내용 기준으로 바꾸면 폭 최소값
100px 에서 **셋 다** 잘린다 — 짧은 이름(`Git`)까지 제 몫을 빼앗기기 때문이다.
대신 글자(11px→10px)와 좌우 패딩(4px→3px)을 줄여 3등분 칸에 가장 긴 이름이
들어가게 한다. 폭 최소값에서는 그때 비로소 말줄임으로 물러난다.

**NFR-EDT-4.** 탐색기는 갱신마다 트리를 새로 만들지 않는다 — `reconcileList` 를
쓴다 (FR-EDT-68). **판정은 "갱신 후에도 펼침·선택·스크롤이 유지된다"** 로 하며,
프레임률을 재지 않는다.

**NFR-EDT-5.** 삭제·덮어쓰기는 사용자가 확인창에서 동의한 것만 일어난다. 검증은
FR-EDT-83·86·115 의 각 항목으로 한다.

---

## 4. 검증 (Verification)

`T` 는 자동(Go 테스트 또는 Playwright), `M` 은 수동 실사다.

| id | 종류 | 항목 | FR |
|---|---|---|---|
| V-EDT-1 | T | 탭 3개가 Windows·Git·Editor 순으로 보인다 | 1 |
| V-EDT-2 | T | `Ctrl+Shift+3` 이 Editor 탭으로 간다 | 5 |
| V-EDT-3 | T | 단축키 맵·설정 그룹에 손으로 넣은 `sidebarTab3` 항목이 없다 (배열에서 파생) | 5 |
| V-EDT-4 | T | 목록 렌더가 배열 순회다 — `list` 를 가진 넷째 서술자를 push 하면 그려진다 | 4 |
| V-EDT-5 | T | 순회 키가 Editor 행을 돌고 root 행이 마지막에 포함된다 | 6 |
| V-EDT-6 | T | Editor 탭 선택 → Editor 창 전환. Editor 창 활성 → 탭이 따라온다 | 7·8 |
| V-EDT-7 | T | root 행이 최하단이고 `×` 가 없으며 드래그 출발·도착 모두 불가 | 14·15 |
| V-EDT-8 | T | 홈 경로를 일반 행으로 추가하면 목록이 변하지 않고 오류도 아니다 | 16 |
| V-EDT-9 | T | 워크스페이스를 비워도 root 행과 root 창이 있다 | 13·42 |
| V-EDT-10 | T | 행 추가·제거가 `editors.list` 에 반영되고 다른 키가 보존된다 | 19·22 |
| V-EDT-11 | T | 같은 경로를 두 번 추가해도 목록이 그대로다 (멱등) | 25 |
| V-EDT-12 | T | 사라진 디렉터리의 행도 제거된다 (정규화 없는 문자열 일치) | 26 |
| V-EDT-13 | T | reorder 델타가 반영되고, 없는 `src`/`target` 은 배열을 바꾸지 않는다 | 27 |
| V-EDT-14 | T | `editors` 가 배열이 아니거나 항목이 문자열이 아니면 조용히 버려진다 | 30 |
| V-EDT-15 | T | 서버 단위테스트: 낡은 rev 로 Save 하면 1회 재시도로 성공한다 | 22 |
| V-EDT-16 | T | 409 응답 후 클라이언트가 서버의 `editors` 를 채택한다 | 21 |
| V-EDT-17 | T | git pin → editor 행 자동 생성 | 31 |
| V-EDT-18 | T | git unpin → 같은 경로 editor 행 자동 제거 | 32 |
| V-EDT-19 | T | git 저장소 루트를 editor 로 추가 → git 핀 자동 생성 | 33 |
| V-EDT-20 | T | 저장소 **안**이지만 루트가 아닌 경로 → 핀이 생기지 않는다 | 33 |
| V-EDT-21 | T | editor 제거 → 같은 경로 핀 자동 제거 | 34 |
| V-EDT-22 | T | 연동 변경이 workspace rev 를 **한 번만** 올린다 | 35 |
| V-EDT-23 | T | 연동 순수 함수가 서로를 호출하지 않는다 (한 겹만 적용) | 36 |
| V-EDT-24 | T | 심볼릭 링크 경로로 editor 를 추가해도 핀과 짝이 맞는다 (`/tmp` 픽스처) | 24 |
| V-EDT-25 | T | 홈을 핀해도 editor 행이 생기지 않고, unpin 해도 root 행이 남는다 | 37·38 |
| V-EDT-26 | T | `pin`/`unpin` 응답에 `editors` 가 실린다 | 39 |
| V-EDT-27 | T | Editor 창이 Windows 목록과 창 순회에 나오지 않는다 | 45 |
| V-EDT-28 | T | **layout 이 없는 Editor 창이 로드·SSE 동기화를 넘어 살아남는다** | 49 |
| V-EDT-29 | T | git pin 을 눌러 `workspace_changed` 를 유발해도 빈 Editor 창이 사라지지 않는다 | 43·49 |
| V-EDT-30 | T | 같은 루트의 Editor 창이 둘이면 재조정이 하나로 줄인다 (결정론) | 42 |
| V-EDT-31 | T | 행 제거 → 창 소멸, 행 추가 → 창 생성 | 42 |
| V-EDT-32 | T | Editor 창에서 `Ctrl+Shift+H`·`V` 가 무동작이고 분할 버튼이 감춰진다 | 50 |
| V-EDT-33 | T | 탭을 pane 가장자리로 드롭하면 분할이 생기고 그 pane 에 탭이 있다 | 51 |
| V-EDT-34 | T | 탭이 0이 된 pane 이 사라진다. 빈 pane 이 남지 않는다 | 52 |
| V-EDT-35 | T | 탭을 다른 Editor 창·일반 창으로 끌어도 이동하지 않는다 | 53 |
| V-EDT-36 | T | 같은 창 안 pane 간 이동은 된다 (게이트가 탭 타입 자리에 들어가지 않았다) | 53 |
| V-EDT-37 | T | Editor 창에 터미널 탭을 만들 수 없다 | 54 |
| V-EDT-38 | T | 갓 만든 Editor 창에 pane 이 없고, 파일을 열면 하나 생긴다 | 55·100 |
| V-EDT-39 | T | 탐색기 폭이 `window.editor.explorerWidth` 로 저장되고 새로고침 후 복원된다 | 47 |
| V-EDT-40 | T | dot 파일·dot 폴더가 보인다 | 58 |
| V-EDT-41 | T | 폴더를 펼칠 때만 그 폴더가 조회된다 (요청 수로 확인) | 59 |
| V-EDT-42 | T | 심볼릭 링크는 펼쳐지지도 열리지도 않는다. `linkDir` 이 응답에 있다 | 60·108 |
| V-EDT-43 | T | 정렬이 폴더 먼저·이름 오름차순(대소문자 무시)이다 | 61 |
| V-EDT-44 | T | 존재하지 않는 경로 조회가 트리를 깨지 않고 그 행에만 오류를 낸다 | 63 |
| V-EDT-45 | T | `FS_LIST_MAX` 초과 시 200 + `truncated:true` 이고 UI 가 잘림을 표시한다 | 65·108 |
| V-EDT-46 | T | 폴링이 돌아도 펼침·선택·스크롤·인라인 입력이 유지된다 | 66·68 |
| V-EDT-47 | T | 루트가 저장소가 아니면 색이 없다 | 69 |
| V-EDT-48 | T | `--git-st-add` 가 `:root` 에 있고 Git 패널의 색이 변하지 않았다 | 70 |
| V-EDT-49 | T | 미추적 초록, 수정 `--accent`, 충돌 `--danger` | 70 |
| V-EDT-50 | T | staged+unstaged 파일이 unstaged 문자로 표시된다 | 72 |
| V-EDT-51 | T | 펼치지 않은 폴더에도 색이 나온다 | 73 |
| V-EDT-52 | T | 폴더에 신규와 수정이 섞이면 신규 색이 이긴다 | 74 |
| V-EDT-53 | T | 폴더 하위에 충돌이 있으면 충돌 색이 이긴다 | 74 |
| V-EDT-54 | T | 폴더 하위에 삭제만 있으면 폴더에 색이 없다 | 74 |
| V-EDT-55 | T | 비활성 Editor 창은 폴링하지 않는다 (요청 수로 확인, 3주기 대기) | 76·77 |
| V-EDT-56 | T | 저장·조작·창 활성화가 즉시 갱신을 부른다 | 78 |
| V-EDT-57 | T | 새 파일·새 폴더가 선택된 폴더 아래에 생긴다 | 81 |
| V-EDT-58 | T | 이름 변경 시 확장자 앞까지 선택된다 | 82 |
| V-EDT-59 | T | 폴더 삭제 확인창이 재귀 삭제와 항목 수를 밝힌다 | 83 |
| V-EDT-60 | T | dirty 탭의 파일 삭제 시 확인창이 그 사실을 밝힌다 | 84 |
| V-EDT-61 | T | 폴더를 자기 하위로 옮길 수 없다 | 85 |
| V-EDT-62 | T | 같은 이름이 있으면 이동·생성이 거부되고 덮어쓰지 않는다 | 86·115 |
| V-EDT-63 | T | 루트 밖 경로의 조작이 `outside_root` 로 거부된다 | 87·112 |
| V-EDT-64 | T | 링크를 통한 루트 이탈이 거부된다 (`EvalSymlinks` 후 검사) | 112 |
| V-EDT-65 | T | `editors.list` 에 없는 `root` 값을 보내면 거부된다 | 113 |
| V-EDT-66 | T | Editor 루트 자신·홈·`/` 의 삭제가 거부된다 | 114 |
| V-EDT-67 | T | `FS_DELETE_MAX` 초과 시 **아무것도 지워지지 않고** 실패한다 | 118 |
| V-EDT-68 | T | 조작 뒤 그 폴더만 다시 읽는다. 이동은 둘 다 | 88 |
| V-EDT-69 | T | 이름 변경·이동 시 열린 탭의 경로·이름이 따라간다 (폴더 이동 포함) | 90 |
| V-EDT-70 | T | 삭제 시 그 파일의 탭이 닫힌다. 폴더면 하위 탭 전부 | 91 |
| V-EDT-71 | T | 실패 시 낙관적 반영이 되돌아간다 | 92 |
| V-EDT-72 | T | 일반 창에서 편집기 탭이 열리지 않는다 | 94 |
| V-EDT-73 | T | 중첩된 Editor 둘이 있으면 깊은 쪽이 이긴다 | 95 |
| V-EDT-74 | T | `edit <path>` 가 연결된 Editor 로 간다 | 96 |
| V-EDT-75 | T | 홈 밖 경로의 `edit` 이 root 에디터로 간다 | 96·99 |
| V-EDT-76 | T | Git `Open File` 이 리포의 Editor 로 간다 | 97 |
| V-EDT-77 | T | `Open File (HEAD)` 의 임시 파일도 리포의 Editor 로 간다 | 98·99 |
| V-EDT-78 | T | 비활성 대상 창에 열어도 그 창의 `focusedPane` 에 붙는다 | 100 |
| V-EDT-79 | T | 이미 열린 파일을 다시 열면 그 탭으로 가고 중복이 없다 | 101 |
| V-EDT-80 | T | 구 워크스페이스의 일반 창 편집기 탭이 로드 시 사라지고 pane 이 붕괴한다 | 103·105 |
| V-EDT-81 | T | `clean()` 은 여전히 Editor 창의 편집기 탭을 보존한다 | 104 |
| V-EDT-82 | T | `/api/fs/list` 가 dot 항목을 포함해 돌려준다 | 108 |
| V-EDT-83 | T | 상대경로 인자가 400 이다 | 111 |
| V-EDT-84 | T | 오류 응답이 `{code,message}` 형태다 | 117 |
| V-EDT-98 | T | 부분 스테이지 파일이 `--attn` 으로, 순수 수정이 `--accent` 로 칠해진다 | 72a |
| V-EDT-97 | T | 창이 없는 워크스페이스에 브라우저가 붙어도 `git.pinned`·`editors.list` 가 지워지지 않는다 | 20a |
| V-EDT-91 | T | 홈을 `editors/remove` 해도 홈의 git 핀이 남고 rev 가 오르지 않는다 | 38a |
| V-EDT-92 | T | 목록이 그대로인 요청은 저장·브로드캐스트하지 않는다 | 27·38a |
| V-EDT-93 | T | workspace blob 이 JSON `null` 이어도 패닉하지 않는다 | 30 |
| V-EDT-94 | T | 파일시스템 루트는 Editor 행이 될 수 없다 | 23 |
| V-EDT-95 | T | 바깥 루트로 **다른 Editor 루트**를 지울 수 없다 | 114 |
| V-EDT-96 | T | 권한 실패가 404 가 아니라 403 `permission_denied` 로 나온다 | 117 |
| V-EDT-90 | T | `..b` · `...` 이름의 폴더가 조회·조작된다. 부모·형제 이탈은 여전히 막힌다 | 58·112 |
| V-EDT-89 | T | `/api/editors` 가 실패하면 Editor 탭이 숨겨진다 | 120 |
| V-EDT-85 | M | 사이드바 100px 에서 탭 3개가 읽힌다 | NFR-3 |
| V-EDT-86 | M | 5,000 항목 폴더에서 스크롤이 매끄럽다 | NFR-4 |
| V-EDT-87 | T | 벤치마크: 1,000 항목 `list` 가 100ms 이내 | NFR-1 |
| V-EDT-88 | T | Editor 창이 열려도 git 실행 횟수가 늘지 않는다 | NFR-2 |

---

## 5. 구현 계획

각 단계는 **그 자체로 동작하는 상태**로 끝난다.

| M | 이름 | 내용 | FR |
|---|---|---|---|
| **M1** | 서버 표면 | `wsentry` 패키지 + 연동 4규칙 + `/api/editors/*` 4종 + `/api/fs/*` 4종. Go 테스트로 완결 검증 | 19~39, 108~119 |
| **M2** | 탭·창 골격 | 사이드바 서술자·목록 렌더 일반화·root 행 · `WINDOW_TYPE_EDITOR`·재조정·게이트 · **일반 창 편집기 금지와 마이그레이션** | 1~18, 40~56, 94, 103~107 |
| **M3** | 탐색기 | 트리·지연 로드·정렬·펼침·파일 열기·pane 선택 | 57~68, 100~102 |
| **M4** | git 색 | 상태 수집·폴더 접기·우선순위·폴링·CSS 변수 승격 | 69~78 |
| **M5** | 파일 조작 | 다섯 조작 + 확인창 + 탭 추종 | 79~93 |
| **M6** | 라우팅 마감 | `edit`·Git Open File·HEAD 임시 파일 | 95~99 |

**M1 이 먼저인 이유.** 나머지 전부가 서버 표면에 얹히고, M1 은 화면 없이 Go
테스트만으로 완결 검증되므로 프론트 작업 중 계약이 흔들리지 않는다.

**M2 가 탭과 창을 함께 하는 이유.** FR-EDT-7("탭 선택 → 창 전환")·FR-EDT-9("행
클릭 → 창 활성화")이 창 없이 성립하지 않는다. 둘을 가르면 M2 가 그 자체로
동작하지 않는다.

**FR-EDT-94(일반 창 금지)와 FR-EDT-103(마이그레이션)이 M2 에 있는 이유.** 둘을
M6 로 미루면 M2~M5 구간에서 `edit <path>` 가 일반 창에 탭을 만들고 다음 로드에
사라지는 상태가 된다. M2 는 라우팅을 **완성하지 않고** "일반 창에는 열지 않는다 +
root 에디터로 보낸다" 까지만 한다. M6 이 연결·리포 규칙을 채운다.

### 5.1 파일 단위 영향 범위

| 파일 | 변경 | M |
|---|---|---|
| **신규** `internal/webserver/domain/wsentry/` | 두 목록의 원자적 mutate + 연동 4규칙 + `RepoRootFn` 주입 | M1 |
| `internal/webserver/gitapi/git_pins.go` | `wsentry` 로 위임 | M1 |
| `internal/webserver/gitapi/handlers_git.go` | pin/unpin 이 연동을 지나가고 응답에 `editors` | M1 |
| **신규** `internal/webserver/httpapi/handlers_fs.go` | `/api/fs/*` · `/api/editors/*` 핸들러, 루트 가드 | M1 |
| `internal/webserver/httpapi/handlers_files.go` | `safeResolve` 재사용 (변경 없음, 참조만) | M1 |
| `internal/webserver/httpapi/handlers_api.go` | 라우트 8개 등록 | M1 |
| `internal/webserver/httpapi/server.go` | `wsentry.Store` 조립 (`RepoRoot` 주입) | M1 |
| `web/js/core/constants.js` | `WINDOW_TYPE_EDITOR` · `EDITOR_GIT_POLL_MS` · 문자열 · 폴더 색 우선순위 | M2 |
| `web/index.html` | 패널 래퍼 1개, 스크립트 2개 | M2 |
| `web/js/ui/sidebar-tabs.js` | 서술자 1개 | M2 |
| `web/js/ui/sidebar-list.js` | `fixed(app)` 지원 | M2 |
| `web/js/ui/renderer.js` | 목록 렌더 일반화 · Editor 창 렌더 · 툴바 게이트 | M2·M3 |
| **신규** `web/js/core/app-editor.js` | 행·창의 App 믹스인, 재조정, 라우팅 | M2·M6 |
| **`web/js/core/app.js`** | **창 필터(`:104`)** · 마이그레이션 호출(`:106`) · **409 병합(`:226-232`)** | M2 |
| **`web/js/core/app-cmd.js`** | **창 필터(`:210`)** · 재조정 호출(`:212`) · `openEditorTab` 라우팅(`:285`) | M2·M6 |
| `web/js/core/app-git.js` | `_plainWindows`(`:14`) · `_gitOpenFile`(`:110`)·`_gitOpenFileHead`(`:125`) | M2·M6 |
| `web/js/core/app-layout.js` | 분할 게이트(`:402`) · `addTab` 게이트(`:220`) · `_findEditorTab`(`:190`) | M2 |
| `web/js/core/app-dnd.js` | 창 판정 자리 넷(`:16`·`:44`·`:46`·`:91`) | M2 |
| `web/js/core/helpers.js` | `_isEditorWin` 헬퍼. **`clean` 은 건드리지 않는다** | M2 |
| **신규** `web/js/ui/file-tree.js` | 탐색기 컴포넌트 | M3·M4·M5 |
| `web/style.css` | `--git-st-add` 를 `:root` 로 승격 · Editor 창 배치 · 탐색기 | M2·M4 |
| **신규** `e2e/editor-*.spec.ts` | V-EDT-* | 전 단계 |

---

## 6. 비목표 (Non-goals)

1. **Monaco 편집기 자체의 개선.** `FileEditor` 는 붙는 자리만 바뀐다.
2. **Git 창 내부의 변경.** 고정 탭 7개는 한 줄도 바뀌지 않는다. 바뀌는 것은
   `Open File` 이 어느 창으로 가느냐뿐이다.
3. **파일 검색 (Ctrl+P 류).** 탐색기는 트리이지 검색기가 아니다.
4. **파일 감시(watch).** 갱신 계기는 FR-EDT-67 의 셋뿐이다
   (`GIT_INTEGRATION_ANALYSIS` §4.5 의 fsnotify 기각 근거가 그대로 걸린다).
5. **중첩 저장소 색.** Editor 루트 아래의 다른 저장소는 색을 갖지 않는다.
6. **휴지통.** 삭제는 영구 삭제다 (D-7).
7. **탐색기의 잘라내기·붙여넣기·복제.** 다섯 조작만 넣는다.
8. **모바일 최적화.** Editor 창은 데스크톱 배치 기준이다. 모바일에서 탐색기를
   어떻게 접을지는 후속이다.
9. **편집기 탭의 백그라운드화.** `TOOL_CAPABILITIES.editor.backgroundCapable=false`
   가 그대로다.
10. **편집기 탭을 `dmctl` 로 조작하는 새 서브커맨드.** `edit` 만 유지한다.

---

## 7. 확정 결정 (Decisions)

인터뷰(2026-08-28)와 1차 스펙 검증으로 확정했다. **본문과 어긋나면 이 표가 이긴다.**

| id | 결정 | 근거 |
|---|---|---|
| **D-1** | Editor 행 하나에 창 하나 (`WINDOW_TYPE_EDITOR`) | 행별 분할·탭 구조가 창에 그대로 산다. 기존 window 모델을 재사용하며 "연결된 Editor" 조회가 창 목록 검색 한 번이다 |
| **D-2** | 일반 창의 기존 편집기 탭은 **제거**한다 (이관하지 않음) | 사용자 지시. 파일은 디스크에 남는다 |
| **D-3** | 편집기 탭은 **같은 Editor 창 안에서만** 이동한다 | 탭 이동은 사용자가 창의 소속을 바꾸는 조작이라, 허용하면 사용자가 스스로 만든 배치를 시스템이 다음 열기에서 뒤집는다(FR-EDT-95 는 자기 루트의 창을 고른다). 반면 FR-EDT-96·98 의 폴백은 시스템이 **갈 곳이 없을 때** 정하는 자리이므로 같은 문제가 아니다 — FR-EDT-99 가 그 예외를 명시한다 |
| **D-4** | 색은 **기존 `GIT_ST_CLASS` + `style.css` 매핑을 그대로** 쓴다 | 사용자 지시. 그 결과 요구 5의 "노란색"은 `--accent` 가 된다 — 노랑(`--attn`)은 부분 스테이지의 색이라 겹칠 수 없다 (`style.css:1123-1124`) |
| **D-5** | 폴더 우선순위 `충돌 > 신규 > 수정 > 이름변경·복사`, **삭제는 전파 없음** | 요구의 "초록이 노랑을 이긴다" + 충돌 우선. VSCode 는 우선순위 자체가 없어 모사 대상이 아니다 (FR-EDT-74 의 조사 근거) |
| **D-6** | git 색의 기준은 **Editor 루트 저장소 하나뿐** | 중첩 탐지는 펼침마다 `rev-parse` 가 붙는다 |
| **D-7** | 파일 조작 다섯, 삭제는 **영구 삭제** | 사용자 지시. 휴지통은 플랫폼 의존이라 cross-platform 보류 방침과 맞지 않는다 |
| **D-8** | **분할은 드래그드롭만.** 단축키·버튼 분할 없음 | 사용자 지시. 그 결과 **빈 pane 개념이 도입되지 않고** 접수한 요구 8이 통째로 불필요해졌다 |
| **D-9** | dirty 확인창을 **띄우지 않는다** — 마이그레이션·Editor 행 제거·Git 행 제거 셋 다 | 사용자 지시. 단 **파일 삭제**는 별개이며 확인창이 필수다 (FR-EDT-83) |
| **D-10** | root 에디터 행은 목록 **최하단 고정**, 별도 관리 | 사용자 지시. 순서 변경·제거 대상이 아니고 순회에는 마지막 자리로 포함된다 |
| **D-11** | Editor 목록은 **서버 권위**, 연동은 서버에서 원자적으로 | 브라우저가 여럿일 때 절반만 반영된 상태를 막는다 |
| **D-12** | 목록 렌더 하드코딩(`renderer.js:52`·`:60`)을 **배열 순회로 일반화**한다 | Editor 탭이 드러낸 기존 결함. 넷째 탭에서 반복된다. **패널 래퍼(`index.html`)는 그대로 손으로 둔다** — 그쪽은 기존 규약이다 (§2.1) |
| **D-13** | **`layout` 이 없는 Editor 창을 보존하도록 창 필터를 고친다** | FR-EDT-55 의 전제. 고치지 않으면 빈 Editor 창이 다음 `workspace_changed` 한 번에 사라진다 (§2.4) |
| **D-14** | 창의 생성·소멸은 **멱등한 재조정**으로 하고, 같은 루트의 중복은 **id 사전순**으로 줄인다 | 창 생성 주체가 브라우저인데 목록 변경은 모든 브라우저에 도달한다. 단일 실행자 지명은 `POST /api/commands` 경로 전용이라 쓸 수 없다 (FR-EDT-42) |
| **D-15** | 경로 정규화는 **`EvalSymlinks` + `Clean` 하나**로 통일한다 | 두 정규화가 갈리면 연동의 짝이 조용히 깨진다 (macOS `/tmp`) |
| **D-16** | 파일 조작 API 는 **`root` 를 함께 받아** 그 아래로 제한한다 | 조작은 트리에서 파생된 경로를 지운다. 기존 `/api/file/*` 의 무제한 가드를 물려받으면 버그 하나가 홈 밖을 지운다 |
| **D-17** | 연동은 **새 패키지 `wsentry`** 가 소유하고 `RepoRootFn` 을 주입받는다 | `httpapi` 가 `gitapi` 를 import 하지 않고 FR-EDT-33 을 판정하는 유일한 길 |
| **D-18** | 탐색기 폭은 **워크스페이스**에 저장한다 | `sidebarWidth` 가 그렇다 — localStorage 는 첫 페인트용 사본이다 (§2.10) |
| **D-19** | 편집기 탭 마이그레이션은 **`clean()` 밖**에서 한다 | `clean` 은 편집기 탭을 보존하도록 만들어져 있고 창 타입을 모른다 (§2.9) |
| **D-20** | 탐색기 항목 **정렬은 서버가** 한다 | 잘림 경계가 요청마다 흔들리지 않으려면 순서가 한 자리에서 정해져야 한다 (FR-EDT-61) |
| **D-21** | `list` 는 경로 전체를, 조작 셋은 **부모까지만** 심볼릭 링크를 푼다 | 조작은 아직 없는 이름을 다루고 링크 자신을 대상으로 삼을 수 있어야 한다 (FR-EDT-112) |
| **D-22** | `NormalizePath` 는 `EvalSymlinks` 실패 시 `Clean` 으로 폴백한다 | 실패를 오류로 올리면 사라진 디렉터리의 행을 지울 수 없어 FR-EDT-26 이 깨진다 |
| **D-23** | `FS_LIST_MAX`·`FS_DELETE_MAX` 는 `const` 가 아니라 패키지 `var` 다 | 실제 값으로 상한 픽스처를 만들면 테스트가 파일 1만 개를 만든다. 프로덕션 경로에서 바꾸지 않는다 |
| **D-26** | `rename` 의 무덮어쓰기는 **파일은 `os.Link` 로, 디렉터리는 Go 의 기존 가드로** 닫는다 | 초판은 "원자적으로 닫을 수 없다" 였으나 실측이 그것을 뒤집었다 — Go 의 `os.Rename` 은 대상이 디렉터리면 이미 EEXIST 이고, 파일은 `os.Link` 가 원자적으로 이름을 잡는다. 심볼릭 링크와 EXDEV 폴백에만 창이 남고, 그쪽은 `fsOpMu` 가 자기 경합만 없앤다 (FR-EDT-115) |
| **D-33** | root 행은 **패널 최하단의 별도 컨테이너**에 그린다 | 초판은 "목록의 같은 컨테이너 마지막" 이었으나 사용자가 뜻한 것은 패널의 바닥(설정 버튼 위)이었다. 같은 컨테이너에 두면 목록이 길어질 때 함께 스크롤돼 바닥을 떠난다 (FR-EDT-14) |
| **D-34** | 지운 리포를 보고 있던 Git 창은 **떠난다** | 리포를 고르는 자리가 이미 비었으므로 그 창에는 갈 곳이 없다. 남기면 사용자가 없앤 것이 화면에 그대로 뜬다 |
| **D-32** | 부분 스테이지는 탐색기에서도 **노랑이 상태색을 이긴다** | Git 패널의 규약을 그대로 가져온다. 이것을 빠뜨리면 같은 파일이 두 화면에서 다른 색이 된다 (FR-EDT-72a) |
| **D-31** | 서버 소유 키(`git.pinned`·`editors.list`)는 **창 분기 밖에서** 채택한다 | 실제 앱을 띄워 찾은 결함이다 — 창이 없는 워크스페이스에서 로드가 서버 스냅샷을 버리고, 이어지는 `_save()` 가 핀을 지웠다. 기존 결함이지만 root 에디터 창을 늘 만들어야 하는 이번 기능이 그것을 상시로 만들었다 (FR-EDT-20a) |
| **D-30** | 탐색기 회수의 자리는 **재조정**이다 | `_edTree` 는 활성 Editor 창을 그릴 때만 불려, 일반 창에 있는 동안 행을 지우면 분리된 DOM 이 남았다. 재조정은 창이 사라지는 것을 아는 유일한 자리다 (FR-EDT-42) |
| **D-27** | 셀 수 없는 트리는 **지우지 않는다** | 절반만 지워진 트리가 거부보다 나쁘다 (FR-EDT-118) |
| **D-28** | 저장소 루트 판정은 `/api/git/status` 로 색과 **함께** 받는다 | `/api/git/repo-at` 은 `tool=` 만 받아 임의 경로를 판정하지 못한다 (FR-EDT-69) |
| **D-29** | 목록이 그대로면 **저장도 브로드캐스트도 하지 않는다** | rev 가 오르면 모든 브라우저가 재조정을 돈다. 바뀐 것이 없는데 치를 비용이 아니다 (FR-EDT-27) |
| **D-25** | DnD 게이트는 **창 경계를 넘는 경로 둘**(`app-dnd.js:44`·`:46`)에만 넣는다 | 초판이 "창 판정 자리 넷"이라 한 것은 오류다. `:16`·`:91` 은 창 **안**의 이동·분할이라 막으면 FR-EDT-51 이 깨진다 (M2 구현이 반증) |
| **D-24** | 루트 경계 검사에 **`safeResolve` 를 쓰지 않는다** | 그쪽은 `..` 접두 문자열로 판정해 `..b`·`...` 같은 정상 이름을 이탈로 오인한다(실측). 탐색기는 전부를 보여야 한다 (FR-EDT-58). 기존 `/api/file/*` 는 base 가 `/` 라 이 오탐이 드러나지 않으므로 **건드리지 않는다** |
