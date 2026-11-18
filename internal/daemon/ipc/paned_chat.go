package ipc

import (
	"encoding/json"
	"sync"

	"dongminal/internal/shared/chatwire"
	"dongminal/internal/shared/toolipc"
)

// PEER_CHAT_SRS §3.11 — 사람 참가자의 채팅. 채팅 소켓(chatsock)은 boot 가 세워 SetChat 으로
// 싣는다. 서버는 화면의 연산을 chat 으로 넘기고, 사람에게 온 글과 바뀜 알림을 chat push 로 받는다.

// ChatUser 는 사람 참가자의 연산이다. chatsock.Server 가 구현한다.
type ChatUser interface {
	UserCall(op string, args json.RawMessage) (json.RawMessage, *chatwire.Error)
}

type chatState struct {
	mu   sync.Mutex
	user ChatUser
}

// SetChat 은 사람 참가자를 싣는다. 싣지 않으면 chat 은 daemon_unavailable 이다.
func (ps *PanedServer) SetChat(u ChatUser) {
	ps.chat.mu.Lock()
	ps.chat.user = u
	ps.chat.mu.Unlock()
}

func (ps *PanedServer) chatUser() ChatUser {
	ps.chat.mu.Lock()
	defer ps.chat.mu.Unlock()
	return ps.chat.user
}

// PushChatMsg 는 사람에게 온 글을 서버로 민다. 서버가 없거나 chat push 를 모르면 버린다 —
// 데몬은 글을 들지 않는다 (FR-PCH-85).
func (ps *PanedServer) PushChatMsg(m chatwire.Message) {
	ps.pushChat(toolipc.ChatEvent{Chat: &m, ChatKind: toolipc.ChatKindMsg, Event: toolipc.EventChat})
}

// PushChatChanged 는 온라인 목록·방이 바뀌었다고 알린다. 서버는 붙을 때 다시 읽게 한다.
func (ps *PanedServer) PushChatChanged() {
	ps.pushChat(toolipc.ChatEvent{ChatKind: toolipc.ChatKindChanged, Event: toolipc.EventChat})
}

func (ps *PanedServer) pushChat(ev toolipc.ChatEvent) {
	ps.mu.Lock()
	c := ps.currConn
	ps.mu.Unlock()
	if c == nil || !c.chat.Load() {
		return
	}
	c.enqueue(ev, false)
}

// chatOp 는 사람 참가자의 연산 하나다. 채팅 핵심의 연산은 메모리 안에서 끝나므로 읽기 루프에서 돈다.
func (pc *panedConn) chatOp(req *toolipc.PanedRequest) interface{} {
	p, perr := decodeParams[toolipc.ChatParams](req)
	if perr != nil {
		return *perr
	}
	var u ChatUser
	if pc.srv != nil {
		u = pc.srv.chatUser()
	}
	if u == nil {
		return okResp(req, toolipc.ChatResult{Error: &chatwire.Error{Code: chatwire.CodeDaemonUnavailable, Message: "chat unavailable"}})
	}
	res, werr := u.UserCall(p.Op, p.Args)
	if werr != nil {
		return okResp(req, toolipc.ChatResult{Error: werr})
	}
	return okResp(req, toolipc.ChatResult{Result: res})
}

// chatSlow 는 도우미를 기다리는 op(kill·kick)인가다. 다른 op 는 읽기 루프에서 차례로 돈다.
func chatSlow(req *toolipc.PanedRequest) bool {
	p, perr := decodeParams[toolipc.ChatParams](req)
	return perr == nil && (p.Op == chatwire.OpKill || p.Op == chatwire.OpKick)
}
