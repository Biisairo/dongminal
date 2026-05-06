# Dongminal 전방위 테스트 체크리스트

> 작성일: 2026-05-05  
> 범위: 백엔드(Go) + 프론트엔드(xterm.js) 전 동작  
> 형식: 각 동작은 하나 이상의 단위/통합 테스트로 커버되어야 함

---

## A. 서버 핵심 (internal/server)

### A1. Server 생명주기
| # | 동작 | 엣지/실패 케이스 |
|---|------|------------------|
| A1.1 | `New(cfg, deps)` — 의존성 주입 | Commands nil → 자동 생성; Settings nil → 기본 파일 스토어 생성 |
| A1.2 | `Run(ctx, addr)` — HTTP 서버 시작 및 ctx 취소 시 graceful shutdown | 이미 실행 중인 경우; 주소 바인딩 실패 |
| A1.3 | `Shutdown(ctx)` — 명시적 graceful shutdown | httpSrv nil인 경우 no-op |
| A1.4 | `Handler()` — 라우팅 매핑 | 모든 등록된 경로가 mux에 연결되는지 확인 |
| A1.5 | `MCPHandler()` — /mcp/* 서브 핸들러 | |
| A1.6 | `PersistSettings()` — 종료 시 설정 저장 | Settings nil인 경우 no-op |
| A1.7 | `loggingMiddleware` — 요청 로깅 | status code 정확히 캡처; Hijacker/Flusher 인터페이스 유지 |
| A1.8 | `shouldLogRequest` — 핫패스 필터링 | 400+는 항상 로그; /api/ping, /api/stats, /api/workspace/*, /api/panes/*는 200대에서 필터 |

### A2. WebSocket 핸들러 (handleWS)
| # | 동작 | 엣지/실패 케이스 |
|---|------|------------------|
| A2.1 | paneID 쿼리 없음 → 새 Pane 생성 | `s.Panes == nil` → 500 |
| A2.2 | paneID 쿼리 있음 → 기존 Pane 재연결 | 존재하지 않는 paneID → OpError |
| A2.3 | 기존 Pane 재연결 시 snapshot 전송 | snapshot 비어있는 경우; snapshot이 bufMax 초과하지 않는지 |
| A2.4 | restored Pane 재연결 시 reset 시퀀스 전송 | restored=false인 Pane에는 전송되지 않음 |
| A2.5 | 재연결 시 resize(cols, rows) 호출 | |
| A2.6 | `OpSID` 전송으로 클라이언트에 pane ID 전달 | |
| A2.7 | 클라이언트 연결/해제 시 로깅 | panic recover |
| A2.8 | `readWS`: `OpInput` → `ptmx.Write` | ptmx Write 에러 시 종료 |
| A2.9 | `readWS`: `OpResize` → `pane.resize` | 메시지 길이 < 5이면 무시 |
| A2.10 | `readWS`: 빈 메시지 무시 | |
| A2.11 | `readWS`: 정상 Close, GoingAway, NoStatusReceived → 조용히 종료 | 기타 에러는 로그 |
| A2.12 | `pingLoop`: 주기적 Ping 전송 | writePing 실패 시 종료; pane done 시 종료 |
| A2.13 | WebSocket 업그레이드 실패 처리 | |

### A3. API 핸들러 (handleAPI)
| # | 동작 | 엣지/실패 케이스 |
|---|------|------------------|
| A3.1 | `GET /api/state` — panes + workspace JSON | `s.Panes == nil` → 500; workspace nil → null; ETag = rev |
| A3.2 | `POST /api/panes` — 새 Pane 생성 | `s.Panes == nil` → 500; cwd 쿼리 우선; cwdPane 참조로 CWD 상속; 생성 실패 → 500 |
| A3.3 | `GET /api/panes/{id}/busy` — Busy 상태 | pane 없음 → `{"busy": false}` |
| A3.4 | `DELETE /api/panes/{id}` — Pane 삭제 | `s.Panes == nil`도 200 반환 (no-op) |
| A3.5 | `GET /api/workspace` — workspace JSON | `s.Work == nil` → `null`; ETag = rev |
| A3.6 | `PUT /api/workspace` — workspace 저장 | `s.Work == nil` → 500; `If-Match` 불일치 → 409 + 현재 ETag; 잘못된 JSON → 400; 성공 시 200 + ETag; Commands Broadcast |
| A3.7 | `GET /api/settings` — 설정 조회 | Settings nil → `{}` |
| A3.8 | `PUT /api/settings` — 설정 저장 | Settings nil → no-op |
| A3.9 | `POST /api/upload` — 파일 업로드 | FormFile 없음 → 400; dir 없음 → `.`; uniquePath 충돌 해결; Create 실패 → 500; Copy 실패 → 500; 성공 시 name/size/path 반환 |
| A3.10 | `GET /api/download` — 파일 다운로드 | path 누락 → 400; 상대경로 → Abs 변환; 파일 없음 → 404; Content-Disposition/Length 설정 |
| A3.11 | `GET /api/cwd` — 현재 디렉토리 | paneID 없으면 `os.Getwd()` 폴백; pane 없어도 폴백 |
| A3.12 | `GET /api/code-server` — 목록 조회 | `s.CS == nil` → `[]` |
| A3.13 | `POST /api/code-server` — code-server 시작 | `s.CS == nil` → 500; 시작 실패 → 500; 성공 시 id/path/folder 반환 |
| A3.14 | `POST /api/code-server/heartbeat` — 하트비트 | `s.CS == nil` 또는 id 없음 → 404 |
| A3.15 | `POST /api/code-server/stop` — 종료 | `s.CS == nil`도 200 |
| A3.16 | `GET /api/ping` — 헬스체크 | `ok` 반환 |
| A3.17 | `GET /api/stats` — 시스템 통계 | top/sysctl/vm_stat/syscall.Statfs 명령 실패 시 graceful degradation |
| A3.18 | `GET /api/md-file` — 마크다운 파일 읽기 | path 누락 → 400; 상대경로 → 400; 비-markdown 확장자 → 403; 파일 없음 → 404; 디렉터리 → 400; Content-Type=text/markdown |

### A4. Pane 생명주기 (internal/server/pane.go)
| # | 동작 | 엣지/실패 케이스 |
|---|------|------------------|
| A4.1 | `StartPane` — 셸 결정 순서: `$SHELL` → `/bin/bash` → `/bin/sh` | 존재하지 않는 셸 경로 다음으로 폴백 |
| A4.2 | `StartPane` — 환경변수 설정 | TERM, COLORTERM, LANG, PATH(DONGMINAL_HOME/bin 추가), HOME, USER/LOGNAME, SHELL |
| A4.3 | `StartPane` — zsh용 ZDOTDIR 설정 | |
| A4.4 | `StartPane` — bash용 BASH_ENV 설정 | |
| A4.5 | `StartPane` — cwd 결정: 인자 > home > "." | 존재하지 않거나 파일이면 home |
| A4.6 | `StartPane` — PTY 시작 및 프로세스 생성 | pty.StartWithSize 실패 |
| A4.7 | `Pane.IsBusy` — pgrep -P로 자식 프로세스 확인 | cmd/process nil → false; pgrep 에러 → false |
| A4.8 | `Pane.Cwd` — /proc/PID/cwd 읽기 | 실패 시 lsof 폴백; 둘 다 실패 시 os.Getwd |
| A4.9 | `Pane.readPTY` — 출력 읽고 broadcast | EOF → OpExit + kill + onExit; io error → 동일; 기타 에러 → 동일 |
| A4.10 | `Pane.readPTY` — bch 채널 full 시 drop | drop 로그 |
| A4.11 | `Pane.drainBuf` — stream.Feed | panic recover |
| A4.12 | `Pane.broadcast` — 모든 클라이언트에 writeMsg | 개별 실패 시 removeClient + close |
| A4.13 | `Pane.addClient/removeClient` — 동시성 안전 | cmu Lock |
| A4.14 | `Pane.resize` — pty.Setsize | 에러 로그 |
| A4.15 | `Pane.kill` — once.Do로 중복 방지 | SIGTERM → sleep 50ms → SIGKILL → Wait → stream.Close |
| A4.16 | `safeConn` — 동시 write 보호 | writeMsg, writePing, send 모두 mu.Lock |
| A4.17 | `safeConn.close` — underlying conn 닫기 | |

### A5. PaneManager (internal/server/pane.go)
| # | 동작 | 엣지/실패 케이스 |
|---|------|------------------|
| A5.1 | `NewPaneManager` — 초기화 | invalidator nil 허용 |
| A5.2 | `SetInvalidator` — 런타인 invalidator 등록 | |
| A5.3 | `Create` — ID 할당(nextID++) 및 StartPane 호출 | StartPane 실패 시 로그; dirty.Store(true); SaveAll 비동기 |
| A5.4 | `Restore` — 기존 ID로 StartPane, restored=true | nextID 동기화; 실패 시 에러 반환 |
| A5.5 | `Get` — ID로 pane 조회 | 없으면 nil |
| A5.6 | `List` — 정렬된 pane 목록 | PID 포함 |
| A5.7 | `Delete` — pane map에서 제거 후 kill | nil pane이어도 panic 없음; dirty.Store(true); SaveAll 비동기 |
| A5.8 | `IsLive` — pane 존재 여부 | |
| A5.9 | `SaveAll` — dirty=false면 스킵 | panes.json에 PaneState 배열 저장; 정렬 |
| A5.10 | `LoadAll` — panes.json 로드 및 Restore | 파일 없음 → 무시; unmarshal 실패 → 로그 |
| A5.11 | `Snapshot` — pane 포인터 복사본 반환 | |
| A5.12 | `ParseSize` — cols/rows 파싱 | 기본값 120x40; 0 또는 파싱 실패 시 기본값; 16비트 범위 |

### A6. CodeServerManager (internal/server/codeserver.go)
| # | 동작 | 엣지/실패 케이스 |
|---|------|------------------|
| A6.1 | `NewCodeServerManager` — 초기화 | |
| A6.2 | `Start` — code-server LookPath 실패 | |
| A6.3 | `Start` — folder 없으면 os.Getwd() | 파일이면 Dir로 변환 |
| A6.4 | `Start` — 소켓 파일 생성 및 프로세스 시작 | cmd.Start 실패 |
| A6.5 | `Start` — 소켓 준비 폴링 (15초 데드라인) | 타임아웃 시 프로세스 kill |
| A6.6 | `Start` — 리버스 프록시 설정 | Director로 Path 트림, Header 설정 |
| A6.7 | `Start` — 프로세스 종료 감시 고루틴 | 종료 시 자동 Stop |
| A6.8 | `List` — 정렬된 인스턴스 목록 | age(초) 포함 |
| A6.9 | `Get` — ID로 인스턴스 조회 | |
| A6.10 | `Touch` — LastPing 갱신 | 없는 ID → false |
| A6.11 | `Stop` — once.Do로 중복 방지 | SIGTERM → sleep 100ms → SIGKILL; 소켓 파일 삭제 |
| A6.12 | `StopAll` — 모든 인스턴스 종료 | |
| A6.13 | `Watchdog` — 30초 이상 heartbeat 없는 인스턴스 종료 | 5초 주기; 동시성 안전 |

### A7. CommandHub (internal/server/commands.go)
| # | 동작 | 엣지/실패 케이스 |
|---|------|------------------|
| A7.1 | `NewCommandHub` — 초기화 | |
| A7.2 | `add` — subscriber 추가 | |
| A7.3 | `remove` — once.Do로 done close | 중복 remove 안전 |
| A7.4 | `Broadcast` — 모든 subscriber에게 전달 | 채널 full 시 drop; delivered count 반환 |
| A7.5 | `AllowedAction` — 화이트리스트 확인 | |
| A7.6 | `handleCommandSSE` — SSE 스트림 | flusher 미지원 → 500; keepalive 15초; context done 시 종료 |
| A7.7 | `handleCommandPost` — 명령 브로드캐스트 | Method not allowed; JSON 파싱 실패; unknown action; 성공 시 delivered 반환 |

### A8. MCP (internal/server/mcp.go)
| # | 동작 | 엣지/실패 케이스 |
|---|------|------------------|
| A8.1 | `handleMCPSSE` — SSE 연결 | flusher 미지원 → 500; CORS 헤더; endpoint 이벤트 전송 |
| A8.2 | `handleMCPSSE` — keepalive 15초 | |
| A8.3 | `handleMCPSSE` — 클라이언트 disconnect 처리 | |
| A8.4 | `handleMCPMessage` — POST만 허용 | 405 |
| A8.5 | `handleMCPMessage` — sessionId 검증 | 없으면 404 |
| A8.6 | `handleMCPMessage` — JSON 파싱 | 실패 → 400 |
| A8.7 | `handleMCPMessage` — 비동기 처리 (202 Accepted) | panic recover |
| A8.8 | `handleMCPRequest` — notification (ID 없음/"null") | 로그만 남기고 응답 없음 |
| A8.9 | `handleMCPRequest` — `initialize` | protocolVersion, capabilities, serverInfo |
| A8.10 | `handleMCPRequest` — `tools/list` | Tools nil → 빈 배열 |
| A8.11 | `handleMCPRequest` — `tools/call` | 파라미터 파싱 실패 → -32602; Tools nil → -32601; ErrUnknownTool → -32601; 기타 에러 → isError=true; 성공 → result |
| A8.12 | `handleMCPRequest` — `ping` | 빈 객체 |
| A8.13 | `handleMCPRequest` — unknown method | -32601 |
| A8.14 | `handleMCPRequest` — 응답 전송 타임아웃 | 5초; Done 체크 |

### A9. MCPSessionRegistry (internal/server/server.go)
| # | 동작 | 엣지/실패 케이스 |
|---|------|------------------|
| A9.1 | `NewMCPSessionRegistry` — 초기화 | |
| A9.2 | `New` — 랜덤 ID 생성, 세션 등록 | |
| A9.3 | `Get` — ID로 세션 조회 | 없으면 nil |
| A9.4 | `Close` — once.Do로 Done close 및 map에서 삭제 | nil 세션 → no-op |

---

## B. 도메인/유틸리티 (internal/)

### B1. Outbuf Stream (internal/outbuf/stream.go)
| # | 동작 | 엣지/실패 케이스 |
|---|------|------------------|
| B1.1 | `NewStream` — context 기반 취소 | parent Done 시 내부 cancel |
| B1.2 | `Feed` — 버퍼에 append | totalIn 증가 |
| B1.3 | `Feed` — max 초과 시 compaction | len(buf) > 2*max일 때만 over만큼 잘라냄; dropped 반환; totalDrop 증가 |
| B1.4 | `Feed` — max~2*max 구간 유지 | Snapshot 시점에 잘리지만 Feed에서는 drop 카운트 안함 |
| B1.5 | `Snapshot` — tail 복사 | max 이상이면 최근 max만; Stats 반환 |
| B1.6 | `Snapshot` — 동시성 안전 | mu.Lock |
| B1.7 | `Len` — 현재 유지 바이트 수 | mu.Lock |
| B1.8 | `Close` — cancel 및 buf nil | 이후 호출 no-op |

### B2. Workspace Manager (internal/workspace/manager.go)
| # | 동작 | 엣지/실패 케이스 |
|---|------|------------------|
| B2.1 | `New` — store.Read | 파일 없음 → data=nil; 기타 에러 → 반환; buildIndex 실패 → emptyIndex |
| B2.2 | `writer` — writeCh 소비 | 에러 로그; done 시 pending drain 후 종료 |
| B2.3 | `enqueueWrite` — latest-wins | size-1 버퍼; block 시 기 queued blob drop |
| B2.4 | `Close` — closedOnce로 중복 방지 | wg.Wait; 이후 Save는 메모리만 업데이트 |
| B2.5 | `CurrentRev` — atomic 읽기 | |
| B2.6 | `Raw` — atomic 읽기 | nil pointer 처리 |
| B2.7 | `Save` — mu.Lock, If-Match 검증 | 빈 ifMatch → 검증 skip; 불일치 → ErrStale; 파싱 실패 → 에러; rev 증가; enqueueWrite |
| B2.8 | `Resolve` — 숫자 ID | live 체크; 없으면 에러 |
| B2.9 | `Resolve` — 라벨 해석 | labelToID 매핑; live 체크; 없으면 에러 |
| B2.10 | `Resolve` — 빈 ID | 에러 |
| B2.11 | `Labels` — 복사본 반환 | nil index → 빈 맵 |
| B2.12 | `Entries` — 복사본 반환 | nil index → nil |
| B2.13 | `InvalidatePane` — 현재는 no-op | |
| B2.14 | `buildIndex` — 빈 blob → emptyIndex | |
| B2.15 | `buildIndex` — JSON 파싱 | 실패 → 에러 |
| B2.16 | `buildIndex` — 라벨 생성 규칙 | S{session+1}.P{region+1}.T{tab+1} |
| B2.17 | `buildIndex` — IsActive 판정 | activeSession + focusedRegion + activeTab |
| B2.18 | `collectRegions` — region 타입 수집 | split 타입은 재귀 |

### B3. MCP Tool Registry (internal/mcptool/registry.go)
| # | 동작 | 엣지/실패 케이스 |
|---|------|------------------|
| B3.1 | `NewRegistry` — 초기화 | |
| B3.2 | `Register` — 동일 이름 덮어쓰기 | |
| B3.3 | `Names` — 정렬된 이름 목록 | |
| B3.4 | `Dispatch` — 등록된 도구 호출 | 없으면 ErrUnknownTool |
| B3.5 | `List` — 정렬된 spec 목록 | |
| B3.6 | `TextResult` — 표준 콘텐츠 봉투 | |
| B3.7 | `Textf` — 포맷팅 헬퍼 | |
| B3.8 | `ErrorResult` — isError=true 봉투 | |
| B3.9 | `genericTool.Call` — JSON unmarshal | 빈 raw → zero value; 파싱 실패 → ErrorResult |
| B3.10 | `Register[A any]` — 제네릭 등록 | |
| B3.11 | `WithRemoteAddr/RemoteAddrFromContext` — context 값 전달 | 없으면 빈 문자열 |

### B4. MCP Tools (internal/mcptool/tools/)
| # | 동작 | 엣지/실패 케이스 |
|---|------|------------------|
| B4.1 | `list_panes` — Pane 목록 + 라벨 | |
| B4.2 | `read_pane_screen` — Snapshot 반환 | pane 없음; base64 인코딩; bytesDrop 포함 |
| B4.3 | `read_pane_output` — Snapshot 반환 | pane 없음; lines 파라미터; ansi 필터링 |
| B4.4 | `send_input` — 텍스트 입력 | pane 없음; submit 시 \r 추가 |
| B4.5 | `send_agent_message` — 에이전트 메시지 전송 | pane 없음; commandHub Broadcast |
| B4.6 | `who_am_i` — 클라이언트 PID → pane 매칭 | clientPID 조회 실패; 조상 체인 32단계; 매칭 실패 |
| B4.7 | `workspace_command` — 허용된 액션 브로드캐스트 | unknown action 거부 |

### B5. Adapters (internal/adapters/)
| # | 동작 | 엣지/실패 케이스 |
|---|------|------------------|
| B5.1 | `Pane.List` — mcptool.PaneInfo 변환 | |
| B5.2 | `Pane.Has` — 존재 여부 | |
| B5.3 | `Pane.Snapshot` — 데이터 + bytesDrop | pane/stream nil → false |
| B5.4 | `Pane.Size` — pty.Getsize | pane/ptmx nil → "?"; 에러 → "?" |
| B5.5 | `Pane.SendPaste` — bracketed paste | pane 없음; submit 시 120ms sleep + \r |
| B5.6 | `Workspace.Resolve/Labels/Entries` — 위임 | |
| B5.7 | `Command.AllowedAction/Broadcast` — 위임 | |
| B5.8 | `Client.ResolveClientPane` — PID 매칭 | clientPID 조회 실패; 조상 체크 32회; 매칭 실패 |

### B6. Runtime Install (internal/runtime/install.go)
| # | 동작 | 엣지/실패 케이스 |
|---|------|------------------|
| B6.1 | `Install` — binDir 생성 | MkdirAll 실패 |
| B6.2 | `Install` — scripts/ WalkDir | |
| B6.3 | `Install` — 디렉터리 복제 | MkdirAll |
| B6.4 | `Install` — 파일 복사 + 권한 | 확장자 없거나 .sh → 0755; 그 외 → 0644 |
| B6.5 | `Install` — 하위 디렉터리 파일 | dst 상위 디렉터리 생성 |

### B7. ClientPID (internal/clientpid/)
| # | 동작 | 엣지/실패 케이스 |
|---|------|------------------|
| B7.1 | `FromRemoteAddr` — TCP 연결에서 PID 조회 | |
| B7.2 | `Parent` — 부모 PID 조회 | 1 이하이면 중단 |

---

## C. 프론트엔드 (web/app.js)

### C1. TermPane — WebSocket 생명주기
| # | 동작 | 엣지/실패 케이스 |
|---|------|------------------|
| C1.1 | `constructor` — DOM 생성 및 drag&drop 이벤트 | |
| C1.2 | `open` — xterm.js 초기화 | 이미 opened면 skip; 애드온(fit, web-links, unicode11, search) 로드 |
| C1.3 | `open` — 키 이벤트 핸들러 | Shift+Enter → ESC+CR; Cmd+Arrow → Home/End; Alt+Arrow → word jump; Ctrl+ shortcuts → preventDefault |
| C1.4 | `open` — onData 핸들러 | mobile sticky modifier 적용; 인코딩; OP.INPUT 프리픽스 |
| C1.5 | `open` — onResize 핸들러 | OP.RESIZE + cols/rows (BigEndian) |
| C1.6 | `connect` — WebSocket 연결 | paneID 포함; binaryType='arraybuffer'; onopen 시 resize 재전송 |
| C1.7 | `connect` — onmessage: OP.OUTPUT | `_handleOutput` 호출 |
| C1.8 | `connect` — onmessage: OP.SID | id 갱신, dataset.pid 갱신 |
| C1.9 | `connect` — onmessage: OP.EXIT | exited 메시지 출력 |
| C1.10 | `connect` — onmessage: OP.ERROR | 에러 메시지 출력(빨강) |
| C1.11 | `connect` — onclose/onerror | destroyed 아니면 overlay + 재연결 |
| C1.12 | `_scheduleReconnect` — 중복 방지 | `_reconnectPending` 플래그; pendingWs 정리; decoder 리셋 |
| C1.13 | `_reconnect` — 지수 백오프 | 1초 시작, 1.5배, 최대 30초 |
| C1.14 | `_reconnect` — pendingWs 교체 | 새 WS 열기; onopen에서 this.ws 교체; onclose에서 재시도 |
| C1.15 | `write` — term.write 또는 버퍼 | term 없으면 _buf에 누적 |
| C1.16 | `doFit` — fitAddon.fit | |
| C1.17 | `focus` — term.focus | |
| C1.18 | `_showOverlay/_hideOverlay` — 연결 상태 UI | |

### C2. TermPane — 출력 처리
| # | 동작 | 엣지/실패 케이스 |
|---|------|------------------|
| C2.1 | `_handleOutput` — stream:true UTF-8 decode | fatal=false; multibyte 상태 보존 |
| C2.2 | `_handleOutput` — flush 스케줄링 | 이미 scheduled면 skip; setTimeout 0 |
| C2.3 | `_doFlush` — 777 escape 파싱 | Download, Cwd, OpenCodeServer, CodeServerList |
| C2.4 | `_doFlush` — escape 제거 후 term.write | clean 텍스트 |
| C2.5 | `_doFlush` — term 없으면 _buf에 누적 | |
| C2.6 | `_onCwd` — app._cwd 갱신 및 상태바 업데이트 | |
| C2.7 | `_downloadFile` — anchor 클릭 트리거 | download 속성; 터미널에 로그 |
| C2.8 | `_openCodeServer` — window.open | 성공 시 codeServerTrack; 실패 시 터미널에 URL 출력 + pending |
| C2.9 | `_listCodeServers` — 터미널에 테이블 렌더링 | 빈 목록; 코드서버 링크 클릭 가능 |
| C2.10 | `_uploadFiles` — FormData POST /api/upload | cwd 기반 dir; 성공/실패 터미널 출력 |

### C3. Code Server Tracker (web/app.js)
| # | 동작 | 엣지/실패 케이스 |
|---|------|------------------|
| C3.1 | `codeServerTrack` — 중복 ID 처리 | 기존 타이머 정리, 기존 창 닫기 |
| C3.2 | `codeServerTrack` — heartbeat 10초 | POST /api/code-server/heartbeat |
| C3.3 | `codeServerTrack` — poll 1초 | 창 닫히면 stop 호출 |
| C3.4 | `beforeunload` — 모든 code-server stop | sendBeacon |
| C3.5 | `codeServerPending` — 팝업 차단 폴백 | URL 클릭 시 id 매핑 |

### C4. 테마 시스템 (web/app.js)
| # | 동작 | 엣지/실패 케이스 |
|---|------|------------------|
| C4.1 | `applyThemeObj` — CSS 변수 적용 | --bg, --sidebar-bg, --border, --accent, --text, --text-muted, --text-bright, --text-dim, --danger, --accent-border, --accent-hover, --accent-active, --accent-subtle |
| C4.2 | `applyThemeObj` — 터미널 테마 동기화 | 모든 pane.term.options.theme 갱신 |
| C4.3 | `getCurrentTheme` — customTheme 우선 | 없으면 THEMES[currentThemeName] |
| C4.4 | THEMES 객체 — 21개 기본 테마 | 각 테마는 ui + terminal 속성 |
| C4.5 | 커스텀 테마 편집 — UI/Terminal 색상 | 동적 DOM 생성; localStorage 저장 |

### C5. 단축키 (web/app.js)
| # | 동작 | 엣지/실패 케이스 |
|---|------|------------------|
| C5.1 | `parseShortcut` — 문자열 파싱 | Ctrl/Alt/Meta/Shift + Key |
| C5.2 | `matchShortcut` — KeyboardEvent 매칭 | code 기준 |
| C5.3 | `fmtShortcut` — 이벤트를 문자열로 | |
| C5.4 | `displayKey` — 가독성 변환 | Key/BracketLeft/BracketRight/Arrow 제거; 기호 변환 |
| C5.5 | 기본 단축키 13개 | sessionNext/Prev, tabNext/Prev, paneUp/Down/Left/Right, splitH/V, newSession/Tab, closeSession/Tab |
| C5.6 | 단축키 설정 저장/로드 | localStorage |

### C6. 설정 모달 (web/app.js)
| # | 동작 | 엣지/실패 케이스 |
|---|------|------------------|
| C6.1 | 모달 열기/닫기 | overlay 클릭, close 버튼 |
| C6.2 | 탭 전환 — Theme/Shortcuts/Status Bar/Presets/Display | active 클래스 토글 |
| C6.3 | Theme 탭 — 테마 목록 + 프리뷰 | 클릭 시 즉시 적용 |
| C6.4 | Custom Theme — 토글 + 색상 편집 | UI/Terminal 분리 |
| C6.5 | Shortcuts 탭 — 단축키 표시 및 재정의 | 키 캡처 |
| C6.6 | Status Bar 탭 — 항목별 on/off | |
| C6.7 | Presets 탭 — 프리셋 목록 + 저장 | 현재 레이아웃 저장 |
| C6.8 | Display 탭 — 모드(Auto/Desktop/Mobile), breakpoint | localStorage 저장 |

### C7. 레이아웃/세션 (web/app.js)
| # | 동작 | 엣지/실패 케이스 |
|---|------|------------------|
| C7.1 | 세션 생성 — `newSession` | 기본 레이아웃(단일 region) |
| C7.2 | 세션 삭제 — `closeSession` | 마지막 세션 방지 |
| C7.3 | 세션 전환 — `sessionNext/Prev` | 순환 |
| C7.4 | 탭 생성 — `newTab` | 현재 region에 추가; 새 pane API 호출 |
| C7.5 | 탭 삭제 — `closeTab` | 마지막 탭이면 region 제거; pane delete API 호출 |
| C7.6 | 탭 전환 — `tabNext/Prev` | 순환 |
| C7.7 | Split H/V — 현재 탭을 분할 | 새 pane API 호출; layout 트리 업데이트 |
| C7.8 | Pane 포커스 이동 — `paneUp/Down/Left/Right` | 인접 pane으로 포커스 |
| C7.9 | Region 트리 — Split/Region 노드 | direction(h/v), children, tabs, activeTab |
| C7.10 | 드래그 앤 드롭 — 탭 이동 | region 간 이동; 순서 변경 |
| C7.11 | 프리셋 저장 — 현재 layout 트리 직렬화 | name 입력; layoutPresets 배열에 추가 |
| C7.12 | 프리셋 로드 — 저장된 트리 복원 | pane 생성 필요 시 API 호출 |
| C7.13 | FocusedRegion 추적 | 현재 포커스된 region ID |
| C7.14 | ActiveSession 추적 | 현재 활성 세션 ID |

### C8. 상태바 (web/app.js)
| # | 동작 | 엣지/실패 케이스 |
|---|------|------------------|
| C8.1 | 연결 상태 표시 | WS onopen/onclose 기반 |
| C8.2 | 레이턴시 측정 | 주기적 ping 또는 API 응답 시간 |
| C8.3 | 위치(MCP id) 표시 | 현재 활성 pane의 label |
| C8.4 | CWD 표시 | pane의 _cwd |
| C8.5 | 메모리 사용량 | /api/stats의 memUsed |
| C8.6 | 호스트명 | /api/stats의 hostname |
| C8.7 | CPU | /api/stats의 cpu |
| C8.8 | 디스크 | /api/stats의 diskPct |
| C8.9 | 터미널 크기 | term.cols × term.rows |
| C8.10 | 업타임 | /api/stats의 sysUptime/srvUptime |
| C8.11 | 주기적 갱신 | statsInterval(기본 3000ms) |
| C8.12 | 항목별 on/off | 설정에 따른 표시/숨김 |

### C9. 검색 (web/app.js)
| # | 동작 | 엣지/실패 케이스 |
|---|------|------------------|
| C9.1 | 검색창 토글 | hidden 클래스 |
| C9.2 | 검색어 입력 | 실시간 검색 |
| C9.3 | 이전/다음 결과 | Shift+Enter / Enter |
| C9.4 | 대소문자 구분 토글 | caseSensitive 옵션 |
| C9.5 | 결과 개수 표시 | |
| C9.6 | 닫기 | Esc |

### C10. 사이드바 (web/app.js)
| # | 동작 | 엣지/실패 케이스 |
|---|------|------------------|
| C10.1 | 세션 목록 표시 | 이름 + 활성 표시 |
| C10.2 | 세션 클릭 — 전환 | |
| C10.3 | `+ New` 버튼 — 새 세션 | |
| C10.4 | `★ Preset` 버튼 — 프리셋으로 새 세션 | defaultPreset |
| C10.5 | 리사이징 핸들 — 드래그 | localStorage에 sidebarWidth 저장 |
| C10.6 | 모바일 — drawer 토글 | backdrop, swipe |

### C11. 모바일 UI (web/app.js)
| # | 동작 | 엣지/실패 케이스 |
|---|------|------------------|
| C11.1 | 반응형 레이아웃 — breakpoint 기반 | Auto 모드: viewport width < breakpoint |
| C11.2 | 모바일 전용 버튼 — pane prev/next, search, add tab, drawer | |
| C11.3 | 가상 키보드 — sticky Ctrl/Alt | toggle/lock 모드 |
| C11.4 | 모바일 키보드 바 | 동적 생성 |

### C12. 파일 업로드/다운로드 (web/app.js)
| # | 동작 | 엣지/실패 케이스 |
|---|------|------------------|
| C12.1 | Drag & Drop — 파일 업로드 | dragover 시 dragover 클래스; drop 시 FormData POST; 성공/실패 메시지 |
| C12.2 | 다운로드 링크 — anchor 클릭 | /api/download?path= |

### C13. 포커스 이동 및 상태 동기화 (핵심)

> 새탭/새 pane/새 세션/분할/닫기/전환 시 `app.focused`, `session.focusedRegion`, `activeSession`, `rg.activeTab`, DOM, 상태바, 검색, 모바일 인덱스가 일관되게 업데이트되는지 검증.
> **코드상 버그로 인해 `session.focusedRegion`이 동기화되지 않는 경우가 다수 있음** — 테스트에서 반드시 감지해야 함.

| # | 동작 | 업데이트 되어야 할 대상 | 엣지/실패 케이스 |
|---|------|------------------------|------------------|
| C13.1 | `_mkSession` (새 세션) | `activeSession` = 새 세션, `focused` = 새 region, **(버그) `session.focusedRegion` 미설정**, DOM `.rg.focused`, 상태바 갱신 | 세션 0개 상태에서 생성; render 호출 |
| C13.2 | `addTab` (새 탭, terminal) | `rg.activeTab` = 새 탭, `focused` 유지(같은 region), pane 생성 및 연결, `_save` | region 없음; refPane CWD 상속 |
| C13.3 | `addTab` (새 탭, markdown) existing | `activeSession` = existing 세션, `existing.region.activeTab` = existing 탭, `focused` = existing.region, **이전 세션 `focusedRegion` = 현재 `focused` 저장**, viewer.refresh | 동일 파일 이미 열림; 세션 전환 발생 |
| C13.4 | `addTab` (새 탭, markdown) 신규 | `rg.activeTab` = 새 탭, MdViewer 생성, render | filePath 없음 |
| C13.5 | `split` (keepFocus=false) | `focused` = 마지막 새 region, `activeSession` = targetSession(변경 시), **(버그) `session.focusedRegion` 동기화 누락**, DOM 리사이즈 핸들러 부착 | mobile이면 split 금지(force 제외); count<2 → 2 |
| C13.6 | `split` (keepFocus=true) | `focused` 유지, **(버그) `session.focusedRegion` 동기화 누락**, 새 region만 추가 | 다른 세션 대상 split 시에도 focused 유지 |
| C13.7 | `closeTab` — 마지막 탭 아님 | `rg.activeTab` = 남은 첫 탭, `focused` 유지 | **terminal 탭만 busy 확인 및 confirm**; markdown은 즉시 닫힘 |
| C13.8 | `closeTab` — 마지막 탭 (region 제거) | `focused` fallback: closest region 또는 firstRg, **(버그) 새 activeSession의 `focusedRegion` 미설정**, 비활성 세션의 focusedRegion도 업데이트 | 세션 전체 삭제(delSession) 트리거; pane _killBg |
| C13.9 | `switchSession` | 이전 세션 `focusedRegion` 저장, `activeSession` 변경, `focused` = saved focusedRegion 또는 firstRg, `_mPaneIdx=0`, drawer 닫기 | 동일 세션 클릭 시 mobile drawer만 닫기 |
| C13.10 | `setFocus` | `app.focused`, `_prevFocus`(**render에서만 갱신, setFocus에서는 불일치 가능**), `session.focusedRegion`, DOM `.rg.focused` 토글, `_clearAllSearchDecorations`, `_researchIfOpen`, `_updateCwd`, `_updateStatusBar`, `_save` | 이미 동일 region이면 early return |
| C13.11 | `_focusLocation` (리모트) | `activeSession` 변경(필요 시), **이전 세션 `focusedRegion` 저장**, `rg.activeTab` = 지정 탭, `session.focusedRegion` = 지정 region, `focused` = 지정 region, `_save`, `render` | 잘못된 location 형식; 없는 session/region/tab |
| C13.12 | `_execRemote` + keepFocus | `savedSession`, `savedFocused` 저장 → 액션 실행 → 복원 → `_save` | `splitH`/`splitV`에서만 keepFocus 의미 있음; `location` 지정 `closeTab`은 항상 포커스 유지; 나머지 action의 keepFocus 무의미 |
| C13.13 | `navMobilePane` | `_mPaneIdx` 증감, `focused` = 해당 region, `session.focusedRegion` 동기화, `_save`, `render` | 순환; paneCount<=1이면 no-op |
| C13.14 | `render` — `_prevFocus` ≠ `focused` | `_clearAllSearchDecorations`, `_researchIfOpen` 호출(setFocus에서도 중복 호출 가능) | |
| C13.15 | `render` — mobile 모드 | `_mPaneIdx` 동기화(`focused` 기준), `focused` 재조정, 단일 region만 DOM에 표시 | |
| C13.16 | `render` — focus 복원 | `requestAnimationFrame` 후 활성 탭의 term.focus() 또는 mdViewer.el.focus() | markdown vs terminal 구분 |
| C13.17 | **모바일↔데스크톱 전환** | `_applyMobileMode` 호출, `_mPaneIdx` 재조정, `focused`가 유효한 region을 가리키는지, DOM 리렌더 | viewport resize 이벤트 |

---

## D. 통합/인수 테스트

### D1. E2E 시나리오
| # | 시나리오 | 검증 포인트 |
|---|----------|-------------|
| D1.1 | 서버 시작 → 브라우저 접속 → 새 세션 → 명령 실행 | WS 연결, 출력 수신, 상태바 갱신 |
| D1.2 | Pane 분할 → 탭 이동 → Pane 닫기 | layout 트리 일관성, API 호출 |
| D1.3 | 브라우저 새로고침 → 기존 Pane 재연결 | snapshot 수신, 출력 연속성 |
| D1.4 | code-server `edit <path>` 실행 → VSCode 열기 → 닫기 | 프로세스 시작, heartbeat, 종료 |
| D1.5 | 파일 드래그앤드롭 업로드 → 터미널에서 확인 | API 호출, 파일 존재 |
| D1.6 | `download <path>` 실행 → 브라우저 다운로드 | escape 시퀀스 파싱, anchor 클릭 |
| D1.7 | MCP tools/list → tools/call 흐름 | SSE 연결, JSON-RPC, 응답 수신 |
| D1.8 | workspace PUT → If-Match 충돌 → 재시도 | 409 응답, ETag 갱신 |
| D1.9 | settings 저장/로드 | 파일 영속화, 페이지 새로고침 후 복원 |
| D1.10 | 테마 변경 → 터미널 색상 동기화 | CSS 변수, term.options.theme |

### D2. 성능/부하
| # | 항목 | 기준 |
|---|------|------|
| D2.1 | WebSocket 메시지 처리 지연 | 키 입력 → PTY write < 10ms |
| D2.2 | 대용량 출력 스트림 | 1MB+ 출력 시 버퍼 compaction 정상 |
| D2.3 | 동시 pane 10개 생성/삭제 | race condition 없음 |
| D2.4 | SSE subscriber 10명 브로드캐스트 | drop 없음 |

---

## E. 프론트엔드 E2E 테스트 계획 (Playwright)

> **方針**: Go 서버를 `testserver` 패키지로 프로그래밍 방식 기동 → Playwright로 브라우저 제어 → 실제 DOM/Network/WebSocket 검증.  
> **위치**: `web/e2e/`  
> **도구**: `@playwright/test`, Go `testserver` 헬퍼 (`internal/server` 직접 인스턴스화)

### E1. 기본 연결 및 생명주기
| # | 테스트 | 검증 방법 |
|---|--------|-----------|
| E1.1 | 서버 기동 → `/` 접속 → 초기 세션 1개 확인 | `#area .rg` 존재, `.rg-tabs .rt` 1개, `.rg.focused` 존재 |
| E1.2 | WebSocket 연결 상태 — 상태바 "연결됨" | `#status-bar` 텍스트 포함 |
| E1.3 | 터미널에 `echo hello` 입력 → 출력 확인 | `page.evaluate(() => app.panes.get(id).term.buffer.active.getLine(0).translateToString())` 로 xterm 버퍼 직접 읽기 |
| E1.4 | 페이지 새로고침 → 기존 pane 재연결 | 세션 이름 유지, WS 메시지에서 snapshot 수신 (Network/WS 로그) |

### E2. 포커스 이동 (사용자 요구 핵심)
| # | 테스트 | 검증 방법 |
|---|--------|-----------|
| E2.1 | **새 세션 생성** → 포커스 이동 | `+ New` 클릭 → `.rg.focused` 개수=1, active 세션 이름 변경, 상태바 CWD 초기화, **`session.focusedRegion` 누락 여부** (API PUT body에서 검증) |
| E2.2 | **새 탭 생성** → 포커스 이동 | region 내 `+` 버튼 클릭 → `.rt.active` = 새 탭, `.rg.focused` 유지, 이전 탭 비활성화 |
| E2.3 | **Split H** → 포커스 우측 이동 / **Split V** → 포커스 하단 이동 | `Split H` → `.rg` 개수=2, `.rg.focused` = 우측(신규); `Split V` → `.rg.focused` = 하단(신규) |
| E2.4 | **Split (keepFocus)** → 포커스 유지 | dmctl/SSE로 `splitV` + keepFocus → `.rg.focused` = 기존 region 유지, API PUT body에서 `focusedRegion` 변경 없음 확인 |
| E2.5 | **탭 닫기** — 마지막 탭 아님 | `×` 클릭 → `.rt.active` = 남은 탭, `.rg.focused` 유지 |
| E2.6 | **탭 닫기** — 마지막 탭 (region 제거) | 유일한 탭 `×` 클릭 → `.rg` 개수 감소, `.rg.focused` = fallback region, activeSession 유지, **새 activeSession의 `focusedRegion` 설정 여부** 확인 |
| E2.7 | **세션 전환** → 포커스 복원 | 사이드바 세션 클릭 → `.si.active` 변경, `#area` 재렌더, `.rg.focused` = 해당 세션의 focusedRegion |
| E2.8 | **setFocus** — region mousedown | 비활성 region 클릭 → `.rg.focused` 이동, API PUT body에서 `focusedRegion` 동기화 확인 |
| E2.9 | **_focusLocation** — 리모트 포커스 | SSE `focus` 명령 수신 → 지정 location으로 `.rg.focused` 이동, `activeTab` 변경, 이전 세션 `focusedRegion` 저장 확인 |
| E2.10 | **검색 열린 상태에서 포커스 이동** | 검색창 열림 + pane 전환 → `page.evaluate(() => app.panes.get(id).search.decorations?.length)` 로 초기화 확인, 새 pane에서 재검색 |
| E2.11 | **모바일 pane 전환** | viewport 축소 + `›` 클릭 → `.rg.focused` 이동, `_mPaneIdx` 동기화(표시 `2/2`) |
| E2.12 | **모바일↔데스크톱 전환** 포커스 일관성 | viewport resize → `body.mobile` 토글, `_mPaneIdx` 재조정, `.rg.focused`가 유효한 region 가리킴 |

### E3. DOM/레이아웃 동기화
| # | 테스트 | 검증 방법 |
|---|--------|-----------|
| E3.1 | Split 리사이저 드래그 → flex 비율 변경 | `.sh` 드래그 → `.sc` style.flex 변경, `_save` API 호출(body에 sizes 포함) |
| E3.2 | 탭 drag & drop — 같은 region 내 순서 변경 | `.rt` 드래그 → 순서 변경, `.rt.active` 유지 |
| E3.3 | 탭 drag & drop — 다른 region으로 이동 | source → target region body drop → source region의 `.rg` 제거/축소, target에 탭 추가 |
| E3.4 | 세션 목록 drag & drop 순서 변경 | `.si` 드래그 → 세션 순서 변경, `_save` 호출 |
| E3.5 | 사이드바 리사이즈 → CSS 변수 `--sb-w` | `#sb-handle` 드래그 → `documentElement` style 확인, localStorage `sidebarWidth` |

### E4. 설정 및 테마
| # | 테스트 | 검증 방법 |
|---|--------|-----------|
| E4.1 | 테마 변경 → CSS 변수 + 터미널 theme 동시 변경 | `#panel-theme` 클릭 → `getComputedStyle(document.documentElement)` 값 변경, `page.evaluate(() => app.panes.get(id).term.options.theme.background)` 로 JS 상태 확인 |
| E4.2 | 단축키 재정의 → 즉시 적용 | 설정 모달 → 단축키 녹화 → 새 단축키로 액션 실행 |
| E4.3 | 설정 저장 → 서버 `/api/settings` PUT | 설정 변경 후 PUT 호출, 새로고침 후 복원 |
| E4.4 | 커스텀 테마 편집 → 실시간 미리보기 | 색상 picker 변경 → CSS 변수 즉시 반영 |

### E5. code-server 및 파일
| # | 테스트 | 검증 방법 |
|---|--------|-----------|
| E5.1 | `edit .` 실행 → code-server 시작 | 터미널에 `edit .` 입력 → `/api/code-server` POST, `/api/code-server` GET 목록에 추가 |
| E5.2 | code-server 종료 — poll 기반 | 팝업/창 객체 조작 불가 → 대신 heartbeat 미전송 30초 후 `/api/code-server` GET 목록에서 제거 확인 (백엔드 Watchdog) |
| E5.3 | 파일 드래그앤드롭 업로드 | 파일 드래그 → `.dragover` 클래스 → drop → `/api/upload` POST, 터미널에 성공 메시지 (xterm 버퍼 확인) |
| E5.4 | `download <path>` → 다운로드 트리거 | `page.evaluate(() => app.panes.get(id)._downloadFile('/tmp/test.txt'))` 로 내부 함수 직접 호출 → `page.waitForEvent('download')` 또는 anchor href 확인 |
| E5.5 | 마크다운 뷰어 열기/링크 클릭 | `openMdTab` → `.md-viewer` DOM 생성, 내부 `.md` 링크 클릭 시 새 마크다운 탭 생성 |

### E6. MCP/리모트 명령
| # | 테스트 | 검증 방법 |
|---|--------|-----------|
| E6.1 | SSE 연결 → `/api/commands/sse` | EventSource 연결, `workspace_changed` 이벤트 수신 후 `#area` DOM 구조가 서버 workspace와 동기화되는지 간접 검증 |
| E6.2 | dmctl → `splitH` 브로드캐스트 수신 → 실행 | 외부 HTTP POST → 브라우저 SSE 수신 → DOM에 새 `.rg` 생성 |
| E6.3 | `workspace_changed` 수신 시 로컬 상태 병합 | 다른 클라이언트에서 PUT → SSE 수신 → `#area` 재렌더, 기존 pane 유지 |

### E7. 동시성/충돌 시나리오
| # | 테스트 | 검증 방법 |
|---|--------|-----------|
| E7.1 | **두 브라우저 탭 동시 수정 → 409 Conflict** | 탭 A에서 split → 탭 B에서 탭 추가 → 탭 A `_save` 409 수신 → ETag 갱신 후 재시도 → 최종 동기화. **(버그) `this.ws`를 서버 값으로 병합하지 않고 덮어쓰는 문제** 감지 |
| E7.2 | 서버 재시작 → panes.json 복원 → 재연결 | 서버 프로세스 kill → 재시작 → 페이지 새로고침 → 기존 pane ID로 WS 연결, snapshot 수신 |
| E7.3 | WS 연결 끊김 → 재연결 오버레이 | 서버 일시 중지 → `.tp-overlay` "연결 끊김" 표시 → 서버 재개 → 재연결 및 오버레이 제거 |

---

## F. 기존 테스트 현황 (커버리지 기준)

| 파일 | 기존 테스트 | 추가 필요 |
|------|-------------|-----------|
| `internal/outbuf/stream_test.go` | Stream Feed/Snapshot/Len | Feed compaction edge, concurrent Feed+Snapshot |
| `internal/workspace/manager_test.go` | Save/Resolve/buildIndex | Close, enqueueWrite latest-wins, stale revision |
| `internal/runtime/install_test.go` | Install | 권한 결정, 하위 디렉터리 |
| `internal/server/di_test.go` | DI | |
| `internal/server/server_test.go` | | **대부분 미커버** |
| `internal/server/pane_exit_test.go` | | **미커버** |
| `internal/server/fakes_test.go` | fake 구현 | |
| `internal/mcptool/registry_test.go` | Registry | genericTool, context |
| `web/` | | **전체 미커버** |
