# SRS: 세션 무중단 재기동 (Hot Reload Without Session Disconnect, IEEE 29148 준수)

**상태**: PLANNED — 미구현. 본 문서는 향후 작업의 계획서이며 구현은 별도 일정에 진행한다.

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)
백엔드(Go) 코드 수정 후 서버를 재기동할 때 활성 PTY 세션과 WebSocket 클라이언트 연결이 끊기지 않도록 하기 위한 요구사항을 정의한다. 현재는 메인 서버 프로세스가 PTY 를 자식으로 보유하므로 재기동 시 모든 세션이 종료된다.

### 1.2 범위 (Scope)
- 대상: `cmd/dongminal/main.go`, `internal/server`, `internal/runtime`, `internal/adapters`(PTY 보유), `internal/outbuf`, `internal/workspace`
- 비대상(이미 동작): 프론트엔드(`web/`) 변경 시 브라우저 새로고침으로 충분 — `outbuf` ring 으로 스크롤백 복원, WebSocket 재연결 동작 검증됨.
- 비대상: 머신 재부팅, 강제 종료(SIGKILL), 컨테이너 환경 재배포.

### 1.3 정의 (Definitions)
- **PTY supervisor**: PTY 프로세스를 보유·관리하며 서버 재시작에 무관하게 살아남는 컴포넌트.
- **Graceful exec**: `syscall.Exec` 으로 새 바이너리를 동일 PID 위에 덮어써 fd 와 PTY 를 인계하는 기법.
- **Live fds**: 살려야 하는 파일 디스크립터 — listening socket, PTY master fd, outbuf 메모리(또는 직렬화 결과).
- **Reattach window**: 클라이언트 WebSocket 재연결 허용 시간 (예: 5초).

### 1.4 참조
- `internal/adapters/`: PTY 어댑터 위치
- `internal/outbuf/`: 스크롤백 ring buffer
- `MD_VIEWER_REGRESSION_FIX_SRS.md`: 프론트엔드 회귀 수정 사례
- POSIX 표준 SCM_RIGHTS, `tmux(1)`, `dtach(1)` 의 detach 모델

## 2. 배경 (Background)

### 2.1 현재 구조
```
main(go) ─ PTY children(zsh, bash...)
         └ http listener
         └ WebSocket clients
```
서버 종료 → SIGHUP → PTY 자식 모두 종료. 클라이언트 세션 손실.

### 2.2 제약
- Go 단일 바이너리 배포, OS = darwin/linux.
- PTY 는 syscalls(`forkpty`/`openpty`)로 직접 보유.
- `outbuf` 는 in-memory, 세션별 ring.
- workspace state 는 디스크에 직렬화됨(`internal/workspace`) — 이미 영속.

## 3. 요구사항 (Requirements)

### 3.1 기능 요구사항 (Functional)

| ID | 요구사항 | 우선순위 |
|----|---------|---------|
| FR-1 | Go 바이너리 변경 후 재기동해도 기존 PTY 세션이 종료되지 않아야 한다. | 필수 |
| FR-2 | 재기동 후 WebSocket 클라이언트는 자동으로 재연결되며 스크롤백이 보존돼야 한다. | 필수 |
| FR-3 | 재기동 중 입력 손실은 reattach window 내 입력에 한해 0건이어야 한다. | 필수 |
| FR-4 | 재기동 트리거는 명시적 명령(예: `SIGUSR2`, `dongminal reload` 서브커맨드, 또는 `/api/reload` 인증 엔드포인트)이어야 하며 우발적 종료(SIGTERM/Ctrl-C)는 종전대로 모든 PTY 를 정리해야 한다. | 필수 |
| FR-5 | 재기동 실패 시 자동 롤백(이전 바이너리 재실행) 또는 안전 종료(PTY 보존, 사용자에게 통보) 중 하나로 동작해야 한다. | 필수 |
| FR-6 | 재기동 흔적은 로그에 남아야 한다(시각, 신·구 PID, 인계된 fd 수, 인계 소요시간). | 권장 |

### 3.2 비기능 요구사항 (Non-functional)
- NFR-1: reattach window 동안 클라이언트가 못 붙으면 다음 입력은 손실되되 PTY 세션 자체는 유지(정책 명시).
- NFR-2: 재기동 추가 메모리 오버헤드 < 50MB (typical).
- NFR-3: 재기동 총 소요시간 < 1초(로컬 dev), < 3초(원격).
- NFR-4: 인계 실패 시 모든 PTY 가 살아남아 별도 재연결 루트(예: 외부 supervisor 모드)로 이어질 수 있어야 한다.
- NFR-5: 보안 — `/api/reload` 엔드포인트는 loopback 또는 토큰 인증 한정.

### 3.3 제약 (Constraints)
- darwin/linux 동시 지원. Windows 비대상.
- Go 표준 라이브러리 + 기존 의존성 범위 내. 신규 외부 데몬 의존성 금지(필요 시 본 바이너리에 서브커맨드로 통합).

## 4. 아키텍처 옵션 (Design Alternatives)

### 4.1 Option A — Graceful exec (단일 프로세스, fd 인계)
```
main(old) ─ exec(new, env=DONGMINAL_RELOAD=1, ExtraFiles=[listener, pty0, pty1, ...])
                │
main(new) ─ inherits fds, reattaches outbuf via shared file/mmap or recreate from disk
```
- 장점: 단일 프로세스, IPC 경계 없음, 구현 비교적 단순.
- 단점:
  - in-memory `outbuf` 가 휘발 → 재기동 직전 디스크 직렬화 또는 `mmap` 으로 영속 필요.
  - PTY master fd 는 ExtraFiles 로 인계 가능하지만 메타데이터(pane id, cwd, env, 자식 PID)는 별도 직렬화 필요.
  - 새 바이너리가 부팅 실패 시 이미 exec 된 상태라 롤백이 까다로움 → "watchdog" 부모 프로세스 필요.
- 작업량 추산: M (2~4일). outbuf 영속화 + ExtraFiles 인계 + 메타데이터 직렬화 + watchdog.

### 4.2 Option B — 외부 PTY supervisor (프로세스 분리)
```
dongminal-paned (long-lived) ─ PTY children, outbuf, Unix socket
dongminal-server (short-lived) ─ http, ws, MCP, workspace
                                └ unix dial → paned
```
- 장점:
  - 서버 재기동이 PTY 와 무관 → 사용자가 의식할 필요 없음.
  - paned 자체는 거의 안 바뀌므로 재기동 빈도 0 에 수렴.
  - 멀티 클라이언트(여러 브라우저, MCP, CLI) 가 동일 paned 에 붙는 자연스러운 모델.
- 단점:
  - IPC 프로토콜 정의·유지(추천: length-prefixed JSON or protobuf over Unix socket).
  - 생명주기 관리(paned 자동 시작·종료·고아 처리), socket 경로 충돌, 권한.
  - 기존 `internal/server` 의 PTY 직접 호출 경로를 IPC 로 우회 — 변경 면이 넓다.
- 작업량 추산: L (1~2주). 인터페이스 추출, IPC 정의, paned 바이너리(or 서브커맨드) 분리, 서버 측 client 구현, 마이그레이션·테스트.

### 4.3 권장
초기에는 **Option A(graceful exec)** 로 진입한다. 코드 변경 면이 작고 단일 바이너리 모델을 유지하며, 사용자가 원하는 "고치고 재시작" 워크플로우를 가장 빠르게 충족한다. Option B 는 멀티 클라이언트 요구가 강해질 때(예: CLI 동시 사용) 별도 안건으로 승격한다.

## 5. 인터페이스 (Interfaces)

### 5.1 트리거
- `kill -USR2 <pid>` — 동일 바이너리 경로 재실행
- `dongminal reload` — 위와 동일하나 사용자 친화적
- `POST /api/reload`(loopback only, opt-in) — 향후

### 5.2 재기동 프로토콜 (Option A 기준 초안)
1. 부모(watchdog) 프로세스가 `dongminal-server` child 를 감독.
2. SIGUSR2 수신 시:
   - 모든 신규 입력 일시 큐잉(짧게).
   - listener fd, PTY master fd 들, outbuf snapshot 파일 경로를 환경변수/ExtraFiles 로 직렬화.
   - watchdog 가 새 child 를 `exec` 으로 spawn(`DONGMINAL_RELOAD=1` 환경 + ExtraFiles).
3. 신 child 가 `DONGMINAL_RELOAD=1` 감지 시:
   - inherited fd 를 listener·pty 로 복원.
   - outbuf 스냅샷 로드.
   - 큐잉된 입력 flush.
   - readiness 신호(fd 또는 socket) 를 watchdog 에 송신.
4. 신 child readiness 수신 후 구 child 종료(자원만 해제, PTY 는 신 child 가 보유).
5. 실패 시 watchdog 가 구 child 유지 또는 신 child 재시도.

### 5.3 데이터 영속화
- outbuf: `${DONGMINAL_HOME}/runtime/outbuf-<paneId>.bin` 로 snapshot. 재기동 직전 flush, 직후 load·삭제.
- pane 메타데이터: `${DONGMINAL_HOME}/runtime/panes.json` (id, cwd, cols/rows, env subset, child pid).

## 6. 실패 모드 및 복구 (Failure Modes)

| 모드 | 검출 | 복구 |
|-----|-----|------|
| 신 child 부팅 실패 | watchdog timeout | 구 child 유지, 알림 기록 |
| outbuf snapshot 손상 | 로드 실패 | 빈 outbuf 로 시작, 경고 로그 |
| PTY fd 인계 실패 | dup2 에러 | fallback: 해당 pane 만 종료, 나머지 유지 |
| 클라이언트 reattach 실패 | ws timeout | 다음 클라이언트 재접속 시 수신 가능 |

## 7. 검증 계획 (Validation)

### 7.1 단위/통합
- `internal/outbuf` snapshot/load round-trip 테스트.
- ExtraFiles 인계 테스트 (mock listener + fake pty).

### 7.2 e2e
- Playwright: split → 명령 실행 → SIGUSR2 트리거 → 1초 내 동일 pane 에서 cont. 출력 확인 → 추가 입력 echo 확인.
- 멀티 클라이언트 동기화 회귀(`e2e/sync.spec.ts`) 가 재기동 후에도 통과해야 함.

### 7.3 수동
- Go 코드 무의미 변경 → `dongminal reload` → 모든 세션의 `top`·`tail -f` 가 끊기지 않는지 확인.

## 8. 점진적 도입 단계 (Phasing)

1. **P0 — 영속화**: outbuf snapshot/restore + pane 메타데이터 저장. 단독 PR.
2. **P1 — watchdog**: 부모 프로세스 도입, 일반 종료/재시작 흐름 정리. PTY 인계는 아직.
3. **P2 — fd 인계**: ExtraFiles 로 listener + PTY master fd 인계. SIGUSR2 트리거.
4. **P3 — 클라이언트 UX**: 재기동 알림(status bar), reattach 진행 표시, 입력 큐잉.
5. **P4(선택) — Option B 분리**: 멀티 클라이언트/IPC 요구가 생기면 paned 분리.

## 9. 비범위(Non-goals)
- Windows 지원
- 라이브 코드 패치(LiveReload of running Go code)
- PTY 마이그레이션 across machines

## 10. 완료 조건 (Definition of Done)

- [ ] Option A 의 P0~P3 구현 완료
- [ ] `dongminal reload` 후 활성 PTY 가 100% 살아남음(자동 테스트 포함)
- [ ] 본 SRS 의 FR-1~FR-5 검증 통과
- [ ] 사용자 매뉴얼(README) 갱신
- [ ] 본 문서를 IMPLEMENTED 상태로 갱신하고 회고 절 추가
