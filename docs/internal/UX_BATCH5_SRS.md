# SRS: 폴더 폐기 · 샌드박스 런타임 · 전역 툴팁 · 서브모듈 · 워크트리 — IEEE 29148

| 항목 | 값 |
|---|---|
| 문서 | UX_BATCH5_SRS |
| 상태 | **구현 완료** (2026-09-06) — Go 단위 24개 · e2e 44개 (`git-folder-stage`(+5) · `git-worktree-repo`(7) · `sandbox-runtime`(8) · `git-submodules`(9) · `tooltips`(15)) |
| 선행 | GIT_SRS(FR-GIT-32~42·64~73·240~244) · WORKBENCH_REVIEW_SRS(FR-WBR-50~53·80~84) · GIT_DIR_ENTRY_SRS(FR-DIR-20~22) · SANDBOX_WINDOW_SRS(FR-SBX-20·25) · SANDBOX_PICK_COPY_SRS(FR-SPK-1~14) · REPO_TAB_UNIFY_SRS(FR-RTU-20·72) |
| 후속 | 없음 |

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

접수한 말은 다섯 줄이다.

> 1. 폴더단위 스테이징, 언스테이징은 했는데 디스카드, 리버트도 하면 좋겠어.
>    스테이징, 언스테이징, 디스카드, 리버트 전부 다른 파일옆의 버튼과 행과 열을 맞춰줘.
> 2. sandbox 추가 버튼을 눌렀을때 도커가 설치되어있지않거나 실행중이지 않을때 동작이 필요해.
>    설치되어있지 않으면 모달 팝업으로 설치하라는 안내와 os 별 설치 명령어를,
>    설치되어있는 경우에는 실행할거냐는 모달팝업을 띄워주면 좋겠어.
> 3. 모든 버튼에 오래 호버를 하면 영어로 이게 무슨 버튼인지 알리는 안내가 나오면 좋겠어.
> 4. 서브모듈도 따로 관리하게할 수 있으면 좋겠어.
> 5. 워크트리에서도 따로 깃을 열어서 해당 워크트리를 관리할 수 있으면 좋겠어.

인터뷰에서 확정한 것 (2026-09-05):

| # | 접수한 말의 모호함 | 확정 |
|---|---|---|
| 1 | "리버트" 가 hunk·커밋 revert 와 같은 것인가 | **아니다. discard 를 말한 것이다** — 폴더 단위 동작은 `discard` 하나이고 이름이 둘이었을 뿐이다 |
| 3 | 범위와 언어 | **앱 전체 모든 버튼**, `title` 속성을 **영어로 교체** (한국어 title 병기 아님) |
| 4 | "따로 관리" 의 범위 | **기본 git 과 동일하게** — 목록·상태에 그치지 않고 `init`·`update`·`sync` 와 서브모듈 자체를 저장소로 여는 것까지 |
| 5 | 무엇이 부족한가 | "worktree 에서 자체 git 을 볼 수 있어야 한다. 그냥 worktree 를 repo 탭에 추가하면 일반적인 git 이 아니라 처리를 못하는 것 같다" |

### 1.2 범위 (Scope)

**포함**

| 묶음 | 내용 | 접두어 |
|---|---|---|
| **A** 폴더 폐기 | 트리 보기 폴더 행의 `discard`, 그리고 폴더 행과 파일 행의 **버튼 열 정렬** | FR-DBA |
| **B** 샌드박스 런타임 | docker 미설치 / 데몬 미실행을 **구분**해 알리고, 각각의 다음 걸음을 준다 | FR-SRT |
| **C** 전역 툴팁 | 앱 전체 버튼의 영어 `title`, 그리고 그것이 빠지지 않게 하는 검증 | FR-TIP |
| **D** 서브모듈 | Submodules 탭 — 목록·상태·`init`·`update`·`sync`·저장소로 열기 | FR-SUB |
| **E** 워크트리 | 워크트리를 그 자체 저장소로 다루는 경로의 **확정과 진입점** | FR-WTG |

**미포함:** §7 비목표.

### 1.3 정의 (Definitions)

| 용어 | 정의 |
|---|---|
| **폴더 행 (dir row)** | Changes 탭 트리 보기에서 파일이 아니라 디렉터리를 나타내는 행 (`.git-dir`) |
| **행 동작 (row act)** | 행 오른쪽 끝의 인라인 버튼 묶음 (`.git-file-acts` 안의 `.git-file-act`) |
| **열 정렬 (column alignment)** | 같은 동작의 버튼이 파일 행과 폴더 행에서 **화면상 같은 가로 위치**에 오는 것 |
| **런타임 상태 (runtime state)** | `missing`(바이너리 없음) · `stopped`(바이너리는 있으나 데몬에 닿지 못함) · `ok` 셋 중 하나 |
| **서브모듈 상태** | `git submodule status` 의 접두 문자 — ` `(ok) · `-`(uninitialized) · `+`(모듈이 다른 커밋에 있음) · `U`(충돌) |
| **연결 저장소** | 워킹 트리 안에 있으나 `.git` 이 **디렉터리가 아니라 파일**(gitdir 포인터)인 저장소 — 워크트리와 서브모듈이 그렇다 |

### 1.4 참조 (References)

- [`./GIT_SRS.md`](./GIT_SRS.md) — FR-GIT-64~73 (스테이징), FR-GIT-240~244 (Worktrees)
- [`./WORKBENCH_REVIEW_SRS.md`](./WORKBENCH_REVIEW_SRS.md) — FR-WBR-50~53 (그룹 일괄), FR-WBR-80~84 (폴더 행 동작)
- [`./GIT_DIR_ENTRY_SRS.md`](./GIT_DIR_ENTRY_SRS.md) — FR-DIR-20~22, **§7 비목표 2** ("서브모듈 조작 명령을 붙이지 않는다") — 본 문서 묶음 D 가 그 비목표를 **해제**한다
- [`./SANDBOX_WINDOW_SRS.md`](./SANDBOX_WINDOW_SRS.md) — FR-SBX-20 (기동 실패 사유), FR-SBX-25 (프로파일 선택), NFR-SBX-3
- [`./SANDBOX_PICK_COPY_SRS.md`](./SANDBOX_PICK_COPY_SRS.md) — FR-SPK-1~14
- `web/js/git/panel-changes.js` · `web/js/core/constants-git.js` · `web/js/core/main.js` · `web/js/git/worktrees.js` · `internal/shared/sandbox/sandbox.go` · `internal/shared/sandboxplace/wire.go` · `internal/webserver/gitapi/handlers_git_worktree.go`

---

## 2. 현재 상태 (조사로 확정한 사실)

**추측이 아닌 실측과 파일:줄로만 적는다.**

### 2.1 폴더 행에는 폐기가 없고, 파일 행과 열이 어긋난다

```js
// constants-git.js:175
const GIT_ROW_ACTS={
  staged:['openFile','unstage'], changes:['openFile','stage','discard'],
  untracked:['openFile','stage','discard'], conflicts:['openFile','ours','theirs','stage'],
};
// constants-git.js:185
const GIT_DIR_ACTS={staged:['unstage'],changes:['stage'],untracked:['stage']};
```

두 표가 **같은 클래스**(`.git-file-act`)로 그려지므로 치수는 같다
(`panel-changes.js:479`, `_dirEl`). 그러나 개수와 종류가 달라 자리가 어긋난다:

| 그룹 | 파일 행 | 폴더 행 | 어긋남 |
|---|---|---|---|
| staged | `↗ −` (2칸) | `−` (1칸) | 폴더의 `−` 가 파일의 `↗` 자리에 온다 |
| changes | `↗ + ↺` (3칸) | `+` (1칸) | 폴더의 `+` 가 파일의 `↗` 자리에 온다 |
| untracked | `↗ + ↺` (3칸) | `+` (1칸) | 같음 |

동작 묶음은 `flex` 로 오른쪽 정렬되므로(§`style-git.css`) **오른쪽 끝부터 채워진다**
— 개수가 다르면 같은 아이콘이 다른 열에 선다.

`GIT_DIR_ACT_TITLE` 은 `stage`·`unstage` 둘만 안다 (`constants-git.js:186`).

### 2.2 그룹 일괄에는 이미 폐기가 있다

```js
// constants-git.js:171
const GIT_GROUP_BULK={staged:['unstage'],changes:['stage','discard'],untracked:['stage','discard']};
```

즉 **폐기의 실행 경로는 이미 있다** (`_bulk` → `_run('discard', targets)`).
폴더 행에 없는 것은 진입점뿐이며, 폴더 대상 목록을 만드는 `_dirBulk` 도 이미 있다
(`panel-changes.js:494`). 묶음 A 는 새 명령을 만들지 않는다.

### 2.3 샌드박스는 미설치와 미실행을 구분하지 않는다

```js
// main.js:37
try{const r=await fetch('/api/sandbox/profiles');if(r.ok) list=await r.json()}catch{}
if(!list.length){
  app._notify('샌드박스를 쓸 수 없습니다 — 컨테이너 런타임(docker)이 설치되어 실행 중인지 확인하세요.');
  return;
}
```

서버 쪽 사실:

| 사실 | 근거 |
|---|---|
| `Wire()` 는 **바이너리 유무만** 본다 — 데몬은 보지 않는다 | `sandboxplace/wire.go:22` → `sandbox.FindRuntime` → `exec.LookPath("docker")` (`sandbox.go:319`) |
| 그래서 **docker 는 설치됐는데 데몬이 죽은 상태**에서는 프로파일 목록이 정상으로 오고, 실패는 창을 만드는 순간까지 미뤄진다 | `handlers_api.go:390` `apiSandboxProfiles` |
| 데몬 미실행을 알아보는 판정은 **이미 있다** — 다만 실행 출력에만 쓰인다 | `sandbox.go:308` `runtimeDown(out)` |
| 서버는 자기 OS 를 안다 (`runtime.GOOS`). 그러나 그것을 화면에 주는 API 가 없다 | `handlers_api.go` 라우팅 표 전체에 없음 |

**결론:** 화면이 두 경우를 가르려면 서버에 판정 표면이 하나 있어야 한다.

### 2.4 title 은 한국어이고, 없는 버튼도 많다

실측 (`web/js/`, `web/index.html`):

| 항목 | 수 |
|---|---|
| 버튼 생성 지점 (`createElement('button')` + 문자열 `<button`) | 105 |
| 그중 `index.html` 의 정적 버튼 | 41 |
| `.title=` 대입 (버튼 외 요소 포함) | 77 |

지금 있는 title 은 전부 한국어다 (`GIT_ACT_TITLE`·`GIT_BULK_TITLE`·
`GIT_DIR_ACT_TITLE`·`GIT_REFRESH_TITLE`·`SANDBOX_WORK_TITLE` 등).

### 2.5 워크트리·서브모듈은 서버가 이미 저장소로 취급한다 — 결함은 진입점에 있다

실측 (서버 :58146, 2026-09-05):

```
$ curl '/api/git/status?repo=/private/tmp/dm-baseline'      # 워크트리
  → "repo":"/private/tmp/dm-baseline", "rootMatch":true, "detached":true

$ curl '/api/git/status?repo=<outer>/vendor/inner'          # 서브모듈
  → "repo":".../vendor/inner", "rootMatch":true, "branch":"main"
```

근거는 `RepoRoot` 가 `rev-parse --show-toplevel` 이고 (`core/repo.go:17`), 그 명령이
연결 저장소에서 **그 저장소 자신**을 답하기 때문이다. `GitDirs` 도 worktree 를
이미 안다 — gitdir 과 common-dir 을 갈라 signature 를 만든다 (`core/dirs.go:17`).

따라서:

| 요구 | 서버 | 화면 |
|---|---|---|
| 워크트리를 저장소로 | **된다** | `worktrees.js` 의 `open` 액션이 `openGitWindow(e.path)` 를 부른다 (`worktrees.js:200`) — **경로는 이미 있다** |
| 서브모듈을 저장소로 | **된다** | **없다.** `GIT_DIR_ENTRY_SRS` §7 이 서브모듈 조작을 명시적 비목표로 두었고, 디렉터리 행은 표시만 한다 |

**묶음 E 의 첫 요구는 그래서 "고친다" 가 아니라 "확정한다" 이다** (FR-WTG-1) —
접수한 말이 "처리를 못하는 것 같다" 라는 추정이므로, 재현되지 않는 것을 고치면
바뀌지 않은 동작을 바꿨다고 보고하게 된다.

### 2.5.1 FR-WTG-1 실측 결과 (2026-09-06) — **결함은 재현되지 않았다**

`e2e/git-worktree-repo.spec.ts` 6개 전부 통과. 확인한 것:

| # | 확인한 것 | 결과 |
|---|---|---|
| E1 | `+ Add`(`/api/editors/add`)로 워크트리 경로를 넣는다 | Editor 행과 **핀이 함께 선다** — 저장소로 판정된다 |
| E2 | 그 창의 Changes 가 딛는 것 | `gitPanel.repo` 가 워크트리 경로. 워크트리에만 있는 미추적 파일이 보이고, **원본에만 있는 것은 보이지 않는다** |
| E3 | 머리의 브랜치 | 워크트리의 브랜치(`e3-branch`) — 원본의 `main` 이 아니다 |
| E4 | detached 워크트리 | 해시 앞 7자 + `detached HEAD` 배지. 일반 저장소와 같은 규약 |
| E5 | 그 창의 Worktrees 탭 | 원본과 자신이 **함께** 선다. `main` 표식은 원본에 붙는다 |
| E6 | 그 창의 History | 워크트리에만 있는 커밋이 보인다 |

`open` → 그 워크트리의 Repo 창은 **이미 검증돼 있었다** — `git-worktrees.spec.ts`
V151 이 `_edRootOf(_aw())` 로 단정하며 통과 중이다.

**결론:** 워크트리를 저장소로 다루는 경로에 결함이 없다. D-11 대로 **아무것도 고치지
않는다.** 남는 것은 FR-WTG-2 (진입점의 말) 하나이며, 그 문구(`GIT_WT_ACT_TITLE.open`
= "이 worktree 를 활성 리포로 엽니다")는 REPO_TAB_UNIFY_SRS FR-RTU-72 이전의 표현이라
지금 하는 일과 어긋나 있다 — **묶음 C 에서 함께 고친다** (같은 상수 표를 두 번 지나지
않기 위해서다).

### 2.6 워크트리 `owner` 는 설계대로다 (결함 아님)

실측에서 main worktree 를 포함한 두 항목이 모두 `"owner":"outside"` 로 왔다.
`gitWorktreeOwner` 는 `$DONGMINAL_HOME/git-worktrees` 밖을 `outside` 로 세며
(`handlers_git_worktree.go:39`), 그 결과 제거 버튼이 붙지 않는 것은 FR-GIT-241 이
요구한 바다. **본 SRS 는 이것을 바꾸지 않는다.**

---

## 3. 기능 요구사항 (Functional Requirements)

### 3.A 묶음 A — 폴더 폐기와 열 정렬

**FR-DBA-1** 트리 보기의 폴더 행은 자기 그룹이 가진 **쓰기 동작 전부**를 갖는다.
표는 그룹별로 다음과 같다.

| 그룹 | 폴더 행 동작 | 근거 |
|---|---|---|
| `staged` | `unstage` | 스테이지된 것을 물리는 것 |
| `changes` | `stage`, `discard` | tracked 폐기 = `checkout -q -- <dir>` |
| `untracked` | `stage`, `discard` | untracked 폐기 = `clean -q -f -- <dir>` — **파일이 지워진다** |
| `conflicts` | 없음 | 그룹 일괄이 없는 것과 같은 이유 (FR-GIT-72) |

**FR-DBA-2** 폴더 행의 동작 목록은 **파일 행 목록에서 `openFile` 만 뺀 것**이어야
한다. 폴더는 편집기로 여는 대상이 아니다. 이 관계는 코드가 보장한다 — 두 표를
따로 적으면 한쪽만 늘어난다.

**FR-DBA-3 (열 정렬)** 같은 동작의 버튼은 파일 행과 폴더 행에서 **같은 가로 위치**에
선다. 폴더 행에는 `openFile` 자리에 **보이지 않는 자리지킴(placeholder)** 이 서고,
그것은 클릭 대상이 아니며 스크린 리더에 읽히지 않는다.

```
Changes 그룹 (트리 보기)
  ▾ src/                        [ ] [+] [↺]      ← 자리지킴, stage, discard
      app.js                    [↗] [+] [↺]
      util.js                   [↗] [+] [↺]
Staged 그룹
  ▾ src/                        [ ] [−]
      app.js                    [↗] [−]
```

**FR-DBA-4** 폴더 폐기는 **파괴적 확인을 거친다.** 그룹 일괄 폐기와 같은 관문
(`GitConfirm`)이며, 확인창은 **대상 폴더 경로와 그 폴더 안의 대상 파일 수**를
밝힌다. untracked 폐기의 확인 문구는 tracked 와 다르다 — 전자는 삭제이고 되살릴 수
없다 (FR-WBR-52a 와 같은 근거).

**FR-DBA-5** 폴더 폐기의 대상은 **그 폴더 아래 그 그룹의 항목 전부**다. 다른 그룹의
항목은 포함하지 않는다 — 트리가 그룹마다 따로 서므로 폴더 행은 한 그룹에만 속한다
(FR-WBR-82).

**FR-DBA-6** 플랫 보기에는 폴더 행이 없으므로 이 요구가 닿지 않는다 (FR-WBR-83).

### 3.B 묶음 B — 샌드박스 런타임 상태

**FR-SRT-1** 서버는 컨테이너 런타임의 상태를 답하는 표면을 하나 갖는다.

```
GET /api/sandbox/runtime
→ 200 {
    "state":   "ok" | "stopped" | "missing",
    "os":      "darwin" | "linux" | "windows" | <runtime.GOOS>,
    "runtime": "docker",
    "path":    "/usr/local/bin/docker",   // missing 이면 ""
    "detail":  "<진단 출력 꼬리>"           // ok 면 ""
  }
```

**FR-SRT-2** 상태 판정은 다음 순서다. **판정 자리는 이 하나뿐이다** —
`Wire()` 가 쓰는 `FindRuntime` 과 같은 `LookPath` 를 지난다.

1. `LookPath("docker")` 실패 → `missing`
2. `docker info --format {{.ServerVersion}}` 실행
   - 성공 → `ok`
   - 실패이고 `runtimeDown(out)` 이 참 → `stopped`
   - 실패이고 그 밖 → `stopped` 이며 `detail` 에 출력 꼬리를 싣는다
3. 2 의 실행에는 **상한 시간**이 있다 (NFR-SRT-1)

**FR-SRT-3** 서버는 런타임을 **띄우려 시도하는** 표면을 하나 갖는다.

```
POST /api/sandbox/runtime/start
→ 200 {"started": true|false, "command": "<시도한 명령>", "detail": "<출력 꼬리>"}
```

OS 별 시도 명령:

| OS | 명령 |
|---|---|
| `darwin` | `open -a Docker` |
| `windows` | `cmd /c start "" "Docker Desktop.exe"` |
| `linux` | **시도하지 않는다** — `started:false` 와 `command:"sudo systemctl start docker"` 를 답한다 |

**D-SRT-3 의 근거:** linux 의 데몬 기동은 권한을 요구한다. 서버가 `sudo` 를 부르면
그 자리에서 비밀번호를 받을 길이 없어 무응답으로 멈춘다 — 사용자가 자기 셸에서
치는 것이 유일하게 끝나는 길이다.

**FR-SRT-4** `started:true` 는 **명령이 오류 없이 반환됐다는 뜻일 뿐** 데몬이
떴다는 뜻이 아니다. 데몬이 떴는지는 화면이 FR-SRT-1 을 다시 물어 확정한다.

**FR-SRT-5** 샌드박스 창 추가 버튼(`#add-sandbox-window`)은 프로파일을 묻기 **전에**
FR-SRT-1 을 부른다. 상태별 결과:

| 상태 | 동작 |
|---|---|
| `ok` | 기존 흐름 그대로 — 프로파일 선택창 (FR-SPK-1) |
| `missing` | **설치 안내 모달** (FR-SRT-6) |
| `stopped` | **실행 확인 모달** (FR-SRT-7) |

**FR-SRT-6 (설치 안내 모달)** 다음을 담는다.

- 런타임이 없다는 사실과, 그것이 있어야 샌드박스 창을 만들 수 있다는 것
- **그 OS 의 설치 명령 하나** — 응답의 `os` 로 고른다. 목록을 전부 보이지 않는다:
  자기 것이 아닌 두 줄은 고를 것이 아니라 잡음이다
- 그 명령의 **복사 버튼**
- 공식 안내 주소 (텍스트로. 이 창은 바깥 링크를 열지 않는다)
- **설치 뒤에는 dongminal 을 다시 시작해야 한다**는 문장 — `Wire()` 가 기동 때 한 번
  도는 것이 근거다 (§2.3). 이 문장이 없으면 사용자는 설치하고도 같은 모달을 본다

| OS | 설치 명령 |
|---|---|
| `darwin` | `brew install --cask docker` |
| `linux` | `curl -fsSL https://get.docker.com \| sh` |
| `windows` | `winget install Docker.DockerDesktop` |

**FR-SRT-7 (실행 확인 모달)** "설치되어 있으나 실행 중이 아니다" 는 사실과,
**실행할 것인지** 묻는 선택지를 담는다.

- `linux` 에서는 실행 버튼 대신 **명령과 복사 버튼**을 보인다 (FR-SRT-3)
- 실행을 고르면 FR-SRT-3 을 부르고, 모달은 **진행 상태로 바뀐다** — 닫히지 않는다
- 진행 중에는 FR-SRT-1 을 폴링한다 (NFR-SRT-2). `ok` 가 되면 모달이 닫히고
  **원래 하려던 일(프로파일 선택창)로 이어진다** — 사용자가 버튼을 다시 누르게 하지
  않는다
- 상한 시간 안에 `ok` 가 되지 않으면 그 사실과 `detail` 을 그 자리에 남긴다.
  모달은 닫히지 않는다 (FR-GIT-175 와 같은 근거: 닫으면 사유를 읽을 자리가 사라진다)

**FR-SRT-8** 두 모달은 기존 확인창 껍데기(`.confirm-overlay`/`.confirm-box`)를 쓴다.
새 껍데기를 만들지 않는다. 본문은 `textContent` 로 넣는다 — 서버가 만든 진단
문자열이 마크업으로 해석되면 안 된다 (`_notify` 의 근거와 같다).

### 3.C 묶음 C — 전역 영어 툴팁

**FR-TIP-1** 앱의 **모든 `<button>`** 은 비어 있지 않은 `title` 속성을 갖는다.
대상은 `web/index.html` 의 정적 버튼과 `web/js/` 가 만드는 동적 버튼 전부다.

**FR-TIP-2** `title` 의 언어는 **영어**다. 기존 한국어 `title` 은 영어로 **교체**한다
(병기하지 않는다).

**FR-TIP-3** 화면에 보이는 나머지 글자(라벨·안내·오류)는 **바꾸지 않는다.** 이번
변경은 `title` 한 속성에 한정된다 — 접수한 말이 "호버하면 나오는 안내"이고, UI 전체를
영어화하라는 요구가 아니다.

**FR-TIP-4** `title` 문자열은 **상수 표에 산다.** 요소를 만드는 자리에 문자열
리터럴로 적지 않는다 — 기존 관습(`GIT_ACT_TITLE` 등)과 같다.

**FR-TIP-5** 뜻이 상태에 따라 갈리는 버튼은 그 상태를 반영한다. 이미 그런 자리가
둘 있으며 그 구조를 유지한다:

- `ours`/`theirs` — 진행 중 조작에 따라 뒤집힌다 (`GIT_SIDE_TITLE`, FR-GIT-224)
- 그룹별 폐기 — tracked 와 untracked 가 다른 명령이다 (`GIT_BULK_TITLE_GROUP`)

**FR-TIP-6** 자리지킴(FR-DBA-3)은 `<button>` 이 아니므로 이 요구의 대상이 아니다.

**FR-TIP-7 (회귀 방지)** e2e 검증이 다음 둘을 단정한다. 이것이 없으면 다음에 추가되는
버튼에서 또 빠진다.

1. 열려 있는 화면의 모든 `button` 이 비어 있지 않은 `title` 을 갖는다
2. 그 `title` 에 한글 음절(U+AC00–U+D7A3)이나 자모(U+3131–U+318E)가 없다

### 3.D 묶음 D — 서브모듈

**FR-SUB-1** 서버는 서브모듈 목록을 답하는 표면을 갖는다.

```
GET /api/git/submodules?repo=<abs>
→ 200 {
    "repo": "<정규화된 루트>", "requested": "<보낸 값>",
    "submodules": [
      {"path":"vendor/inner", "absPath":"/abs/.../vendor/inner",
       "oid":"8bb349b…", "state":"ok"|"uninitialized"|"modified"|"conflict",
       "describe":"heads/main", "url":"../inner"}
    ]
  }
```

**FR-SUB-2** 목록의 진실은 `git submodule status` 다. 상태는 그 접두 문자에서 온다.

| 접두 | `state` | 뜻 |
|---|---|---|
| ` ` (공백) | `ok` | 등록된 커밋과 체크아웃이 같다 |
| `-` | `uninitialized` | 초기화되지 않았다 (디렉터리가 비어 있다) |
| `+` | `modified` | 등록된 커밋과 다른 커밋에 있다 |
| `U` | `conflict` | 머지 충돌이 있다 |

`url` 은 `.gitmodules` 에서 온다. 없으면 빈 문자열이며 오류가 아니다.

**FR-SUB-3** `--recursive` 를 쓰지 않는다. 중첩된 서브모듈은 **그 서브모듈을 저장소로
연 뒤 그 창의 Submodules 탭**에서 보인다 — 한 목록에 깊이를 섞으면 어느 행이 누구의
것인지 말할 수 없다.

**FR-SUB-4** 서버는 서브모듈 쓰기 표면 둘을 갖는다.

```
POST /api/git/submodules/update  {repo, path, init:bool, recursive:bool, confirm:true}
     → git submodule update [--init] [--recursive] -- <path>
POST /api/git/submodules/sync    {repo, path, confirm:true}
     → git submodule sync -- <path>
```

`path` 가 비면 저장소의 서브모듈 전부가 대상이다.

**FR-SUB-5** `update` 는 **파괴적이다** — 서브모듈 안의 체크아웃을 등록된 커밋으로
옮기며, 그 안의 커밋되지 않은 변경이 있으면 git 이 거부하거나 덮는다. 그러므로
`GitConfirm` 의 파괴적 확인(2단계)을 거치고, 확인창은 대상 경로와 실행될 명령을
밝힌다. `sync` 는 `.gitmodules` 의 URL 을 `.git/config` 로 옮길 뿐이라 1단계다.

**FR-SUB-6** Git 창에 고정 탭 **Submodules** 가 선다. `GIT_VIEWS` 와
`GIT_SIDE_ACTIONS` 에 함께 더한다 — 두 자리가 다른 목록을 말하지 않는다.

**FR-SUB-7** 탭의 골격과 규약은 **Worktrees 탭과 같다** (`worktrees.js`):
머리에 일괄 버튼, 그 아래 안내 줄, 그 아래 `reconcileList` 로 그리는 목록.
새 규약을 만들지 않는다.

**FR-SUB-8** 행이 보이는 것: 경로 · 상태 배지 · 등록된 커밋 앞 7자 · `describe`.
행이 갖는 동작:

| 동작 | 조건 | 결과 |
|---|---|---|
| `open` | `state !== 'uninitialized'` | `openGitWindow(absPath)` — 그 서브모듈의 Repo 창 |
| `init` | `state === 'uninitialized'` | `update` 를 `init:true` 로 |
| `update` | `state !== 'uninitialized'` | `update` 를 `init:false` 로 |
| `sync` | 언제나 | `sync` |
| `term` | `state !== 'uninitialized'` | 그 경로에서 터미널 (FR-GIT-244 와 같은 경로) |

초기화되지 않은 서브모듈에 `open` 을 붙이지 않는 이유는 열 저장소가 없기 때문이다 —
눌리지만 아무 일도 하지 않는 버튼은 고장으로 읽힌다 (FR-GIT-180).

**FR-SUB-9** 머리의 일괄: `update --init` 전부 · `sync` 전부. 서브모듈이 없으면
비활성이다 (FR-WBR-53 과 같은 근거).

**FR-SUB-10** 서브모듈이 없는 저장소에서 탭은 그 사실을 말한다. 탭 자체는 숨기지
않는다 — 고정 탭은 생성·삭제되지 않는다 (FR-GIT-28).

**FR-SUB-11** Changes 탭의 서브모듈 디렉터리 행(FR-DIR-20)에서 **Submodules 탭으로
가는 길**이 있다. 우클릭 메뉴에 한 줄이며, 새 버튼을 행에 더하지 않는다 — 행의
동작 묶음은 열 정렬(FR-DBA-3)의 대상이고 거기에 예외를 만들면 정렬이 깨진다.

### 3.E 묶음 E — 워크트리

**FR-WTG-1 (확정이 먼저다)** 구현에 앞서 다음을 **실측으로 확정한다.** 결과를
본 문서 §2 에 적고, 그 뒤에 FR-WTG-2 이후의 범위를 정한다.

| 확인할 것 | 방법 |
|---|---|
| Worktrees 탭의 `open` 이 그 워크트리의 Repo 창을 실제로 여는가 | e2e — 워크트리를 만들고 `open` 을 눌러 창의 루트와 Changes 목록을 본다 |
| `+ Add` 로 워크트리 경로를 넣으면 저장소로 서는가 | e2e — `/api/editors/add` 뒤 그 창의 상태 |
| 그 창의 Changes·History·Branches·Worktrees 가 **워크트리 기준**으로 답하는가 | 각 탭의 응답 `repo` 필드 |
| detached 워크트리에서 머리가 무엇을 보이는가 | HEAD 표시 (`oid` 앞 7자) |

**§2.5 의 실측은 서버가 정상임을 이미 보였다.** 따라서 FR-WTG-1 이 재현하지 못하면
남는 요구는 FR-WTG-2·3 (진입점)뿐이며, **그 경우 "고쳤다" 고 보고하지 않는다.**

**FR-WTG-2** 워크트리 행의 `open` 은 그것이 하는 일을 라벨과 툴팁으로 밝힌다 —
"열기" 가 무엇을 여는지가 지금 이름에서 보이지 않는다. 툴팁은
"Open this worktree as its own repository window" 의 뜻을 갖는다 (FR-TIP-2).

**FR-WTG-3** 워크트리 행에 **핀 동작이 이미 있다** (`pin`/`unpin`, FR-GIT-249).
좌측 GIT 섹션에 워크트리를 세우는 길은 그것이므로 **새로 만들지 않는다.**

**FR-WTG-4** FR-WTG-1 이 결함을 재현하면, 그 결함마다 요구를 **본 절에 추가한 뒤**
고친다. 재현 없이 고치지 않는다.

---

## 4. 비기능 요구사항 (Non-Functional Requirements)

**NFR-SRT-1** FR-SRT-1 의 `docker info` 는 **3초** 안에 끝난다. 넘으면 `stopped` 로
답한다 — 데몬이 응답하지 않는 것도 사용자에게는 실행 중이 아닌 것이다.

**NFR-SRT-2** FR-SRT-7 의 폴링은 **2초 주기, 최대 60초**다. Docker Desktop 의 기동은
수십 초가 걸린다(실측 범위 밖의 환경 값이므로 상한을 넉넉히 둔다).

**NFR-SRT-3** FR-SRT-1 은 샌드박스 버튼을 누르는 순간에만 돈다. **상주 폴링을 만들지
않는다** — `docker info` 는 싼 호출이 아니다 (D-FLW-3 과 같은 근거).

**NFR-SUB-1** FR-SUB-1 은 Submodules 탭이 열려 있는 동안에만 돈다. Changes 폴링에
업지 않는다 — 서브모듈 목록은 파일 저장마다 바뀌는 값이 아니다.

**NFR-TIP-1** FR-TIP-1 의 검증은 e2e 에서 **한 번에 화면 전체**를 훑는다. 버튼마다
케이스를 쓰지 않는다.

**NFR-DBA-1** FR-DBA-3 의 자리지킴은 레이아웃 계산을 늘리지 않는다 — 기존
`.git-file-act` 와 **같은 치수의 빈 요소**이며 새 CSS 규칙을 최소로 둔다.

---

## 5. 설계 결정 (Design Decisions)

**D-1 (묶음 A)** 폴더 동작 표를 파일 동작 표에서 **파생시킨다.**

```js
const GIT_DIR_ACTS=Object.fromEntries(
  Object.entries(GIT_ROW_ACTS).map(([k,v])=>[k,v.filter(a=>a!=='openFile')]));
```

두 표를 따로 적으면 파일 행에 동작이 하나 늘 때 폴더 행이 조용히 뒤처진다. 지금이
바로 그 상태다 (§2.1). `conflicts` 의 `ours`/`theirs` 는 폴더 단위로 뜻이 성립하지
않으므로 그 그룹만 명시적으로 빈 배열로 덮는다 — 예외가 하나면 예외만 적는다.

**D-2 (묶음 A)** 열 정렬을 CSS `grid` 가 아니라 **자리지킴 요소**로 낸다. grid 로
하면 그룹마다 열 수가 달라 템플릿을 그룹별로 두어야 하고, 그것은 표를 다시 두 벌로
만든다. 자리지킴은 D-1 의 파생과 같은 자리에서 계산된다.

**D-3 (묶음 B)** 런타임 판정을 **서버에 둔다.** 화면이 `navigator.platform` 으로
OS 를 재는 길도 있으나, 그것은 브라우저의 OS 이지 **dongminal 이 도는 호스트의
OS 가 아니다** — 원격에서 접속하면 둘이 다르다. docker 가 도는 곳은 서버 쪽이다.

**D-4 (묶음 B)** `state` 를 셋으로 둔다. 넷째(`ok` 이지만 프로파일이 없음)를 만들지
않는다 — 그 경우는 이미 FR-SPK-7 이 다룬다 (설정으로 가는 길).

**D-5 (묶음 B)** linux 에서 서버가 데몬을 띄우지 않는다 (FR-SRT-3 근거 참조).

**D-6 (묶음 C)** `title` 속성을 쓴다. 커스텀 툴팁 컴포넌트를 만들지 않는다.
접수한 말이 "오래 호버하면" 이고 그것이 곧 브라우저 기본 `title` 의 동작이다.
컴포넌트를 만들면 상수 표가 두 벌이 되고, 터미널 위에 뜨는 오버레이가 xterm 의
포인터 처리와 겹친다.

**D-7 (묶음 C)** 한국어 title 을 **교체**한다 (병기 아님). 인터뷰에서 확정했다.
UI 나머지 글자는 그대로다 (FR-TIP-3) — 한 번의 요청이 UI 전체의 언어를 바꾸는 결정이
될 수는 없다.

**D-8 (묶음 D)** `GIT_DIR_ENTRY_SRS` §7 비목표 2 를 **해제한다.** 그 문서가 조작을
비목표로 둔 근거는 "그 마일스톤의 범위가 표시였다" 이지 "조작이 위험하다" 가 아니다.
본 문서가 그 범위를 명시적으로 넓히며, 두 문서가 충돌하지 않도록 여기에 적는다.

**D-9 (묶음 D) — 정정 (2026-09-06).**

> **초안의 D-9 는 틀렸다.** "`submodule` 은 `status`(읽기)와 `update`·`sync`(쓰기)가
> **다른 하위 명령**이라 교집합-금지 불변식을 깨지 않는다" 고 적었으나, 화이트리스트는
> **`argv[0]` 으로 판정한다** (`core/write.go:53` `writeCommands[argv[0]]`,
> `core/guard.go:19` `readCommands`). `git submodule status` 와 `git submodule update`
> 는 **argv[0] 이 똑같이 `submodule`** 이다 — 즉 한 하위 명령에 읽기와 쓰기가 함께 있다.
>
> 이는 worktree 가 별도 Manager 로 빠진 것과 **정확히 같은 상황**이다
> (`handlers_git_worktree.go:14`: "한 하위 명령에 읽기(list)와 쓰기(add·remove)가
> 함께 있다"). 초안은 그 선례를 잘못 읽었다.

**정정된 결정:** 서브모듈은 **별도 도메인 패키지**(`internal/webserver/domain/submodule`)를
갖는다. `domain/git` 의 두 허용 목록 중 어느 쪽도 건드리지 않으므로 FR-GIT-95 의
교집합-금지가 그대로 유지된다.

고려했다가 버린 대안:

| 대안 | 버린 이유 |
|---|---|
| 허용 목록을 `argv[0]+argv[1]` 조합으로 확장 | 두 목록의 판정 규칙 자체를 바꾼다. 그 규칙에 기대는 곳이 `IsWriteCommand`(Console 이 쓰기를 감추는 기준)를 포함해 여럿이라, 서브모듈 하나 때문에 저장소 전체의 불변식을 흔든다 |
| `submodule status` 를 쓰지 않고 상태를 직접 계산 (`ls-files -s` 의 gitlink + `.gitmodules`) | git 이 이미 답하는 것을 다시 구현하는 일이다 — `+`/`-`/`U` 판정 규칙이 두 벌이 되고, 어긋날 때 화면이 거짓을 말한다 |

**D-9a** 그 패키지는 worktree 와 같은 모양이다: `Runner` 주입(런타임 없이 파싱과
가드를 시험할 수 있어야 한다), 사유 열거, 경로 가드. 새 규약을 만들지 않는다.

**D-10 (묶음 D)** 서브모듈을 여는 것은 `openGitWindow` 다 — 워크트리와 **같은
경로**다. 연결 저장소를 여는 길이 둘이면 한쪽만 고쳐진다.

**D-11 (묶음 E)** 재현되지 않은 것을 고치지 않는다 (FR-WTG-1·4). 접수한 말이
추정형("~것 같다")이고 §2.5 의 실측이 서버 정상을 보였으므로, 여기서 무엇인가를
바꾸면 사용자가 겪은 것과 다른 것을 바꾸게 된다.

---

## 6. 검증 (Verification)

| 요구 | 방법 | 자리 |
|---|---|---|
| FR-DBA-1·2 | 단위 — 파생 표가 그룹마다 기대한 배열인가 | e2e 안의 평가 |
| FR-DBA-3 | e2e — 파일 행과 폴더 행의 같은 `data-act` 버튼 `getBoundingClientRect().left` 가 같다 | `e2e/git-folder-stage.spec.ts` |
| FR-DBA-4 | e2e — 폴더 폐기가 확인창을 띄우고, untracked 문구가 tracked 와 다르다 | 같음 (F6·F7·F8) |
| FR-DBA-5 | e2e — 두 그룹에 같은 이름의 폴더가 있을 때 한쪽만 폐기된다 | 같음 (F6·F7) |
| FR-SRT-1·2 | Go 단위 — `LookPath`·실행을 주입해 세 상태를 만든다 | `internal/shared/sandbox/runtime_test.go` |
| FR-SRT-3 | Go 단위 — OS 별 명령 선택. linux 는 시도하지 않는다 | 같음 |
| FR-SRT-5·6·7 | e2e — 상태를 라우트 가로채기로 위조해 세 갈래를 본다 | `e2e/sandbox-runtime.spec.ts` |
| FR-SRT-7 (이어짐) | e2e — `ok` 로 바뀌면 프로파일 선택창이 저절로 뜬다 | 같음 |
| FR-TIP-1·2·7 | e2e — **열다섯 표면**을 훑는다: 기본 화면 · 설정 9탭 · Git 8뷰 · 트리 보기 · Explorer · 모바일 · 확인창 · 다이얼로그 · 충돌 상태 · 알림 센터 · 진단 오버레이 · 알림창 · 도구 닫기 확인 · 터미널 복사창 · diff 의 hunk | `e2e/tooltips.spec.ts` |
| FR-SUB-1·2 | Go 단위 — `submodule status` 출력 네 형태의 파싱 | `internal/webserver/domain/submodule/submodule_test.go` (D-9 정정에 따라 자리가 바뀌었다) |
| FR-SUB-4·5 | Go 단위 — argv 조립과 경로 가드 | `internal/webserver/domain/submodule/submodule_test.go` |
| FR-SUB-6~10 | e2e — 서브모듈 픽스처에서 탭·행·동작 | `e2e/git-submodules.spec.ts` |
| FR-SUB-11 | e2e — 서브모듈 디렉터리 항목에서 Submodules 탭으로 간다. 중첩 저장소에는 그 길이 없다 | 같음 (D9) |
| FR-SUB-8 (`open`) | e2e — 눌러서 열린 창의 루트가 서브모듈 경로다 | 같음 |
| FR-WTG-1 | e2e — §3.E 표의 네 가지 + 형제 목록·History | `e2e/git-worktree-repo.spec.ts` (§2.5.1 결과) |
| FR-WTG-2 | e2e — `open` 의 툴팁이 하는 일과 맞고, 옛 표현이 남아 있지 않다 | 같음 (E7) |
| FR-WTG-3 | **기존 시험이 이미 답한다** — `git-worktrees.spec.ts` 묶음 N(FR-GIT-249)이 핀 토글을 검증한다. "새로 만들지 않는다" 가 이 요구의 뜻이므로 그것이 그대로 도는 것이 곧 검증이다 | `e2e/git-worktrees.spec.ts` |
| FR-TIP-5 | e2e — 충돌 행의 `ours`/`theirs` 툴팁이 **서로 다르고** 각자 자기 이름을 담는다. 그룹별 폐기의 갈림은 `git-discard-all` D1 이 본다 | `e2e/tooltips.spec.ts` (C9) |

**검증 대상이 아닌 요구 둘.** 남겨 두는 것이 아니라 성격이 다르다.

| 요구 | 왜 시험이 없나 |
|---|---|
| **FR-TIP-4** (문자열은 상수 표에 산다) | 결과가 아니라 **구조**에 대한 요구다. 화면에서 관측되는 차이가 없으므로 e2e 로 잴 것이 없고, 정적 검사로 만들면 "상수 표" 의 정의를 코드로 다시 써야 한다 — 그 정의가 두 벌이 된다. 리뷰가 지킬 규약으로 둔다 |
| **FR-WTG-4** (재현되면 요구를 추가한 뒤 고친다) | **절차**에 대한 요구다. §2.5.1 에서 아무것도 재현되지 않았으므로 발동하지 않았다 |

**픽스처**

- 서브모듈: 부모 저장소 + 등록된 서브모듈 둘 — 하나는 초기화됨(`ok`), 하나는
  초기화되지 않음(`-`). §2.5 의 구성 절차를 그대로 쓴다
- 워크트리: 저장소 + 브랜치 워크트리 하나 + detached 워크트리 하나
- 폴더 폐기: 한 폴더 아래에 tracked 변경과 untracked 파일이 **함께** 있는 상태

---

## 7. 비목표 (Non-Goals)

1. **UI 전체의 영어화.** `title` 만이다 (FR-TIP-3).
2. **커스텀 툴팁 컴포넌트.** 브라우저 기본 `title` 이다 (D-6).
3. **컨테이너 런타임의 설치를 서버가 대신 실행하는 것.** 명령을 보이고 복사시킬 뿐이다.
   설치는 권한과 패키지 관리자를 건드리며, 실패 복구가 이 앱의 몫이 될 수 없다.
4. **linux 데몬 기동의 자동화** (D-5).
5. **런타임 상태의 상주 감시** (NFR-SRT-3).
6. **서브모듈 안의 관측.** 부모의 배지·색이 서브모듈 내부 변경을 세지 않는다
   (GIT_DIR_ENTRY_SRS D-DIR-5 를 유지한다). 서브모듈 내부는 **그것을 저장소로 연 창**이
   본다.
7. **`submodule add`·`deinit`.** 저장소의 구성을 바꾸는 조작이며, 되돌리기가 사용자
   몫이 되는 범위다. 이번 요구는 "관리"(update·sync·열기)까지다.
8. **재귀 서브모듈 목록** (FR-SUB-3).
9. **워크트리 `owner` 판정의 변경** (§2.6).
10. **폴더 단위 `ours`/`theirs`.** 충돌 해결은 파일 단위의 판단이다 (FR-GIT-72).

---

## 8. 리스크 (Risks)

| # | 리스크 | 등급 | 완화 |
|---|---|---|---|
| R1 | 폴더 폐기가 의도보다 넓게 지운다 (untracked 는 파일 삭제) | **HIGH** | FR-DBA-4 의 2단계 확인 + 대상 수 표시. FR-DBA-5 로 그룹을 넘지 않음을 단정 |
| R2 | `title` 전역 교체가 기존 e2e 의 선택자를 깬다 | MEDIUM | 선택자로 쓰이는 `title` 을 먼저 조사한다. e2e 는 대부분 클래스·`data-*` 를 쓴다 |
| R3 | `docker info` 가 3초 안에 끝나지 않아 버튼이 굼떠 보인다 | MEDIUM | NFR-SRT-1 의 상한. 조회 중에는 버튼을 비활성으로 보인다 |
| R4 | `submodule update` 가 서브모듈의 미커밋 변경을 덮는다 | **HIGH** | FR-SUB-5 의 2단계 확인 + 실행될 명령 노출. git 자신도 거부하는 경우가 많다 |
| R5 | FR-WTG-1 이 아무 결함도 재현하지 못한다 | LOW | 그것이 정상 결과다 — D-11 대로 보고하고 진입점(FR-WTG-2)만 손본다 |
| R6 | 다섯 묶음이 한 번에 들어가 회귀 원인을 가리기 어렵다 | MEDIUM | 묶음별로 커밋을 나눈다. 각 묶음의 검증이 §6 에서 이미 분리돼 있다 |

---

## 8.1 구현하며 확정한 사실 (2026-09-06)

스펙을 쓸 때 몰랐거나 틀리게 적었던 것들이다. **실측으로 확정한 것만 적는다.**

| # | 사실 | 결과 |
|---|---|---|
| 1 | **D-9 가 틀렸다.** 화이트리스트는 `argv[0]` 으로 판정하므로 `submodule` 은 읽기·쓰기가 한 하위 명령에 있다 | §5 D-9 정정 — 별도 도메인 패키지로 갔다 (worktree 의 선례 그대로) |
| 2 | `Wire` 가 바이너리만 보므로 **데몬이 죽어도 `/api/sandbox/profiles` 는 정상 목록을 답한다** | §2.3 의 추정이 실측으로 확정됐다. 묶음 B 의 근거 |
| 3 | 이 호스트의 실제 데몬-정지 출력은 `failed to connect…` 이며, 기존 `runtimeDown()` 의 패턴(`cannot connect`)과 **매치되지 않는다** | FR-SRT-2 를 "알아보지 못한 실패도 `stopped`" 로 둔 결정이 이 케이스를 살렸다 |
| 4 | `worktree.execGit` 를 그대로 베껴 출력을 `TrimSpace` 했더니 `submodule status` 의 **`ok` 상태 줄이 전부 버려졌다** (첫 글자가 상태다) | 실측으로 잡았다. 주입 러너로는 볼 수 없는 자리라 `TestExecGitKeepsLeadingSpace` 가 실제 러너를 시험한다 |
| 5 | 쓰기 표면의 성공 판정은 HTTP 200 이 아니라 **본문의 `ok`** 다 (`panel-write.js:166`) | 서브모듈 핸들러가 빠뜨려 확인창이 닫히지 않았다 (실측) |
| 6 | 사이드 진입점이 `flex:1 1 0; min-width:0` 이라 **개수가 늘면 폭이 조용히 줄어든다** — 일곱째에서 28px 이 되어 FR-GIT-226 을 깼다 | `flex-wrap` + 하한 폭으로 고쳤다. 개수가 늘어도 견딘다 |
| 7 | 커밋·stash 버튼은 **같은 문자열을 title 과 화면 텍스트에 함께** 쓴다 | FR-TIP-2 와 FR-TIP-3 이 충돌한다 — `_why()` 가 **사유 코드**를 답하고 두 표가 각자 옮기게 갈랐다 |
| 8 | `GIT_WT_ACT_TITLE.open` 의 문구가 REPO_TAB_UNIFY_SRS FR-RTU-72 이전 표현("활성 리포로 엽니다")으로 남아 있었다 | FR-WTG-2 대로 고쳤다 — 묶음 E 가 실제로 바꾼 것은 이 한 줄이다 |
| 9 | 뷰 목록이 26개 spec 에 **하드코딩**돼 있어 탭 하나가 늘자 전부 깨졌다 | `GIT_BODY_VIEWS` 를 한 자리에 두고 `GIT_VIEW_TABS` 를 그 길이에서 파생시켰다 |
| 10 | **툴팁 검증이 "열려 있는 화면" 만 훑어 FR-TIP-1 이 미달이었다.** 띄워야 보이는 자리에서 구멍이 계속 나왔다 (아래 표) | 시험을 5개→**15개**로 넓혀 **각 표면을 실제로 띄워** 훑는다. `test.skip` 으로 둔 두 케이스가 그냥 건너뛰길래 상태를 만들어 열게 고쳤고, 그러자 둘 다에서 구멍이 나왔다 — **skip 은 검증이 아니다** |
| 11 | 꺼진 원격 버튼의 **사유가 title 을 덮는다** (`GIT_REMOTE_WHY_*`). 상태를 아직 못 읽은 순간에만 드러나므로 회차에 따라 보였다 안 보였다 한다 | 그 둘은 화면에 글자로 서는 자리가 없는 **툴팁 전용**이라 영어로 옮겼다. 이런 종류는 한 번 통과했다고 끝이 아니므로 툴팁 시험을 3회 반복해 안정성을 확인했다 |

**탭이 늘어 갱신한 단정 2건** (둘 다 개수를 세던 자리다):

| 시험 | 이전 | 지금 | 근거 |
|---|---|---|---|
| `repo-tab` W4 | `.ed-side-act` 6개 | **7개** | `GIT_SIDE_ACTIONS` 에 Submodules 가 더해졌다 (FR-SUB-6) |
| `repo-tab` N4 | 폴더 행 동작 1개 | **2개** | FR-DBA-1 로 `discard` 가 붙었다. 자리지킴은 `.git-file-act` 가 아니라 세지 않는다 |

N4 의 **핵심 단정은 개수가 아니라 "좁은 폭에서 버튼이 사이드를 넘지 않는가"** 이며,
버튼이 둘이 된 뒤에도 하한 100px 까지 통과한다 (실측).

### 8.2 FR-TIP-1 이 미달이었던 자리 (전부 메웠다)

"모든 버튼" 이라는 요구를 처음 구현했을 때 훑은 것은 **바로 보이는 화면**뿐이었다.
띄워야 보이는 자리마다 구멍이 있었고, 시험을 넓힐 때마다 새로 드러났다.

| 표면 | 무엇이 없었나 | 왜 중요한가 |
|---|---|---|
| 모바일 화면 | `drawer-close`·키바 `⌨` 가 한국어 | `⌨` 는 같은 표의 나머지 15개가 이미 영어였다 — 표의 일관성도 깨져 있었다 |
| **파괴적 확인창** | `Run`·`Cancel`·`Copy` 에 title 없음 | **승인 버튼이 무엇을 실행하는지 스스로 말하지 않았다** |
| 옵션 다이얼로그 | `Cancel`·실행 버튼에 title 없음 | 실행 라벨이 다이얼로그마다 달라 그것이 유일한 근거다 |
| 진행 중 조작 바 | `Continue`·`Abort` 가 한국어 | 머지·리베이스에서 나가는 유일한 길이다 |
| 진단 오버레이 | 5개 전부 title 없음 | |
| 알림 센터 | `모두 제거` title 없음 | |
| 알림창·도구 닫기 확인 | `확인`·`닫기`·`취소`·`저장 후 닫기`·`백그라운드로` title 없음 | 도구 세션을 끊는 자리다 |
| 터미널 복사창 | `복사`·`닫기` title 없음 | |
| **diff 의 hunk** | `Stage hunk`·`Revert hunk` 가 한국어 | `Revert hunk` 는 되돌릴 수 없는 조작이다 |
| 백그라운드 종료·Run 삭제 확인 | `예`·`아니오` title 없음 | 되돌릴 수 없는 조작의 승인이다 |
| 꺼진 원격 버튼 | 사유(`why`)가 한국어로 title 을 덮음 | 위 표 11번 |

**깨지는 e2e 는 미리 훑었다.** `toHaveAttribute('title', …)` 로 한국어를 단정하는
자리가 e2e 에 아홉 곳 더 있으나 **전부 `<button>` 이 아니다** — `.git-menu-item`(div) ·
목록 행 · 배지다. FR-TIP-1 의 대상이 아니고 FR-TIP-3 대로 한국어로 남으므로 깨지지
않는다. 실제로 깨진 둘(`git-remote-actions` E6 · `git-remote` R12)은 원격 버튼의
사유였고, 그 계약("꺼진 버튼이 왜 꺼졌는지 말한다", FR-GIT-101)은 그대로 둔 채
정규식만 영어로 옮겼다.

**플레이키 — 기준선을 재서 확정했다.**

전체 실행(chromium)을 네 번 돌렸고, 그중 한 번은 **본 변경을 전부 되돌린 상태**다.

| 회차 | 상태 | 결과 | 실패한 시험 |
|---|---|---|---|
| **기준선** | **변경 전 (stash)** | 1075 / **2 실패** | `sidebar-tabs` T6 · `slot-view-state` TC-SVS-50 |
| 1 | 변경 후 | 1104 / 5 실패 | `repo-tab` W4·N4(위 표대로 갱신) · `sidebar-tabs` T6 · `slot-live-refresh` · `git-branch-actions` |
| 2 | 변경 후 | 1106 / 3 실패 | `git-remote-actions` E1 · `git-worktrees` V150 · `slot-view-state` TC-SVS-50 |
| 3 | 변경 후 | 1113 / 2 실패 | `git-hunk` G4 · `git-ui-revision` V78 |
| 최종 | 변경 후 (시험 52개 추가 뒤) | 1124 / 5 실패 | `git-commit` E6 · `git-diff` D4 · `git-folder-stage` F6 · `git-worktrees` V146 · `slot-view-state` TC-SVS-50 |

**결론 두 가지.**

1. **변경이 없어도 전체 실행은 실패한다** (기준선 2건). 그 둘은 회차 1·2 에서도
   나타났다 — 즉 이 저장소 e2e 의 기존 성질이며 본 변경이 만든 것이 아니다.
2. **네 회차의 실패 집합에 공통 원소가 없다.** 갱신 대상이었던 `repo-tab` 둘을 뺀
   나머지는 전부 단독 재실행에서 통과한다 (`git-worktrees` 는 두 번 더, `git-hunk`·
   `git-ui-revision` 도 재실행해 확인했다 — 재실행에서는 **또 다른** 시험 V100 이
   떨어졌다).

통과 수가 1075 → 1124 로 는 것은 본 변경이 시험 52개를 더했기 때문이다.

**최종 회차도 같은 성질이다.** 다섯 중 넷이 재실행에서 통과했고, 남은 하나
(`TC-SVS-50`)는 **기준선에 있던 그것**이다. 특히 `git-folder-stage` 는 재실행에서
**다른 시험**(F6 → F2)이 떨어졌고 그 파일만 4회 연속 돌리면 10개가 모두 통과한다 —
파일 안의 특정 시험이 아니라 전체 실행에서의 간섭임을 보인다.

**확정하지 못한 것 하나를 적어 둔다.** 시험이 52개 늘어 전체 실행이 길어졌으므로
간섭의 기회도 늘었을 수 있다. 회차별 실패 수(2·5·3·2·5·2·6·5)에 그런 경향이 보이지만
표본이 작고 원인을 짚지 못했다 — **사실로 적지 않는다.**

무작위 실패의 원인은 본 SRS 의 범위가 아니다 — **확정하지 못한 것을 사실로 적지
않는다.**

## 9. 실행 순서

의존이 있는 것만 순서가 고정된다.

1. **A** (폴더 폐기·열 정렬) — 독립. 가장 작고 위험이 국소적이다
2. **E-1** (FR-WTG-1 실측) — 독립. 결과가 E 의 나머지 범위를 정한다
3. **B** (샌드박스 런타임) — 독립. 서버 표면 둘 + 모달 둘
4. **D** (서브모듈) — **A 뒤**. Changes 행의 진입점(FR-SUB-11)이 A 의 열 정렬을 딛는다
5. **C** (전역 툴팁) — **맨 뒤**. A·B·D 가 만든 새 버튼까지 한 번에 덮는다.
   앞에 두면 같은 일을 두 번 한다
