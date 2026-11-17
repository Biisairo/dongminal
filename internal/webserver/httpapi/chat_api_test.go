package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"

	"dongminal/internal/shared/chatwire"
	"dongminal/internal/shared/toolipc"
	"dongminal/internal/webserver/apierr"
)

// PEER_CHAT_SRS §3.11 — 로컬 API `/api/chat` 과 SSE (TC-PCH-16).

type fakeChatDaemon struct {
	ready bool
	got   []toolipc.ChatParams
	res   toolipc.ChatResult
	err   error
}

func (f *fakeChatDaemon) ChatReady() bool { return f.ready }
func (f *fakeChatDaemon) Chat(p toolipc.ChatParams) (toolipc.ChatResult, error) {
	f.got = append(f.got, p)
	return f.res, f.err
}

func chatSrv(t *testing.T, d ChatDaemon) (*edgeNode, *fakeCommandBroker) {
	t.Helper()
	cmds := &fakeCommandBroker{}
	srv, err := New(Config{DataDir: shortHome(t)}, Deps{Commands: cmds, ChatDaemon: d})
	if err != nil {
		t.Fatal(err)
	}
	return &edgeNode{srv: srv}, cmds
}

// NFR-PCH-5: 직접 모드는 409 chat_daemon_only 다.
func TestChatAPI_DirectModeIsDaemonOnly(t *testing.T) {
	n, _ := chatSrv(t, nil)
	for _, c := range []struct{ m, p string }{{http.MethodGet, "/api/chat"}, {http.MethodPost, "/api/chat/send"}} {
		code, out := n.api(t, c.m, c.p, map[string]any{"room": "r", "text": "x"})
		if code != http.StatusConflict || errCode(out) != apierr.CodeChatDaemonOnly {
			t.Fatalf("%s %s: %d %v", c.m, c.p, code, out)
		}
	}
}

// 채팅을 모르는 옛 데몬은 409 chat_daemon_restart 다. 데몬에 보내지 않는다.
func TestChatAPI_OldDaemonNeedsRestart(t *testing.T) {
	d := &fakeChatDaemon{}
	n, _ := chatSrv(t, d)
	code, out := n.api(t, http.MethodGet, "/api/chat", nil)
	if code != http.StatusConflict || errCode(out) != apierr.CodeChatDaemonRestart || len(d.got) != 0 {
		t.Fatalf("%d %v %+v", code, out, d.got)
	}
}

// GET 은 state, POST 는 경로의 op 와 본문을 데몬에 넘기고 답을 그대로 쓴다.
func TestChatAPI_PassesOpAndBody(t *testing.T) {
	d := &fakeChatDaemon{ready: true, res: toolipc.ChatResult{Result: json.RawMessage(`{"me":{"id":"u"}}`)}}
	n, _ := chatSrv(t, d)
	code, out := n.api(t, http.MethodGet, "/api/chat", nil)
	if code != http.StatusOK || !strings.Contains(out["_raw"].(string), `"me":{"id":"u"}`) || d.got[0].Op != chatwire.OpState {
		t.Fatalf("%d %v %+v", code, out, d.got)
	}
	for _, op := range []string{chatwire.OpCreate, chatwire.OpDirect, chatwire.OpJoin, chatwire.OpLeave, chatwire.OpSend, chatwire.OpKill, chatwire.OpKick} {
		code, _ := n.api(t, http.MethodPost, "/api/chat/"+op, map[string]any{"room": "r1"})
		last := d.got[len(d.got)-1]
		if code != http.StatusOK || last.Op != op || string(last.Args) != `{"room":"r1"}` {
			t.Fatalf("%s: %d %+v", op, code, last)
		}
	}
}

// 데몬의 채팅 코드는 chat_ 를 붙여 상태와 함께 낸다.
func TestChatAPI_ErrorMapping(t *testing.T) {
	cases := []struct {
		code   string
		status int
		want   string
	}{
		{chatwire.CodeBadRequest, 400, apierr.CodeChatBadRequest},
		{"too_large", 413, apierr.CodeChatTooLarge},
		{"rate_limited", 429, apierr.CodeChatRateLimited},
		{"not_in_room", 409, apierr.CodeChatNotInRoom},
		{"no_such_room", 404, apierr.CodeChatNoSuchRoom},
		{"no_such_participant", 404, apierr.CodeChatNoSuchParticipant},
		{chatwire.CodeDaemonUnavailable, 503, apierr.CodeChatUnavailable},
		{chatwire.CodeBadCode, 403, apierr.CodeChatBadCode},
		{chatwire.CodeLocked, 423, apierr.CodeChatLocked},
		{chatwire.CodeNoHelper, 409, apierr.CodeChatNoHelper},
		{"모르는_코드", 400, apierr.CodeChatBadRequest},
	}
	for _, c := range cases {
		d := &fakeChatDaemon{ready: true, res: toolipc.ChatResult{Error: &chatwire.Error{Code: c.code, Message: "m"}}}
		n, _ := chatSrv(t, d)
		code, out := n.api(t, http.MethodPost, "/api/chat/send", map[string]any{"room": "r"})
		if code != c.status || errCode(out) != c.want {
			t.Fatalf("%s: %d %v", c.code, code, out)
		}
	}
	d := &fakeChatDaemon{ready: true, err: errors.New("끊김")}
	n, _ := chatSrv(t, d)
	if code, out := n.api(t, http.MethodGet, "/api/chat", nil); code != http.StatusBadGateway || errCode(out) != apierr.CodeChatUnreachable {
		t.Fatalf("끊김: %d %v", code, out)
	}
}

func lastPayload(t *testing.T, cmds *fakeCommandBroker) map[string]any {
	t.Helper()
	cmds.mu.Lock()
	defer cmds.mu.Unlock()
	if len(cmds.published) == 0 {
		t.Fatal("방송하지 않았다")
	}
	raw := string(cmds.published[len(cmds.published)-1])
	raw = strings.TrimPrefix(strings.TrimSpace(raw), "data: ")
	out := map[string]any{}
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		t.Fatalf("payload %q: %v", raw, err)
	}
	return out
}

// chat push 는 chat_message·chat_changed 로, 다시 붙으면 chat_changed 로 방송한다.
func TestChatAPI_PushBroadcasts(t *testing.T) {
	n, cmds := chatSrv(t, &fakeChatDaemon{ready: true})
	n.srv.ChatPushed(toolipc.ChatEvent{ChatKind: toolipc.ChatKindMsg, Chat: &chatwire.Message{ID: "m1", Text: "<b>hi</b>"}})
	p := lastPayload(t, cmds)
	args, _ := p["args"].(map[string]any)
	msg, _ := args["msg"].(map[string]any)
	if p["action"] != "chat_message" || msg["text"] != "<b>hi</b>" {
		t.Fatalf("msg %v", p)
	}
	n.srv.ChatPushed(toolipc.ChatEvent{ChatKind: toolipc.ChatKindChanged})
	if p := lastPayload(t, cmds); p["action"] != "chat_changed" {
		t.Fatalf("changed %v", p)
	}
	cmds.published = nil
	n.srv.ChatResync()
	if p := lastPayload(t, cmds); p["action"] != "chat_changed" {
		t.Fatalf("resync %v", p)
	}
}
