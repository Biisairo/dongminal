# SRS: handlers_api 라우터 테이블화 (S3) — IEEE 29148

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)
`internal/server/handlers_api.go` 의 단일 함수 `handleAPI` (∼270줄, 17개 case 의 거대 `switch`) 를 라우트 테이블 + 핸들러별 함수로 분해하여 가독성·테스트 격리·확장성을 향상시키되 외부 동작은 1:1 보존한다.

### 1.2 범위 (Scope)
- `internal/server/handlers_api.go` 의 `handleAPI` 함수만 대상.
- 비즈니스 로직 자체는 변경하지 않음.
- 테스트 양상 (`handlers_api_test.go`) 은 외부 행위 호환만 보장.

### 1.3 정의
- **route**: `(method, matcher) → handler` 트리플. matcher 는 `func(path string) bool` 또는 정확 매치.

## 2. 현황
- 17개 `case` 가 path/method 비교 로직 + 핸들러 본문을 모두 함수 안에 둠.
- 신규 라우트 추가 시 함수 길이 증가 + 스코프 변수 충돌 위험.

## 3. 요구사항

### 3.1 기능 요구사항
| ID | 요구사항 | 우선순위 |
|----|----------|---------|
| FR-S3-1 | `handleAPI` 는 라우트 테이블을 순회하며 첫 매치 핸들러를 호출하고, 매치 실패 시 404 를 반환한다. | 필수 |
| FR-S3-2 | 각 라우트 핸들러는 `(*Server)` 메서드로 분리되어 하나의 책임만 갖는다. | 필수 |
| FR-S3-3 | 라우팅 결과는 기존 동작과 1:1 동일 (status code / headers / body). | 필수 |
| FR-S3-4 | 동적 path (예: `/api/panes/{id}/busy`) 는 명시적 matcher 함수로 분리한다. | 필수 |

### 3.2 비기능
| ID | 요구사항 |
|----|----------|
| NFR-S3-1 | `handlers_api_test.go` 변경 없이 모두 통과 (행위 호환). |
| NFR-S3-2 | 신규 핸들러 함수 도입 외 별도 추상화는 만들지 않는다. |

## 4. 검증
- `go test ./internal/server/` green.
- 동일 응답 (수동 spot check 불필요 — 기존 테스트가 충분히 외부 동작 검증).

## 5. DoD
- [ ] handleAPI 본체 30줄 이하.
- [ ] 17개 라우트가 모두 메서드로 분리.
- [ ] `go test ./...` green.
- [ ] DESIGN_REVIEW_FOLLOWUP §4 의 S3 ✅ 표시.
