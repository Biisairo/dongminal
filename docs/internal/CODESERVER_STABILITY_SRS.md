# Code-Server Stability SRS (L7)

> Format: IEEE 29148:2018 §9 (Software Requirements Specification)

## 1. Introduction

### 1.1 Purpose
TODO #15 (code-server 연동) 출시 이후 관찰된 두 종류의 회귀를 단일 SRS 로 통합하여 해결한다.

1. 의도치 않은 code-server 창 열림(spurious window opens).
2. 정상적으로 떠 있던 code-server 창이 갑작스럽게 끊기는 현상(unexpected disconnects).

본 SRS 는 변경 범위, 기능 요구사항(FR), 비기능 요구사항(NFR), 검증 방법을 명시한다.

### 1.2 Scope
| 계층 | 파일 |
|---|---|
| 백엔드 (Go) | `internal/server/codeserver.go`, `internal/server/handlers_ws.go`, `internal/server/handlers_api.go` |
| 백엔드 테스트 | `internal/server/codeserver_test.go`, `internal/server/codeserver_shutdown_test.go`, `internal/server/handlers_ws_test.go` |
| 프론트엔드 (브라우저) | `web/app.js` |
| 런타임 바이너리 | (수정 없음 — `internal/runtimebin/edit.go` 는 응답 호환 유지) |

외부 API 표면: `POST /api/code-server`, `POST /api/code-server/heartbeat`, `POST /api/code-server/stop`, `GET /api/code-server`, `/cs/<id>/*` 의 응답 스키마는 **변경하지 않는다**. 동일 폴더 재요청 시 응답의 `id` 필드 값이 기존 인스턴스 ID 로 동일해질 수 있다는 점만 호환 가능한 변화이다.

### 1.3 Definitions, Acronyms
- **OSC 777**: dongminal 이 사용하는 사설 OSC(Operating System Command) 시퀀스. 형식 `ESC ] 777 ; <cmd> ; <payload> BEL`. cmd ∈ {`OpenCodeServer`, `CodeServerList`, `Download`, `Cwd`}.
- **PTY snapshot**: `internal/outbuf.Stream.Snapshot()` 가 반환하는, pane 의 최근 출력 누적 버퍼. WebSocket 재연결/페이지 리로드 시 클라이언트로 일괄 송신된다.
- **watcher**: 프론트에서 `codeServerWatchers` 맵에 등록되는 `{win, hbTimer, pollTimer}` 트리플. code-server 창 1개당 1개.

### 1.4 References
- `docs/internal/CODESERVER_SHUTDOWN_SRS.md` (L6) — 종료 경로 정의(상속).
- `docs/internal/OUTBUF_BACKPRESSURE_SRS.md` — `outbuf.Stream` 의 single drop path 원칙(보존).
- `docs/internal/TODO.md` §15, §17 — 기능 도입 및 관련 회귀 히스토리.

## 2. Overall Description

### 2.1 Problem Analysis (현황)
| ID | 분류 | 원인 | 사용자 증상 |
|----|------|------|-------------|
| P1 | spurious-open | `Pane.broadcast` 가 PTY 원본을 OSC 포함 그대로 stream 에 적재 → WS 재연결 시 snapshot 송출 → 프론트가 OSC 를 *다시* 실행 | 한 번 `edit` 했을 뿐인데 페이지 리로드/재연결마다 새 code-server 창이 또 열림 |
| P2 | disconnect | 동일 id 로 `codeServerTrack` 가 재호출되면 `prev.win.close()` 가 수행됨 | 잘 쓰고 있던 코드 창이 갑자기 닫힘 |
| P3 | disconnect | `beforeunload` 가 등록된 모든 watcher 에 `sendBeacon('/stop')` 송신 | 터미널 탭 새로고침 시 다른 창의 code-server 도 같이 죽음 |
| P4 | resource-leak | 같은 folder 에 대해 `edit` 두 번 시 인스턴스 누적 (cs1, cs2, ...) | 메모리/소켓 누수. 사용자 측면에서는 동일 폴더에 대해 창이 여러 개 떠 보임 |
| P5 | disconnect | 백그라운드 탭의 `setInterval` throttling 으로 10s 하트비트가 30s watchdog 임계 안에 도달하지 못함 | 잠시 다른 탭 보다가 돌아오면 code-server 가 502 |

### 2.2 Stakeholders / Sources
- 1차 사용자 보고 (2026-05-11): "코드 서버가 열리면 안 되는데 창을 열거나 코드 서버를 열었는데 갑자기 연결이 끊긴다."
- 기존 SRS — CODESERVER_SHUTDOWN_SRS.md 의 종료 경로는 보존.

### 2.3 Assumptions & Constraints
- A1. 사용자가 사용하는 브라우저는 `setInterval`/`navigator.sendBeacon`/`window.open`/Page Visibility API 표준을 지원하는 modern Evergreen 브라우저 (Chrome 88+, Firefox 100+, Safari 16+).
- A2. code-server 자체는 단일 폴더에 대해 다중 인스턴스를 요구하지 않는다 (멀티 워크스페이스가 필요하면 사용자가 명시적으로 다른 폴더 path 를 지정).
- A3. OSC 777 은 dongminal 만이 emit 한다 — 외부 프로그램이 임의로 emit 하지 않음.
- A4. PTY snapshot 의 단일 청크 안에 완성된 OSC 시퀀스가 포함되어 있다 (이는 readPTY 가 한 read 의 결과만 broadcast 하므로 일반적으로 참이지만, 본 SRS 는 **snapshot 단위로 strip** 하므로 청크 경계 의존이 없다).

## 3. Specific Requirements

### 3.1 Functional Requirements (FR)

#### FR-A1 OSC 777 strip on snapshot
`Pane.stream.Snapshot()` 의 출력은 `internal/server/handlers_ws.go` 의 snapshot 송출 경로(현 58:65 라인) 직전에 OSC 777 시퀀스가 모두 제거되어야 한다. 라이브 `broadcast(msg)` 경로는 변경하지 않는다.

규격:
- Strip 대상 정규식 동치: `\x1b\]777;[^\x07]*\x07` (Go: `regexp.MustCompile(`\x1b\]777;[^\x07]*\x07`)`).
- 함수 시그니처: `func stripOSC777(b []byte) []byte`.
- 입력에 시퀀스가 없으면 입력을 그대로(또는 동일 내용 슬라이스) 반환.
- 길이 비교 시 strip 이후 길이는 ≤ 입력 길이.

#### FR-A2 stripOSC777 단위 테스트
- 평문만 → 무변경.
- OSC 777 OpenCodeServer 한 개 → 해당 시퀀스만 제거, 주변 평문 보존.
- 다중 OSC 777 + 일반 ANSI escape(`\x1b[31m...\x1b[0m`) 혼재 → 777 만 제거, ANSI escape 보존.
- BEL 으로 종료되지 않은 미완성 시퀀스 → 변경 없이 그대로 통과 (스냅샷 직전 read 가 미완 OSC 를 잡았더라도 stale state 흘리지 않음).

#### FR-B1 beforeunload 일괄 stop 제거
`web/app.js` 의 `window.addEventListener('beforeunload', ...)` 블록에서 모든 watcher 에 대해 `navigator.sendBeacon('/api/code-server/stop', ...)` 를 호출하는 로직을 제거한다. code-server 창 자체의 `win.closed` 폴링이 종료 시점을 이미 권위 있게 결정하므로, 터미널 탭이 새로고침/닫히더라도 다른 창의 code-server 는 살아있어야 한다.

#### FR-C1 folder reuse
`CodeServerManager.Start(folder)` 는 다음을 만족해야 한다.
1. 입력 `folder` 를 `filepath.Abs` 로 정규화한 뒤(현행 로직 보존), 기존 인스턴스 중 동일한 정규화 folder 를 가진 항목이 있으면 **새 프로세스를 띄우지 않고** 해당 instance 의 `LastPing` 을 갱신해 반환한다.
2. 매핑은 별도 자료구조를 추가하지 않고 `insts` 순회로 처리해도 무방하다(인스턴스 수가 보통 1자리이므로 O(n) 허용).
3. 동시성: `m.mu` 잠금 안에서 lookup → 발견 시 즉시 반환. 미발견 시에만 lock 해제 후 신규 프로세스 spawn (현재 로직과 동일).
4. `info, err := os.Stat(folder)` 실패 시 새 프로세스 spawn 시도와 동일하게 에러 반환(현행 호환).

#### FR-D1 watchdog 임계값 + 즉시 hb
- `CodeServerManager.Watchdog` 의 staleness 임계값을 **30 초 → 90 초** 로 상향한다(상수 또는 package var 로 노출하여 테스트 단축 가능).
- 프론트 `web/app.js` 는 `document.addEventListener('visibilitychange', ...)` 를 추가하고, `document.visibilityState === 'visible'` 로 전환되는 순간 모든 활성 watcher 의 hb 를 **즉시 1회 트리거**한다.
- 기존 `setInterval(hb, 10000)` 주기는 유지한다(코드 변경 최소화 + 정상 케이스에서 충분).

#### FR-E1 codeServerTrack 멱등화
`codeServerTrack(id, win)` 가 동일한 `id` 에 대해 재호출될 때:
1. `prev.win === win` 이면 noop (기존 타이머 유지, 새 타이머 등록 없음).
2. `prev.win` 이 살아있고(`!prev.win.closed`) 새 `win` 도 살아있는 경우, **이전 win 을 close 하지 않는다**. 새 win 만 close 한다(중복 창 자동 정리). 그리고 기존 타이머는 그대로 유지.
3. `prev.win` 이 이미 닫힌 경우(`prev.win.closed`)에만 새 win 으로 교체한다 (현행 cleanup 로직 + 새 타이머 set).

이로써 #1·#2 의 연쇄(스냅샷 replay → spurious open → prev close) 가 발생해도 사용자 작업 중인 창은 보존된다.

#### FR-E2 OSC replay 안전화 (이중 안전선)
FR-A1 으로 서버측에서 strip 이 보장되더라도, 클라이언트는 한 세션 안에서 동일 `(id, csPath, folder)` 가 OSC 로 두 번 이상 들어와도 **2번째부터는 새 창을 열지 않는다**. 구현은 `_openCodeServer` 가 `codeServerWatchers.get(id)?.win?.closed === false` 이면 즉시 return.

### 3.2 Non-Functional Requirements (NFR)

- NFR-1 (회귀 없음). 기존 단위 테스트 (`go test ./...`) 전부 그린.
- NFR-2 (race-clean). 신규/수정 테스트는 `-race` 옵션에서 그린.
- NFR-3 (관측성). FR-C1 의 인스턴스 reuse 시 `log.Printf("[cs %s] reuse folder=%s", id, folder)` 한 줄 로그를 남긴다. FR-D1 의 watchdog kill 은 기존 메시지 유지.
- NFR-4 (외부 API 호환). `POST /api/code-server` 응답 스키마 변경 없음. 동일 폴더 재요청 시 `id` 가 기존 ID 로 같아질 수 있다는 점만 변경.
- NFR-5 (FR-A1 시간복잡도). `stripOSC777` 는 snapshot 송출 시점에 1회 실행되며, snapshot 크기는 `bufMax` (현행 2MB) 상한. O(n) 단일 패스 허용.

## 4. Verification (Test Plan)

### 4.1 새 테스트
| ID | 위치 | 테스트 | 검증 항목 |
|----|------|--------|----------|
| TC-A1-a | `internal/server/codeserver_test.go` | `TestStripOSC777_NoSequence` | 평문 입력 그대로 반환 |
| TC-A1-b | 〃 | `TestStripOSC777_RemovesOpenCodeServer` | OSC 777 OpenCodeServer 한 개 strip |
| TC-A1-c | 〃 | `TestStripOSC777_PreservesAnsiEscape` | 일반 `\x1b[...m` 보존 |
| TC-A1-d | 〃 | `TestStripOSC777_IncompleteSequenceUnchanged` | BEL 없는 미완성 OSC 는 strip 하지 않음 |
| TC-C1   | `internal/server/codeserver_test.go` | `TestCodeServerManager_Start_ReusesFolder` | 동일 folder 두 번 Start 시 동일 ID + insts 카운트 1 |
| TC-D1   | `internal/server/codeserver_test.go` | `TestWatchdogThreshold` | LastPing -60s 인 인스턴스는 살아있고, -120s 인스턴스는 stale 로 잡힘 |

`Start` 호출 자체는 `code-server` 바이너리 의존이라 통합 테스트가 어려우므로 TC-C1 는 `m.insts` 에 fixture 를 미리 넣고 `Start` 의 lookup 분기만 단위 시험한다.

### 4.2 기존 테스트
- `TestCodeServerManager_Watchdog` 가 30s 하드코딩을 검사하지 않도록 임계값 상수를 직접 참조하게 갱신한다(이미 인라인 30s 사용 — 갱신 필요).
- `TestCodeServerStop_WaitsForExit` 등 종료 경로 테스트 그대로 그린.

### 4.3 프론트 검증 (수동 + 시각 검사)
프론트는 단위 테스트가 없으므로 다음 시나리오로 수동 검증한다 (DoD 체크리스트).
- M1. `edit ~/foo` → 새 창. 터미널 탭 F5. → 추가 창이 열리지 않아야 함. (FR-A1, FR-E2)
- M2. `edit ~/foo` 두 번 연속 → 두 번째는 동일 ID 의 동일 창으로 focus, 새 창 안 뜸. (FR-C1 + FR-E1)
- M3. M1 결과 창에서 작업 중에 터미널 탭만 F5 → code-server 창 살아있음, 502 없음. (FR-B1)
- M4. M1 결과 창을 백그라운드로 두고 2분 대기 → 복귀 시 정상. (FR-D1)

## 5. Out of Scope
- HTTPS 환경에서의 `X-Forwarded-Proto` 정합성 (별도 follow-up).
- code-server 내부 graceful shutdown URL 호출 (L6 와 동일하게 범위 밖).
- 인증/권한 (현행 `--auth none`).
- `edit -l` 출력의 URL 누적(`codeServerPending` 맵 정리) — FR-E2 로 영향 무해화되므로 별도 처리 안 함.

## 6. Done Criteria
- [ ] FR-A1, FR-A2 구현 및 TC-A1-a~d 그린
- [ ] FR-B1 구현 (beforeunload 일괄 stop 제거)
- [ ] FR-C1 구현 및 TC-C1 그린
- [ ] FR-D1 백엔드 구현 및 TC-D1 그린, 프론트 visibilitychange 핸들러 추가
- [ ] FR-E1, FR-E2 프론트 구현
- [ ] `go build ./...` / `go vet ./...` / `go test ./... -race` 전부 그린
- [ ] TODO.md 에 본 SRS 완료 표기
