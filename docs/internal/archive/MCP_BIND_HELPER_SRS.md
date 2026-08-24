# MCP Typed Bind Helper SRS (S6)

## 1. Introduction
### 1.1 Purpose
`internal/mcptool/tools/*.go` 의 6 개 tool (ListPanes, ReadPaneScreen, ReadPaneOutput, SendInput, SendAgentMessage, WorkspaceCommand) 을 `mcptool.Register[A](r, name, spec, fn)` typed helper 사용 패턴으로 일원화한다 (이미 WhoAmI 가 동일 패턴).

### 1.2 Scope
- 변경 대상: `internal/mcptool/tools/*.go`, `internal/mcptool/tools/tools_test.go`, `cmd/dongminal/main.go`.
- `mcptool.Register` 와 `mcptool.Tool` 인터페이스 자체는 변경하지 않는다.

### 1.3 Background
현재 6 개 tool 은 각각 struct + `Name()/Spec()/Call()` 메서드를 정의하여 `Tool` 인터페이스를 구현한다. 매 tool 마다 동일한 보일러플레이트:
- json.Unmarshal
- 의존성 핸들 boilerplate (`PM`, `WS` 필드)
- 에러 wrapping

WhoAmI 한 개만 이미 함수형 (`<Name>Handler(deps) func(ctx, Args) (Result, error)`) 으로 변환되어 있다. 통일 시 ~100 줄 감축 추산.

## 2. Stakeholders / Sources
- DESIGN_REVIEW_FOLLOWUP §2 S6.

## 3. Functional Requirements

### FR-S6-1 통일 패턴
각 tool 은 다음 4 요소만 노출한다:
1. `<Name>Name` (string const) — tool 식별자
2. `<Name>Spec` (var map[string]any) — tools/list 페이로드
3. `<Name>Args` (struct) — typed 입력
4. `<Name>Handler(deps <Name>Deps) func(ctx, <Name>Args) (Result, error)` — 핵심 로직

기존 struct 와 `Name()/Spec()/Call()` 메서드는 제거.

### FR-S6-2 등록
`cmd/dongminal/main.go` 에서 `mcptool.Register[<Name>Args](reg, <Name>Name, <Name>Spec, <Name>Handler(deps))` 로 등록.

### FR-S6-3 동작 보존
- 모든 tool 의 외부 동작(JSON 입력 형식, 출력 텍스트, 에러 의미) 변경 없음.
- 기존 `tools_test.go` 테스트가 새 API 형태로 갱신된 후 그린.

## 4. Non-Functional Requirements
- NFR-1 race detector clean.
- NFR-2 코드 라인 감축 (목표 ≥ 80 줄, 실제 측정 보고).
- NFR-3 e2e 회귀 없음.

## 5. Test Plan
- 기존 단위 테스트(`tools_test.go`) 를 새 함수형 API 호출로 변환 → 그린.
- 신규 통합 테스트 불필요 (기존 케이스가 동작 보존을 검증).

## 6. Done Criteria
- [ ] 6 개 tool 변환 완료
- [ ] tools_test.go 갱신 완료
- [ ] main.go 등록 갱신 완료
- [ ] `go test -race ./...` 그린
- [ ] `npx playwright test` 그린

## 7. Out of Scope
- Tool 인터페이스 자체 (`Tool`, `Registry`) 의 시그니처 변경.
- 새 tool 추가.
