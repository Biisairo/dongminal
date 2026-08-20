# SRS: PaneManager 분해 + mutex 정리 (S2) — IEEE 29148

## 1. 개요

### 1.1 목적
`internal/server/pane.go` 의 PaneManager / Pane 콘체른 분리. 디자인 리뷰가 기술한 "두 mutex(mu/mu2) 공존" / "busy 셸 프롬프트 추정" 은 현행 코드(2026-05-07)와 직접 일치하지 않는다 (mu/mu2 가 아니라 `PaneManager.mu` + `Pane.cmu` 로 서로 다른 자원을 보호; busy 는 `pgrep -P` 단일 호출). 따라서 본 SRS 는 실제로 측정 가능한 두 가지 개선만 정의한다.

### 1.2 범위
- `PaneManager.mu` 를 `sync.Mutex` → `sync.RWMutex` 로 변경하여 read 경로 (`Get`, `List`, `Snapshot`, `IsLive`) 가 RLock 사용.
- `Pane.IsBusy()` 의 외부 명령 호출 (`pgrep`) 을 의존성 주입 가능한 함수 변수로 분리 (`paneBusyProbe`) 하여 테스트 가능성 향상.
- `Pane.cmu` 는 mutate-heavy 자원을 보호 → 변경 없음.

### 1.3 정의
- **read 경로**: 컬렉션을 읽기만 하는 메서드. 쓰기 경로는 `Create`, `Restore`, `Delete`, `SetInvalidator`.
- **busy probe**: `IsBusy()` 가 사용하는 자식 프로세스 존재 검사 함수. 현재는 `pgrep -P` 외부 호출.

## 2. 현황
- `mu sync.Mutex` 가 read/write 모두 직렬화 → 다중 reader 들 (예: API GET state) 사이에 불필요한 직렬화.
- `IsBusy()` 가 `exec.Command("pgrep", ...)` 직접 호출 → 단위 테스트가 macOS pgrep 동작·자식 프로세스 존재에 강결합.

## 3. 요구사항

### 3.1 기능
| ID | 요구사항 | 우선순위 |
|----|----------|---------|
| FR-S2-1 | `PaneManager.mu` 는 `sync.RWMutex` 이며 read 메서드(`Get`, `List`, `Snapshot`, `IsLive`)는 `RLock`/`RUnlock` 사용. write 메서드는 `Lock`/`Unlock`. | 필수 |
| FR-S2-2 | `Pane.IsBusy` 는 패키지 변수 `paneBusyProbe func(pid int) bool` 를 통해 호출되며, 테스트는 이를 교체 가능. 기본 구현은 기존 `pgrep -P` 동작 보존. | 필수 |
| FR-S2-3 | `IsBusy` 의 기본 동작은 변경 없음 (회귀 금지). | 필수 |

### 3.2 비기능
| ID | 요구사항 |
|----|----------|
| NFR-S2-1 | `go test -race ./internal/server/` 통과. |
| NFR-S2-2 | 추가 락 도입 금지. 기존 보호 범위 보존. |

## 4. 검증
- TC-S2-1: `paneBusyProbe` 를 fake 로 교체하면 `IsBusy()` 가 fake 의 결과를 반환. (Go 테스트)
- TC-S2-2: 동시 100 reader / 10 writer 부하 race 테스트 — panic / race 없음.

## 5. DoD
- [ ] `go test -race ./...` green.
- [ ] DESIGN_REVIEW_FOLLOWUP §4 의 S2 ✅ 표시.

## 6. 비목표
- busy probe 의 셸 프롬프트 휴리스틱 도입 (현재 코드에 없음, 후속).
- snapshot 직렬화 분리 — 현재 SaveAll 가 이미 작은 단일 함수이므로 가치 낮음.
