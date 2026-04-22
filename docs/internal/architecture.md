# 아키텍처

## 패키지 레이아웃

```
cmd/dongminal/         # composition root (main)
internal/
  adapters/            # internal/{server,workspace} → internal/mcptool 인터페이스 브리지
  clientpid/           # 원격 TCP(remoteAddr) → client PID (ps/lsof)
  mcptool/             # MCP 툴 레지스트리 + JSON-RPC 핸들러 + 구체 툴 구현체
    tools/             # list_panes, read_pane_output, send_input, who_am_i 등
  outbuf/              # PTY 출력 바운디드 버퍼 (Stream — readPTY 와 MCP/WS 리더 통합)
  pane/                # pane 도메인 타입 (PaneLabel 등)
  runtime/             # 런타임에 배포될 셸 헬퍼 스크립트 embed + Install()
    scripts/           # download, edit, bash-hook.sh, zdotdir/.zshrc (실제 파일)
  server/              # HTTP/WS/SSE 라우팅, PaneManager, CodeServerManager, CommandHub, MCPSessionRegistry, settingsStore
  workspace/           # workspace.json 인덱싱·resolve·영속화 (Manager + FilePersister)
web/                   # 프론트엔드 자산 (HTML/CSS/JS) + embed.FS()
scripts/               # start/stop/health/install-mcp.sh (개발자·운영자 대상)
.env / .env.example    # start.sh 가 자동 로드하는 환경변수(PORT, BINARY, LOG, DONGMINAL_HOME)
docs/
  internal/            # 개발자 문서 (이 파일)
  external/            # 사용자 문서
```

`internal/` 는 Go 언어 레벨에서 외부 import 를 막아 캡슐화를 강제한다. 외부 의존성이 필요한 모듈은 의도적으로 `internal/` 밖(현재는 `web/` 만 해당)으로 뺀다.

## 런타임 헬퍼 배포 (`internal/runtime`)

`runtime.Install(binDir)` 이 `main()` 초기화에서 `$DONGMINAL_HOME/bin/` 으로 임베드된 스크립트를 복사한다. 확장자 없거나 `.sh` → `0755`, 그 외 → `0644`. 대상 파일:

- `dmctl` — `/api/commands` 로 워크스페이스 action 브로드캐스트하는 shell CLI.
- `edit` — `/api/code-server` 호출 + OSC 777 `OpenCodeServer` 출력.
- `download` — OSC 777 `Download;<abs>` 출력.
- `bash-hook.sh` — `PROMPT_COMMAND` 에 `_rt_cwd_hook` 주입, OSC 777 `Cwd;<pwd>`.
- `zdotdir/.zshrc` — zsh 용 `precmd`/`chpwd` 훅. `~/.zshrc` 를 먼저 source.

pane 스폰 시 `StartPane` 이 환경을 덧붙인다 (`internal/server/pane.go`):

```
PATH=<기존>:$DONGMINAL_HOME/bin
zsh  → ZDOTDIR=$DONGMINAL_HOME/bin/zdotdir
bash → BASH_ENV=$DONGMINAL_HOME/bin/bash-hook.sh
TERM=xterm-256color, COLORTERM=truecolor, LANG/LC_ALL/LC_CTYPE=en_US.UTF-8
DONGMINAL_PORT=<서버 포트>   # main() 이 setenv, 자식 PTY 가 상속
```

## code-server 통합 (`internal/server/codeserver.go`)

`CodeServerManager` 는 `code-server` 를 Unix 소켓 모드(`--socket`, `--socket-mode 600`) 로 기동하고 `httputil.ReverseProxy` 를 인스턴스별로 보관한다. `/cs/<id>/` 프록시는 WebSocket 업그레이드까지 지원. `user-data-dir`/`extensions-dir` 는 인스턴스별 격리.

- `Start(folder)` — `PATH` 에 `code-server` 가 없으면 실패. 경로가 파일이면 상위 디렉터리로 보정.
- `Touch(id)` — `/api/code-server/heartbeat` 로 갱신. 프론트는 10s 주기 호출.
- `Watchdog()` — 30s 동안 heartbeat 없으면 프로세스 kill. `main()` 에서 `go bd.csm.Watchdog()`.
- `Stop(id)` / `StopAll()` — SIGTERM 후 소켓 파일 cleanup.
- 기동 경로: pane `edit <path>` → `POST /api/code-server?path=<abs>` → 응답 수신 → OSC 777 `OpenCodeServer` → 브라우저 `window.open('/cs/<id>/...')`.

## 커맨드 브로드캐스트 (`internal/server/commands.go`)

`CommandHub` 는 SSE 구독자 집합과 버퍼 크기 16 의 채널을 관리. `POST /api/commands` 로 들어온 action 을 `allowedCmdActions` 화이트리스트로 검증 후 구독자 전원에게 브로드캐스트. 버퍼가 꽉 차면 해당 구독자에 한해 드롭 + `[cmd] subscriber channel full` 로그.

15개 허용 action: `newSession`/`newTab`/`splitH`/`splitV`/`focus`/`closeTab`/`closeSession`/`sessionNext`/`sessionPrev`/`tabNext`/`tabPrev`/`paneUp`/`paneDown`/`paneLeft`/`paneRight`. 동일 집합을 MCP 툴 `workspace_command` 가 공유(같은 `CommandHub` 를 주입받음).

## 어댑터 패턴

`internal/mcptool` 은 `PaneReader`, `WorkspaceReader`, `CommandBroadcaster`, `ClientPaneResolver` 같은 **인터페이스만** 정의한다. 구체 타입(`server.PaneManager`, `workspace.Manager`, `server.CommandHub`)은 그 인터페이스를 직접 구현하지 않는다. 대신 `internal/adapters` 가 브리지 역할을 한다.

- `adapters.Pane` — `*server.PaneManager` 를 `mcptool.PaneReader` 로.
- `adapters.Workspace` — `*workspace.Manager` 를 `mcptool.WorkspaceReader` 로.
- `adapters.Command` — `*server.CommandHub` 를 `mcptool.CommandBroadcaster` 로.
- `adapters.Client` — `*server.PaneManager` + `clientpid` 를 `mcptool.ClientPaneResolver` 로.

import 방향은 단방향 (`adapters → {mcptool, server, workspace, clientpid}`). server/workspace 는 mcptool 을 몰라도 되며, mcptool 은 server/workspace 의 구체 타입을 몰라도 된다. 테스트에서 인터페이스를 mock 하기 쉽다.

## 성능: 핫패스 비차단

### `workspace.Manager.Save` (H5)

HTTP `PUT /api/workspace` 핸들러는 `Save(blob, ifMatch)` 호출 → 인덱스 빌드 + atomic swap 만 수행하고 디스크 쓰기는 **비동기 writer 고루틴** 에 넘긴다.

- `writeCh chan []byte` (버퍼 크기 1) + 전용 writer 고루틴.
- `enqueueWrite` 는 latest-wins 코얼레싱: 대기 중인 blob 이 있으면 덮어쓴다. 다수의 빠른 Save 가 들어와도 디스크 쓰기는 하나로 합쳐진다.
- `Manager.Close()` 는 `sync.Once` 로 writer 를 종료하고 마지막 blob 을 flush. `main.go` 의 shutdown 경로에서 `srv.PersistSettings()` 뒤 `bd.wsMgr.Close()` 로 호출.
- 측정치: 101.7 ms/call (동기 `os.WriteFile`) → 18 µs/call (atomic swap 만). 자세한 배경은 [FOLLOWUP_HOTFIX_RFC.md](./FOLLOWUP_HOTFIX_RFC.md) §4-ter.

### 로깅 스킵 (H5 Track A)

`server.loggingMiddleware` 는 `/api/workspace*`, `/api/panes*`, `/api/ping`, `/api/stats` 에 대해 **정상 응답(status < 400) 만 로그 스킵**. 에러는 항상 로그. 분할/삭제 시 초당 수십 회 히트하는 엔드포인트의 로그 오버헤드 제거.

### 클라이언트 낙관적 UI (성능 재개선 턴)

`web/app.js` 의 `split`, `closeTab`, `addTab` 은 레이아웃 mutation + `render()` 를 **즉시** 실행하고 `_kill`, `_save` 를 await 하지 않고 fire-and-forget. `_save()` 는 내부 직렬화 큐로 ETag 경쟁을 방지하고 coalescing 수행.

또한 `/api/panes` POST 에 `cwdPane=<refPaneId>` 쿼리 지원 → 클라이언트가 `/api/cwd` 사전 조회할 필요 없음 (RT 1 건 제거).

## 동시성

- `PaneManager` : 내부에 `sync.RWMutex`. `Snapshot()` 은 슬라이스 복사로 외부 공개.
- `workspace.Manager` : `atomic.Pointer[[]byte]` + `atomic.Pointer[*index]` + `atomic.Uint64` (rev). Save 내부에서만 `sync.Mutex` 로 직렬화. 리더는 락 없이 atomic load.
- `outbuf.Stream` : `sync.Mutex` + `atomic.Int64` (누적 카운터). Feed/Snapshot 모두 lock 내에서 slice 조작.
- `CommandHub` : SSE 구독자 list + broadcast. 내부 `sync.RWMutex`.

## 종료 경로

1. `signal.NotifyContext` 가 `SIGINT`/`SIGTERM` 포착 → ctx cancel.
2. `srv.Run` 이 리턴 (http.Server.Shutdown 내부 호출).
3. `bd.pm.SaveAll()` — pane 별 cwd 등 상태를 디스크에.
4. `srv.PersistSettings()` — settings.json flush.
5. `bd.wsMgr.Close()` — workspace writer 고루틴 flush + 종료.
6. `bd.csm.StopAll()` — code-server 자식 프로세스 종료.

순서 중요: wsMgr.Close 가 PersistSettings 뒤, csm.StopAll 앞. pane/settings 저장 중 workspace writer 가 살아 있어야 한다.

## 테스트

- `internal/server/*_test.go` — HTTP 라우팅, DI, Pane CRUD.
- `internal/workspace/*_test.go` — Save 비차단·coalescing·Close flush, parse, resolve.
- `internal/outbuf/*_test.go` — Feed/Snapshot/compaction/통계.
- `internal/mcptool/*_test.go` — 툴 dispatch, JSON-RPC.

Go 관례대로 `*_test.go` 는 각 패키지 안에 공존. Black-box 테스트가 필요한 경우 `package xxx_test` 를 사용.
