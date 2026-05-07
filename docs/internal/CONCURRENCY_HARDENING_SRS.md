# Concurrency Hardening SRS (L3 / L5 / L7)

본 문서는 IEEE 29148 SRS 양식에 따라 design review 후속 항목 L3, L5, L7 의 요구사항·설계·완료 조건을 기술한다.

## 1. Introduction

### 1.1 Purpose
`internal/server/pane.go` 의 PTY exit 경로와 `internal/server/commands.go` 의 SSE hub 의 동시성 불변식(invariant) 을 코드와 테스트로 명시한다. `mcptool/tools/readpane.go` 의 ANSI strip 중복 가능성을 검증한다.

### 1.2 Scope
- L3: `Pane` 의 exit 신호와 client 등록의 race 제거
- L5: `CommandHub` 의 add/remove vs Broadcast 동시성 보증을 race detector 테스트로 박제
- L7: ANSI strip 중복 여부 검증 + 단일 구현 확인 기록

### 1.3 Definitions
- **Pane invariant**: `Pane.exited` 가 true 가 된 이후에는 broadcast 가 호출되지 않으며, 새로 추가되는 client 는 즉시 `OpExit` 만 받고 종료한다.
- **CommandHub invariant**: `Broadcast` 가 보유 중인 subscriber 집합은 add/remove 와 직렬화된다. drop 정책은 채널 가득 시 무손실 보장 없음.

## 2. Stakeholders / Sources
- 사용자(@dy.kim): 멀티 client 연결 환경에서 exit 직후 dangling 연결 방지 요구.
- DESIGN_REVIEW_FOLLOWUP §3 L3, L5, L7.

## 3. Functional Requirements

### FR-L3-1 Pane exit 단일 진입점
`Pane` 은 `exited bool` 필드를 `cmu` 로 보호한다. `kill()` 의 `sync.Once.Do` 내부에서 `cmu.Lock()` 으로 `exited=true` 설정 후 release 한다. 이후 broadcast 는 호출되지 않는다.

### FR-L3-2 addClient 거절 정책
`addClient(c)` 호출 시 `cmu.Lock()` 안에서 `exited` 가 true 이면 list 추가 없이 unlock 한 뒤, **lock 밖에서** `OpExit` 1바이트를 client 에 송신하고 close 한다. 반환값은 false (반환값 추가 금지가 부담이면 내부 처리만).

### FR-L3-3 호출자 invariant 문서화
`broadcast`, `addClient`, `removeClient` 의 godoc 에 "must not be called holding cmu by caller" 를 명시한다.

### FR-L5-1 CommandHub race 테스트
`commands_test.go` 에 동시 add/remove/Broadcast 를 1000회 fan-out 하는 테스트 추가. `go test -race` 에서 그린.

### FR-L7-1 ANSI strip 검증
codebase 전체에 ANSI escape regex 가 `mcptool/tools/ansi.go` 외에 존재하지 않음을 확인하고 `DESIGN_REVIEW_FOLLOWUP.md` §4 에 검증 결론(✅ verified — no duplicate) 기록.

## 4. Non-Functional Requirements
- NFR-1 race detector clean: `go test -race ./...` 그린 유지.
- NFR-2 외과적 변경: pane.go / commands.go 의 외부 API 시그니처 변경 금지.
- NFR-3 성능 회귀 없음: addClient 의 lock-hold 구간이 1 boolean 검사만 추가.

## 5. Test Plan (TDD)

### TC-L3-1 (RED → GREEN)
`pane_test.go` 에 `TestPaneAddClientAfterExit`:
1. StartPane 후 즉시 kill 호출.
2. `addClient` 호출 → 더미 conn 이 OpExit 1바이트 수신했는지 확인.
3. `cls` 가 비어 있는지 확인.

### TC-L3-2 race
`TestPaneBroadcastAddRace`: goroutine 100개에서 broadcast/addClient/removeClient 를 무작위 호출. race detector 그린.

### TC-L5-1 race
`TestCommandHubAddRemoveBroadcastRace`: 동시 fan-out 1000회.

### TC-L7-1
스크립트 또는 grep 로 codebase 에 다른 ANSI regex 가 없음을 확인 — 본 SRS 작성 시점에 1회 수동 검증 완료.

## 6. Done Criteria (DoD)
- [ ] FR-L3-1, FR-L3-2, FR-L3-3 구현 + TC-L3-1, TC-L3-2 그린
- [ ] FR-L5-1 테스트 추가 + 그린
- [ ] FR-L7-1 verification 기록 in DESIGN_REVIEW_FOLLOWUP §4
- [ ] `go test -race ./...` 그린

## 7. Out of Scope
- PaneManager 전체 mutex 재설계 (S2 에서 처리됨)
- SSE backpressure 정책 변경 (현재 drop-on-full 유지)
