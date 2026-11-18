package ipc

import (
	"bytes"
	"encoding/json"
	"testing"

	"dongminal/internal/shared/chatwire"
	"dongminal/internal/shared/toolipc"
)

// PEER_CHAT_SRS §3.11 — 사람 참가자의 채팅 IPC (TC-PCH-16).

type fakeChatUser struct {
	op   string
	args string
	res  json.RawMessage
	err  *chatwire.Error
}

func (f *fakeChatUser) UserCall(op string, args json.RawMessage) (json.RawMessage, *chatwire.Error) {
	f.op, f.args = op, string(args)
	return f.res, f.err
}

func chatServer(t *testing.T, user ChatUser, serverSaysChat bool) (*PanedServer, *panedConn, *bytes.Buffer) {
	t.Helper()
	ps, pc, buf := attnServer(t, false)
	pc.chat.Store(serverSaysChat)
	if user != nil {
		ps.SetChat(user)
	}
	return ps, pc, buf
}

func chatResult(t *testing.T, m map[string]json.RawMessage) toolipc.ChatResult {
	t.Helper()
	var r toolipc.ChatResult
	if err := json.Unmarshal(m["result"], &r); err != nil {
		t.Fatalf("result %s: %v", m["result"], err)
	}
	return r
}

// chat 은 사람 참가자의 답을 그대로 돌려준다.
func TestChat_PassesToUser(t *testing.T) {
	u := &fakeChatUser{res: json.RawMessage(`{"ok":true}`)}
	_, pc, buf := chatServer(t, u, true)
	r := chatResult(t, call(t, pc, buf, toolipc.MethodChat, toolipc.ChatParams{Op: chatwire.OpJoin, Args: json.RawMessage(`{"room":"r1"}`)}))
	if r.Error != nil || string(r.Result) != `{"ok":true}` || u.op != chatwire.OpJoin || u.args != `{"room":"r1"}` {
		t.Fatalf("%+v op=%q args=%q", r, u.op, u.args)
	}
	u.res, u.err = nil, &chatwire.Error{Code: "not_in_room", Message: "m"}
	r = chatResult(t, call(t, pc, buf, toolipc.MethodChat, toolipc.ChatParams{Op: chatwire.OpSend}))
	if r.Error == nil || r.Error.Code != "not_in_room" || r.Result != nil {
		t.Fatalf("%+v", r)
	}
}

// 채팅을 세우지 못한 데몬은 daemon_unavailable 로 답한다.
func TestChat_NoChatIsUnavailable(t *testing.T) {
	_, pc, buf := chatServer(t, nil, true)
	r := chatResult(t, call(t, pc, buf, toolipc.MethodChat, toolipc.ChatParams{Op: chatwire.OpState}))
	if r.Error == nil || r.Error.Code != chatwire.CodeDaemonUnavailable {
		t.Fatalf("%+v", r)
	}
}

func TestChat_HelloStoresFeature(t *testing.T) {
	_, pc, buf := chatServer(t, nil, false)
	call(t, pc, buf, toolipc.MethodHello, toolipc.HelloParams{Features: []string{toolipc.FeatureChat}})
	if !pc.chat.Load() {
		t.Fatal("hello 의 chat 기능을 적지 않았다")
	}
}

func chatEvents(t *testing.T, buf *bytes.Buffer) []toolipc.ChatEvent {
	t.Helper()
	var out []toolipc.ChatEvent
	for _, m := range lines(t, buf) {
		if string(m["event"]) != `"`+toolipc.EventChat+`"` {
			continue
		}
		raw, _ := json.Marshal(m)
		var ev toolipc.ChatEvent
		_ = json.Unmarshal(raw, &ev)
		out = append(out, ev)
	}
	return out
}

// 사람에게 온 글과 바뀜 알림은 chat 을 말한 서버에만 push 한다.
func TestChatPush_OnlyToChatServer(t *testing.T) {
	ps, _, buf := chatServer(t, nil, true)
	ps.PushChatMsg(chatwire.Message{ID: "m1", Text: "hi"})
	ps.PushChatChanged()
	ev := chatEvents(t, buf)
	if len(ev) != 2 || ev[0].ChatKind != toolipc.ChatKindMsg || ev[0].Chat == nil || ev[0].Chat.Text != "hi" || ev[1].ChatKind != toolipc.ChatKindChanged || ev[1].Chat != nil {
		t.Fatalf("push %+v", ev)
	}
	ps2, _, buf2 := chatServer(t, nil, false)
	ps2.PushChatMsg(chatwire.Message{ID: "m1"})
	ps2.PushChatChanged()
	if ev := chatEvents(t, buf2); len(ev) != 0 {
		t.Fatalf("chat 을 모르는 서버에 보냈다: %+v", ev)
	}
}
