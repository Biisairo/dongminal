# 설계 계약 — M1 5·6단계 Changes 탭 + 변경 감지 (묶음 E·C 클라, FR-GIT-18~24·32~42)

GIT_SRS.md §3.3·§3.5 의 클라이언트 절반이다. 검증은 V5·V6·V9·V18·V22·V23·V24·V25.
전제: 2단계(API), 3단계(`GitPanel` 골격), 4단계(GIT 섹션)가 끝나 있다.

두 단계를 한 계약으로 묶는 이유: 둘 다 `web/js/git-panel.js` 를 쥔다. 파일을 나눠
가질 수 없으므로 순서만 지킨다 — **5단계(표시)를 먼저 완성한 뒤 6단계(폴링)를 얹는다.**
갱신할 대상이 있어야 폴링이 의미가 있다.

## 0. 파일 배치

| 파일 | 변경 |
|---|---|
| `web/js/git-panel.js` | Changes view 구성 + 감지 3계층 |
| `web/js/constants.js` | 폴링 주기·상한 상수 |
| `web/js/term-pane.js` | `_onCwd` 에 즉시 신호 훅 1줄 |
| `web/js/app.js` | `_gitSignal` (즉시 신호 진입점), 파일 저장 훅 |
| `web/style.css` | `/* ── Git 창 ── */` 구획 |
| `e2e/git-changes.spec.ts` | **신규** — V22·V23·V24 |
| `e2e/git-polling.spec.ts` | **신규** — V6·V18 |

## 1. 상수 (`constants.js`)

```js
// 변경 감지 3계층의 기본 주기 (GIT_INTEGRATION_ANALYSIS §4.5.4).
// 0 이면 그 계층을 끈다 (FR-GIT-23).
const GIT_SIGNATURE_POLL_MS=500;
const GIT_STATUS_POLL_MS=1000;
// 즉시 신호는 몰아서 온다 — 셸 훅·에디터 저장·포커스 복귀가 겹친다.
// 하나로 합쳐 status 를 연발하지 않게 한다 (FR-GIT-20).
const GIT_SIGNAL_DEBOUNCE_MS=150;
// 파일 목록은 한 번에 다 그리지 않는다 (FR-GIT-42). 스크롤이 끝에 닿을 때마다
// 이만큼 늘린다.
const GIT_FILE_ROW_CHUNK=200;
```

주기는 설정(`/api/settings`)으로 덮을 수 있어야 한다 (FR-GIT-23). `statsInterval` 이
`main.js` 에서 어떻게 덮이는지 보고 같은 방식을 쓴다:
`saved.gitSignatureInterval` / `saved.gitStatusInterval`.

## 2. Changes 탭 (5단계, FR-GIT-32~42)

### 2.1 구조

```
.git-view.git-changes
├ .git-head                                     ← FR-GIT-32·33·40
│   .git-head-repo      리포명
│   .git-head-branch    브랜치 (또는 해시 앞 7자)
│   .git-head-badges    detached / no-upstream / 충돌 배지
│   .git-head-ab        ↑2 ↓1
│   .git-head-spacer
│   .git-head-remote    [Fetch][Pull][Push]  ← 전부 disabled (M1)
├ .git-commit                                   ← FR-GIT-39. **고정 영역**
│   textarea.git-commit-msg (disabled, placeholder "M2 에서 제공됩니다")
│   .git-commit-side  ☐ amend (disabled)  [Commit ▾] (disabled)
└ .git-changes-body                             ← 좌 목록 / 우 미리보기
    ├ .git-files
    │   .git-files-bar   [트리|플랫] 토글            ← FR-GIT-38
    │   .git-group[data-group=staged|changes|untracked|conflicts]
    │       .git-group-head  ▾ Staged (1)
    │       .git-group-rows
    │           .git-file[data-path]
    └ .git-preview
```

**FR-GIT-39 의 실체**: `.git-changes` 는 `display:flex; flex-direction:column`
이고 `.git-head`·`.git-commit` 은 `flex:0 0 auto`, `.git-changes-body` 는
`flex:1 1 auto; min-height:0` 다. 목록 스크롤은 `.git-files` 안에서만 일어난다.
**커밋 영역이 목록과 함께 스크롤되면 이 요구사항은 실패다.**

### 2.2 헤더 (FR-GIT-32·33)

- 리포명 = 경로의 마지막 조각. `title` 에 전체 경로.
- 브랜치: `status.branch`. `detached` 면 `status.oid` 앞 7자 + `.git-badge-detached`
  배지("detached HEAD").
- `hasUpstream` 이 false 이고 detached 가 아니면 `.git-badge-noupstream`
  배지("upstream 없음").
- ahead/behind 는 0 이면 그리지 않는다.
- 충돌이 있으면 `.git-badge-conflict` 배지("충돌 N").
- Fetch/Pull/Push 버튼은 `disabled` 이고 `title` 에 "M3 에서 제공됩니다".

### 2.3 파일 목록 (FR-GIT-34·36·37·38·42)

- 그룹 순서: `conflicts` → `staged` → `changes` → `untracked`.
  충돌이 맨 위인 이유는 그것이 먼저 해결돼야 하는 상태이기 때문이다.
  빈 그룹은 헤더만 보이고 접힌다 (개수 0 을 숨기지 않는다 — FR-GIT-34 가 개수를
  요구한다).
- 그룹 헤더 클릭으로 접기/펴기. 접힘 상태는 리포 전환에도 유지한다 (뷰의 성질이다).
- 행 표시: `<상태문자> <경로>`.
  - 상태문자는 `xy` 에서 뽑는다. staged 그룹은 X, changes 그룹은 Y,
    untracked 는 `?`, conflicts 는 `U`.
  - rename/copy(`origPath` 있음)는 `origPath → path` 로 **둘 다** 보인다
    (FR-GIT-36). `title` 에 유사도(`Score`).
  - 충돌 행은 `.git-file.conflict` 로 구분한다 (FR-GIT-37). M1 은 표시만 한다.
- **트리/플랫 (FR-GIT-38)**: 기본은 플랫. 토글은 `.git-files-bar` 의 버튼.
  트리 보기는 경로를 `/` 로 쪼개 디렉터리 노드를 만들고, 디렉터리는 접을 수 있다.
  중간에 자식이 하나뿐인 디렉터리는 합쳐 보인다(`a/b/c`) — 깊은 트리에서 줄 수를
  줄인다. 보기 선택은 `localStorage` 에 남긴다 (기기별 취향이다).
- **FR-GIT-42**: 그룹의 행 수가 `GIT_FILE_ROW_CHUNK` 를 넘으면 그만큼만 그리고
  마지막에 `.git-file-more` 를 둔다. `IntersectionObserver` 로 그것이 보이면
  다음 덩어리를 이어 그린다. 행 생성은 `DocumentFragment` 로 한 번에 붙인다.
  **한 번에 수천 행을 innerHTML 로 만들지 않는다.**

### 2.4 선택과 이동 (FR-GIT-52)

- 단일 클릭 → 선택(`.git-file.sel`) + 우측 `.git-preview` 갱신.
  M1 의 5단계에서 미리보기는 **파일 경로와 축 이름을 보이는 자리**다. 실제 diff 는
  7단계가 채운다. `panel.previewFile` 에 선택을 담아 두고 7단계가 읽는다.
- 더블클릭 → Diff 탭으로 전환(`gitView:'diff'`)하고 그 파일을 대상으로 둔다.
  탭 전환은 `app` 의 기존 `switchTab(paneId, tabId)` 를 쓴다.
- 축 결정: staged 그룹 → `index↔HEAD`, changes/untracked 그룹 → `worktree↔index`,
  conflicts → `worktree↔HEAD`. 이 매핑을 상수 표로 둔다.

### 2.5 우클릭 (FR-GIT-41, 검증 V24)

`contextmenu` 로 3항목 메뉴를 띄운다. **저장소를 바꾸는 항목은 하나도 없다.**

| 항목 | 동작 |
|---|---|
| Open Changes | Diff 탭으로 전환 (더블클릭과 같다) |
| Open File | 내장 편집기로 연다 — 기존 경로를 쓴다. `app` 에 파일을 editor 탭으로 여는 함수가 이미 있는지 **먼저 확인**하고 그것을 부른다 |
| Copy Path | `navigator.clipboard.writeText(절대경로)`. 실패 시 폴백(기존 코드에 복사 유틸이 있으면 그것을 쓴다) |

메뉴는 이 단계 전용 최소 구현이다 — 공통 프레임워크(FR-GIT-146)는 M4 다.
클래스는 `.git-ctxmenu`. `Esc`·바깥 클릭·스크롤로 닫힌다.

## 3. 변경 감지 (6단계, FR-GIT-18~24)

### 3.1 계층

```
① 즉시 신호  → 150ms 디바운스 → collect()
② signature 폴링 500ms → 값이 바뀌면 collect()
③ status 폴링 1000ms → collect()
```

`collect()` = `GET /api/git/status?repo=<활성 리포>` 1회. **single-flight**
(FR-GIT-21): 진행 중이면 새로 띄우지 않고 "끝나면 한 번 더" 플래그만 세운다.

`signature()` = `GET /api/git/signature?repo=<활성 리포>`. 이전 값과 같으면
아무것도 하지 않는다 (FR-GIT-19).

`collect()` 의 응답에 signature 가 함께 오므로(2단계 §5.6) 그 값으로 마지막
signature 를 갱신한다 — 직후 signature 폴링이 헛되이 변화를 보고하지 않게 한다.

### 3.2 즉시 신호 4종 (FR-GIT-18·20)

| 신호 | 배선 |
|---|---|
| 터미널 `precmd` | `term-pane.js` 의 `_onCwd(cwd)` 끝에 `if(app)app._gitSignal('cwd')` |
| 에이전트 hook | `precmd` 와 같은 OSC 경로를 타므로 위와 동일 |
| 파일 저장 | `POST /api/file/write` 를 부르는 클라이언트 코드(내장 편집기 저장)에 `app._gitSignal('write')` |
| 브라우저 가시성·포커스 복귀 | `visibilitychange`(→ 보이게 됨)·`window.focus` |

```js
// app.js
// _gitSignal 은 즉시 신호의 단일 진입점이다. 어디서 왔는지는 라벨로만 남기고
// 처리는 GitPanel 이 한다 — 디바운스와 게이팅이 한 곳에 있어야 한다.
_gitSignal(kind){ if(this.gitPanel) this.gitPanel.signal(kind) }
```

`GitPanel.signal(kind)`:
- `document.hidden` 이면 버린다.
- 활성 리포가 없으면 버린다.
- `GIT_SIGNAL_DEBOUNCE_MS` 타이머를 다시 건다. 만료 시 `collect()` 1회.
  **연속 신호가 status 를 연발하지 않는다** (FR-GIT-20).

### 3.3 게이팅 (FR-GIT-22, 검증 V6)

폴링 두 계층(②③)은 다음 **전부**가 참일 때만 돈다:

1. `!document.hidden`
2. Git 창이 활성 창이다 (`app.ws.activeWindow === gitWindow.id`)
3. 활성 리포가 있다

거짓이 되면 `clearInterval` 로 **완전히 멈춘다** (`return` 으로 넘기는 게 아니라
타이머를 없앤다 — FR-GIT-22 의 "완전 중단"). 참이 되면 **즉시 1회 수집**하고 주기를
건다. `SYSTEM_STATS_SRS` FR-STAT-17 과 같은 규약이다.

**즉시 신호(①)는 게이팅이 다르다.** 조건 1·3 만 본다 — Git 창이 활성이 아니어도
셸 명령 직후 한 번은 수집한다. 이유: 상태바 chip(8단계)과 GIT 섹션 배지가 사용자가
Git 창을 보지 않을 때도 딛는 값이고, 즉시 신호는 사용자 행동에 정확히 1:1 이라
"폴링"이 아니다. 비용은 사용자가 명령을 실행한 순간의 10ms 한 번이다.
(이 해석은 SRS §7 의 열린 결정에 없던 항목이므로 §8 변경 기록에 남긴다.)

재평가 시점: `visibilitychange`, `window.focus`, `switchWindow`, 활성 리포 변경,
설정 변경. 하나의 `_reschedule()` 이 전부를 처리한다.

### 3.4 주기 0 (FR-GIT-23, 검증 V18)

`GIT_SIGNATURE_POLL_MS===0` 이면 signature 계층을 아예 걸지 않는다.
`GIT_STATUS_POLL_MS===0` 이면 status 계층을 걸지 않는다. 둘 다 0 이면 즉시 신호만
남는다. 상수를 코드에서 다시 읽어 쓰지 말고 `_reschedule()` 이 한 번 읽는다.

### 3.5 활성 리포 1개 (FR-GIT-24, 검증 V7)

폴링·수집은 **활성 리포에만** 한다. 핀된 다른 리포에 대해 `collect()`·`signature()`
를 부르는 코드 경로가 있어서는 안 된다. 다른 리포의 배지는
`app._gitReposRefresh()` 가 서버의 마지막 관측값을 받아 그린다 (4단계).

`collect()` 성공 후 `app._gitReposRefresh()` 를 부른다 — 활성 리포의 배지가
따라 갱신된다.

### 3.6 stale 가드 (FR-GIT-16, 검증 V4)

3단계가 만든 `token()`/`isStale(tok)` 를 **모든 응답 처리 앞에서** 쓴다.

```js
const tok=this.token();
const res=await fetch(…);
const body=await res.json();
if(this.isStale(tok)) return;              // ① 세대·리포 확인
if(body.requested!==tok.repo) return;      // ② 서버가 되돌려준 요청값 확인
… 화면에 쓴다 …
```

②가 있는 이유: 같은 세대 안에서도 응답이 뒤바뀌어 도착할 수 있다. 서버가
`requested` 를 그대로 돌려주는 것(2단계 §5.6)이 그것을 잡는다.

`setRepo()` 는 세대를 올리고, 진행 중 타이머를 재편성하고, 화면을 "불러오는 중"
으로 되돌린다. **이전 리포의 파일 목록이 새 리포의 헤더와 함께 보이는 순간이
있어서는 안 된다.**

### 3.7 오류 표시

- `not_a_git_repo` — 활성 리포를 null 로 되돌리고 "저장소가 아닙니다" 를 보인다.
- `git_missing` — "git 을 찾을 수 없습니다" 를 보이고 폴링을 멈춘다.
- 네트워크 오류 — 이전 화면을 유지하고 `.git-stale-note` 로 "갱신 실패" 를 보인다.
  **목록을 지우지 않는다.**

## 4. e2e

### `e2e/git-changes.spec.ts`

| # | 검증 | 내용 |
|---|---|---|
| C1 | V22 | 헤더에 리포명·브랜치가 나온다 |
| C2 | V22 | detached HEAD 저장소에서 `.git-badge-detached` 가 나온다 (테스트가 임시 저장소를 만들어 detach 한다) |
| C3 | V22 | upstream 없는 브랜치에서 `.git-badge-noupstream` 이 나온다 |
| C4 | V23 | 파일을 만들면 untracked 그룹 개수가 늘고 행이 보인다 |
| C5 | V23 | `git add` 한 파일이 staged 그룹에 있다 |
| C6 | V23 | 트리/플랫 토글이 동작한다 |
| C7 | V24 | 우클릭 메뉴에 3항목이 있고 **stage·discard·commit 같은 항목이 없다** |
| C8 | FR-GIT-39 | 파일이 많아 목록을 스크롤해도 `.git-commit` 이 화면에 남는다 |
| C9 | FR-GIT-36 | rename 한 파일이 `원본 → 대상` 으로 보인다 |

### `e2e/git-polling.spec.ts`

| # | 검증 | 내용 |
|---|---|---|
| P1 | V6 | Git 창이 활성일 때 `/api/git/status` 요청이 온다 (요청 가로채기로 개수 확인) |
| P2 | V6 | 다른 창으로 전환하면 status 요청이 **0건**이 된다 |
| P3 | V6 | Git 창으로 돌아오면 즉시 1건이 온다 |
| P4 | V18 | `gitStatusInterval:0` 설정이면 status 폴링이 돌지 않는다 |
| P5 | V5 | 같은 순간의 신호 여러 개가 status 1건으로 합쳐진다 |
| P6 | V4 | 활성 리포를 바꾸면 이전 리포의 응답이 화면에 닿지 않는다 (응답 지연을 라우트 지연으로 흉내) |

임시 저장소가 필요한 테스트는 `os.tmpdir()` 아래에 `git init` 으로 만든다.
정리는 테스트가 한다.

## 5. 하지 않는 것

- Monaco DiffEditor·실제 diff 내용 — 7단계.
- 상태바 chip — 8단계.
- 스테이징·커밋·discard — M2. **버튼 자리만 있고 전부 disabled 다.**
- 충돌 해결 — 범위 밖 (FR-GIT-37 은 표시만).
- 다이얼로그·컨텍스트 메뉴 공통 프레임워크 — M4·M5.
