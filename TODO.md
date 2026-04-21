# Remote Terminal — TODO

## 기능 구현 목록

### 1. 터미널 검색 (Terminal Search) ✅
- [x] xterm.js `@xterm/addon-search` 연동
- [x] Ctrl+F / Cmd+F → 검색 바 UI 표시
- [x] 이전/다음 매치 이동 (Enter/Shift+Enter)
- [x] 대소문자 구분 토글
- [x] ESC / ✕ 버튼으로 검색 바 종료
- [x] 검색 시 터미널 크기 자동 조정

### 2. 파일 업로드 / 다운로드 ✅
- [x] **업로드**: 브라우저 → 서버
  - 드래그앤드롭으로 터미널에 파일 드롭
  - POST `/api/upload` 로 파일 전송
  - 터미널의 현재 작업 디렉토리에 저장
  - 업로드 결과 터미널에 표시
- [x] **다운로드**: 서버 → 브라우저
  - 터미널에서 `download <path>` 명령어
  - GET `/api/download?path=<path>` 엔드포인트
  - 브라우저 다운로드로 파일 저장

### 3. 자동 재연결 (Auto Reconnect) ✅
- [x] WebSocket 연결 끊기 감지 (onclose / onerror)
- [x] 지수 백오프로 재연결 시도 (1s → 1.5s → 2.25s → ... → max 30s)
- [x] 재연결 중 오버레이 표시 ("연결 끊김 / 재연결 중...")
- [x] 재연결 성공 시 PTY 버퍼 리플레이 → 터미널 복원
- [x] 네트워크 복구 후 자동으로 이어서 작업 가능

### 4. 상태 표시줄 (Status Bar) ✅
- [x] 하단 상태 바 UI
- [x] 연결 상태 (🟢/🔴 + 연결됨/끊김)
- [x] 레이턴시 (ping ms)
- [x] 현재 디렉토리
- [x] 메모리 사용량
- [x] CPU 사용률
- [x] 호스트명
- [x] 디스크 사용률
- [x] 터미널 크기
- [x] 업타임
- [x] 설정 → Status Bar 탭에서 항목 토글
- [x] 기본값: 연결상태, 레이턴시, 현재디렉토리, 메모리
- [x] settings.json에 저장

### 5. 링크 열기 (Link Handling) ✅
- [x] xterm.js `@xterm/addon-web-links` 연동 (이미 CDN에 있음)
- [x] URL 클릭 시 새 브라우저 탭에서 열기

### 6. 레이아웃 프리셋 (Layout Presets) ✅
- [x] 현재 레이아웃(분할 + 탭 수)을 프리셋으로 저장
- [x] 프리셋 목록 UI (설정 → Presets 탭)
- [x] 프리셋 로드 → 새 세션에 해당 레이아웃 적용
- [x] 프리셋 삭제
- [x] 더블클릭으로 프리셋 이름 변경
- [x] settings.json에 프리셋 데이터 저장

### 7. tui 환경에서 화면 업데이트 시 화면 깨짐 문제 해결 ✅
  - [x] 각 TermPane에 전용 TextDecoder 인스턴스 사용 (stream:true) → UTF-8 멀티바이트가 WebSocket 청크 경계에서 잘리는 문제 해결
  - [x] requestAnimationFrame 기반 배치 처리 → 동일 프레임 내 여러 청크를 하나로 합쳐 write() → 중간 상태 렌더링 제거

### 8. 세션, 탭 종료 시 해당 터미널에 실행 중인 프로세스가 있는 경우 물어보기 기능 추가 ✅
  - [x] 세션, 탭 종료 시 종료되는 터미널 중 프로세스가 실행중인 경우 질문 후 허가 시 닫기, 허가하지 않을 시 아무 창도 닫히지 않음

### 9. 세션 리스트, pane, tab 드래그로 이동 기능 추가 ✅
  - [x] 세션 리스트 내에서 드래그 드롭으로 순서 변경
  - [x] 탭에서 드래그 드롭으로 순서 변경
  - [x] 탭을 드래그하여 다른 pane 위에 올릴 시 올리는 위치에 따라 해당 탭 분할하여 배치
    - [x] 이때 드롭 전에 시각적으로 어떻게 분할이 될 지 보여주기
  - [x] 탭을 다른 pane 에 탭 안으로 이동 가능

### 10. tab 생성, pane 분할 시 포커스 되어있는 터미널의 경로를 가져는 기능 추가 ✅
  - [x] 새 탭, pane 분할 시 포커스 되어있는 터미널의 경로와 같은 경로로 생성하기
  - [x] session 생성 시에는 ~(home) 으로 생성 유지

### 11. 스크롤바 색상 변경 ✅
  - [x] 배경과 색상이 너무 비슷하여 잘 보이지 않음 → --text-dim / hover 시 --text-muted 로 변경

### 12. shift+enter 동작 안되는 이유 확인 ✅
  - [x] attachCustomKeyEventHandler로 Shift+Enter 인터셉트 → \x1b\r (ESC+CR, iTerm 관례) 전송

### 13. session 이동 시 focus pane ✅
  - [x] 세션 이동 시 이전 포커스 pane 복원 (session.focusedRegion 저장/복원)
  - [x] pane 삭제 시 closestRg()로 인접 pane 포커스

### 14. esc, enter 동작 ✅
  - [x] 창/세션 닫을때 경고 창에서 enter/esc 로 동의/취소
  - [x] 설정창 연 뒤 esc 로 설정창 닫기

### 15. code-server 연동 (원격 에디터) ✅
  - 동기: 로컬에서 VSCode + 터미널 두 창을 원격에서도 동일하게 사용하기 위함
  - [x] **서버 (Go)** — `/api/code-server` POST/heartbeat/stop 엔드포인트
    - `exec.LookPath("code-server")`로 설치 확인
    - `net.Listen(":0")` 자동 포트 할당, `--bind-addr 0.0.0.0:PORT --auth none`
    - 입력 경로로 code-server 실행 (`<folder>` 인자)
    - watchdog: 하트비트 30s 타임아웃 시 프로세스 kill
    - SIGINT/SIGTERM 시 전체 인스턴스 정리
  - [x] **bin/edit** — `edit <path>` 호출 시 `/api/code-server` 요청 후 OSC `OpenCodeServer;id|port|folder` 발신
  - [x] **프론트엔드** — OSC 수신 시 `window.open`으로 새 창, 10s 주기 하트비트 + 1s 주기 `win.closed` 폴링 → 창 닫히면 `/stop` 호출. 팝업 차단 시 터미널의 URL 링크 클릭으로 폴백 및 창 추적.

### 16. focus 시 highlight line 이 terminal 을 가리지 않도록 ui 수정

### 17. 이유모를 서버 중단이 있음. 문제점 코드에서 찾아보고 로그 꼼꼼히 넣기 ✅
  - [x] gorilla/websocket 동시 쓰기 버그 수정 (broadcast + pingLoop + snapshot이 같은 conn에 concurrent 쓰기 → panic/crash)
  - [x] safeConn 래퍼 추가 (write mutex로 모든 쓰기 직렬화)
  - [x] bch 채널 누수 수정 (readPTY 종료 시 defer close(bch) → drainBuf 고루틴 정상 종료)
  - [x] 모든 고루틴에 panic recovery + stack trace 로깅
  - [x] HTTP request 로깅 미들웨어 추가
  - [x] WebSocket connect/disconnect 상세 로그
  - [x] pane 생성/종료/에러 상세 로그
  - [x] 로그 타임스탬프 마이크로초 단위

## 리팩터링 (ARCHITECTURE_DEEPENING_RFC.md)

- [x] **Candidate 1 완료** (2026-04-21): `internal/outbuf.Stream` 도입, `OutputBuffer` 제거, `dropped_bytes` 관측 지원, 테스트 4개 통과
- [x] **Candidate 2 완료** (2026-04-21): `Pane.onExit` 콜백 도입, `readPTY`에서 `pm.delete` 제거, `startPane` 시그니처에 `onExit` 추가, `PaneManager.create/restore`가 콜백 바인드, `Pane.Wait()` 공개, 단위 테스트 1개 통과
- [x] **Candidate 3 완료** (2026-04-21): `internal/workspace.Manager` 도입 (atomic.Pointer + sync.Mutex), `Liveness`/`Persister` 인터페이스로 DI, `ErrStale` + rev 증가 기반 낙관적 동시성, `parseWorkspaceBlob` 포팅, `resolveID`/`buildLabelMap`/`parseWorkspace` 제거, 전역 `wsJSON`/`wsMu` → `wsMgr`, `PUT /api/workspace` If-Match→409 매핑 및 ETag 응답, `GET /api/workspace` + `GET /api/state`에 ETag 헤더, `PaneManager.create/restore` onExit에서 `wsMgr.InvalidatePane` 호출, manager 단위 테스트 4개 통과
  - RFC §6.2와의 차이: `Labels() map[string]string`만으로는 `toolListPanes`/`toolWhoAmI`/`toolSendAgentMessage`가 필요로 하는 `SessionName`/`TabName`/`IsActive`를 못 실어서 `Entries() []PaneLabel` 메서드를 추가
- [ ] **프론트엔드 ETag 연동 (follow-up)**: `static/app.js`의 `/api/workspace` PUT 요청에 `If-Match` 헤더 + 409 처리 (서버 버전 재로드 후 재시도) 추가. 서버는 이미 ETag 발급/검증 중이지만 현재 프론트엔드는 If-Match를 보내지 않아 last-write-wins로 동작.
- [x] **Candidate 4 Stage 1 완료** (2026-04-21): `internal/mcptool.Registry` + `Tool` 인터페이스 도입, `PaneReader`/`WorkspaceReader`/`CommandBroadcaster`/`ClientPaneResolver` DI 인터페이스 정의, 7개 MCP tool (`list_panes`/`read_pane_screen`/`read_pane_output`/`send_input`/`send_agent_message`/`who_am_i`/`workspace_command`)을 `internal/mcptool/tools/` 하위 struct로 포팅, `mcp.go`의 `callTool` switch + `mcpToolSchemas` + 기존 `toolXxx` 함수 전면 제거, `tools/list` 응답은 Registry 기반 생성(스키마 동일성 유지), `handleMCPRequest`가 `Registry.Dispatch` 호출하고 `ErrUnknownTool→-32601`·기타 err→`isError:true` 매핑. 원본에는 8개라고 기재됐으나 실제 tool은 7개(callTool switch 및 `mcpToolSchemas` 모두 7종). Registry 테스트 5개 통과. Stage 2 (`Register[A]` 제네릭)는 범위 제외.
  - RFC §7.2와의 차이: `WhoAmI`가 SSE `remoteAddr`를 요구하므로 `context.Context`를 통해 전달(`mcptool.WithRemoteAddr`/`RemoteAddrFromContext`). `workspace_command`는 `CommandBroadcaster` 인터페이스(`AllowedAction`+`Broadcast`)를 추가로 정의했고, `commands.go`의 기존 `toolWorkspaceCommand`는 삭제.
- [x] **Candidate 5 Stage 5a 완료** (2026-04-21): `internal/server` 패키지 신설 — `server.Config`/`server.Deps`/`server.Server`/`server.MCPSessionRegistry` 도입. `NewServer(cfg, deps)` → `Handler()` / `MCPHandler()` / `Run(ctx, addr)` / `Shutdown(ctx)` 제공. 기존 `main()` 의 HTTP 서버 기동·graceful shutdown 로직을 `Server.Run` 으로 이관(+ `signal.NotifyContext` 사용). `loggingMiddleware` / `responseWriter` 를 `internal/server` 로 이동. `mcp.go` 의 `mcpSessions`/`mcpSessionsMu`/`newMCPSession`/`getMCPSession`/`mcpSession` 타입을 제거하고 `server.MCPSessionRegistry` (shim `var mcpReg *server.MCPSessionRegistry`) 로 대체. 핸들러 본문·기존 핸들러 함수 시그니처는 그대로. `grep -rn '\bpm\.' internal/` 는 테스트 로컬 변수만 매치(패키지 main 전역 참조 0). 단위 테스트 3개(`TestNewServerInTempDir`/`TestHandlerBasics`/`TestTwoServersInSameProcess`) 통과.
  - 설계 조정(보스 승인): `PaneManager`/`CodeServerManager` 가 `package main` 에 있어 `internal/server` 가 구체 타입을 직접 참조하면 import cycle 발생 + Stage 5c(인터페이스화) 금지 충돌. 보스 지시로 옵션 (b) 채택 — `PaneHub`/`CodeServerHost`/`WorkspaceStore`/`ToolDispatcher`/`CommandBroker`/`SettingsStore` 를 `internal/server` 내부에 최소 인터페이스로 선언하고, 구체 타입을 `main` 에서 `server.Deps` 로 주입. kickoff 원문의 `pm = srv.Panes` 바인딩은 의존 방향이 뒤집혀 불필요해짐 — `pm`/`csm`/`wsMgr`/`toolRegistry` shim 전역은 `main()` 초기화 지점에서 종전대로 생성되어 핸들러가 그대로 참조한다.
- [ ] **Candidate 5 Stage 5b (follow-up)**: `main` 의 핸들러 함수(`handleAPI`/`handleWS`/`handleCSProxy`/`handleCommandSSE`/`handleCommandPost`/`handleMCPSSE`/`handleMCPMessage`/`handleMCPRequest`)를 `*server.Server` 메서드로 점진 전환하고 shim 전역(`pm`/`csm`/`wsMgr`/`toolRegistry`/`mcpReg`)을 제거. 각 핸들러의 `pm`/`csm`/... 접근을 `s.Panes.*` 등으로 바꾸되, 그러려면 `PaneManager`/`CodeServerManager` 를 `package main` 밖(예: `internal/pane`, `internal/codeserver`)으로 옮기거나, Stage 5c 의 `PaneStore` 인터페이스 도입이 선행되어야 한다.
- [ ] **Candidate 5 Stage 5c (follow-up)**: `PaneManager` → `PaneStore` 인터페이스, `CodeServerManager` → `CodeServerHost` 등 실제 메서드를 가진 인터페이스로 확장해 Design B(포트&어댑터) 방향으로 수렴. Stage 5b 와 함께 또는 직전에 수행.