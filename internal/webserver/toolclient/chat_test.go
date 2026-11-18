package toolclient

import (
	"encoding/json"
	"os"
	"testing"
	"time"

	"dongminal/internal/daemon/ipc"
	"dongminal/internal/shared/chatwire"
	"dongminal/internal/shared/toolhub"
	"dongminal/internal/shared/toolipc"
)

// PEER_CHAT_SRS §3.11 — 서버가 사람 참가자의 연산을 chat 으로 넘기고 chat push 를 받는다.

type echoUser struct{}

func (echoUser) UserCall(op string, args json.RawMessage) (json.RawMessage, *chatwire.Error) {
	if op == chatwire.OpSend {
		return nil, &chatwire.Error{Code: "not_in_room", Message: "m"}
	}
	return json.RawMessage(`{"op":"` + op + `"}`), nil
}

func chatDaemon(t *testing.T) (*ipc.PanedServer, string) {
	t.Helper()
	d, err := os.MkdirTemp("", "ctc")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(d) })
	pm := toolhub.NewToolManager(d, nil)
	t.Cleanup(pm.StopSaving)
	ps := ipc.NewPanedServer(pm, d+"/s", "")
	ps.SetChat(echoUser{})
	if err := ps.Listen(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ps.Close() })
	go func() { _ = ps.Accept() }()
	return ps, d + "/s"
}

func TestChat_CallAndPush(t *testing.T) {
	ps, sock := chatDaemon(t)
	c, err := DialToolClient(sock)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if !c.ChatReady() {
		t.Fatal("chat 기능을 보지 못했다")
	}
	r, err := c.Chat(toolipc.ChatParams{Op: chatwire.OpState})
	if err != nil || r.Error != nil || string(r.Result) != `{"op":"state"}` {
		t.Fatalf("state %+v %v", r, err)
	}
	r, err = c.Chat(toolipc.ChatParams{Op: chatwire.OpSend})
	if err != nil || r.Error == nil || r.Error.Code != "not_in_room" {
		t.Fatalf("send %+v %v", r, err)
	}
	got := make(chan toolipc.ChatEvent, 4)
	c.SetOnChat(func(ev toolipc.ChatEvent) { got <- ev })
	ps.PushChatMsg(chatwire.Message{ID: "m1", Text: "hi", FromKind: "agent"})
	ps.PushChatChanged()
	for i, want := range []string{toolipc.ChatKindMsg, toolipc.ChatKindChanged} {
		select {
		case ev := <-got:
			if ev.ChatKind != want || (i == 0 && (ev.Chat == nil || ev.Chat.Text != "hi" || ev.Chat.FromKind != "agent")) || (i == 1 && ev.Chat != nil) {
				t.Fatalf("push %d %+v", i, ev)
			}
		case <-time.After(3 * time.Second):
			t.Fatalf("push %d 가 오지 않았다", i)
		}
	}
}
