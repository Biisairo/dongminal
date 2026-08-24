# Code-Server Graceful Shutdown SRS (L6)

## 1. Introduction
### 1.1 Purpose
`CodeServerManager.Stop` 의 종료 경로에서 **무조건 100ms sleep 후 SIGKILL** 패턴을 제거하고, 프로세스가 SIGTERM 으로 자발 종료할 시간을 명시적 timeout(`shutdownGrace`) 으로 정의한다.

### 1.2 Scope
`internal/server/codeserver.go` 의 `CodeServerInst` 와 `Stop` 메서드. 외부 API 변경 없음.

## 2. Stakeholders / Sources
- DESIGN_REVIEW_FOLLOWUP §3 L6.

## 3. Functional Requirements

### FR-L6-1 명시적 종료 신호
`CodeServerInst` 에 `exited chan struct{}` 필드를 추가한다. `Start()` 의 cmd.Wait 루프 종료 시점에 close 된다.

### FR-L6-2 timeout 기반 SIGKILL
`Stop()` 은 다음 순서로 동작한다:
1. SIGTERM 송신
2. `exited` 가 닫히길 `shutdownGrace` (기본 2 초) 까지 대기
3. timeout 시 SIGKILL 송신, 그 후 `exited` 닫힐 때까지 대기

### FR-L6-3 backward compat
이미 `inst.exited` 가 nil 인 경우 (synthetic test fixture 등) 신호 블록 자체가 실행되지 않도록 한다 (`Cmd.Process == nil` 이면 반환).

## 4. Non-Functional Requirements
- NFR-1 race detector clean.
- NFR-2 정상 종료 시 wall-clock 지연이 100ms 고정에서 ~프로세스 실제 종료 시간으로 단축.

## 5. Test Plan

### TC-L6-1
`TestCodeServerStop_WaitsForExit`: `exec.Command("sleep", "30")` 시작 → `Stop()` 호출 → 함수 반환 시 프로세스가 실제로 종료되었는지 (`cmd.ProcessState.Exited()`) 확인. wall-clock 이 `shutdownGrace` 미만(SIGTERM 으로 즉시 종료) 또는 grace+여유(SIGKILL) 임을 확인.

### TC-L6-2
기존 단위 테스트 (`TestCodeServerManager_StopIdempotent`, `_StopAll`, `_Watchdog`) 가 그대로 그린.

## 6. Done Criteria
- [ ] FR-L6-1, FR-L6-2, FR-L6-3 구현
- [ ] TC-L6-1 그린 (-race)
- [ ] go test ./... 그린

## 7. Out of Scope
- code-server 내부 graceful shutdown URL/IPC 호출 (외부 도구 의존성 도입은 이번 범위 밖)
