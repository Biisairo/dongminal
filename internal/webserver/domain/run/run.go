// Package run은 오케스트레이션 실행(Run)이 공간 계층과 맞닿는 접합면만
// 정의한다. Run 런타임 자체 — 생성·토폴로지·상태기계·보고 — 는 후속
// SRS(RUN_ORCHESTRATION_SRS)의 범위다 (ENTITY_MODEL_RESTRUCTURE_SRS FR-EM-17).
//
// Run 은 공간 계층(Window ─ Pane ─ Tab ─ Tool)의 한 레벨이 아니라 **직교한
// 축**이다. 계층으로 만들면 "공간을 차지하지 않고 백그라운드로만 도는 팀"을
// 표현할 수 없고, 실행 상태·토폴로지·보고를 담을 자리도 없다.
package run

// Projection은 Run 이 소유한 도구를 공간에 어떻게 놓을지를 정한다.
// 공간 투영이 선택적이라는 점이 Run 을 계층 노드보다 강하게 만든다.
type Projection string

const (
	// DedicatedWindow: Run 전용 Window 를 만든다. 사용자 작업 공간을 침범하지
	// 않는다 — 현재 dongminal-team 이 팀장의 Pane 을 쪼개어 생기는 문제
	// (포커스 침범 방어가 스킬 규칙의 절반을 차지)의 해소책.
	DedicatedWindow Projection = "dedicated-window"

	// Background: 공간에 놓지 않는다. 도구는 백그라운드로만 존재한다.
	// 계층으로는 표현할 수 없는 형태 (FR-BG).
	Background Projection = "background"

	// Inline: 호출자의 Window 를 쪼갠다. 관찰 목적.
	Inline Projection = "inline"
)

// Valid는 p 가 정의된 투영인지 보고한다. 빈 값은 유효하지 않다 — 투영을
// 지정하지 않은 Run 은 접합면 관점에서 Run 이 아니다.
func (p Projection) Valid() bool {
	switch p {
	case DedicatedWindow, Background, Inline:
		return true
	}
	return false
}
