package toolipc

import (
	"encoding/json"

	"dongminal/internal/shared/chatwire"
)

// PEER_CHAT_SRS §3.11 — 사람 참가자의 채팅 와이어. 채팅은 데몬에 있고, 서버는 화면의 요청을
// chat 으로 넘기고 chat push 를 화면에 방송한다. FeatureChat 을 양쪽이 말할 때만 쓴다.

// ChatParams 는 사람 참가자의 연산 하나다. Op 는 chatwire 의 call op 와 state 다.
type ChatParams struct {
	Args json.RawMessage `json:"args,omitempty"`
	Op   string          `json:"op"`
}

// ChatResult 는 그 답이다. Error 가 있으면 Result 가 없다.
type ChatResult struct {
	Error  *chatwire.Error `json:"error,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
}

// chat push 의 종류.
const (
	ChatKindMsg     = "msg"
	ChatKindChanged = "changed"
)

// ChatEvent 는 chat push 다. msg 는 사람에게 온 글을, changed 는 온라인 목록·방이 바뀌었음을 알린다.
type ChatEvent struct {
	Chat     *chatwire.Message `json:"chat,omitempty"`
	ChatKind string            `json:"chatKind"`
	Event    string            `json:"event"`
}
