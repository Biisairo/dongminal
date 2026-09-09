# Go 백엔드 아키텍처 · 코드 품질 · 리팩터링 감사 (read-only)

- 대상: `/Users/dykim/personal/dongminal` — `cmd/`, `internal/` (Go 1.24, 266 소스 / 314 테스트 파일, 49,271 LOC)
- 기준 커밋: `a312eee` (2026-09-09)
- 방법: 패키지 그래프 `go list` 실측, 500줄 이상 파일 전량 열람, 핸들러·IPC·PTY·동시성 경로 정독, `go vet ./...` / `go build ./...` (clean), `go test -race` (toolclient·toolhub·hub·workspace — pass)
- 우선순위: P0 = 배포 차단(보안·데이터 손실·크래시), P1 = 운영 중 실질 위험 또는 심각한 유지보수 부채, P2 = 개선 권장

먼저 짚어 둘 강점: git 실행 초크포인트(`domain/git/core`)와 정적 검사, `apierr` sentinel 전수성 테스트, `platform.WriteFileAtomic`(fsync + rename), 상수화된 타임아웃 대부분, 테스트 밀도. 아래 발견은 그 위에 남은 것들이다.

---

## P0

### [P0] 브라우저 교차 출처(CSWSH/CSRF)로 임의 명령 실행 가능 — Origin·Content-Type·인증 검사 전무
- 위치
  - `internal/shared/toolhub/conn.go:37` — `CheckOrigin: func(r *http.Request) bool { return true }`
  - `internal/webserver/httpapi/handlers_toolio.go:175-181` — `decodeJSONBody` 는 Content-Type 을 보지 않고 본문만 디코드
  - `internal/webserver/httpapi/handlers_runs_headless.go:45-97` — `POST /api/tools/headless {"command": …}` → `createHeadlessTool`
  - `internal/shared/toolhub/manager.go:412-424` → `platform.Current().Shell.RunCommand(place.Command)` → `internal/shared/platform/shell.go:113-115` `[]string{sh, "-c", cmdline}`
  - `internal/webserver/httpapi/access.go:276-278` — loopback 출발지는 허용 목록과 무관하게 항상 통과
  - `internal/webserver/httpapi/handlers_files.go:362-390` — `POST /api/file/write` 임의 절대경로 쓰기 (가드 없음, 문서상 의도)
  - 저장소 전체에서 `Header.Get("Origin"|"Content-Type"|"Sec-Fetch-*")` 검사 0건, 인증 토큰 0건 (grep 실측)
- 현상: 서버가 기본값(127.0.0.1)으로만 떠 있어도 사용자가 방문한 **어떤 웹사이트든** ① `fetch("http://localhost:58146/api/tools/headless", {method:"POST", body: JSON.stringify({command:"…"})})` — Content-Type 이 `text/plain` 인 단순 요청이라 preflight 없이 전송되고 서버는 Content-Type 을 검사하지 않으므로 `sh -c` 로 실행된다. ② `new WebSocket("ws://localhost:58146/ws?tool=<id>")` 도 Origin 검사가 없어 PTY 입출력 전권을 얻는다. ③ `/api/file/write` 로 `~/.zshrc`·`~/.ssh/authorized_keys` 등 임의 파일 덮어쓰기. 접속 허용 목록(access.go)은 출발지 IP 기반이라 브라우저 경유 공격을 막지 못한다(loopback 은 항상 허용).
- 왜 문제인가: README 는 "인증이 없으므로 신뢰하는 망에서만" 이라 적지만, 위 경로는 **망 노출 여부와 무관**하게 로컬 사용자의 브라우저 탭 하나로 RCE 가 성립한다. 프로덕션 승격 차단 사유.
- 조치
  1. `Upgrader.CheckOrigin` 을 "Origin 이 없거나(비브라우저) Host 와 동일 출처" 로 제한.
  2. 상태 변경 종단(POST/PUT/DELETE) 공통 미들웨어: `Content-Type: application/json` 강제 + `Sec-Fetch-Site` 가 `cross-site` 면 거절 (단순 요청 CSRF 차단). `decodeJSONBody`·`fsDecode`·`gitDecodeBody` 를 하나의 헬퍼로 통일해 그 안에서 검사.
  3. 근본 대책: `$DONGMINAL_HOME/token` 을 기동 시 생성해 `index.html` 주입 + 도구 셸 환경(`DONGMINAL_TOKEN`)으로 `dmctl` 에 전달, 모든 `/api/*`·`/ws` 에서 검증. `access.go` 의 게이트 자리에 얹으면 한 겹으로 덮인다.
- 규모: 1·2 = S, 3 = M

---

## P1

### [P1] `http.Server` 타임아웃 부재 + 비정상 종료(Close) — Slowloris·연결 고갈, in-flight 요청 절단
- 위치: `internal/webserver/httpapi/server.go:220` `&http.Server{Addr: addr, Handler: s.Handler()}`, `:238-241` `srv.Close()`
- 현상: `ReadHeaderTimeout`·`IdleTimeout` 이 없어 헤더를 천천히 보내는 연결 하나가 goroutine·fd 를 무기한 점유. 종료 시 `Shutdown(ctx)` 대신 `Close()` 라 진행 중인 PUT /api/workspace 가 잘린다 (workspace 는 비동기 writer 라 마지막 blob 은 flush 되지만 클라이언트는 실패로 본다).
- 조치: `ReadHeaderTimeout: 10s`, `IdleTimeout: 120s` 설정(SSE/WS 는 hijack/flush 라 `WriteTimeout` 은 두지 않는다). 종료는 `Shutdown(ctx, 2~3s)` 후 `Close()`.
- 규모: S

### [P1] 요청 본문 크기 상한 부재 — 메모리 DoS
- 위치: `handlers_api.go:326` (`body, _ := io.ReadAll(r.Body)` — 에러까지 무시), `handlers_settings.go:91`(동일), `access.go:424`, `commands.go:116`, `handlers_fs.go:93`, `handlers_files.go:363`, `gitapi/handlers_git.go:247,353`, `gitapi/handlers_git_write.go:339`, `handlers_toolio.go:176`(`json.NewDecoder(r.Body)` 무제한). 상한이 있는 곳은 업로드(`handlers_files.go:111`)와 LSP(`handlers_lsp.go:57,82,121`)만.
- 현상: 임의 크기 본문이 그대로 힙에 올라간다. `PUT /api/settings` 는 그 blob 을 메모리에 보관하고 디스크에 쓴다.
- 조치: `http.MaxBytesReader(w, r.Body, N)` 을 JSON 디코드 헬퍼 한 곳에 넣고(P0 조치 2 와 같은 자리) 표면별 상한 상수(`jsonBodyMax = 1<<20`, workspace 는 4MiB 등).
- 규모: S

### [P1] 프로세스 축 의존 규칙 위반 — 문서("예외는 없다")와 실제 import 그래프 불일치
- 위치 (`go list` 실측)
  - `internal/shared/runtime → internal/helper/runtimebin` (`install.go:39` `runtimebin.HelperNames()`) — shared 가 ①프로세스 전용 패키지에 의존
  - `internal/daemon/boot → internal/webserver/domain/run` (`boot.go:71,73` `run.HeadlessToolIDs`) — ② 데몬이 ③ 웹서버 도메인 import
  - `internal/ctl/cli → internal/webserver/domain/git/core` (`verify.go:104`), `→ internal/helper/runtimebin`, `→ internal/shared/toolhub` — ④ 제어 CLI 가 ③·① 에 의존
  - `internal/shared/sandboxplace → internal/shared/toolhub` (배선 패키지가 shared 아래)
  - `docs/internal/architecture.md:49-111` 패키지 표에 `shared/{dmenv,platform,sandbox,sandboxplace,diagtail,listorder,testpath}`, `webserver/domain/{lsp,ext,submodule,wsentry}`, `webserver/httproute` 누락. `:113` "프로세스 축에 예외는 없다" 는 현재 거짓.
- 왜 문제인가: 축 규칙이 유일한 계층 기준인데 강제 장치가 없어 이미 4곳이 새었다. `domain/git` 만 `static_test.go` 로 경계를 지킨다.
- 조치: ① `HelperNames` 를 `shared/dmenv`(또는 `shared/helpernames`)로 내리기. ② `HeadlessToolIDs` 처럼 파일만 읽는 함수는 `shared/runfile` 로 분리하고 `domain/run` 이 그것을 import. ③ `verify.go` 의 `core.New().RepoRoot` 는 `exec.LookPath("git")` + `rev-parse` 한 줄로 대체하거나 `shared/gitprobe` 로. ④ 패키지 경계 테스트 추가(`go list -deps` 를 읽어 `internal/{ctl,daemon,helper}` 가 `internal/webserver` 를 import 하지 않음을 검증). ⑤ architecture.md 표 갱신.
- 규모: M

### [P1] 문서화된 채 남아 있는 데이터 레이스 — `ToolClient.OnOutput / OnExit`
- 위치: `internal/webserver/toolclient/client.go:89-91` (주석이 레이스를 인정), `:279-280` (`pc.OnOutput` 잠금 없이 읽음), `:341-347`(OnExit 은 잠금), 쓰기 `cmd/dongminal/main.go:468,472` (맨 대입)
- 현상: `DialPaneClientWithReconnect` 가 돌아온 순간 `readLoop` 는 이미 돌고 있고 데몬은 접속 직후 `output` push 를 보낼 수 있다. 같은 계열의 `OnForeground` 는 `go test -race` 3회 중 1회 관측되어 setter 로 고쳤다(`:83-96`)고 적혀 있는데 나머지 둘은 "범위 밖" 으로 남겼다.
- 조치: `SetOnOutput/SetOnExit` (mu 또는 `atomic.Pointer[func]`) 로 통일, 필드 비공개화.
- 규모: S

### [P1] 데몬 모드 `Get / IsLive / Has` 가 매번 전체 `list` RPC — O(N) 왕복, 재접속 창에서 5초 정지 증폭
- 위치: `client.go:549-559` (`Get` → `List()`), `:572-574` (`IsLive` → `Get`), `:416` (호출당 5초 타임아웃)
- 호출부: `shared/workspace/manager.go:255,313,318,378,389` (Resolve 1회에 최대 3회), `httpapi/handlers_runs.go:465` (멤버마다), `handlers_runs_headless.go:255,283`, `handlers_runs_cleanup.go:57`, `hub/attn_tracker.go:280` (주의 id 마다 probe), `seam/adapters/tool.go:84-92`, `handlers_attention.go:51,54,86,155`, `handlers_ws.go:55`
- 현상: 도구 N 개·멤버 M 개에서 `GET /api/runs` 한 번이 M 번 list 직렬화·전송. 데몬 재접속 중에는 각 호출이 `panedCallTimeout`(5s) 까지 매달려 요청 하나가 수십 초가 될 수 있다.
- 조치: 데몬에 `has {id}` RPC 추가(paned.go 핸들러 1개), 또는 `ToolClient` 에 `list` 결과 200ms TTL 캐시 + `exit` push 시 무효화. `IsLive` 는 그 캐시를 읽는다.
- 규모: M

### [P1] `readPTY` 패닉 시 도구가 반죽음 상태로 남는다
- 위치: `internal/shared/toolhub/tool.go:342-347` — `defer recover()` 가 로그만 남기고 반환
- 현상: 패닉이 나면 `kill()`·`onExit` 이 불리지 않아 PTY fd·프로세스가 남고, 클라이언트는 `OpExit` 을 받지 못하며(무한 재연결 폭주의 원인 조건), `tools.json` 에 계속 기재된다.
- 조치: defer 안에서 recover 뒤 `p.kill()` 과 `relay.onExit` 호출(EOF 경로와 동일 순서).
- 규모: S

### [P1] IPC 경계에서 실패를 성공으로 응답 — 에이전트가 배달됐다고 믿는다
- 위치: `internal/daemon/ipc/paned.go:258` (`pc.pm.Write(p.ID, raw)` 반환값 폐기 후 성공 응답), `:294` (`Resize` 동일), `internal/shared/toolhub/manager_hub.go:21` (없는 도구에 Write → `nil`, 주석 "silently drop"), `internal/webserver/toolclient/client.go:562` (`Delete` 가 `call` 오류 무시), `:576-577` (`SaveAll/LoadAll` no-op)
- 현상: `dmctl send-input` → `/api/tools/input` → `SendPaste` 는 오류를 돌려주지만 그 아래 `write` RPC 는 PTY 쓰기 실패·없는 도구 모두 200 이다. 데몬 모드 `DELETE /api/tools/{id}` 도 실패를 알 수 없다.
- 조치: `write`/`resize` 핸들러가 오류를 `PanedError{-32000}` 로 돌려주고, `ToolManager.Write` 는 없는 도구에 `ErrToolNotFound` sentinel 을 반환. `ToolHub.Delete` 시그니처에 `error` 추가.
- 규모: S

### [P1] 패키지 전역 가변 상태가 "서버 두 개 공존" 계약을 깨고, 전역 뮤텍스가 네트워크 I/O 를 감싼다
- 위치: `httpapi/server.go:1-4` ("two independent servers can coexist in a single process") vs `handlers_fs.go:391` `var fsOpMu sync.Mutex`, `handlers_runs_context.go:80` `var contextNotices`, `handlers_tools_kill.go:21` `var toolKillGrace`, `handlers_files.go:100` `var uploadMaxBytes`, `handlers_fs.go:43-48` `fsListMax/fsDeleteMax/fsCopyMax`; `domain/worktree/worktree.go:75-78` `repoLocks`(의도적 전역)
- 현상: `apiFSCreate`(`:319-320`)·`apiFSDelete`(`:452-453`) 가 `fsOpMu` 를 잡은 채 `fsDecode`(본문 읽기)와 최대 1만 항목 `RemoveAll` 을 수행 — 느린 클라이언트 하나가 모든 탐색기 파일 조작을 직렬 대기시킨다. `contextNotices` 는 Server 수명이 아니라 프로세스 수명이라 테스트 간 오염. 테스트 노브가 전역이라 `t.Parallel` 불가.
- 조치: 전역들을 `Server` 필드(`fsOps sync.Mutex`, `contextNotices`, `limits struct`)로 이동; `fsOpMu` 는 경로 확정 뒤 실제 `Mkdir/OpenFile/RemoveAll` 구간만 감싼다.
- 규모: M

### [P1] 영속 실패가 사용자에게 성공으로 보인다
- 위치: `cmd/dongminal/main.go:593` `_ = bd.wsMgr.Close()`; `shared/workspace/manager.go:139-140,147-148` (비동기 writer 가 실패를 로그만); `httpapi/access.go:135-137` (`WriteFileAtomic` 실패해도 `setConfig` 가 `nil` 반환 → PUT 200); `handlers_settings.go:57-59,90-102` (`save()` 실패 로그만, PUT 200); `handlers_api.go:321-352` (workspace PUT 은 인메모리 성공만 확인)
- 현상: 디스크 풀·권한 오류·경로 소실 시 `workspace.json` 이 갱신되지 않아도 브라우저는 저장 성공(ETag 증가)을 본다. 재기동 시 세션 배치 손실.
- 조치: writer 의 마지막 실패를 `atomic.Pointer[error]` 로 보관해 `Save` 다음 호출·`/api/ping`/diag 스냅샷에 노출(`persistErr` 필드), `Close()` 가 flush 오류를 반환하고 `serve` 가 로그+비0 종료. `setConfig`·`save()` 는 오류를 반환해 500 으로.
- 규모: S

### [P1] 문자열 매칭 기반 에러 분류 · 내부 오류 문구 노출
- 위치: `toolhub/tool.go:352` `strings.Contains(err.Error(), "input/output error")`; `httpapi/handlers_ws.go:234` `"use of closed network connection"` (→ `errors.Is(err, net.ErrClosed)`); `handlers_files.go:115` `"request body too large"`; `handlers_api.go:276,436` `http.Error(w, err.Error(), 500)`; 숫자 리터럴 상태코드 15곳 (`grep` 실측), `http.Error` 63곳
- 현상: Go 버전·로케일에 따라 문구가 바뀌면 조용히 분기가 달라진다. 500 본문에 내부 경로·명령이 실린다.
- 조치: `errors.Is(err, io.EOF) || errors.Is(err, syscall.EIO)`, `net.ErrClosed`, `*http.MaxBytesError` 만 사용; 500 은 고정 문구 + 로그.
- 규모: S

### [P1] 요청 고루틴 안의 `time.Sleep` 폴링 — 컨텍스트 취소 미전파, 락 장기 점유
- 위치: `handlers_runs.go:364-379` `waitHandoff` (최대 90초, `r.Context()` 무시); `handlers_runs_headless.go:232-244` `awaitTab` (3초); `handlers_runs_cleanup.go:104-123` `waitToolsIdle` (20초, tick 마다 도구별 `Busy` = 데몬 RPC/pgrep); `toolhub/bracketpaste.go:123` `SendPaste` 120ms sleep (요청 경로); `toolhub/tool.go:746` `kill()` 50ms sleep + `Wait()` (HTTP Delete 경로에서 동기); `domain/worktree/worktree.go:424-436` `removeWithRetry` 6×(git ≤180s) 를 `repoLock` 을 쥔 채 — 최악 18분 동안 같은 저장소의 다른 worktree 조작 전부 대기
- 조치: `select { case <-ctx.Done(): case <-time.After(...) }` 로 교체(`handlers_status.go:247-252` 가 이미 모범). `Runner` 시그니처에 `ctx` 추가. `kill()` 의 유예는 `Terminate` → `Wait(50ms)` → `Kill` 로 채널 기반.
- 규모: M

### [P1] 핵심 인터페이스 `ToolHub.List()` 가 `[]map[string]interface{}` — 타입 없는 와이어가 계층을 관통
- 위치: `shared/toolhub/hub.go:6`; 소비처 `manager.go:491` `out[i]["id"].(string)` (패닉 가능), `toolclient/client.go:553` `m["id"].(string)` (데몬 응답이 비정상이면 패닉), `seam/adapters/tool.go:28-31,44-53,128-135`, `daemon/ipc/paned.go:171-177`; 저장소 전체 `map[string]interface{}` 79곳
- 현상: 필드 추가 시 컴파일러가 잡아 주지 않고(`fgName`·`sizeCols` 가 문자열 키로 흩어짐), 형 단언 실패는 런타임 패닉.
- 조치: `type ToolInfo struct{ID, Name string; PID, Cols, Rows int; FgName string}` 로 `List() []ToolInfo`; IPC 는 그 구조체를 그대로 JSON 인코딩.
- 규모: M

---

## P2

### 거대 파일 · 거대 함수 · 과도한 책임 (8건)
- `httpapi/handlers_fs.go` 775줄 — fs 조작(`:1-663`)과 `/api/editors/*`(`:665-775`)가 한 파일. 후자를 `handlers_editors.go` 로. (S)
- `shared/toolhub/tool.go` 774줄 — PTY 수명(`:245-376,605-774`)과 주의/활동 상태기(`:398-603`)가 섞임. `tool_attention.go` 로 분리하면 `attention.go`·`agentturn.go` 와 응집. (S)
- `cmd/dongminal/main.go:442-600` `serve` 158줄 + `buildDeps/buildDepsWithHub/buildCommonDeps` 3벌(`:209-396`) — 조립·기동·종료가 한 함수. `internal/webserver/app`(또는 `cmd/dongminal/wire.go`) 로 `Build(cfg) (*App, error)` / `App.Run(ctx)` / `App.Shutdown()` 분리. 종료 순서 주석(`:571-593`)이 코드가 되게. (M)
- `httpapi/handlers_runs.go` 710줄 — `apiRunClose` 94줄(`:428`), `apiRunMemberAdd` 90줄(`:223`), workspace JSON 트리 직접 조작(`:560-710` `markWorkspaceRun*`·`applyRunMarks`·`markTabsIn`) 은 `shared/workspace` 의 책임. (M)
- `domain/worktree/worktree.go` 701줄 — git 실행·정리 규칙·porcelain 파서·slug/validRef 가 한 파일. `parse.go`, `naming.go` 로. `checkPath:600` 의 `strings.Contains(p, "..")` 는 `a..b` 같은 정상 이름을 거부(`handlers_fs.go:167-170` 이 같은 오탐을 이미 지적). (S)
- `helper/runtimebin/dmctl_run.go:521` `runSubClose` 121줄, `dmctl_listworkspace.go:16` 118줄, `ctl/migrate/identity.go:44` `RewriteIdentifiers` 146줄. (S 각)
- `ctl/cli/doctor.go` 685줄 — 진단 항목 11개가 순차 함수; 항목을 `[]check{name, fn}` 표로. (S)
- `toolclient/client.go:263-349` `handlePush` 86줄 switch — 이벤트별 메서드로. (S)

### 중복 로직 (7건)
- `daemon/ipc/paned.go:184-364` 핸들러 12개가 `json.Unmarshal(req.Params,&p)` + `PanedError{Code:-32602}` 를 복제; JSON-RPC 코드 `-32601/-32602/-32603/-32000` 이 매직 넘버. → `decodeParams[T](req) (T, *PanedError)` 제네릭 + 코드 상수. (S)
- JSON 응답 조립: `Header().Set("Content-Type","application/json")` 36곳, 오류 렌더러 5종(`writeToolIOError`, `fsFail`, `writeRunError`, `gitFail`, `http.Error`). 방언 통일은 파괴적 변경(architecture.md 가 명시)이지만 **렌더러 함수는** `apierr` 옆에 모아 둘 수 있다. (S)
- `dataPath` 가 `main.go:41-47` 과 `toolhub/manager.go:312-318` 에 동일 구현. (S)
- `run.HeadlessToolIDs(dir)` 가 부팅 한 번에 두 번 파일을 읽는다 — `main.go:226,236`, `boot.go:71,73`. (S)
- 스냅샷 전송 프레이밍 `stripSnapshotQueries(stripOSC777(snap))` + `msg[0]=OpOutput; copy` 가 `handlers_ws.go:113-123` 과 `:174-186` 에 두 벌. (S)
- 준비 대기 폴링 루프: `main.go:108-115` (20×100ms), `ctl/cli/start.go:236-244` `waitReady`, `ctl/cli/proc.go:56-71` `killPort`(1초 sleep 2회) — 공통 `pollUntil(ctx, every, fn)` 로. (S)
- 기본 터미널 크기 `120×40` 이 `manager_hub.go:96`, `persist.go:115`, `handlers_runs_headless.go:26-27` 세 곳에 리터럴. (S)

### 동시성 (7건)
- `toolhub/manager.go:377-384` `Create` 가 `m.mu` **쓰기 락을 쥔 채** `StartTool`(fork/exec + PTY open) — 그동안 `Get/List/IsLive` 전부 대기. 락 밖에서 띄우고 등록만 락 안에서. (S)
- `manager.go:379-383,439-443` onExit 클로저가 `m.invalidator` 를 락 없이 읽음(`SetInvalidator` 는 락으로 씀). (S)
- `httpapi/handlers_ws.go:125-126` `tool.Restored = false` — 일반 bool 을 핸들러 고루틴이 쓰고 동시 WS 두 개가 읽음. `atomic.Bool` 또는 `CompareAndSwap`. (S)
- `hub/attn_tracker.go:294-306` `ClearAllAttention` 이 `t.mu` 를 쥔 채 `onAttentionClear`(SSE Broadcast) 호출 — 같은 파일의 `Forget:116-128` 은 락을 놓고 부른다. 규약 불일치, Broadcast 가 hub 락을 잡으므로 락 순서 의존. (S)
- `hub/gitwatch.go:291` `ctx := context.Background()` — 종료 시 진행 중 `git status` 를 취소할 수 없다. `StartGitWatch(stop)` 를 `ctx` 로. (S)
- `shared/workspace/manager.go:227-232` `OnIndexUpdate` 를 `m.mu` 안에서 호출 — 재진입 데드락 위험을 주석으로만 방어. 락 밖 호출 + 순서 보장은 rev 로. (S)
- `toolclient/client.go:416` 호출마다 `time.After` 타이머 생성(5초짜리 미회수) — 고빈도 `list` 에서 타이머 누적. `time.NewTimer` + `Stop`. (S)

### 리소스 관리 (3건)
- `daemon/ipc/paned.go:446` `os.WriteFile(pidPath…)` 반환값 폐기 — pidfile 이 없으면 `ctl/cli/proc.go:80-93` 의 데몬 정지가 "미실행" 으로 오판. (S)
- `toolhub/tool.go:365,367` 청크마다 두 번 복사(`append([]byte(nil), raw[:n]...)`) — Stream.Feed 와 relay 에 같은 사본을 공유하거나 relay 쪽만 복사. (S)
- `httpapi/handlers_files.go:325-355` `apiFileRead` 가 `io.Copy` 반환 무시, 크기 상한 없음(수 GB 파일도 그대로 스트리밍). (S)

### 외부 명령 실행 (2건)
- 셸 경유는 `platform/shell.go:107,114,192,203` 4곳뿐이고 `RunCommand` 는 설계상 사용자 명령 실행(P0 참조), `EchoCommand` 는 진단 고정 문구. 나머지 `exec.Command*` 17곳은 인자 배열 전달로 안전. (확인 완료)
- `worktree.execGit:159-174` 와 `submodule.go:275`, `git/jobs/job.go:515`, `git/core/exec.go:152`, `handlers_fs_ignored.go:107` — git 실행기가 4벌. `core.Env()`(`exec.go:200-225`, `GIT_TERMINAL_PROMPT=0` 등)를 worktree·submodule 은 쓰지 않아 자격증명 프롬프트에 매달릴 수 있다. `core.Env()` 공유 또는 `core` 에 `ExecRaw(ctx, dir, args)` 를 열어 허용 목록 우회 없이 재사용. (M)

### 설정 · 상수 · 전역 (4건)
- `main.go:90` `3 * time.Second`, `:108-109` `20`/`100ms`; `toolhub/tool.go:746` `50ms`; `handlers_ws.go:21` `termReset` 시퀀스 리터럴; `platform/paths.go:65` `/tmp` 로그 기본값 — 이름 있는 상수로. (S)
- 환경변수 기반 런타임 설정이 `hub/commands.go:96-103` (`DONGMINAL_CMD_RESULT_TIMEOUT_MS`), `toolhub/attention.go`(`DONGMINAL_ATTENTION_*`), `dmenv` 에 분산 — `dmenv` 한 곳에서 파싱해 `Config` 로 주입. (S)
- 패키지 변수 테스트 훅 `toolBusyProbe`(`tool.go:128`), `attnBusyProbe`(`:507`), `fgProbe`(`foreground.go:42`), `attnNow`, `procCtl`(`cli/proc.go:77`) — 전역 교체는 `t.Parallel` 을 막는다. 구조체 필드 주입으로. (M)
- 로깅: `log.Printf` 146곳, 레벨·구조화 없음(`log/slog` 0건). 크기 감시(`cli.WatchLogSize`)는 있으나 회전 없음. `slog` + 필드(tool, addr) 도입. (M)

### 인터페이스 설계 · 테스트 가능성 (4건)
- `httpapi/deps.go:79,90,94,99,108` `AttnTracker *hub.AttnTracker`, `Runs *run.Store`, `Worktrees/UserWorktrees *worktree.Manager`, `Git *store.Store` 가 구체 포인터 — `/api/runs*`·`/api/git/*` 핸들러 테스트가 실제 파일시스템·git 을 요구. 좁은 인터페이스(`RunStore`, `WorktreeManager`, `GitQuery`)로. (M)
- `deps.go:63-67` `SettingsStore` 가 비공개 메서드(`get/set/save`)만 가진 인터페이스 — 패키지 밖에서 구현 불가라 주입 표면으로서 무의미. (S)
- 데몬 모드 판별이 타입 단언으로 새어 나감: `handlers_ws.go:60` `interface{ Connected() bool }`, `:158` `s.Tools.(*toolclient.ToolClient)`, `handlers_api.go:247` `interface{ ListOK() }`, `main.go:272,276,304-311`. `ToolHub` 에 `Connected()`·`Subscribe()` 를 올리거나 `DaemonHub` 하위 인터페이스로. (M)
- `toolhub.ToolHub` 가 `Get(id) *Tool` 로 구체 타입을 반환하는데 데몬 모드에서는 `term==nil` 합성 Tool — 호출자가 "어떤 메서드가 안전한가" 를 알아야 한다(`hub.go:11-19` 주석이 그 사실을 경고). `Get` 을 `Info(id) (ToolInfo, bool)` 로 좁히고 PTY 접근은 direct 전용 경로에만. (M)

### 문서 (1건)
- `docs/internal/architecture.md:49-116` 패키지 표 누락 11개, 축 규칙 서술 불일치(P1 참조). `:959-962` 동시성 절에 `toolclient`·`AttnTracker`·`Jobs` 미기재. (S)

---

## 참고: 검증 결과
- `go vet ./...` — 경고 없음
- `go build ./...` — 성공
- `go test -race -count=1 ./internal/webserver/toolclient/ ./internal/shared/toolhub/ ./internal/webserver/hub/ ./internal/shared/workspace/` — 전부 ok (P1 의 OnOutput 레이스는 배선이 `cmd/dongminal` 에 있어 패키지 테스트가 닿지 않는다)
