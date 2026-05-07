# SRS: Workspace Snapshot 단일 진입점 (S5) — IEEE 29148

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)
`workspace.Manager` 의 `Raw()` 와 `CurrentRev()` 가 분리된 atomic 으로 노출되어 있어, `Save()` 가 진행 중일 때 외부에서 두 값을 연속 호출하면 일치하지 않는 `(raw, rev)` 페어를 관측할 수 있다. 이를 단일 호출에서 일관된 페어로 반환하는 `Snapshot()` 진입점으로 통합하여 race 윈도우를 제거한다.

### 1.2 범위 (Scope)
- `internal/workspace/manager.go` 의 raw/rev 저장 구조와 read 진입점.
- `internal/server/handlers_api.go` 의 `/api/state`, `/api/workspace` GET 경로 호출자.
- `internal/server/deps.go` `WorkspaceStore` 인터페이스.

### 1.3 정의 (Definitions)
- **coherent pair**: 동일한 `Save()` 트랜잭션이 만들어낸 raw 와 rev.
- **race window**: `Raw()` 가 새 raw 를 보고 `CurrentRev()` 가 이전 rev 를 보거나 그 반대인 시간 구간.

## 2. 현황 (Identified Issue)

### S5: 분리 atomic 으로 인한 race
- **위치**: `manager.go:139-145` (`Raw()`), `manager.go:135-137` (`CurrentRev()`), `manager.go:147-168` (`Save()` 의 raw/rev 갱신).
- **현상**: `Save()` 는 `m.raw.Store` 와 `m.rev.Store` 를 순차 실행. 두 store 사이에 다른 goroutine 이 reader path 를 진행하면 `(raw_new, rev_old)` 또는 `(raw_old, rev_new)` 관측 가능.
- **영향**: `/api/state`, `/api/workspace` 응답의 `ETag` 와 body 가 서로 다른 트랜잭션을 가리키는 비일관성. 클라이언트가 stale ETag 로 If-Match 보내면 false-conflict 발생 가능.

## 3. 요구사항 (Requirements)

### 3.1 기능 요구사항 (Functional)
| ID | 요구사항 | 우선순위 |
|----|----------|---------|
| FR-S5-1 | `workspace.Manager.Snapshot()` 가 `(raw []byte, rev uint64)` 를 반환하며, 반환된 두 값은 항상 동일 `Save()` 트랜잭션의 결과여야 한다. | 필수 |
| FR-S5-2 | `Raw()` 와 `CurrentRev()` 는 backward 호환을 위해 유지되며, 내부적으로 `Snapshot()` 을 통해 일관된 값을 읽어야 한다. | 필수 |
| FR-S5-3 | 서버 핸들러(`/api/state`, `/api/workspace` GET)는 `Snapshot()` 을 단일 호출하여 ETag 와 body 가 항상 동일 트랜잭션을 가리키도록 한다. | 필수 |
| FR-S5-4 | `WorkspaceStore` 인터페이스에 `Snapshot()` 추가 (Raw/CurrentRev 유지). | 필수 |

### 3.2 비기능 요구사항 (Non-functional)
| ID | 요구사항 |
|----|----------|
| NFR-S5-1 | 추가 lock 도입 없이 lock-free 읽기 성능 유지. |
| NFR-S5-2 | 동시 Save / Snapshot 병렬 실행 race 테스트 (`go test -race`) 통과. |

## 4. 검증 (Verification)

### 4.1 테스트 케이스
- **TC-S5-1**: 단일 Save 후 `Snapshot()` 반환 raw/rev 가 일치.
- **TC-S5-2**: 100 회 동시 Save 와 1000 회 동시 Snapshot 병렬 실행 시 모든 snapshot 의 (raw, rev) 가 coherent (rev 와 raw 의 관계가 단조 증가, raw 가 빈 경우 rev=0).
- **TC-S5-3**: `Raw()`+`CurrentRev()` 의 기존 호출 패턴 호환 — 동일 결과.

### 4.2 완료 조건 (DoD)
- [ ] `go test -race ./internal/workspace/` 통과.
- [ ] `go test ./...` green.
- [ ] handlers_api 의 두 호출 경로가 `Snapshot()` 으로 변경.
- [ ] DESIGN_REVIEW_FOLLOWUP §4 의 S5 ✅ 표시.

## 5. 비목표
- writer goroutine 변경 없음.
- index/labels 의 일관성 (이미 다른 atomic 으로 보호됨) — 본 SRS 범위 외.
