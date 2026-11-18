package toolclient

import (
	"dongminal/internal/shared/toolipc"
)

// PEER_CHAT_SRS §3.11 — 채팅의 사람 참가자는 데몬에 있다. 아래 메서드는 데몬이 FeatureChat 을
// 말할 때만 부른다.

// ChatReady 는 붙은 데몬이 chat 기능을 말하는가다. 데몬이 바뀔 수 있으므로 부를 때마다 묻는다.
func (pc *ToolClient) ChatReady() bool { return pc.HasFeature(toolipc.FeatureChat) }

// Chat 은 사람 참가자의 연산 하나를 데몬에 넘긴다.
func (pc *ToolClient) Chat(p toolipc.ChatParams) (toolipc.ChatResult, error) {
	return callT[toolipc.ChatResult](pc, toolipc.MethodChat, p)
}

// SetOnChat 은 chat push 콜백을 건다. 콜백은 읽기 루프에서 돌므로 데몬 RPC 를 기다리면 안 된다.
func (pc *ToolClient) SetOnChat(cb func(ev toolipc.ChatEvent)) {
	pc.mu.Lock()
	pc.onChat = cb
	pc.mu.Unlock()
}

func (pc *ToolClient) pushChat(m *wireMsg) {
	pc.mu.Lock()
	cb := pc.onChat
	pc.mu.Unlock()
	if cb != nil {
		cb(toolipc.ChatEvent{Chat: m.Chat, ChatKind: m.ChatKind, Event: m.Event})
	}
}

// SetOnChatResync 는 재접속 뒤의 콜백을 건다. 끊긴 동안의 바뀜을 화면이 다시 읽게 한다.
func (pc *ToolClient) SetOnChatResync(cb func()) {
	pc.mu.Lock()
	pc.onChatResync = cb
	pc.mu.Unlock()
}

func (pc *ToolClient) resyncChat() {
	pc.mu.Lock()
	cb := pc.onChatResync
	pc.mu.Unlock()
	if cb != nil {
		cb()
	}
}
