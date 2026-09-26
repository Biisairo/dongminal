// Package activity 는 에이전트 활동 상태의 어휘다 (OPTIMIZE_REFACTOR_SRS FR-OPT-10-1).
//
// 어댑터의 파서·Tool·AgentTurn·웹서버의 AttnTracker·Run 멤버 상태가 같은 다섯
// 낱말을 쓴다. 문자열로 흩어 두면 오타를 컴파일러가 잡지 못한다. 프론트엔드의 짝은
// `web/js/core/constants.js` 의 `ACTIVITY_STATE` 이고, 두 목록은
// `scripts/check-activity-vocab.sh` 가 대조한다.
//
// 값은 와이어 그대로다 — 훅 표면·SSE `tool_activity`·`/api/tools/activity` 가 이
// 문자열을 싣는다. 필드의 타입을 바꾸지 않으려고 상수는 타입 없는 문자열이다.
package activity

const (
	Working = "working"
	Waiting = "waiting"
	Done    = "done"
	Idle    = "idle"
	// Ended 는 세션 종료 신호다 — 상태로 저장하지 않고 카드를 거둔다.
	Ended = "ended"
)

// States 는 어휘 전부다. 부를 때마다 새 조각이다.
func States() []string { return []string{Working, Waiting, Done, Idle, Ended} }

// Valid 는 s 가 어휘 안의 낱말인가다.
func Valid(s string) bool {
	switch s {
	case Working, Waiting, Done, Idle, Ended:
		return true
	}
	return false
}
