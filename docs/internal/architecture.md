# 아키텍처

## 패키지 레이아웃

```
cmd/dongminal/         # composition root (main)
internal/
  adapters/            # internal/{server,workspace} → internal/mcptool 인터페이스 브리지
  clientpid/           # 원격 TCP(remoteAddr) → client PID (ps/lsof)
  mcptool/             # MCP 툴 레지스트리 + JSON-RPC 핸들러 + 구체 툴 구현체
    tools/             # list_workspace, read_output, read_screen, send_input, who_am_i 등
  migrate/             # v1 → v2 엔티티 스키마 1회성 변환 (진입점: `./scripts/migrate.sh`)
  outbuf/              # PTY 출력 바운디드 버퍼 (Stream — readPTY 와 MCP/WS 리더 통합)
  run/                 # Run(오케스트레이션 실행)의 공간 계층 접합면 타입 (Projection)
  runtime/             # helper symlink 설치 + 셸 훅 embed + agent-hooks 생성
    shellhooks/        # bash-hook.sh, zdotdir/.zshrc (실제 파일)
  runtimebin/          # dmctl/edit/download/detach multi-call CLI 구현
  server/              # HTTP/WS/SSE 라우팅, ToolManager, CommandHub, MCPSessionRegistry, settingsStore
  toolline/            # dmctl·MCP 공용 한 줄 렌더러 (byte-level 동일 출력 보장)
  uuid/                # 엔티티 uuid(UUID v7) 생성·파싱
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

`runtime.Install(binDir)` 이 `main()` 초기화에서 `$DONGMINAL_HOME/bin/` 을 채운다.

**helper CLI** 는 `internal/runtimebin` 의 multi-call dispatch 로 dongminal 바이너리 자체가 처리하므로, `bin/<name>` 은 실행 파일을 가리키는 symlink (미지원 환경에선 복사) 다. `runtimebin.HelperNames()` 가 단일 소스:

- `dmctl` — `/api/commands` 로 워크스페이스 action 브로드캐스트 + `list-workspace`/`who-am-i`/`notify`/`activity`.
- `edit` — `POST /api/commands` 로 `openEditorTab` 브로드캐스트 (내장 편집기 탭).
- `download` — OSC 777 `Download;<abs>` 출력.
- `detach` — 현재 도구를 백그라운드로 보내고 탭을 닫는다 (`--list` / `--restore <id>`).

**셸 훅** 은 shell 문법이 필수라 임베드 파일을 그대로 풀어둔다:

- `bash-hook.sh` — `PROMPT_COMMAND` 에 `_rt_cwd_hook` 주입, OSC 777 `Cwd;<pwd>`.
- `zdotdir/.zshrc` — zsh 용 `precmd`/`chpwd` 훅. `~/.zshrc` 를 먼저 source.

**agent-hooks** — `installAgentHooks` 가 `bin/agent-hooks/` 에 Claude Code hooks settings 를 생성한다. hook 커맨드는 `dmctl` 을 절대경로로 참조해, PATH 앞쪽의 낡은 `dmctl` 이 `notify` 를 모르는 사고를 막는다.

도구 스폰 시 `StartTool` 이 환경을 덧붙인다 (`internal/server/tool.go`):

```
PATH=<기존>:$DONGMINAL_HOME/bin
zsh  → ZDOTDIR=$DONGMINAL_HOME/bin/zdotdir
bash → BASH_ENV=$DONGMINAL_HOME/bin/bash-hook.sh
TERM=xterm-256color, COLORTERM=truecolor, LANG/LC_ALL/LC_CTYPE=en_US.UTF-8
DONGMINAL_PORT=<서버 포트>   # main() 이 setenv, 자식 PTY 가 상속
DONGMINAL_TOOL_ID=<도구 id>  # detach 가 자기 도구를 식별하는 근거
```

## 파일 편집기 (`web/js/file-editor.js`)

`edit <path>` 는 `POST /api/commands` 로 `openEditorTab` 을 브로드캐스트하고, 브라우저가 그 탭에 Monaco Editor 를 띄운다. 서버 쪽 표면은 파일 I/O 두 개뿐이다.

- `GET /api/file/read?path=<abs>` — 절대경로만 허용. 디렉터리·심볼릭 링크 이탈은 거부.
- `POST /api/file/write` — 바디 `{path, content}`.

도구 타입은 `terminal` 과 `editor` 두 가지다 (`web/js/helpers.js` 의 capability 맵). `editor` 는 `backgroundCapable=false` 이므로 detach 대상이 아니다 (FR-BG-11).

과거의 code-server 통합(`internal/server/codeserver.go`, `/cs/<id>/` 리버스 프록시, `CodeServerManager`)은 `8dc0a3f` 에서 이 내장 편집기로 대체되며 제거됐다.

## 커맨드 브로드캐스트 (`internal/server/commands.go`)

`CommandHub` 는 SSE 구독자 집합과 버퍼 크기 16 의 채널을 관리. `POST /api/commands` 로 들어온 action 을 `allowedCmdActions` 화이트리스트로 검증 후 구독자 전원에게 브로드캐스트. 버퍼가 꽉 차면 해당 구독자에 한해 드롭 + `[cmd] subscriber channel full` 로그.

`allowedCmdActions` 는 20개를 허용한다: `newWindow`/`newTab`/`splitH`/`splitV`/`focus`/`closeTab`/`closeWindow`/`windowNext`/`windowPrev`/`tabNext`/`tabPrev`/`paneUp`/`paneDown`/`paneLeft`/`paneRight`/`openEditorTab`/`renameTab`/`renameWindow`/`detachTab`/`restoreTool`.

MCP 툴 `workspace_command` 는 같은 `CommandHub` 를 주입받지만 **부분집합만 노출**한다 (`workspaceCmdActions`, 18개). `detachTab`·`restoreTool` 은 `toolId` 인자를 요구하고 `workspace_command` 는 그 인자를 갖지 않으므로 제외된다 — `detach` CLI 전용 경로다.

이 화이트리스트는 생산자(브라우저 `_execRemote`, `dmctl`, `detach`)와 대조 검증된다 (`internal/server/commands_browser_test.go`). 생산자가 처리하는 action 이 여기 없으면 `POST /api/commands` 가 400 으로 거부해 브라우저 코드에 도달하지 못하는데, 스텁 서버로 테스트하는 CLI 쪽은 그 결함을 볼 수 없다.

## 어댑터 패턴

`internal/mcptool` 은 `ToolReader`, `WorkspaceReader`, `CommandBroadcaster`, `ClientToolResolver` 같은 **인터페이스만** 정의한다. 구체 타입(`server.ToolManager`, `workspace.Manager`, `server.CommandHub`)은 그 인터페이스를 직접 구현하지 않는다. 대신 `internal/adapters` 가 브리지 역할을 한다.

- `adapters.Tool` — `*server.ToolManager` 를 `mcptool.ToolReader` 로.
- `adapters.Workspace` — `*workspace.Manager` 를 `mcptool.WorkspaceReader` 로.
- `adapters.Command` — `*server.CommandHub` 를 `mcptool.CommandBroadcaster` 로.
- `adapters.Client` — `*server.ToolManager` + `clientpid` 를 `mcptool.ClientToolResolver` 로.

import 방향은 단방향 (`adapters → {mcptool, server, workspace, clientpid}`). server/workspace 는 mcptool 을 몰라도 되며, mcptool 은 server/workspace 의 구체 타입을 몰라도 된다. 테스트에서 인터페이스를 mock 하기 쉽다.

## 성능: 핫패스 비차단

### `workspace.Manager.Save` (H5)

HTTP `PUT /api/workspace` 핸들러는 `Save(blob, ifMatch)` 호출 → 인덱스 빌드 + atomic swap 만 수행하고 디스크 쓰기는 **비동기 writer 고루틴** 에 넘긴다.

- `writeCh chan []byte` (버퍼 크기 1) + 전용 writer 고루틴.
- `enqueueWrite` 는 latest-wins 코얼레싱: 대기 중인 blob 이 있으면 덮어쓴다. 다수의 빠른 Save 가 들어와도 디스크 쓰기는 하나로 합쳐진다.
- `Manager.Close()` 는 `sync.Once` 로 writer 를 종료하고 마지막 blob 을 flush. `main.go` 의 shutdown 경로에서 `bd.pm.SaveAll()` 뒤 `bd.wsMgr.Close()` 로 호출.
- 측정치: 101.7 ms/call (동기 `os.WriteFile`) → 18 µs/call (atomic swap 만). 자세한 배경은 [FOLLOWUP_HOTFIX_RFC.md](./archive/FOLLOWUP_HOTFIX_RFC.md) §4-ter.

### 로깅 스킵 (H5 Track A)

`server.shouldLogRequest` 는 `/api/workspace*`, `/api/tools*`, `/api/ping`, `/api/stats` 에 대해 **정상 응답(status < 400) 만 로그 스킵**. 에러는 항상 로그. 분할/삭제 시 초당 수십 회 히트하는 엔드포인트의 로그 오버헤드 제거.

### 클라이언트 낙관적 UI (성능 재개선 턴)

`web/js/app.js` 의 `split`, `closeTab`, `addTab` 은 레이아웃 mutation + `render()` 를 **즉시** 실행하고 `_kill`, `_save` 를 await 하지 않고 fire-and-forget. `_save()` 는 내부 직렬화 큐로 ETag 경쟁을 방지하고 coalescing 수행.

또한 `/api/tools` POST 에 `cwdTool=<refToolId>` 쿼리 지원 → 클라이언트가 `/api/cwd` 사전 조회할 필요 없음 (RT 1 건 제거).

## 동시성

- `ToolManager` : 내부에 `sync.RWMutex`. `Snapshot()` 은 슬라이스 복사로 외부 공개. 백그라운드 도구는 `background map[string]BackgroundEntry` 로 같은 락 아래에서 관리한다.
- `workspace.Manager` : `atomic.Pointer[[]byte]` + `atomic.Pointer[*index]` + `atomic.Uint64` (rev). Save 내부에서만 `sync.Mutex` 로 직렬화. 리더는 락 없이 atomic load.
- `outbuf.Stream` : `sync.Mutex` + `atomic.Int64` (누적 카운터). Feed/Snapshot 모두 lock 내에서 slice 조작.
- `CommandHub` : SSE 구독자 list + broadcast. 내부 `sync.RWMutex`.

## 종료 경로

1. `signal.NotifyContext` 가 `SIGINT`/`SIGTERM` 포착 → ctx cancel.
2. `srv.Run` 이 리턴 (http.Server.Shutdown 내부 호출).
3. `panedClient.Close()` — 데몬 연결을 **가장 먼저** 닫아 `dongminald` 가 새 연결을 받을 수 있게 한다.
4. `bd.pm.SaveAll()` — `tools.json` 에 도구별 cwd 등 상태를 기록. 탭이 참조하는 도구만 기록하므로 백그라운드 도구는 데몬 재시작을 넘기지 않는다 (FR-BG-9).
5. `bd.wsMgr.Close()` — workspace writer 고루틴 flush + 종료.

순서 중요: `wsMgr.Close` 가 `SaveAll` 뒤여야 한다. 도구 상태 저장 중 workspace writer 가 살아 있어야 한다.

## 테스트

- `internal/server/*_test.go` — HTTP 라우팅, DI, 도구 CRUD, 커맨드 화이트리스트의 생산자 대조.
- `internal/workspace/*_test.go` — Save 비차단·coalescing·Close flush, parse, resolve.
- `internal/outbuf/*_test.go` — Feed/Snapshot/compaction/통계.
- `internal/mcptool/*_test.go` — 툴 dispatch, JSON-RPC.

Go 관례대로 `*_test.go` 는 각 패키지 안에 공존. Black-box 테스트가 필요한 경우 `package xxx_test` 를 사용.
