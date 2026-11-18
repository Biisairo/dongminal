package hub

import (
	"dongminal/internal/shared/activity"

	"dongminal/internal/webserver/sse"
)

// ValidActivityState 는 어휘 판정이다. `ended` 는 종료 신호 — 카드 제거(상태로 저장하지 않음).
func ValidActivityState(s string) bool { return activity.Valid(s) }

// toolActivityPayload builds the tool_activity SSE event body broadcast via
// CommandHub. Server-published only (not in allowedCmdActions). Keys are
// lowerCamelCase.
func toolActivityPayload(toolID, state, tool, detail string) []byte {
	return sse.Payload("tool_activity", map[string]any{"toolId": toolID, "state": state, "tool": tool, "detail": detail})
}
