# Outbuf Backpressure SRS (S4)

## 1. Introduction
### 1.1 Purpose
`internal/outbuf.Stream` 의 backpressure / drop 정책을 단일 진입점으로 정형화하고, `pane.bch` 채널 기반의 두 번째(불가시) drop 경로를 제거한다.

### 1.2 Scope
- `internal/outbuf/stream.go`: 정책을 godoc 으로 명시. 외부 API 변경 없음.
- `internal/server/pane.go`: `bch chan []byte` 와 `drainBuf` 고루틴 제거. `readPTY` 는 `Stream.Feed` 를 직접 호출한다.

### 1.3 Background
현재 PTY → outbuf 경로는 다음과 같다:
```
readPTY → bch (256 buffered chan, drop-on-full) → drainBuf → Stream.Feed
```
- `bch` 가득 시 silent drop 발생. drop 카운터는 `Stream.totalDrop` 에 반영되지 않는다 (Feed 까지 도달하지 못했으므로).
- 결과: 사용자에게 노출되는 drop 통계(`Stats.TotalBytesDrop`) 가 실제 손실량 과소 보고.

## 2. Stakeholders / Sources
- DESIGN_REVIEW_FOLLOWUP §2 S4
- Stream.Feed 는 mutex 보호 하의 짧은 append 연산 — readPTY 에서 직접 호출해도 throughput 영향 미미.

## 3. Functional Requirements

### FR-S4-1 단일 drop 경로
PTY 출력의 모든 drop 은 `Stream.Feed` 의 compaction 경로(2*max 초과 시 head 절단)로만 발생한다. drop 누적은 `Stats.TotalBytesDrop` 에 그대로 노출된다.

### FR-S4-2 readPTY 직접 Feed
`Pane.readPTY` 는 PTY 에서 읽은 바이트를 즉시 `p.stream.Feed(buf)` 로 넘긴다. `bch` 채널 / `drainBuf` 고루틴은 삭제한다.

### FR-S4-3 정책 godoc
`outbuf.Stream` godoc 에 다음 invariant 를 명시한다:
- Feed 는 절대 블록되지 않는다.
- max 이상 ~ 2*max 미만 구간의 tail 은 보존되며 Snapshot 시점에 잘려 반환된다 (loss 가 아니라 단순 retention 정책).
- 2*max 초과는 compaction 으로 head 가 잘리고 그 분량은 totalDrop 에 반영된다.

## 4. Non-Functional Requirements
- NFR-1 race detector clean.
- NFR-2 외부 API 시그니처 불변 (`Feed`/`Snapshot`/`Stats`/`Len`/`Close`).
- NFR-3 throughput 회귀 없음 (수동 확인: e2e 그린).

## 5. Test Plan (TDD)

### TC-S4-1
`TestPane_DrainBufRemoved` (pane_test.go): 새 Pane 의 `bch` 필드는 더 이상 존재하지 않거나 nil 이다. drainBuf 고루틴 누수 없음 (간접 확인: 이전 `pane_exit_test.go` 가 그린).

### TC-S4-2
기존 outbuf 테스트 (`internal/outbuf/stream_test.go`) 가 그대로 그린.

## 6. Done Criteria (DoD)
- [ ] FR-S4-1, FR-S4-2, FR-S4-3 구현
- [ ] `go test -race ./...` 그린
- [ ] e2e 통과

## 7. Out of Scope
- 새 backpressure 모드(blocking Feed 등) 도입 — 본 SRS 는 정책을 *명시*하고 *단순화*만 한다.
