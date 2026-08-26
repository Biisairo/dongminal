package hub

import (
	"dongminal/internal/shared/toolhub"

	"encoding/json"
	"strings"
)

const (
	ActivityToolMax   = 64
	ActivityDetailMax = 512
)

var activityStates = map[string]bool{
	"working": true,
	"done":    true,
	"waiting": true,
	"idle":    true,
	"ended":   true, // 종료 신호 — 카드 제거(상태로 저장하지 않음)
}

func ValidActivityState(s string) bool { return activityStates[s] }

// SanitizeActivityField strips control chars and bounds the length of a
// tool/detail field before it is stored or rendered (NFR-AAP-3). Mirrors
// runtimebin.sanitizeNotifyLabel; the two live in different packages.
func SanitizeActivityField(s string, max int) string {
	s = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, s)
	if len(s) > max {
		s = s[:max]
	}
	return s
}

// toolActivityPayload builds the tool_activity SSE event body broadcast via
// CommandHub. Server-published only (not in allowedCmdActions). Keys are
// lowerCamelCase.
func toolActivityPayload(toolID, state, tool, detail string) []byte {
	b, _ := json.Marshal(map[string]any{
		"action": "tool_activity",
		"args":   map[string]any{"toolId": toolID, "state": state, "tool": tool, "detail": detail},
	})
	return b
}

// WireActivity connects tool activity transitions to SSE broadcasts. Called
// from the composition root once both the toolhub.ToolManager and CommandHub exist.
func WireActivity(pm *toolhub.ToolManager, hub CommandBroker) {
	pm.SetActivityNotifier(func(id, state, tool, detail string) {
		hub.Broadcast(toolActivityPayload(id, state, tool, detail))
	})
}
