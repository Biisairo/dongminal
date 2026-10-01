package hub

import (
	"sync/atomic"

	"dongminal/internal/shared/toolhub"
	"dongminal/internal/webserver/sse"
)

// attnSeq 는 알람 방송의 번호다 (ATTENTION_FIRING_SRS FR-ATD-1). 창들은 이 번호로
// "같은 알람" 을 알아보고, 한 컴퓨터에서 하나만 배너·소리를 맡는다.
var attnSeq atomic.Uint64

// broadcast via CommandHub. Keys are lowerCamelCase.
func toolAttentionPayload(toolID, reason string) []byte {
	return sse.Payload("tool_attention", map[string]any{"toolId": toolID, "reason": reason, "seq": attnSeq.Add(1)})
}

func toolAttentionClearPayload(toolID string) []byte {
	return sse.Payload("tool_attention_clear", map[string]any{"toolId": toolID})
}

// attnBroadcasts 는 주의·활동 전이를 방송으로 옮기는 콜백 세 벌이다. 직접 모드
// (WireAttention·WireActivity)와 데몬 모드(NewAttnTracker)가 같은 것을 쓴다 (IPC-20).
type attnBroadcasts struct {
	attention      func(id, reason string)
	attentionClear func(id string)
	activity       func(id, state, tool, detail string)
}

func attnBroadcastsOf(hub CommandBroker) attnBroadcasts {
	return attnBroadcasts{
		attention:      func(id, reason string) { hub.Broadcast(toolAttentionPayload(id, reason)) },
		attentionClear: func(id string) { hub.Broadcast(toolAttentionClearPayload(id)) },
		activity: func(id, state, tool, detail string) {
			hub.Broadcast(toolActivityPayload(id, state, tool, detail))
		},
	}
}

// WireAttention connects tool attention transitions to SSE broadcasts. Called
// from the composition root once both the toolhub.ToolManager and CommandHub exist.
func WireAttention(pm *toolhub.ToolManager, hub CommandBroker) {
	b := attnBroadcastsOf(hub)
	pm.SetAttentionNotifier(b.attention, b.attentionClear)
}
