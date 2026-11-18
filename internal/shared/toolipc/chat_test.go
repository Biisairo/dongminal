package toolipc

import (
	"encoding/json"
	"testing"

	"dongminal/internal/shared/chatwire"
)

// PEER_CHAT_SRS §3.11: 채팅 와이어. 필드는 JSON 키 사전순이고 바이트를 고정한다.
func TestChatWireGolden(t *testing.T) {
	cases := []struct {
		name string
		v    any
		want string
	}{
		{"chat-params", ChatParams{Args: json.RawMessage(`{"room":"r1"}`), Op: "join"}, `{"args":{"room":"r1"},"op":"join"}`},
		{"chat-params-min", ChatParams{Op: "state"}, `{"op":"state"}`},
		{"chat-result", ChatResult{Result: json.RawMessage(`{"ok":true}`)}, `{"result":{"ok":true}}`},
		{"chat-result-fail", ChatResult{Error: &chatwire.Error{Code: "not_in_room", Message: "m"}},
			`{"error":{"code":"not_in_room","message":"m"}}`},
		{"chat-event-msg", ChatEvent{Chat: &chatwire.Message{ID: "m1"}, ChatKind: ChatKindMsg, Event: EventChat},
			`{"chat":{"id":"m1","room":"","roomKind":"","roomName":"","roomPurpose":"","from":"","fromLabel":"","fromKind":"","node":"","text":"","at":0},"chatKind":"msg","event":"chat"}`},
		{"chat-event-changed", ChatEvent{ChatKind: ChatKindChanged, Event: EventChat}, `{"chatKind":"changed","event":"chat"}`},
	}
	for _, c := range cases {
		got, err := json.Marshal(c.v)
		if err != nil || string(got) != c.want {
			t.Errorf("%s: %s (%v), want %s", c.name, got, err, c.want)
		}
	}
	if !HasFeature(DaemonFeatures, FeatureChat) || !HasFeature(ServerFeatures, FeatureChat) {
		t.Fatal("양쪽이 chat 기능을 말하지 않는다")
	}
}
