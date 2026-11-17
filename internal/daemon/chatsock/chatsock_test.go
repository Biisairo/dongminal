package chatsock

import (
	"bufio"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"dongminal/internal/daemon/chat"
	"dongminal/internal/shared/chatwire"
	"dongminal/internal/shared/edge"
	"dongminal/internal/shared/platform"
)

// PEER_CHAT_SRS §3.10 — 채팅 소켓 (TC-PCH-6).

type fakeTools struct {
	mu      sync.Mutex
	resting map[string]bool
	pasted  []string
}

func (f *fakeTools) Resting(id string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.resting[id]
}

func (f *fakeTools) Paste(id, text string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.pasted = append(f.pasted, id+"|"+text)
	return nil
}

func (f *fakeTools) pastes() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.pasted...)
}

type harness struct {
	t     *testing.T
	srv   *Server
	svc   *chat.Service
	tools *fakeTools
	path  string
}

func newHarness(t *testing.T, opts ...func(*Options)) *harness {
	t.Helper()
	id, err := edge.LoadOrCreateIdentity(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	dir, err := os.MkdirTemp("", "dmcs")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	h := &harness{t: t, tools: &fakeTools{resting: map[string]bool{}}, path: filepath.Join(dir, "c.sock")}
	var srv *Server
	h.svc = chat.New(chat.Options{Identity: id, Name: func() string { return "mac" },
		Deliver: func(pid string, m chat.Message) { srv.Deliver(pid, m) }})
	o := Options{Chat: h.svc, Tools: h.tools, Name: func() string { return "mac" }, CountWait: 100 * time.Millisecond}
	for _, f := range opts {
		f(&o)
	}
	srv = New(o)
	h.srv = srv
	if err := srv.Listen(h.path); err != nil {
		t.Fatal(err)
	}
	go srv.Serve()
	t.Cleanup(func() { srv.Close(); h.svc.Close() })
	return h
}

type client struct {
	t  *testing.T
	c  net.Conn
	sc *bufio.Scanner
	n  uint64
	in chan chatwire.Frame
}

func (h *harness) dial() *client {
	h.t.Helper()
	c, err := platform.Current().IPC.Dial(h.path, time.Second)
	if err != nil {
		h.t.Fatal(err)
	}
	h.t.Cleanup(func() { c.Close() })
	cl := &client{t: h.t, c: c, sc: chatwire.NewScanner(c), in: make(chan chatwire.Frame, 64)}
	go func() {
		for cl.sc.Scan() {
			var f chatwire.Frame
			if json.Unmarshal(cl.sc.Bytes(), &f) == nil {
				cl.in <- f
			}
		}
		close(cl.in)
	}()
	return cl
}

func (cl *client) send(f chatwire.Frame) {
	cl.t.Helper()
	b, err := chatwire.Encode(f)
	if err != nil {
		cl.t.Fatal(err)
	}
	if _, err := cl.c.Write(b); err != nil {
		cl.t.Fatal(err)
	}
}

func (cl *client) next(want string) chatwire.Frame {
	cl.t.Helper()
	select {
	case f, ok := <-cl.in:
		if !ok {
			cl.t.Fatalf("%s 를 기다리는데 연결이 닫혔다", want)
		}
		if f.T != want {
			cl.t.Fatalf("frame %+v, want %s", f, want)
		}
		return f
	case <-time.After(3 * time.Second):
		cl.t.Fatalf("%s 가 오지 않는다", want)
	}
	return chatwire.Frame{}
}

func (cl *client) closed() bool {
	select {
	case _, ok := <-cl.in:
		return !ok
	case <-time.After(3 * time.Second):
		return false
	}
}

func (h *harness) agent(session, tool, tab string) (*client, chatwire.Frame) {
	cl := h.dial()
	cl.send(chatwire.Frame{T: chatwire.TypeHello, Session: session, Tool: tool, Tab: tab})
	return cl, cl.next(chatwire.TypeHello)
}

func (cl *client) call(op string, args any) chatwire.Frame {
	cl.t.Helper()
	raw, _ := json.Marshal(args)
	cl.n++
	cl.send(chatwire.Frame{T: chatwire.TypeCall, N: cl.n, Op: op, Args: raw})
	f := cl.next(chatwire.TypeReply)
	if f.N != cl.n {
		cl.t.Fatalf("reply n=%d, want %d", f.N, cl.n)
	}
	return f
}

func mustRoom(t *testing.T, f chatwire.Frame) chatwire.Room {
	t.Helper()
	if f.Error != nil {
		t.Fatalf("error %+v", f.Error)
	}
	var r chatwire.RoomResult
	if err := json.Unmarshal(f.Result, &r); err != nil {
		t.Fatal(err)
	}
	return r.Room
}

func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("%s: 시간 초과", what)
}

func TestHelloRegistersParticipant(t *testing.T) {
	h := newHarness(t)
	_, hello := h.agent("s1", "01a1e8ee-e475-7000", "review")
	if hello.Label != "mac/review" || !strings.Contains(hello.ID, "-") {
		t.Fatalf("hello %+v", hello)
	}
	_, anon := h.agent("s2", "01a1e8ee-e475-7000", "")
	if anon.Label != "mac/tool-01a1e8ee" {
		t.Fatalf("탭 이름 없는 표시 이름 %q", anon.Label)
	}
	if n := len(h.svc.Online().Participants); n != 2 {
		t.Fatalf("참가자 %d, want 2", n)
	}
}

func TestHelloSanitizesTab(t *testing.T) {
	h := newHarness(t)
	_, hello := h.agent("s1", "t1", "a\x1b[31mb"+strings.Repeat("x", 100))
	if strings.ContainsRune(hello.Label, 0x1b) || len(hello.Label) > maxLabel {
		t.Fatalf("label %q", hello.Label)
	}
}

func TestHelloRequiresSessionAndTool(t *testing.T) {
	h := newHarness(t)
	for _, f := range []chatwire.Frame{
		{T: chatwire.TypeHello, Tool: "t1"},
		{T: chatwire.TypeHello, Session: "s1"},
		{T: chatwire.TypeCall, Op: chatwire.OpOnline},
	} {
		cl := h.dial()
		cl.send(f)
		e := cl.next(chatwire.TypeError)
		if e.Error == nil || e.Error.Code != chatwire.CodeBadRequest {
			t.Fatalf("error %+v", e)
		}
		if !cl.closed() {
			t.Fatal("연결이 닫히지 않았다")
		}
	}
}

func TestParticipantCap(t *testing.T) {
	h := newHarness(t, func(o *Options) { o.MaxAgents = 1 })
	h.agent("s1", "t1", "a")
	cl := h.dial()
	cl.send(chatwire.Frame{T: chatwire.TypeHello, Session: "s2", Tool: "t2"})
	if e := cl.next(chatwire.TypeError); e.Error == nil || e.Error.Code != chatwire.CodeFull {
		t.Fatalf("error %+v", e)
	}
}

func TestCallsAndDelivery(t *testing.T) {
	h := newHarness(t)
	a, _ := h.agent("sa", "ta", "a")
	b, hb := h.agent("sb", "tb", "b")
	room := mustRoom(t, a.call(chatwire.OpCreate, chatwire.CreateArgs{Name: "auth", Purpose: "리뷰"}))
	if room.Name != "auth" || !room.Joined || room.Members != 1 {
		t.Fatalf("room %+v", room)
	}
	if f := b.call(chatwire.OpSend, chatwire.SendArgs{Room: room.ID, Text: "x"}); f.Error == nil || f.Error.Code != chat.CodeNotInRoom {
		t.Fatalf("들지 않은 방에 썼다: %+v", f)
	}
	mustRoom(t, b.call(chatwire.OpJoin, chatwire.RoomArgs{Room: room.ID}))
	if f := a.call(chatwire.OpSend, chatwire.SendArgs{Room: room.ID, Text: "안녕"}); f.Error != nil {
		t.Fatalf("send %+v", f.Error)
	}
	m := b.next(chatwire.TypeMsg).Msg
	if m == nil || m.Text != "안녕" || m.RoomName != "auth" || m.RoomPurpose != "리뷰" || m.FromLabel != "mac/a" || m.At == 0 {
		t.Fatalf("msg %+v", m)
	}
	var rooms chatwire.Rooms
	if err := json.Unmarshal(b.call(chatwire.OpRooms, struct{}{}).Result, &rooms); err != nil || len(rooms.Rooms) != 1 || rooms.Rooms[0].Members != 2 {
		t.Fatalf("rooms %+v %v", rooms, err)
	}
	var on chatwire.Online
	if err := json.Unmarshal(a.call(chatwire.OpOnline, struct{}{}).Result, &on); err != nil || len(on.Participants) != 2 || len(on.Nodes) != 1 || len(on.Nodes[0].FP) != fpShown {
		t.Fatalf("online %+v %v", on, err)
	}
	direct := mustRoom(t, a.call(chatwire.OpDirect, chatwire.DirectArgs{Participant: hb.ID}))
	if direct.Kind != chat.KindDirect {
		t.Fatalf("direct %+v", direct)
	}
	if f := a.call(chatwire.OpLeave, chatwire.RoomArgs{Room: room.ID}); f.Error != nil {
		t.Fatalf("leave %+v", f.Error)
	}
	if f := a.call("bogus", struct{}{}); f.Error == nil || f.Error.Code != chatwire.CodeBadRequest {
		t.Fatalf("bogus op %+v", f)
	}
}

// FR-PCH-43: 연결이 끊기면 바로 모든 방에서 퇴장한다.
func TestDisconnectUnregisters(t *testing.T) {
	h := newHarness(t)
	a, _ := h.agent("sa", "ta", "a")
	b, _ := h.agent("sb", "tb", "b")
	mustRoom(t, a.call(chatwire.OpCreate, chatwire.CreateArgs{Name: "auth", Purpose: "p"}))
	a.c.Close()
	eventually(t, "퇴장", func() bool { return len(h.svc.Online().Participants) == 1 })
	var rooms chatwire.Rooms
	_ = json.Unmarshal(b.call(chatwire.OpRooms, struct{}{}).Result, &rooms)
	if len(rooms.Rooms) != 0 {
		t.Fatalf("방이 남았다 %+v", rooms)
	}
}

// FR-PCH-61·62: 0→1 알림은 쉬는 중일 때만 붙여 넣는다.
func TestRisePastesOnlyWhenResting(t *testing.T) {
	h := newHarness(t)
	h.tools.resting["rest"] = true
	rest, _ := h.agent("s1", "rest", "a")
	busy, _ := h.agent("s2", "busy", "b")
	rest.send(chatwire.Frame{T: chatwire.TypeRise, Total: 2, Rooms: []chatwire.RoomCount{{Name: "auth\x07" + strings.Repeat("가", 50), N: 2}}})
	busy.send(chatwire.Frame{T: chatwire.TypeRise, Total: 1, Rooms: []chatwire.RoomCount{{Name: "x", N: 1}}})
	eventually(t, "붙여넣기", func() bool { return len(h.tools.pastes()) == 1 })
	time.Sleep(50 * time.Millisecond)
	ps := h.tools.pastes()
	if len(ps) != 1 {
		t.Fatalf("pastes %q", ps)
	}
	want := `rest|[dongminal chat] 새 글 2건 (방: "auth` + strings.Repeat("가", roomNameShown-4) + `"). chat_read 로 확인한다.`
	if ps[0] != want {
		t.Fatalf("paste\n got %q\nwant %q", ps[0], want)
	}
}

// FR-PCH-60: 훅 질의는 그 세션의 MCP 에 물어 그대로 전한다.
func TestUnreadRelaysToSession(t *testing.T) {
	h := newHarness(t)
	old, _ := h.agent("s1", "t1", "a")
	mcp, _ := h.agent("s1", "t2", "b")
	go func() {
		ask := mcp.next(chatwire.TypeCountAsk)
		mcp.send(chatwire.Frame{T: chatwire.TypeCount, N: ask.N, Total: 3, Rooms: []chatwire.RoomCount{{Name: "auth", N: 3}}})
	}()
	hook := h.dial()
	hook.send(chatwire.Frame{T: chatwire.TypeUnread, Session: "s1"})
	got := hook.next(chatwire.TypeUnread)
	if got.Total != 3 || len(got.Rooms) != 1 || got.Rooms[0].Name != "auth" {
		t.Fatalf("unread %+v", got)
	}
	select {
	case f := <-old.in:
		t.Fatalf("먼저 연결에 물었다: %+v", f)
	default:
	}
}

func TestUnreadWithoutAnswerIsZero(t *testing.T) {
	h := newHarness(t)
	h.agent("s1", "t1", "a")
	for _, s := range []string{"s1", "nobody"} {
		hook := h.dial()
		hook.send(chatwire.Frame{T: chatwire.TypeUnread, Session: s})
		if got := hook.next(chatwire.TypeUnread); got.Total != 0 {
			t.Fatalf("%s: unread %+v", s, got)
		}
	}
}
