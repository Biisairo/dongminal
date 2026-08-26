package server

import "dongminal/internal/shared/toolhub"

import "encoding/json"

// broadcast via CommandHub. Keys are lowerCamelCase.
func toolAttentionPayload(toolID, reason string) []byte {
	b, _ := json.Marshal(map[string]any{
		"action": "tool_attention",
		"args":   map[string]any{"toolId": toolID, "reason": reason},
	})
	return b
}

func toolAttentionClearPayload(toolID string) []byte {
	b, _ := json.Marshal(map[string]any{
		"action": "tool_attention_clear",
		"args":   map[string]any{"toolId": toolID},
	})
	return b
}

// WireAttention connects tool attention transitions to SSE broadcasts. Called
// from the composition root once both the toolhub.ToolManager and CommandHub exist.
func WireAttention(pm *toolhub.ToolManager, hub CommandBroker) {
	pm.SetAttentionNotifier(
		func(id, reason string) { hub.Broadcast(toolAttentionPayload(id, reason)) },
		func(id string) { hub.Broadcast(toolAttentionClearPayload(id)) },
	)
}
