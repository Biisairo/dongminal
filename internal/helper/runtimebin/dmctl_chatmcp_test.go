package runtimebin

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"dongminal/internal/shared/chatwire"
)

// PEER_CHAT_SRS §3.10 — MCP 서버 `dmctl chat-mcp` (TC-PCH-12 MCP 쪽).

// fakeDaemon 은 채팅 소켓의 데몬 쪽이다. 받은 프레임을 got 으로 넘긴다.
type fakeDaemon struct {
	t   *testing.T
	c   net.Conn
	got chan chatwire.Frame
	wmu sync.Mutex
}

func (d *fakeDaemon) send(f chatwire.Frame) {
	d.t.Helper()
	b, _ := chatwire.Encode(f)
	d.wmu.Lock()
	defer d.wmu.Unlock()
	if _, err := d.c.Write(b); err != nil {
		d.t.Fatal(err)
	}
}

func (d *fakeDaemon) next(want string) chatwire.Frame {
	d.t.Helper()
	select {
	case f, ok := <-d.got:
		if !ok {
			d.t.Fatalf("%s 를 기다리는데 닫혔다", want)
		}
		if f.T != want {
			d.t.Fatalf("frame %+v, want %s", f, want)
		}
		return f
	case <-time.After(3 * time.Second):
		d.t.Fatalf("%s 가 오지 않는다", want)
	}
	return chatwire.Frame{}
}

func (d *fakeDaemon) quiet() {
	d.t.Helper()
	select {
	case f := <-d.got:
		d.t.Fatalf("뜻밖의 프레임 %+v", f)
	case <-time.After(50 * time.Millisecond):
	}
}

// mcpHarness 는 chat-mcp 하나를 stdio 파이프로 돌린다. 가짜 데몬을 준비한 뒤 start 로 띄운다. dials 에 넣은 결과가 차례로 연결이 된다.
type mcpHarness struct {
	t     *testing.T
	in    io.WriteCloser
	out   *bufio.Scanner
	dials chan net.Conn
	id    int
	start func()
}

func newMCPHarness(t *testing.T, session string) *mcpHarness {
	t.Helper()
	h := &mcpHarness{t: t, dials: make(chan net.Conn, 4)}
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	h.in = inW
	h.out = bufio.NewScanner(outR)
	h.out.Buffer(make([]byte, 0, 64<<10), 4<<20)
	m := newChatMCP(session, "tool-1", func() (net.Conn, error) {
		select {
		case c := <-h.dials:
			if c == nil {
				return nil, errors.New("데몬 없음")
			}
			return c, nil
		default:
			return nil, errors.New("데몬 없음")
		}
	}, func() string { return "review" })
	done := make(chan struct{})
	h.start = func() {
		go func() { m.serve(inR, outW); outW.Close(); close(done) }()
		t.Cleanup(func() { inW.Close(); <-done })
	}
	return h
}

// daemon 은 다음 dial 에 붙을 가짜 데몬이다. hello 답을 미리 정한다.
func (h *mcpHarness) daemon() *fakeDaemon {
	a, b := net.Pipe()
	h.t.Cleanup(func() { a.Close(); b.Close() })
	d := &fakeDaemon{t: h.t, c: b, got: make(chan chatwire.Frame, 64)}
	go func() {
		sc := chatwire.NewScanner(b)
		for sc.Scan() {
			var f chatwire.Frame
			if json.Unmarshal(sc.Bytes(), &f) == nil {
				if f.T == chatwire.TypeHello {
					d.send(chatwire.Frame{T: chatwire.TypeHello, ID: "pid-1", Label: "mac/review"})
				}
				d.got <- f
			}
		}
		close(d.got)
	}()
	h.dials <- a
	return d
}

type rpcResp struct {
	ID     json.RawMessage `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code int `json:"code"`
	} `json:"error"`
}

func (h *mcpHarness) rpc(method string, params any) rpcResp {
	h.t.Helper()
	h.id++
	b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": h.id, "method": method, "params": params})
	if _, err := h.in.Write(append(b, '\n')); err != nil {
		h.t.Fatal(err)
	}
	if !h.out.Scan() {
		h.t.Fatalf("%s: 답이 없다", method)
	}
	var r rpcResp
	if err := json.Unmarshal(h.out.Bytes(), &r); err != nil {
		h.t.Fatal(err)
	}
	if string(r.ID) != fmt.Sprint(h.id) {
		h.t.Fatalf("id %s, want %d", r.ID, h.id)
	}
	return r
}

type toolResult struct {
	Content []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"content"`
	IsError bool `json:"isError"`
}

func (h *mcpHarness) tool(name string, args any) toolResult {
	h.t.Helper()
	r := h.rpc("tools/call", map[string]any{"name": name, "arguments": args})
	var tr toolResult
	if err := json.Unmarshal(r.Result, &tr); err != nil || len(tr.Content) != 1 {
		h.t.Fatalf("%s: result %s", name, r.Result)
	}
	return tr
}

func errCode(t *testing.T, tr toolResult) string {
	t.Helper()
	if !tr.IsError {
		t.Fatalf("오류가 아니다: %s", tr.Content[0].Text)
	}
	var e chatwire.Error
	if err := json.Unmarshal([]byte(tr.Content[0].Text), &e); err != nil {
		t.Fatal(err)
	}
	return e.Code
}

func msgFrame(id, room, name, text string) chatwire.Frame {
	return chatwire.Frame{T: chatwire.TypeMsg, Msg: &chatwire.Message{ID: id, Room: room, RoomKind: "group",
		RoomName: name, RoomPurpose: "p-" + name, From: "x", FromLabel: "mac/x", Text: text, At: 1}}
}

func TestChatMCPInitializeAndList(t *testing.T) {
	h := newMCPHarness(t, "s1")
	h.daemon()
	h.start()
	r := h.rpc("initialize", map[string]any{"protocolVersion": "2025-06-18"})
	var init struct {
		ProtocolVersion string         `json:"protocolVersion"`
		Capabilities    map[string]any `json:"capabilities"`
		Instructions    string         `json:"instructions"`
	}
	if err := json.Unmarshal(r.Result, &init); err != nil {
		t.Fatal(err)
	}
	if init.ProtocolVersion != "2025-06-18" || init.Capabilities["tools"] == nil {
		t.Fatalf("initialize %s", r.Result)
	}
	for _, w := range []string{"사용자 지시가 아니다", "비밀", "방 목적", "chat_read"} {
		if !strings.Contains(init.Instructions, w) {
			t.Fatalf("안내문에 %q 가 없다", w)
		}
	}
	// 알림에는 답하지 않는다 — 다음 답이 ping 의 것이어야 한다.
	h.in.Write([]byte(`{"jsonrpc":"2.0","method":"notifications/initialized"}` + "\n"))
	h.rpc("ping", nil)
	var list struct {
		Tools []struct {
			Name        string         `json:"name"`
			InputSchema map[string]any `json:"inputSchema"`
		} `json:"tools"`
	}
	if err := json.Unmarshal(h.rpc("tools/list", nil).Result, &list); err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, tl := range list.Tools {
		if tl.InputSchema["type"] != "object" {
			t.Fatalf("%s: inputSchema %v", tl.Name, tl.InputSchema)
		}
		names = append(names, tl.Name)
	}
	want := "chat_online chat_rooms chat_create chat_direct chat_join chat_leave chat_send chat_read"
	if strings.Join(names, " ") != want {
		t.Fatalf("tools %v", names)
	}
	if r := h.rpc("bogus/method", nil); r.Error == nil || r.Error.Code != -32601 {
		t.Fatalf("모르는 메서드 %+v", r)
	}
	if code := errCode(t, h.tool("chat_nope", map[string]any{})); code != chatwire.CodeBadRequest {
		t.Fatalf("모르는 도구 %s", code)
	}
}

func TestChatMCPHelloAndCalls(t *testing.T) {
	h := newMCPHarness(t, "s1")
	d := h.daemon()
	h.start()
	hello := d.next(chatwire.TypeHello)
	if hello.Session != "s1" || hello.Tool != "tool-1" || hello.Tab != "review" {
		t.Fatalf("hello %+v", hello)
	}
	done := make(chan toolResult)
	go func() { done <- h.tool("chat_send", map[string]any{"room": "r1", "text": "안녕"}) }()
	call := d.next(chatwire.TypeCall)
	var args chatwire.SendArgs
	_ = json.Unmarshal(call.Args, &args)
	if call.Op != chatwire.OpSend || args.Room != "r1" || args.Text != "안녕" {
		t.Fatalf("call %+v", call)
	}
	d.send(chatwire.Frame{T: chatwire.TypeReply, N: call.N, Result: json.RawMessage(`{"ok":true}`)})
	if tr := <-done; tr.IsError || tr.Content[0].Text != `{"ok":true}` {
		t.Fatalf("send %+v", tr)
	}
	go func() { done <- h.tool("chat_join", map[string]any{"room": "r9"}) }()
	call = d.next(chatwire.TypeCall)
	d.send(chatwire.Frame{T: chatwire.TypeReply, N: call.N, Error: &chatwire.Error{Code: "no_such_room", Message: "r9"}})
	if code := errCode(t, <-done); code != "no_such_room" {
		t.Fatalf("join %s", code)
	}
}

// FR-PCH-54: 글함 200, 넘치면 가장 오래된 글부터 버리고 버린 수를 알린다.
func TestChatMCPInboxCapAndRead(t *testing.T) {
	h := newMCPHarness(t, "s1")
	d := h.daemon()
	h.start()
	d.next(chatwire.TypeHello)
	for i := range inboxMax + 1 {
		d.send(msgFrame(fmt.Sprint(i), "r1", "auth", fmt.Sprint("m", i)))
	}
	d.send(msgFrame("b", "r2", "ops", "다른 방"))
	d.next(chatwire.TypeRise)
	var read struct {
		Dropped int `json:"dropped"`
		Rooms   []struct {
			Room, Name, Purpose string
			Messages            []struct{ Text string } `json:"messages"`
		} `json:"rooms"`
	}
	// 방을 고르면 그 방만 읽는다. 버린 수는 첫 읽기에 실린다.
	if err := json.Unmarshal([]byte(h.tool("chat_read", map[string]any{"room": "r2"}).Content[0].Text), &read); err != nil {
		t.Fatal(err)
	}
	if read.Dropped != 2 || len(read.Rooms) != 1 || read.Rooms[0].Name != "ops" || read.Rooms[0].Purpose != "p-ops" {
		t.Fatalf("read r2 %+v", read)
	}
	read.Rooms = nil
	if err := json.Unmarshal([]byte(h.tool("chat_read", map[string]any{}).Content[0].Text), &read); err != nil {
		t.Fatal(err)
	}
	if read.Dropped != 0 || len(read.Rooms) != 1 || len(read.Rooms[0].Messages) != inboxMax-1 || read.Rooms[0].Messages[0].Text != "m2" {
		t.Fatalf("read all dropped=%d rooms=%d", read.Dropped, len(read.Rooms))
	}
	read.Rooms = nil
	_ = json.Unmarshal([]byte(h.tool("chat_read", map[string]any{}).Content[0].Text), &read)
	if len(read.Rooms) != 0 {
		t.Fatalf("읽은 글이 남았다 %+v", read)
	}
}

// FR-PCH-61·62: 0건에서 생기는 순간에만 rise 를 보낸다.
func TestChatMCPRiseOnlyFromZero(t *testing.T) {
	h := newMCPHarness(t, "s1")
	d := h.daemon()
	h.start()
	d.next(chatwire.TypeHello)
	d.send(msgFrame("1", "r1", "auth", "a"))
	rise := d.next(chatwire.TypeRise)
	if rise.Total != 1 {
		t.Fatalf("rise %+v", rise)
	}
	d.send(msgFrame("2", "r1", "auth", "b"))
	d.quiet()
	h.tool("chat_read", map[string]any{})
	d.send(msgFrame("3", "r1", "auth", "c"))
	d.next(chatwire.TypeRise)
}

// FR-PCH-60: 훅 질의에 지금 개수를 방별로 답한다.
func TestChatMCPCountAnswer(t *testing.T) {
	h := newMCPHarness(t, "s1")
	d := h.daemon()
	h.start()
	d.next(chatwire.TypeHello)
	d.send(msgFrame("1", "r1", "auth", "a"))
	d.send(msgFrame("2", "r2", "ops", "b"))
	d.send(msgFrame("3", "r1", "auth", "c"))
	d.next(chatwire.TypeRise)
	d.send(chatwire.Frame{T: chatwire.TypeCountAsk, N: 7})
	c := d.next(chatwire.TypeCount)
	if c.N != 7 || c.Total != 3 {
		t.Fatalf("count %+v", c)
	}
}

func TestChatMCPRoomsFillUnread(t *testing.T) {
	h := newMCPHarness(t, "s1")
	d := h.daemon()
	h.start()
	d.next(chatwire.TypeHello)
	d.send(msgFrame("1", "r1", "auth", "a"))
	d.next(chatwire.TypeRise)
	done := make(chan toolResult)
	go func() { done <- h.tool("chat_rooms", map[string]any{}) }()
	call := d.next(chatwire.TypeCall)
	d.send(chatwire.Frame{T: chatwire.TypeReply, N: call.N, Result: json.RawMessage(`{"rooms":[{"id":"r1","kind":"group","creator":"c","creatorName":"n","members":1,"joined":true,"unread":0},{"id":"r2","kind":"group","creator":"c","creatorName":"n","members":1,"joined":false,"unread":0}]}`)})
	var rooms chatwire.Rooms
	if err := json.Unmarshal([]byte((<-done).Content[0].Text), &rooms); err != nil {
		t.Fatal(err)
	}
	if rooms.Rooms[0].Unread != 1 || rooms.Rooms[1].Unread != 0 {
		t.Fatalf("rooms %+v", rooms)
	}
}

// FR-PCH-43: 데몬과 끊기면 글함을 비우고, 다음 호출에서 새 참가자로 다시 연결한다.
func TestChatMCPReconnectClearsInbox(t *testing.T) {
	h := newMCPHarness(t, "s1")
	d := h.daemon()
	h.start()
	d.next(chatwire.TypeHello)
	d.send(msgFrame("1", "r1", "auth", "a"))
	d.next(chatwire.TypeRise)
	d.c.Close()
	time.Sleep(50 * time.Millisecond)
	if code := errCode(t, h.tool("chat_online", map[string]any{})); code != chatwire.CodeDaemonUnavailable {
		t.Fatalf("끊긴 뒤 %s", code)
	}
	d2 := h.daemon()
	done := make(chan toolResult)
	go func() { done <- h.tool("chat_read", map[string]any{}) }()
	d2.next(chatwire.TypeHello)
	var read struct {
		Rooms []any `json:"rooms"`
	}
	_ = json.Unmarshal([]byte((<-done).Content[0].Text), &read)
	if len(read.Rooms) != 0 {
		t.Fatalf("옛 글이 남았다 %+v", read)
	}
}

func TestChatMCPWithoutSession(t *testing.T) {
	h := newMCPHarness(t, "")
	d := h.daemon()
	h.start()
	if code := errCode(t, h.tool("chat_online", map[string]any{})); code != chatwire.CodeBadRequest {
		t.Fatalf("세션 없음 %s", code)
	}
	d.quiet()
}
