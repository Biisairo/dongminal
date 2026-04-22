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
  server/              # HTTP 라우팅, WS 핸들러, PaneManager, CodeServerManager, CommandHub
  workspace/           # workspace.json 인덱싱·resolve·영속화 (Manager + FilePersister)
web/                   # 프론트엔드 자산 (HTML/CSS/JS) + embed.FS()
scripts/               # start/stop/health/install-mcp.sh (개발자·운영자 대상)
docs/
  internal/            # 개발자 문서 (이 파일)
  external/            # 사용자 문서
```

`internal/` 는 Go 언어 레벨에서 외부 import 를 막아 캡슐화를 강제한다. 외부 의존성이 필요한 모듈은 의도적으로 `internal/` 밖(현재는 `web/` 만 해당)으로 뺀다.

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
