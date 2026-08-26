# SRS: 프로세스 축 패키지 재구성 — IEEE 29148

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

`internal/` 의 평평한 패키지 17개와 `web/js/` 의 평평한 파일 20개를 **프로세스
축**으로 재배치하고, 둘 이상의 프로세스가 실행하는 코드는 `shared/` 로 분리한다.
아울러 프로세스 경계 안에서 역할이 드러나도록 대형 패키지 3개(`server` 19,653줄,
`git` 10,936줄, `app.js` 2,999줄)를 역할별로 가른다.

근본 문제는 디렉터리가 평평하다는 것이 아니라 — **데몬 코어와 HTTP 서버가 한
패키지에 섞여 있어서 "이게 데몬인지 서버인지"를 디렉터리로 표현할 방법 자체가
없다는 것**이다.

`dongminald` 가 `internal/server` 에서 실제로 쓰는 심볼은 둘뿐이다:

```go
// cmd/dongminal/main.go:163,171
pm := server.NewToolManager(home, nil)      // internal/server/tool.go   1,140줄
ps := server.NewPanedServer(pm, sock, pid)  // internal/server/paned.go    483줄
```

76파일 중 **1,623줄**. 나머지 74파일(핸들러·git API·SSE·activity 배선)은 웹 서버
전용인데 같은 패키지에 있어서, 데몬 코드 경로가 `git`·`sysstat`·`worktree`·`run` 을
전부 끌고 온다. 이 경계를 먼저 갈라야 프로세스 축 배치가 성립한다.

### 1.2 범위 (Scope)

| 묶음 | 내용 | 리스크 |
|---|---|---|
| A | 데몬 코어 분리 — `toolhub`(ToolManager·PTY·attention 탐지) + `toolipc`(paned 와이어) 신설 | LOW |
| B | export 승격 13개 + `ToolHub` 인터페이스 이동 (묶음 A 의 귀결) | LOW |
| C | `internal/` 17패키지를 프로세스 축 4 + `shared/` 로 이동, import 경로 갱신 | LOW |
| D | `runDaemon()` 을 `main.go` 에서 `internal/daemon/boot` 로 분리 | LOW |
| E | `web/js/` 20파일을 `core`/`ui`/`git` 3폴더로 이동, `git-` 접두어 제거 | LOW |
| F | 참조처 갱신 — `index.html`, `embed.go`, e2e 3개, README, architecture.md | LOW |
| G | README 에 e2e 실행 절차 추가, `build.sh` 주석 | LOW |
| H | `server` 잔여 74파일을 `httpapi`/`gitapi`/`hub` 3패키지로 분할. git 핸들러 48개를 `*GitServer` 메서드로 이관 | **MEDIUM** |
| I | `git` 54파일을 `core`/`query`/`write`/`store`/`jobs` 5패키지로 분할. `*Service` 메서드 47개를 자유 함수로 전환 | **HIGH** |
| J | `app.js` 단일 `class App`(159 메서드)을 프로토타입 증강으로 14파일로 분할 | LOW |

**미포함:** §5 비목표 참조.

### 1.3 정의 (Definitions)

| 용어 | 정의 |
|------|------|
| **프로세스 역할** | 단일 바이너리가 `main()` 의 분기로 취하는 네 가지 실행 형태. `main.go:317-335` |
| **① helper CLI** | `argv[0]` basename 이 `dmctl`/`edit`/`download`/`detach`. `runtimebin.Dispatch` |
| **② 데몬** | `dongminal d` 또는 `argv[0]=="dongminald"`. `runDaemon()`. PTY 소유 + Unix socket |
| **③ 웹 서버** | `dongminal start --foreground`. `serve()`. HTTP/WS/SSE |
| **④ 제어 CLI** | `start`/`stop`/`health`/`migrate`. `cli.Dispatch` |
| **공유 (shared)** | **둘 이상의 프로세스 역할이 실제로 실행**하는 코드. 단일 바이너리이므로 링크 클로저는 전부 동일하다 — 링크 여부가 아니라 실행 여부로 판정한다 |
| **메서드-패키지 제약** | Go 는 타입 `T` 의 메서드를 `T` 를 선언한 패키지에만 둘 수 있다. 이 제약이 묶음 H·I 의 형태를 결정한다 |
| **프로토타입 증강** | `Object.assign(App.prototype, { … })` 로 클래스 본문 밖에서 메서드를 얹는 것. 모듈 시스템 없이 클래스를 파일로 가르는 유일한 무동작변경 경로 |
| **읽기 초크포인트** | `git.Service.Exec` — `guardArgs` 로 `readCommands` 화이트리스트를 통과시키고 타임아웃·출력상한·기록을 적용한다 |
| **쓰기 초크포인트** | `git.Service.ExecWrite` — `guardWriteArgs` 를 적용한다. `Exec` 와 별개 경로다 (`write.go:98`) |

### 1.4 참고 (References)

- `cmd/dongminal/main.go` — `main()`, `runDaemon()`, `serve()`, `buildDeps()`, `buildDepsWithHub()`
- `internal/server/` — `tool.go`, `paned.go`, `tool_client.go`, `attention.go`, `deps.go`, `server.go`
- `internal/git/` — `exec.go`(Exec), `write.go`(ExecWrite), `store.go`, `job.go`
- `web/index.html:158-177` — `<script>` 로드 순서
- `web/embed.go:9` — `go:embed` glob
- `README.md` §프로젝트 구조, `docs/internal/architecture.md`

---

## 2. 현황 (Current State)

### 2.1 프로세스 × 패키지 실행 행렬

`grep` 으로 실사용처를 확인한 결과다. ● = 실행, ○ = 링크만.

| 패키지 | ① helper | ② 데몬 | ③ 웹서버 | ④ 제어 | 판정 |
|---|:--:|:--:|:--:|:--:|---|
| `workspace` | ● | ● | ● | | **공유(3)** |
| `uuid` | | ●¹ | ● | ●² | **공유(3)** |
| `runtime` | | ● | ● | | **공유(2)** |
| `outbuf` | | ●¹ | ●¹ | | **공유(2)** |
| `agentadapter` | ● | | ● | | **공유(2)** |
| `server` | | ●*(2심볼)* | ●*(전체)* | | **분할 필요** |
| `runtimebin` | ● | | ○³ | | ① 전용 |
| `toolline` | ● | | | | ① 전용 |
| `git` | | | ● | | ③ 전용 |
| `sysstat` | | | ● | | ③ 전용 |
| `worktree` | | | ● | | ③ 전용 |
| `run` | | | ● | | ③ 전용 |
| `adapters` | | | ● | | ③ 전용 |
| `toolaccess` | | | ● | | ③ 전용 |
| `clientpid` | | | ●¹ | | ③ 전용 |
| `cli` | | | | ● | ④ 전용 |
| `migrate` | | | | ● | ④ 전용 |

¹ `server/tool.go`(ToolManager) 또는 `adapters/client.go` 경유
² `migrate` 경유
³ `runtime/install.go:34` 가 `HelperNames()` 로 심링크 이름만 받는다 — 코드 실행 아님

**근거:**
- `workspace` ① — `runtimebin/dmctl_listworkspace.go` / ② — `main.go:145` `ReferencedToolIDs`
- `agentadapter` ① — `dmctl_activity.go`, `dmctl_run.go` / ③ — `handlers_status.go`
- `runtime` ② — `main.go:157` / ③ — `main.go:365`
- `outbuf` — `server/tool.go` 단일 사용처 · `clientpid` — `adapters/client.go` 단일 사용처

### 2.2 데몬 코어 분리 실측 (묶음 A·B)

스크래치 사본에서 `tool.go`+`paned.go`+`tool_client.go`+`attention.go` 탐지부를
별도 패키지로 옮기고 컴파일해 측정했다.

**역방향 의존 = 0.** 분리 후보는 독립 빌드된다. 외부 의존은 `outbuf`, `uuid`,
`creack/pty`, `gorilla/websocket` 뿐이다 (`paned.go` 는 표준 라이브러리만 import).

**`attention.go` 는 갈라야 한다.** 180줄 중 1~155행(OSC 탐지, 순수 함수)만 `tool.go`
가 참조하고, 156~180행(`toolAttentionPayload`, `toolAttentionClearPayload`,
`WireAttention`)은 서버 배선이다.

**export 승격 대상 13개** (`go build -gcflags=-e` 전량 수집):

| 심볼 | 정의 | 서버측 사용처 | 성격 |
|---|---|---|---|
| `safeConn` | `tool.go:55` | `handlers_ws.go` | 브라우저 WS 헬퍼 |
| `newSafeConn` | `tool.go:61` | 〃 | 〃 |
| `upgrader` | `tool.go:47` | 〃 | 〃 |
| `pongWait` | `tool.go:42` | 〃 | 〃 |
| `pingPeriod` | `tool.go:43` | 〃 | 〃 |
| `activityState` | `tool.go:451` | `attn_tracker.go`, `handlers_status.go` | activity 타입 |
| `activitySnap` | `tool.go:458` | `attn_tracker.go`, `handlers_api.go` | 〃 |
| `detectAttentionSignal` | `attention.go:66` | `tool.go` | attention 탐지 |
| `attentionIdleThreshold` | `attention.go:34` | 〃 | 〃 |
| `attnMaxCarry` | `attention.go:21` | 〃 | 〃 |
| `panedRequest` | `paned.go` | `tool_client.go` | IPC 와이어 |
| `panedResponse` | 〃 | 〃 | 〃 |
| `panedError` | 〃 | 〃 | 〃 |

**이동 대상 인터페이스**: `ToolHub`(`deps.go:15`) → `shared/toolhub`.

**접두어만 붙이면 되는 것 11개**: `Tool`, `ToolManager`, `ToolSnapshot`, `ToolClient`,
`BackgroundEntry`, `ParseSize`, `OpInput`, `OpOutput`, `OpResize`, `OpExit`, `OpError`,
`OpToolID`.

### 2.3 메서드-패키지 제약 실측 (묶음 H·I 의 근거)

**이것이 묶음 H·I 를 "파일 이동"이 아니라 "코드 변경"으로 만드는 사실이다.**

#### 2.3.1 `server` — `*Server` 메서드 123개

| 파일 | 메서드 | 파일 | 메서드 |
|---|---:|---|---:|
| `handlers_api.go` | 25 | `handlers_git_branch.go` | 4 |
| `handlers_runs.go` | 13 | `server.go` | 4 |
| `handlers_git.go` | 12 | `handlers_ws.go` | 3 |
| `handlers_git_write.go` | 10 | `handlers_git_policy.go` | 3 |
| `handlers_git_stash.go` | 8 | `handlers_git_history.go` | 3 |
| `handlers_git_remote.go` | 8 | `git_pins.go` | 3 |
| `handlers_status.go` | 7 | `focus.go` | 3 |
| `handlers_toolio.go` | 6 | `commands.go` | 3 |
| `handlers_runs_worktree.go` | 6 | `handlers_whoami.go` | 1 |
| | | `handlers_git_records.go` | 1 |

**git 핸들러 48개**(`handlers_git*.go` 8파일 + `git_pins.go`)가 전부 `*Server`
메서드다. 별도 패키지로 떼려면 리시버를 바꿔야 한다.

git 핸들러가 실제로 쓰는 `Server` 표면은 좁다 — `s.Git`(86회), `s.Work`(7회), 그리고
git 전용 헬퍼 6개(`gitResolveRepo`·`gitRepoParam`·`gitStatusBefore`·`gitJobs`·
`gitApply`·`gitPinsMutate`). `GitServer` 타입에 이만 담으면 갈린다.

**`hub` 후보는 리시버 변경이 필요 없다.** `commands.go`·`focus.go` 의 `*Server`
메서드 6개는 전부 HTTP 종단이다:

```
focus.go:153,169,180      broadcastFocusOwners, apiFocusGet, apiFocusClaim
commands.go:252,301,382   handleCommandSSE, handleCommandPost, handleCommandResult
```

이 6개를 `httpapi` 에 남기고 `CommandHub`·focus 상태 로직만 `hub` 로 보내면 된다 —
두 파일을 각각 둘로 가르는 것으로 해결된다.

#### 2.3.2 `git` — `*Service` 메서드 47개가 18파일에 분산

`Jobs`·`Store` 는 `*Service` 를 **주입받아 보유**하므로 단방향으로 나갈 수 있다:

```go
// store.go:34   type Store struct { svc *Service; … }
// job.go:130    type Jobs  struct { svc *Service; … }
```

추출 실험 결과 필요한 export 승격은 5개다:

| 패키지 | 미해결 심볼 | 승격 필요 |
|---|---|---|
| `store` | `readSignature`, `Service`, `Signature`, `Status` | `readSignature` |
| `jobs` | `gitEnv`, `guardWriteArgs`, `sanitizeArgv`, `sanitizeRemote`, `Service`, `Output`, `WriteSpec`, `ErrGitMissing`, `ErrTimeout`, `ErrUnsafeArgument`, `DefaultStderrTailLines` | `gitEnv`, `guardWriteArgs`, `sanitizeArgv`, `sanitizeRemote` |

`store`(283줄) + `jobs`(619줄) = 902줄. 전체 10,936줄의 **8%** 다. 나머지 9,000줄을
가르려면 `*Service` 메서드 47개를 자유 함수로 전환해야 한다 (묶음 I).

#### 2.3.3 읽기/쓰기 초크포인트가 이미 둘로 갈려 있다

묶음 I 의 `query`/`write` 축은 없던 경계를 발명하는 것이 아니다. 현행 설계에 이미
독립된 두 진입점이 있다:

| 초크포인트 | 정의 | 가드 | 우회 경로 |
|---|---|---|---|
| `Service.Exec` | `exec.go:88` | `guardArgs` → `readCommands` 화이트리스트 | `exec.go:75` 내부 러너뿐 |
| `Service.ExecWrite` | `write.go` | `guardWriteArgs` | `write.go:98` 내부 러너뿐 |

`execGit` 직접 호출은 이 두 곳의 내부 러너뿐이다. 즉 `query/` 함수는 `Exec` 를,
`write/` 함수는 `ExecWrite` 를 받으므로 **초크포인트가 분할 후에도 유지된다**.
이것이 묶음 I 의 리스크를 실질적으로 낮춘다.

### 2.4 `app.js` 실측 (묶음 J)

**단일 `class App`, 2,999줄, 159 메서드.** 접두어가 주제 뭉치를 그대로 드러낸다:
`_attn*` 20, `_git*` 22, 창/탭/분할 20, 포커스 14, 상태바 11, `_agents*` 9, 설정 9,
모바일 7, 검색 7, 도구 생명주기 11, 원격 커맨드 7, 프리셋 7, 드래그앤드롭 5.

**프로토타입 증강 차단 요인 확인 결과:**

| 항목 | 결과 | 판정 |
|---|---|---|
| `#` private 필드 | 4곳 전부 CSS 선택자 문자열 (`#windows`, `#area`, `#app`) | **차단 없음** |
| getter/setter | 11개 실재 — `displayMode`, `mobileBreakpoint`, `isMobile`(38~59행), `attnDesktop`, `attnSound`, `agentsPollMs`(698~703행) | **본체 유지 필요** |
| `for…in` 프로토타입 순회 | `web/js/` 전체에 없음 | enumerable 차이 무해 |
| `static` 멤버 | 없음 | 차단 없음 |
| 기반 클래스(`super`) | 없음 | 차단 없음 |

`Object.assign` 은 getter 를 **값으로 복사**하므로 접근자 11개는 `app.js` 클래스
본문에 남긴다.

### 2.5 npm 사용 현황 (묶음 G 근거)

`package.json` 의 name 은 `dongminal-e2e`, devDependencies 는 `@playwright/test`
하나다. 프론트엔드는 번들러가 없고 `web/vendor/xterm.js` 는 저장소에 커밋되어
있으므로 **빌드에 npm 이 필요 없다** — `scripts/build.sh` 의 `go build` 단독 구성은
옳다.

결손은 다른 데 있다: **e2e 실행 절차가 `README.md`·`docs/` 어디에도 없다.**
`playwright.config.ts` 의 `webServer.command` 는 `go run ./cmd/dongminal start
--foreground` 라 빌드 산출물조차 쓰지 않는다.

---

## 3. 요구사항 (Requirements)

### 3.1 묶음 A — 데몬 코어 분리

**FR-SPL-1** `internal/shared/toolhub` 신설. 구성: `tool.go`(ToolManager·PTY·브라우저
WS), `attention.go` 탐지부(현 1~155행).

**FR-SPL-2** `internal/shared/toolipc` 신설. 구성: `paned.go` 의 와이어 타입
(`PanedRequest`, `PanedResponse`, `PanedError`, `Op*` 상수)만.

**FR-SPL-3** `paned.go` 의 `PanedServer`(서버측 accept 루프) → `internal/daemon/ipc`.
② 전용이다.

**FR-SPL-4** `tool_client.go` 의 `ToolClient`(클라측 dial·재접속) →
`internal/webserver/ipc`. ③ 전용이다.

**FR-SPL-5** `attention.go` 배선부(현 156~180행) → `internal/webserver/hub`.

**FR-SPL-6** `toolhub` 는 `webserver/**`·`daemon/**` 를 import 하지 않는다. 허용
의존은 `shared/outbuf`, `shared/uuid`, `creack/pty`, `gorilla/websocket` 뿐이다.

### 3.2 묶음 B — export 승격

**FR-EXP-1** §2.2 표의 심볼 13개를 export 로 승격한다. 이름 규칙은 선두 대문자화이며
축약형을 풀어쓰지 않는다 (`attnMaxCarry` → `AttnMaxCarry`).

**FR-EXP-2** `ToolHub` 인터페이스를 `deps.go` 에서 `shared/toolhub` 로 옮긴다.

**FR-EXP-3** 승격은 **이름 변경만**이다. 시그니처·본문·동작을 바꾸지 않는다.

### 3.3 묶음 C — 프로세스 축 배치

**FR-DIR-1** 목표 트리 (묶음 H·I 반영 후 최종형):

```
internal/
├── helper/                 ① dmctl/edit/download/detach 프로세스
│   ├── runtimebin/         ← internal/runtimebin
│   └── toolline/           ← internal/toolline
│
├── daemon/                 ② dongminald 프로세스
│   ├── boot/               ← main.go 의 runDaemon()            (묶음 D)
│   └── ipc/                ← server/paned.go 서버측            (FR-SPL-3)
│
├── webserver/              ③ 웹 서버 프로세스
│   ├── httpapi/            ← server 잔여 (핸들러·라우팅·배선)   (묶음 H)
│   ├── gitapi/             ← handlers_git*.go + git_pins.go     (묶음 H)
│   ├── hub/                ← CommandHub·SSE·attention·activity·focus 상태 (묶음 H)
│   ├── ipc/                ← server/tool_client.go              (FR-SPL-4)
│   ├── seam/
│   │   ├── adapters/       ← internal/adapters
│   │   ├── toolaccess/     ← internal/toolaccess
│   │   └── clientpid/      ← internal/clientpid
│   └── domain/
│       ├── git/            ← internal/git                       (묶음 I)
│       │   ├── core/       Service·exec·guard·errors·record
│       │   ├── query/      조회 (Exec 초크포인트)
│       │   ├── write/      변경 (ExecWrite 초크포인트)
│       │   ├── store/      TTL + single-flight 캐시
│       │   └── jobs/       잡 큐
│       ├── run/            ← internal/run
│       ├── worktree/       ← internal/worktree
│       └── sysstat/        ← internal/sysstat
│
├── ctl/                    ④ 제어 CLI 프로세스
│   ├── cli/                ← internal/cli
│   └── migrate/            ← internal/migrate
│
└── shared/                 둘 이상의 프로세스가 실행
    ├── workspace/          ①②③ — 유일한 3-프로세스 공유
    ├── toolhub/            ②③  — 신설 (FR-SPL-1)
    ├── toolipc/            ②③  — 신설 (FR-SPL-2)
    ├── outbuf/             ②③
    ├── runtime/            ②③
    ├── uuid/               ②③④
    └── agentadapter/       ①③
```

**FR-DIR-2** 이동은 `git mv` 로 수행해 이력을 보존한다.

**FR-DIR-3** 디렉터리명과 패키지명을 일치시킨다. 묶음 H 로 `server` 가 세 패키지로
갈리므로 `net/http` 와 충돌하는 이름이 생기지 않고 import alias 도 불필요하다.

**FR-DIR-4** `runtime/shellhooks`·`runtime/agentplugin` 의 `go:embed` 대상 파일은
`shared/runtime/` 하위로 함께 이동한다. embed 경로는 패키지 상대이므로 glob 수정
불필요.

### 3.4 묶음 D — 데몬 부팅 분리

**FR-BOOT-1** `main.go` 의 `runDaemon()`(153~199행)과 `referencedTools()`(137~151행)를
`internal/daemon/boot` 로 옮기고 `boot.Run(home)` 으로 노출한다.

**FR-BOOT-2** `main()` 의 데몬 분기는 `boot.Run(home)` 한 줄이 된다. 분기 조건은
`main()` 에 남긴다 — 진입점 판별은 composition root 의 책임이다.

**FR-BOOT-3** `startDaemon()`(자식 spawn)은 `main.go` 에 남는다. ③ 이 ② 를 띄우는
코드이지 ② 자신의 코드가 아니다.

### 3.5 묶음 E — `web/js` 재배치

**FR-JS-1** 목표 트리:

```
web/js/
├── core/    constants.js  helpers.js  main.js
│             app.js  app-*.js (13개)                (묶음 J)
├── ui/      themes.js  renderer.js  term-pane.js
│             input-binding.js  file-editor.js
└── git/     panel.js  history.js  branches.js  remote.js  commit.js
             stash.js  dialog.js  confirm.js  menu.js  lanes.js  console.js
```

**FR-JS-2** `git-` 접두어를 제거한다. 폴더가 이미 그 정보를 담는다.

**FR-JS-3** `index.html` 의 `<script>` 순서를 **바꾸지 않는다**. 경로만 갱신하고
`?v=146` → `?v=147`. 묶음 J 의 `app-*.js` 는 `app.js` **직후**, `main.js` 앞에 넣는다.

**FR-JS-4** `web/embed.go:9` 의 glob `js/*.js` → `js/*/*.js`. 고치지 않으면 매칭
0건으로 **빌드가 실패한다** (`go:embed` 는 빈 매칭을 오류로 본다).

### 3.6 묶음 F — 참조처 갱신

**FR-REF-1** e2e 스펙 3곳:

| 파일 | 현재 | 변경 |
|---|---|---|
| `e2e/git-remote.spec.ts:387` | `request.get('/js/git-remote.js')` | `'/js/git/remote.js'` |
| `e2e/git-history.spec.ts:144` | `['web/js/git-history.js', 'web/js/git-lanes.js', 'web/js/git-menu.js']` | `['web/js/git/history.js', 'web/js/git/lanes.js', 'web/js/git/menu.js']` |
| `e2e/git-lanes.spec.ts:9` | 주석의 `web/js/git-lanes.js` | `web/js/git/lanes.js` |

**FR-REF-2** `README.md` §프로젝트 구조 트리를 FR-DIR-1 · FR-JS-1 로 교체한다.

**FR-REF-3** `docs/internal/architecture.md` 의 경로 참조 3곳(63행 `web/js/file-editor.js`,
70행 `web/js/helpers.js`, 508행 `web/js/app.js`)과 패키지 서술을 갱신한다.

**FR-REF-4** `.serena/` 캐시는 심볼 인덱스이므로 재생성 대상이다. 갱신 불필요.

### 3.7 묶음 G — e2e 절차 문서화

**FR-DOC-1** `README.md` 에 e2e 실행 절차를 추가한다:

```bash
npm ci                    # Playwright 설치 (빌드에는 불필요 — e2e 전용)
npx playwright install    # 브라우저 바이너리
npx playwright test       # 전량 실행
```

**FR-DOC-2** "빌드에 npm 이 필요 없다"는 사실을 `scripts/build.sh` 주석에 한 줄로
명시한다. 프론트엔드가 번들러 없이 원본을 서빙한다는 사실이 코드에서 자명하지 않다.

### 3.8 묶음 H — `server` 3분할

**FR-SRV-1** `internal/webserver/hub`(`package hub`) 를 신설한다. 구성:

| 파일 | 출처 | 비고 |
|---|---|---|
| `commands.go` | `server/commands.go` 의 `CommandHub`·SSE 브로커 | HTTP 종단 3개 제외 |
| `focus.go` | `server/focus.go` 의 focus 상태 | HTTP 종단 3개 제외 |
| `activity.go` | `server/activity.go` 전체 | |
| `attention.go` | `server/attention.go` 156~180행 | FR-SPL-5 |
| `attn_tracker.go` | `server/attn_tracker.go` 전체 | |

**FR-SRV-2** `server/commands.go` 의 `handleCommandSSE`·`handleCommandPost`·
`handleCommandResult` 와 `server/focus.go` 의 `broadcastFocusOwners`·`apiFocusGet`·
`apiFocusClaim` 은 `*Server` 메서드이므로 `httpapi` 에 남긴다. 각 파일을
`commands_http.go`·`focus_http.go` 로 가른다. **리시버를 바꾸지 않는다.**

**FR-SRV-3** `internal/webserver/gitapi`(`package gitapi`) 를 신설하고 `GitServer`
타입을 정의한다. 필드는 git 핸들러가 실제로 쓰는 것만 담는다 — `Git`, `Work`.

**FR-SRV-4** `handlers_git*.go` 8파일 + `git_pins.go` 의 `*Server` 메서드 48개를
`*GitServer` 메서드로 이관한다. git 전용 헬퍼 6개(`gitResolveRepo`, `gitRepoParam`,
`gitStatusBefore`, `gitJobs`, `gitApply`, `gitPinsMutate`)도 함께 옮긴다.

**FR-SRV-5** `httpapi.Server` 는 `git *gitapi.GitServer` 를 보유하고 라우팅만
위임한다. 핸들러 **본문은 수정하지 않는다** — 리시버 이름과 필드 접근 경로만 바뀐다.

**FR-SRV-6** `internal/webserver/httpapi`(`package httpapi`) 는 위 셋을 제외한 잔여다:
`server.go`, `deps.go`, `ansi.go`, `snapshot_clean.go`, `handlers_api.go`,
`handlers_ws.go`, `handlers_status.go`, `handlers_toolio.go`, `handlers_whoami.go`,
`handlers_runs.go`, `handlers_runs_worktree.go`, `commands_http.go`, `focus_http.go`.

**FR-SRV-7** 의존 방향은 `httpapi → gitapi`, `httpapi → hub`, `gitapi → domain/git`
단방향이다. 역방향 import 를 만들지 않는다.

### 3.9 묶음 I — `git` 5분할

**FR-GIT-1** `domain/git/core`(`package core`) — `Service` 타입과 두 초크포인트를
보유한다: `exec.go`(`Exec`), `write.go` 의 `ExecWrite`, `guard.go`, `errors.go`,
`redact.go`, `record.go`, `dirs.go`, `repo.go`, `doc.go`.

**FR-GIT-2** `domain/git/query`(`package query`) — 조회 함수. `Exec` 초크포인트만
사용한다. 대상: `status.go`, `log.go`, `diff.go`, `diff_commit.go`, `commitdetail.go`,
`refs.go`, `resolve.go`, `signature.go` 및 `branch.go`·`remote.go`·`stash.go` 의 조회
함수.

**FR-GIT-3** `domain/git/write`(`package write`) — 변경 함수. `ExecWrite` 초크포인트만
사용한다. 대상: `stage.go`, `commit.go`, `write.go` 의 변경부, `preflight.go`,
`recovery.go`, `destructive.go` 및 `branch.go`·`remote.go`·`stash.go` 의 변경 함수.

**FR-GIT-4** `*Service` 메서드 47개를 `func Xxx(s *core.Service, …)` 형태의 자유
함수로 전환한다. **본문은 수정하지 않는다** — 리시버가 첫 인자로 내려간다.

**FR-GIT-5** `branch.go`·`remote.go`·`stash.go` 는 조회·변경 함수가 섞여 있으므로
함수 단위로 `query`/`write` 에 배분한다. 파일을 통째로 옮기지 않는다.

**FR-GIT-6** `domain/git/store`(`package store`) — `store.go`. `Store{svc *core.Service}`.
export 승격: `readSignature` → `ReadSignature`.

**FR-GIT-7** `domain/git/jobs`(`package jobs`) — `job.go`. `Jobs{svc *core.Service}`.
export 승격: `gitEnv`→`Env`, `guardWriteArgs`→`GuardWriteArgs`, `sanitizeArgv`→
`SanitizeArgv`, `sanitizeRemote`→`SanitizeRemote` (전부 `core` 로 이동 후 승격).

**FR-GIT-8** 초크포인트 불변: `query` 는 `core.Service.Exec` 외의 경로로, `write` 는
`core.Service.ExecWrite` 외의 경로로 git 을 실행하지 않는다. `execGit` 은 `core`
패키지 밖으로 노출하지 않는다.

**FR-GIT-9** 의존 방향은 `store → core`, `jobs → core`, `query → core`,
`write → core` 단방향이다. `query ↔ write` 상호 참조가 필요한 조합이 나오면 공통부를
`core` 로 올린다.

### 3.10 묶음 J — `app.js` 14분할

**FR-APP-1** `class App` 본문에는 다음만 남긴다: `constructor`, 접근자 11개(§2.4),
`init`, `render`, `_bind`, `_save`, `_rename`, `executeAction`, `_mkTool`,
`_collectPanes`, `_flattenPanes`.

**FR-APP-2** 나머지 메서드를 주제별 13파일로 옮긴다. 각 파일은
`Object.assign(App.prototype, { … })` 한 블록이다.

| 파일 | 주제 | 대표 메서드 |
|---|---|---|
| `app-cmd.js` | 원격 커맨드·워크스페이스 동기화 | `_subscribeCommands`, `_execRemote`, `_applyRemoteWorkspace` |
| `app-tool.js` | 도구 생명주기 | `_newTool`, `_restoreTool`, `_setToolBackground`, `_killTool` |
| `app-layout.js` | 창·탭·분할 | `addTab`, `closeTab`, `split`, `_splitInner`, `switchWindow` |
| `app-focus.js` | 포커스 동기화 | `_initFocusSync`, `_focusClaim`, `_resendWindowSizes` |
| `app-attn.js` | 주의 알림 | `_onToolAttention`, `_attnRefresh`, `_attnCenterRender`, `_initAttn` |
| `app-agents.js` | 활동 패널 | `_onToolActivity`, `_agentsRender`, `_agentOrderSync` |
| `app-git.js` | git 연동 | `openGitWindow`, `_gitReposRefresh`, `_gitPin`, `_gitChip` |
| `app-search.js` | 검색 | `toggleSearch`, `_doSearch` |
| `app-mobile.js` | 모바일 | `_initMobile`, `_initMobileKeybar`, `navMobilePane` |
| `app-settings.js` | 설정 모달·테마 | `_initModal`, `_renderThemePanel`, `_renderShortcutList` |
| `app-statusbar.js` | 상태바 | `_initStatusBar`, `_pollStats`, `_updateStatusBar` |
| `app-presets.js` | 레이아웃 프리셋 | `_savePreset`, `_loadPreset`, `_renderPresets` |
| `app-dnd.js` | 드래그앤드롭 | `_moveTabToPane`, `_splitPaneWithTab` |

**FR-APP-3** 메서드 **본문을 수정하지 않는다.** `this` 의미가 그대로이므로 변경은
클래스 본문에서 객체 리터럴로의 이동뿐이다.

**FR-APP-4** getter/setter 11개는 `Object.assign` 이 값으로 복사하므로 옮기지 않는다
(FR-APP-1).

**FR-APP-5** `app-*.js` 는 `app.js` 이후에 로드되어야 한다 (`App` 이 선언된 뒤여야
`App.prototype` 이 존재한다). FR-JS-3 참조.

---

## 4. 검증 (Verification)

| ID | 대상 | 방법 | 합격 기준 |
|---|---|---|---|
| TC-SPL-1 | FR-SPL-6 | `go list -f '{{.Imports}}' ./internal/shared/toolhub` | `webserver`·`daemon` 0건 |
| TC-SPL-2 | 묶음 A | `go build ./...` | 오류 0 |
| TC-EXP-1 | FR-EXP-3 | `go test ./...` | 기준선과 동일한 통과/실패 집합 |
| TC-DIR-1 | FR-DIR-1 | `go list ./...` | 목표 트리와 경로 일치 |
| TC-DIR-2 | FR-DIR-2 | `git log --follow` | 이동 파일 이력 연속 |
| TC-BOOT-1 | 묶음 D | `dongminal start` → `pgrep -f dongminald` | 데몬 기동, `paned.sock` 생성 |
| TC-SRV-1 | FR-SRV-5 | `handlers_git*_test.go` 16파일 | 전량 통과 |
| TC-SRV-2 | FR-SRV-7 | `go list` 의존 방향 검사 | 역방향 import 0건 |
| TC-GIT-1 | FR-GIT-8 | `grep -rn "execGit(" ./internal/webserver/domain/git/{query,write,store,jobs}` | 0건 |
| TC-GIT-2 | 묶음 I | `internal/git` 테스트 54파일 | 전량 통과 |
| TC-APP-1 | FR-APP-3 | `git diff` 의 메서드 본문 | 들여쓰기·리시버 외 변경 0 |
| TC-JS-1 | FR-JS-4 | `go build ./web` | embed 매칭 성공 |
| TC-JS-2 | FR-JS-1/3 | 브라우저 devtools Network | `js/**` 전부 200, 404 0건 |
| TC-E2E-1 | 전체 | `npx playwright test` | 기준선 유지 |

**기준선 확보**: 착수 전 `go test ./... 2>&1 | tee /tmp/base-go.txt` 와
`npx playwright test --reporter=list 2>&1 | tee /tmp/base-e2e.txt` 를 남긴다.
이 재구성은 **동작을 바꾸지 않으므로**, 기준선과의 차이가 곧 결함이다.

---

## 5. 비목표 (Non-Goals)

| # | 비목표 | 이유 |
|---|---|---|
| 1 | 프론트엔드 모듈 시스템 도입 (ESM/번들러) | `index.html` 의 `<script>` 20개가 진입점 1개로 바뀌고 전역 스코프 의존이 사라진다 — 로드 순서·타이밍이 달라지는 **실질 동작 변경**이다. 이번 작업의 무동작변경 성질을 깨뜨린다 |
| 2 | `go.mod` 모듈 경로 변경 | 불필요 |
| 3 | 동작·API·설정 파일 포맷 변경 | 이번 작업은 **순수 재구성**이다. 이것은 요구사항이 아니라 **보장사항**이다 |
| 4 | `handlers_api.go`(701줄, 메서드 25개) 추가 분할 | 묶음 H 의 3분할로 프로세스·역할 경계는 표현된다. 단일 파일 크기는 별개 문제다 |
| 5 | `app.js` 메서드 본문 리팩터 | 묶음 J 는 이동만 한다 (FR-APP-3). 본문 개선을 섞으면 회귀 원인 판별이 불가능해진다 |

---

## 6. 리스크 (Risks)

| # | 리스크 | 등급 | 완화 |
|---|---|---|---|
| 1 | export 승격 중 오타로 다른 심볼을 가림 | LOW | 이름 변경만(FR-EXP-3). `go build` 가 전량 검출 |
| 2 | 테스트 파일의 소속 패키지 오판 | LOW | 컴파일러가 확정한다. 미해결 심볼 = 잘못 배치 |
| 3 | `web/embed.go` glob 누락으로 정적 자산 404 | MEDIUM | FR-JS-4 + TC-JS-1/2. `go:embed` 빈 매칭은 빌드 실패라 조용히 지나가지 않는다 |
| 4 | `index.html` 스크립트 순서가 깨져 전역 참조 실패 | MEDIUM | FR-JS-3·FR-APP-5. 번들러가 없어 순서가 곧 의존성이다 |
| 5 | daemon mode 회귀 — IPC 가 안 붙음 | MEDIUM | TC-BOOT-1 + `daemon_integration_test.go`(현존) |
| 6 | **git 핸들러 48개 리시버 교체 중 필드 접근 누락** | MEDIUM | FR-SRV-5(본문 불변) + TC-SRV-1. `GitServer` 에 없는 필드를 쓰면 컴파일 실패한다 |
| 7 | **`*Service` 메서드 47개 자유 함수 전환 중 초크포인트 우회** | **HIGH** | FR-GIT-8 + TC-GIT-1(`execGit` grep 0건). `execGit` 을 `core` 밖으로 내보내지 않으면 우회가 구조적으로 불가능하다 |
| 8 | `query`↔`write` 순환 의존 발생 | MEDIUM | FR-GIT-9 — 공통부를 `core` 로 올린다. `PushSpec`·`StashPopChecked` 등 복합 메서드가 후보다 |
| 9 | 프로토타입 증강으로 접근자 유실 | LOW | §2.4 로 접근자 11개 특정 완료. FR-APP-1/4 로 본체 유지 |
| 10 | 실행 중인 `dongminald` 가 옛 바이너리라 프로토콜 불일치 | LOW | 와이어 포맷 불변. 검증 시 `dongminal stop --all` 선행 |

---

## 7. 실행 순서 (Sequence)

**단계마다 `go build ./... && go test ./...` 통과 후 커밋한다.** 커밋 전 사용자
확인을 받는다.

| # | 단계 | 묶음 | 검증 |
|---|---|---|---|
| 0 | 기준선 로그 확보 (`go test`, `playwright test`) | — | — |
| 1 | `attention.go` 를 탐지부/배선부로 가름 (같은 패키지) | A | `go test` |
| 2 | export 승격 13개 + `ToolHub` 이동 — **패키지는 그대로** | B | `go test` |
| 3 | `toolhub`·`toolipc`·`daemon/ipc`·`webserver/ipc` 신설 및 이동 | A | `go test` |
| 4 | 13패키지를 프로세스 축으로 `git mv` + import 일괄 치환 | C | `go test` |
| 5 | `runDaemon()` → `daemon/boot` | D | `go test` + TC-BOOT-1 |
| 6 | `hub` 분리 (`commands.go`·`focus.go` 가름) | H | `go test` |
| 7 | `gitapi` + `GitServer` — 리시버 48개 교체 | H | `go test` + TC-SRV-1 |
| 8 | `git` core/store/jobs 분리 (export 승격 5개) | I | `go test` |
| 9 | `git` query/write 분리 — 자유 함수 47개 전환 | I | `go test` + TC-GIT-1 |
| 10 | `web/js` 이동 + `index.html` + `embed.go` | E | TC-JS-1/2 + e2e |
| 11 | `app.js` 14분할 | J | TC-APP-1 + e2e |
| 12 | 참조처 갱신 (e2e 3, README, architecture.md) | F | e2e |
| 13 | README e2e 절차 + `build.sh` 주석 | G | — |
| 14 | 전량 검증 (§4) | — | 전체 |

**단계 2 를 3 보다 먼저 두는 이유**: 같은 패키지 안에서 이름만 바꾸면 컴파일러가
누락을 전부 잡아준다. 패키지를 먼저 가르면 "이름 문제"와 "경로 문제"가 섞여 오류
원인 판별이 어려워진다.

**단계 4 의 함정**: import 경로를 `sed` 로 치환할 때 `internal/run` 이
`internal/runtime`·`internal/runtimebin` 의 접두어다. 긴 것부터 치환하거나 경계를
포함해 매칭해야 한다.

**단계 8 을 9 보다 먼저 두는 이유**: `store`·`jobs` 는 `Service` 를 주입받아 보유하는
구조라 이동만으로 끝난다(§2.3.2). 위험한 자유 함수 전환(단계 9)을 시작하기 전에
안전한 부분을 확정해 두면, 회귀가 났을 때 원인 범위가 단계 9 로 좁혀진다.

**단계 10 을 11 보다 먼저 두는 이유**: 경로 이동과 파일 분할을 한 커밋에 섞으면
404 와 문법 오류를 구분할 수 없다.

---

## 8. 실행 기록 (Deviations)

착수 후 실측으로 드러난 스펙 이탈을 기록한다. 스펙이 단일 진실 공급원이므로
구현이 스펙을 벗어난 지점은 여기서 확정한다.

### 8.1 기준선 (단계 0)

| 항목 | 결과 |
|---|---|
| `go build ./...` | 통과 |
| `go test ./...` | 전량 통과 |
| `npx playwright test` | **397 통과 / 1 실패** |

**착수 전부터 실패하던 e2e 1건**: `e2e/git-ui-revision.spec.ts:1026`
"V79 (FR-GIT-192·193·194): 이모지가 없고 점이 활성 리포를 나타내며 follow 아래에
구분선이 있다". 이 재구성과 무관하므로 합격 기준은 "397 통과 / 이 1건만 실패"다.

### 8.2 D-1: export 승격 규모 — 13개 → 30개

**FR-EXP-1 의 13개는 과소 추정이었다.** §2.2 의 측정은 `go build` 의
*패키지 수준 undefined* 만 수집했고, **경계를 넘는 비공개 멤버 접근**은 잡지
않았다 — 당시 실험은 `internal/server` 의 참조를 `toolhub.` 로 전환하기 전에
멈췄기 때문에 그 오류 종류가 아직 나타나지 않았다.

실제 승격:

| 구분 | 개수 | 대상 |
|---|---:|---|
| 패키지 수준 (§2.2) | 13 | 표 그대로 |
| 와이어 타입 추가 | 1 | `panedErrObj` → `PanedErrObj` (`PanedError` 의 필드 타입이라 함께 이동) |
| `SafeConn` 메서드 | 9 | `Close`, `Send`, `WriteMsg`, `WritePing`, `RemoteAddr`, `SetReadLimit`, `SetReadDeadline`, `SetPongHandler`, `ReadMessage` |
| `Tool` 메서드 | 5 | `SignalAttention`, `Attend`, `SetActivity`, `AddClient`, `RemoveClient` |
| `Tool` 필드 | 2 | `Restored`, `LastOutputAt` |
| **합계** | **30** | |

`Tool.resize`·`Tool.done` 은 승격하지 않았다 — 이미 exported wrapper
(`Resize`, `Wait()`)가 있어 **호출부를 wrapper 로 바꾸는 것으로 해결**했다.
`Tool` 필드 2개는 json 태그가 없는 내부 상태이고 직렬화 타입은
`ToolState`/`ToolSnapshot` 이므로 와이어 포맷이 바뀌지 않는다.

### 8.3 D-2: 신규 API 5개 — FR-EXP-3("이름 변경만") 이탈

순수 이름 승격으로는 내부 표현이 패키지 경계로 새어나가는 지점이 있었다.
그런 곳은 불변식을 소유 타입 안에 캡슐화했다.

| API | 이유 |
|---|---|
| `Tool.WireRelayOnce(build)` | 순수 승격 시 `atomic.Pointer[toolRelay]` 와 `toolRelay` 타입이 노출된다. "평생 한 번만 배선"(FR-12) 불변식을 `Tool` 안에 둔다. `daemon/ipc` 가 유일한 호출자 |
| `ToolManager.Adopt(p)` | 핸들러 테스트가 `m.mu`/`m.tools` 를 직접 잠그고 합성 도구를 꽂던 픽스처를 대체. PTY 를 띄우지 않는 등록 경로 |
| `NewDetachedTool(id, hooks)` | PTY 없이 훅만 배선된 도구. 테스트 헬퍼가 `Tool.onAttention` 등 비공개 훅 필드를 세팅하던 것을 대체 |
| `NewAttendingTool(id, hooks, armed)` | 주의 상태가 올라간 도구. 주의 종단(clear/clear-all) 테스트의 시작 상태 — 실제 경로로는 PTY 출력 관찰을 거쳐야만 도달한다 |
| `SetAttnBusyProbe(f) (restore)` | `attnBusyProbe` 는 같은 패키지에서만 덮어쓰던 테스트 이음매다. 변수는 비공개로 두고 교체 함수만 노출 |

동작 변경은 없다. 다섯 모두 기존 코드가 하던 일을 옮겨 담은 것이다.

### 8.4 D-3: `webserver/ipc` → `webserver/toolclient`

**FR-SPL-4 를 수정한다.** `daemon/ipc` 와 `webserver/ipc` 는 둘 다
`package ipc` 가 되어, 양쪽을 함께 import 하는 `cmd/dongminal/main.go` 에서
alias 가 필요해진다 — FR-DIR-3(alias 불필요)과 충돌한다. 클라측을
`internal/webserver/toolclient`(`package toolclient`)로 둔다.

### 8.5 D-4: 테스트 파일 재배치

컴파일러가 소속을 확정한 결과다.

| 파일 | 이동 | 근거 |
|---|---|---|
| `tool_test.go` | → `shared/toolhub` | `dataPath`·`dirty`·`invalidator`·`toolBusyProbe` 화이트박스 |
| `activity_tool_test.go` | → `shared/toolhub` | `onActivity`·`attnBusyProbe` |
| `attention_tool_test.go` | → `shared/toolhub` (**함수 4개는 server 에 잔류**) | Tool 내부 7개는 toolhub, 종단 4개는 `attention_endpoint_test.go` 로 분리 |
| `concurrency_invariants_test.go` | → `shared/toolhub` (**함수 1개는 server 에 잔류**) | `broadcast`·`cls`·`cmu`·`kill`. CommandHub 경합 테스트는 `commandhub_race_test.go` 로 분리 |
| `paned_test.go` | → `daemon/ipc` | 서버측 IPC |
| `tool_client_test.go` | → `webserver/toolclient/client_test.go` | `ToolClient.call` 비공개 접근. `startFakePaned` 가 쓰던 `panedConn` 은 **우발적 의존**이었다 — `pc.encoder` 만 사용해서 `json.NewEncoder(conn)` 로 대체 |
| `daemon_integration_test.go` | `internal/server` 잔류 | `AttnTracker`·`CommandHub` 까지 써서 세 패키지에 걸친다. `ipc.` 접두어만 부여 |

신설: `internal/server/tool_fixtures_test.go` — 종단 테스트용 픽스처 헬퍼
(`attnHooks`, `newAttnPane`, `newAttendingPane`, `newActivityPane`).

### 8.6 D-5: `git` 5분할의 실측 이탈 (단계 8·9)

**FR-GIT-1·2·3 의 파일 목록은 초크포인트 기준으로 다시 놓았다.** 어느 패키지에
두느냐를 정하는 것은 파일 이름이 아니라 **그 함수가 git 을 어느 진입점으로
실행하는가**다 — FR-GIT-8 이 그 기준이며, 스펙의 파일 목록과 어긋난 곳은 목록을
고쳤다.

| 파일 | 스펙 | 실제 | 근거 |
|---|---|---|---|
| `recovery.go` | write | **core** | `Service.hints` 가 비공개 필드다. `HintLog`·`Hint` 가 core 밖이면 `AddHint`/`Hints` 가 성립하지 않는다 |
| `destructive.go` | write | **core** | `Hint.Action` 이 core 의 필드이고 core 의 HintLog 테스트가 그 낱말을 딛는다 |
| `preflight.go` | write | **query** | `Exec` 만 쓴다. write 에 두면 그 파일 하나가 FR-GIT-8 을 깨뜨린다 |
| `resolve.go` | query | **write** | `execPaths` → `ExecWrite` 로 간다. 파괴적이며 hint 를 남긴다 |
| `stash.go` | 함수 단위 분산 | **전부 write** | `stash` 가 `writeCommands` 에 있어 `stash list`·`stash show` 까지 `ExecWrite` 로 간다 (파일 머리 주석의 기존 설명). 초크포인트로 가르면 조회 함수도 write 다 |
| `remote.go` | 함수 단위 분산 | **query** `DefaultRemote`·`remoteNames`·`ErrNoRemote` / **write** `FetchSpec`·`PullSpec`·`PushSpec`·옵션 / **core** 세척기 | FR-GIT-5 그대로. write 쪽은 git 을 실행하지 않고 `WriteSpec` 만 만든다 — 실제 실행은 `jobs` 다 |
| `stage.go` | write | **write** + `HasHead` → query | `rev-parse --verify HEAD` 는 조회다 |
| `commit.go` | write | **write** + `LastCommitMessage` → query | `log -1` 은 조회다 |
| `branch.go` | 함수 단위 분산 | **query** `ValidBranchName`·`LocalBranchExists` / **write** 나머지 | FR-GIT-5 그대로 |
| `diff.go` | `diff.go` + `diff_commit.go` | 둘로 갈랐다 | FR-GIT-2 의 목록에 맞췄다 |

**의존 방향 — `write → query` 를 허용했다.** 복합 함수(`PushSpec` 의 upstream
확인, `StashPopChecked` 의 목록 재조회, `Discard`/`Unstage` 의 HEAD 확인,
`checkNewBranchName`)는 읽기가 필요하다. 선택은 셋이었다:

1. write 가 `s.Exec` 을 직접 부른다 → **FR-GIT-8 위반**
2. 복합 함수와 그것이 읽는 `Status`·`StashList` 를 전부 core 로 올린다 →
   `status.go` 가 core 로 가고 core 가 다시 커진다
3. write 가 query 를 부른다 → 읽기는 query 안에서 `Exec` 을 지나고, 의존은
   여전히 **단방향**이다 (FR-GIT-9 가 금지한 것은 상호 참조다)

3 을 택했다. 실측: write 안의 `s.Exec(` 0건, query 안의 `ExecWrite` 0건.
`go list` 로 확인한 방향은 `core ← query ← {write, store}`, `core ← jobs` 다.

**자유 함수 전환은 47개가 아니라 34개다.** FR-GIT-4 의 47 은 `*Service` 메서드
전체 수이고, 그중 13개는 core 에 남는 Service 자신의 것이다 — `Exec`,
`ExecWrite`, `Records`, `MaxOutput`, `AddHint`, `Hints`, `GitDirs`, `RepoRoot`
와 비공개 `deny`·`withTimeout`·`record`·`writeRunner`·`denyWrite`.

**함수 이름 5개에 `Of` 접미를 붙였다.** Go 는 같은 패키지에서 타입과 함수가 이름을
나눠 가질 수 없고, `Status`·`Signature`·`Preflight`·`CommitDetail`·`DiffContent`
는 **결과 타입이 이미 그 낱말을 쓰고 있다.** 그래서 함수는 `StatusOf`·
`SignatureOf`·`PreflightOf`·`CommitDetailOf`·`DiffContentOf` 다. 타입을 core 로
올려 이름을 비우는 길도 있었으나 그러면 값 타입이 core 로 흩어진다.

**export 승격은 5개가 아니라 11개 + 신규 API 1개다.**

| 승격 | 쓰는 곳 | 근거 |
|---|---|---|
| `readSignature` → `ReadSignature` | store | FR-GIT-6 (파일은 query 로 갔다) |
| `gitEnv` → `Env` | jobs | FR-GIT-7 |
| `guardWriteArgs` → `GuardWriteArgs` | jobs | FR-GIT-7 |
| `sanitizeArgv` → `SanitizeArgv` | jobs | FR-GIT-7 |
| `sanitizeRemote` → `SanitizeRemote` | jobs | FR-GIT-7 |
| `recordWrite` → `RecordWrite` | jobs | §2.3.2 의 측정이 비공개 **메서드** 접근을 잡지 않았다 — D-1 과 같은 종류의 과소 추정 |
| `relPath` → `RelPath` | query·write | FR-GIT-9 공통부 (core/guard.go) |
| `unixSecToMilli` → `UnixSecToMilli` | query·write | FR-GIT-9 공통부 (core/time.go) |
| `checkRefArg` → `CheckRefArg` + `ErrRefName` | query·write | FR-GIT-9 공통부 (core/guard.go) |
| `checkRefFormatBranch` → `CheckRefFormatBranch` | query | 가드가 묶은 인자 형태를 조회가 그대로 붙인다 |
| `hasHead` → `HasHead`, `defaultRemote` → `DefaultRemote` | write | 자유 함수 전환의 귀결 |

신규 API 1개는 `Service.MaxOutput() int` 다. 출력이 상한에서 잘렸다는 **사유에
그 값을 적는** 조회 4곳(`log`·`refs`·`commitdetail`·`stash`)이 `s.maxOutput` 을
읽고 있었다. 필드는 비공개로 두고 읽기만 노출했다 (D-2 와 같은 방식).

`xe.kind` 접근 5곳은 승격 없이 기존 `ExecError.Unwrap()` 으로 바꿨다 — 같은 값을
주는 공개 메서드가 이미 있었다.

**테스트 재배치 (컴파일러가 확정)**

| 파일 | 이동 | 근거 |
|---|---|---|
| `status`·`log`·`diff`·`diff_commit`·`commitdetail`·`refs`·`signature`·`preflight_test` | → query | 대상이 조회다 |
| `stage`·`stash`·`resolve_test` | → write | 대상이 변경이다 |
| `branch_test` | **3분할** | 이름 검사 2개 → query, `guardArgs` 검사 1개 → core, 나머지 → write |
| `commit_test` | 2분할 | `LastCommitMessage` 1개 → query, 나머지 → write |
| `remote_test` | 2분할 | `TestSanitizeRemote` → core, 나머지 → write |
| `destructive_test` | → core | `destructive.go` 와 함께 |
| `preflight_test` 의 `TestGuardArgs_ConfigReadOnly` | → `core/guard_test.go` | `guardArgs` 는 core 비공개다 |

신설: `query/fixture_test.go`, `write/fixture_test.go` — `gitPath`·`tempRepo`·
`gitRun` 등 실제 git 픽스처의 복제다. 테스트 헬퍼는 패키지 경계를 넘지 못한다
(D-4 와 같은 이유). `resolve_test.go` 의 `s.rec = NewRecorder(…)` 는
`core.WithRecorder(…)` 로 바꿨다 — 같은 일을 공개 옵션으로 하는 것이다.

**보호 테스트는 약화시키지 않았다.** `credScanDirs` 에 query·write 를 더했다
(`ReadDir` 은 하위 디렉터리를 훑지 않으므로 새 패키지는 명시해야 한다).
`credRemoteFiles` 에 `query/remote.go`·`write/remote.go` 를 더했다 — 원격 표면이
셋으로 갈렸고 셋 다 강한 검사(`token`·`secret` 금지)를 받아야 한다. 임계값
`scanned < 40` 은 그대로 두었고 실제 스캔은 59파일이다.
`static_test.go`·`write_test.go` 의 허용 경로는 접두어 매칭이라 하위 디렉터리가
그대로 걸려 갱신이 필요 없었다.

### 8.7 D-6: `web/js` 재배치와 `app.js` 분할의 실측 이탈 (단계 10·11)

**D-6a (실질) FR-REF-1 표가 불완전했다.** `e2e/git-lanes.spec.ts` 는 9행(주석)만
표에 있었으나, 실제로 파일을 읽는 곳은 37행
`const LANES_JS = join(process.cwd(), 'web','js','git-lanes.js')` 다. 주석만 고치면
그 스펙 파일 전체가 ENOENT 로 죽는다. 37행도 갱신했다.

**D-6b (실질) FR-REF-1 표에 `internal/server/commands_browser_test.go` 가 없었다.**
이 테스트는 `web/js/app.js` 를 경로로 읽어 `_execRemote` 본문에서 action 을 추출한다.
단계 10 에서 `web/js/core/app.js` 로, 단계 11 에서 `web/js/core/app-cmd.js` 로 두 번
바뀌었다 — `_execRemote` 와 그 경계인 `_resolveLocation` 이 함께 `app-cmd.js` 로 갔다.

**D-6c (실측차) §2.4 의 "159 메서드" 는 158 이다.** 총 멤버 170 = `constructor` 1 +
접근자 11 + 메서드 158. 접근자·constructor 포함 방식의 차이다. §2.4 의 차단 요인
판정 3건(`#` 은 CSS 선택자 · `for…in` 없음 · `static` 없음)은 실측과 일치했다.

**D-6d (해석) FR-APP-2 표는 주제·대표 메서드만 주고 149개 전량 분류표가 없었다.**
§2.4 의 뭉치 개수와 `app.js` 자체의 섹션 주석으로 확정했다. §2.4 의 접두어 개수와
어긋난 곳: layout 21(§2.4 "20"), tool 12("11"), focus 11("14"), git 23("22") —
§2.4 는 접두어 근사치이고(`openGitWindow` 는 `_git*` 가 아니다) 파일 경계는 주제로
갈랐다. 분류가 전량 소진임은 스크립트가 강제한다(미분류·중복·부재를 에러로 낸다).

**D-6e (사소)** `index.html:12` 의 `style.css?v=146` 은 그대로 두었다. FR-JS-3 은
`<script>` 를 대상으로 하고 `style.css` 는 무변경이라 캐시 무효화 이유가 없다.

**FR-APP-3(본문 불변) 의 증거** — 추정이 아니라 텍스트 대조다:
원본 AST 멤버 170개 ↔ 새 14파일의 멤버·속성 대조에서 누락 0 / 초과 0 / 중복 0이고,
소스 텍스트 170개가 **바이트 단위 동일**하다. 줄 단위 다중집합 대조에서 원본 2,999줄이
전부 잔존하며 차이는 객체 리터럴 구분용 쉼표 149개뿐이다.

**FR-APP-4 의 증거**: 실브라우저에서 `App.prototype` descriptor 6개가 여전히 get/set
함수다(값 복사되지 않았다). 접근자 반환값 `auto|768|boolean|true|false|5000`.

### 8.8 D-7: 문서 갱신 범위 (단계 12)

**완료 기록인 SRS 문서의 경로는 고치지 않았다.** `RUN_ORCHESTRATION_SRS.md`,
`GIT_UI_REVISION_SRS.md`, `ORCHESTRATOR_RESEARCH_NOTES.md` 등은 그 시점의 사실을
적은 기록이다. 새 경로로 고치면 기록이 거짓이 된다. 살아 있는 포인터
(`architecture.md`, `README.md`, `getting-started.md`, `docs/internal/README.md`)만
갱신했다.

**README 아키텍처 다이어그램을 프로세스 축으로 다시 그렸다.** 기존 다이어그램은
데몬과 웹 서버를 "Go Server (PTY hub)" 한 상자로 묶어, PTY 소유자가 누구인지를
가리고 있었다 — 이번 재구성이 코드에서 갈라낸 바로 그 경계다.

### 8.9 진행 상황

| 단계 | 묶음 | 상태 | 검증 |
|---|---|---|---|
| 0 | — | 완료 | §8.1 |
| 1 | A | 완료 | `go test` 통과 |
| 2 | B | 완료 | `go build`·`vet`·`test`·`gofmt` 통과 |
| 3 | A | 완료 | 전량 통과 + 격리 인스턴스에서 데몬 기동·`paned.sock` 생성·`/api/ping`·도구 생성(IPC 왕복) 확인 |
| 4 | C | 완료 | `f604d9d` — 프로세스 축 재배치 |
| 5 | D | 완료 | `5e638b7` — `daemon/boot` |
| 6 | H | 완료 | `c043b34` — `webserver/hub` |
| 7 | H | 완료 | `70c6c25` — `webserver/gitapi` + `*GitServer` |
| 8 | I | 완료 | `go build`·`vet`·`test`·`gofmt` 통과. `core`/`store`/`jobs` |
| 9 | I | 완료 | 전량 통과 + TC-GIT-1(`execGit` 0건) + 의존 방향 `go list` 확인. §8.6 |
| 10 | E | 완료 | `fd93ae4` — `web/js` 3폴더. TC-JS-1(embed) + 격리 인스턴스에서 js 20개 200, 구 평면 경로 404 |
| 11 | J | 완료 | `3d8511a` — `app.js` 14분할. TC-APP-1(바이트 단위 대조) + 실브라우저 요청 138건 전부 200, console error 0 |
| 12 | F | 완료 | 참조처 갱신 — e2e 4곳, `commands_browser_test.go`, `README.md`, `architecture.md`, `getting-started.md`, `docs/internal/README.md`. §8.8 |
| 13 | G | 완료 | README 테스트 절 신설(e2e 절차 + 격리 실행 안내), `build.sh` 주석 |
| 14 | — | 완료 | §8.10 |
