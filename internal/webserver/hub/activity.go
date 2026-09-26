package hub

import (
	"dongminal/internal/shared/activity"
	"dongminal/internal/shared/toolhub"

	"dongminal/internal/webserver/sse"
	"strings"
	"unicode/utf8"
)

const (
	ActivityToolMax   = 64
	ActivityDetailMax = 512
)

// ValidActivityState 는 어휘 판정이다. `ended` 는 종료 신호 — 카드 제거(상태로 저장하지 않음).
func ValidActivityState(s string) bool { return activity.Valid(s) }

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
		// IPC-27: 상한 이하의 마지막 글자 경계까지 물린다 — 끊긴 바이트는 카드에 □ 로
		// 보인다.
		cut := max
		for cut > 0 && !utf8.RuneStart(s[cut]) {
			cut--
		}
		s = s[:cut]
	}
	return s
}

// toolActivityPayload builds the tool_activity SSE event body broadcast via
// CommandHub. Server-published only (not in allowedCmdActions). Keys are
// lowerCamelCase.
func toolActivityPayload(toolID, state, tool, detail string) []byte {
	return sse.Payload("tool_activity", map[string]any{"toolId": toolID, "state": state, "tool": tool, "detail": detail})
}

// WireActivity connects tool activity transitions to SSE broadcasts. Called
// from the composition root once both the toolhub.ToolManager and CommandHub exist.
func WireActivity(pm *toolhub.ToolManager, hub CommandBroker) {
	pm.SetActivityNotifier(attnBroadcastsOf(hub).activity)
}
