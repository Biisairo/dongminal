package hub

import (
	"sync/atomic"

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

// attnBroadcasts 는 주의·활동 전이를 방송으로 옮기는 콜백 묶음이다. NewAttnTracker 가
// 쓴다 (IPC-20). gone 은 방송하지 않고 관찰자에게만 넘긴다.
type attnBroadcasts struct {
	attention      func(id, reason string)
	attentionClear func(id string)
	activity       func(id, state, tool, detail string)
	gone           func(id string)
}

func attnBroadcastsOf(hub CommandBroker) attnBroadcasts {
	return attnBroadcasts{
		attention: func(id, reason string) {
			hub.Broadcast(toolAttentionPayload(id, reason))
			if o, ok := hub.(*CommandHub); ok {
				o.observeAttention(id, reason)
			}
		},
		attentionClear: func(id string) {
			hub.Broadcast(toolAttentionClearPayload(id))
			if o, ok := hub.(*CommandHub); ok {
				o.observeAttentionClear(id)
			}
		},
		activity: func(id, state, tool, detail string) {
			hub.Broadcast(toolActivityPayload(id, state, tool, detail))
		},
		gone: func(id string) {
			if o, ok := hub.(*CommandHub); ok {
				o.observeToolGone(id)
			}
		},
	}
}

// SetAttentionObserver 는 알람 방송을 함께 받을 함수를 단다. nil 이면 걷는다
// (TELEGRAM_BRIDGE_SRS FR-TGB-50). 추적기의 알람 방송이 모두 이 콜백 묶음을 지나므로 한 자리에서 받는다.
func (h *CommandHub) SetAttentionObserver(f func(id, reason string)) {
	if f == nil {
		h.attnObs.Store(nil)
		return
	}
	h.attnObs.Store(&f)
}

func (h *CommandHub) observeAttention(id, reason string) {
	if f := h.attnObs.Load(); f != nil {
		(*f)(id, reason)
	}
}

// SetAttentionClearObserver 는 알람 해제 방송을 함께 받을 함수를 단다. nil 이면 걷는다
// (TELEGRAM_BRIDGE_SRS FR-TGB-58b).
func (h *CommandHub) SetAttentionClearObserver(f func(id string)) {
	if f == nil {
		h.attnClearObs.Store(nil)
		return
	}
	h.attnClearObs.Store(&f)
}

func (h *CommandHub) observeAttentionClear(id string) {
	if f := h.attnClearObs.Load(); f != nil {
		(*f)(id)
	}
}

// SetToolGoneObserver 는 추적기가 도구를 잊을 때(종료·삭제, AttnTracker.Forget) 불릴 함수를
// 단다. nil 이면 걷는다 (REFACTOR3_GO_STRUCT_SRS GD-12 — Telegram 브리지가 탭 상태를 걷는다).
func (h *CommandHub) SetToolGoneObserver(f func(id string)) {
	if f == nil {
		h.goneObs.Store(nil)
		return
	}
	h.goneObs.Store(&f)
}

func (h *CommandHub) observeToolGone(id string) {
	if f := h.goneObs.Load(); f != nil {
		(*f)(id)
	}
}
