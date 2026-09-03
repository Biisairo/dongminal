package lsp

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeServer 는 in-process 언어 서버다. 실제 프로세스를 띄우지 않고 프로토콜만
// 흉내내므로, 검사가 기계에 무엇이 깔렸는지에 매이지 않는다.
type fakeServer struct {
	fromClient *bufio.Reader
	toClient   io.Writer
}

// newPair 는 conn 과 fakeServer 를 잇는다.
func newPair(t *testing.T, onNotify func(string, json.RawMessage)) (*conn, *fakeServer) {
	t.Helper()
	cr, sw := io.Pipe() // 서버 → 클라이언트
	sr, cw := io.Pipe() // 클라이언트 → 서버
	c := newConn(rwc{Reader: cr, Writer: cw, closeFn: func() error {
		cw.Close()
		cr.Close()
		return nil
	}}, onNotify)
	t.Cleanup(func() { c.Close(); sw.Close(); sr.Close() })
	return c, &fakeServer{fromClient: bufio.NewReader(sr), toClient: sw}
}

type rwc struct {
	io.Reader
	io.Writer
	closeFn func() error
}

func (x rwc) Close() error { return x.closeFn() }

// next 는 클라이언트가 보낸 메시지 하나를 읽는다.
func (f *fakeServer) next(t *testing.T) map[string]any {
	t.Helper()
	b, err := readFrame(f.fromClient)
	if err != nil {
		t.Fatalf("클라이언트의 메시지를 읽지 못했다: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("클라이언트가 JSON 이 아닌 것을 보냈다: %v", err)
	}
	return m
}

func (f *fakeServer) reply(t *testing.T, id any, result any) {
	t.Helper()
	b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
	if err := writeFrame(f.toClient, b); err != nil {
		t.Fatal(err)
	}
}

func (f *fakeServer) replyError(t *testing.T, id any, code int, msg string) {
	t.Helper()
	b, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "id": id,
		"error": map[string]any{"code": code, "message": msg},
	})
	if err := writeFrame(f.toClient, b); err != nil {
		t.Fatal(err)
	}
}

func (f *fakeServer) notify(t *testing.T, method string, params any) {
	t.Helper()
	b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "method": method, "params": params})
	if err := writeFrame(f.toClient, b); err != nil {
		t.Fatal(err)
	}
}

// TC-LSP-50: 요청 하나가 자기 응답을 받는다.
func TestConn_Call(t *testing.T) {
	c, s := newPair(t, nil)
	type res struct {
		Hello string `json:"hello"`
	}
	done := make(chan error, 1)
	var got res
	go func() { done <- c.Call(context.Background(), "initialize", map[string]any{"x": 1}, &got) }()

	req := s.next(t)
	if req["method"] != "initialize" {
		t.Fatalf("method 가 다르다: %v", req["method"])
	}
	if req["jsonrpc"] != "2.0" {
		t.Fatalf("jsonrpc 가 없다: %v", req)
	}
	s.reply(t, req["id"], map[string]any{"hello": "there"})

	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if got.Hello != "there" {
		t.Fatalf("응답이 안 왔다: %+v", got)
	}
}

// TC-LSP-51: **응답이 뒤바뀐 순서로 와도 각자 자기 것을 받는다.**
//
// 이것이 이 계층의 존재 이유다. id 로 매칭하지 않고 순서로 짝지으면, 정의 이동이
// 호버의 답을 받는다 — 그리고 그 증상은 "가끔 엉뚱한 데로 뛴다" 로 보인다.
func TestConn_CallsAreMatchedByID(t *testing.T) {
	c, s := newPair(t, nil)
	type res struct {
		Which string `json:"which"`
	}
	var a, b res
	ea := make(chan error, 1)
	eb := make(chan error, 1)
	go func() { ea <- c.Call(context.Background(), "first", nil, &a) }()
	r1 := s.next(t)
	go func() { eb <- c.Call(context.Background(), "second", nil, &b) }()
	r2 := s.next(t)

	if r1["id"] == r2["id"] {
		t.Fatalf("두 요청이 같은 id 를 썼다: %v", r1["id"])
	}
	// 나중에 온 것을 먼저 답한다.
	s.reply(t, r2["id"], map[string]any{"which": "second"})
	s.reply(t, r1["id"], map[string]any{"which": "first"})

	if err := <-ea; err != nil {
		t.Fatal(err)
	}
	if err := <-eb; err != nil {
		t.Fatal(err)
	}
	if a.Which != "first" || b.Which != "second" {
		t.Fatalf("응답이 섞였다: a=%q b=%q", a.Which, b.Which)
	}
}

// TC-LSP-52: 서버가 error 를 내면 오류로 온다 — 빈 결과로 삼키지 않는다 (D-9).
func TestConn_CallError(t *testing.T) {
	c, s := newPair(t, nil)
	done := make(chan error, 1)
	go func() { done <- c.Call(context.Background(), "boom", nil, nil) }()
	req := s.next(t)
	s.replyError(t, req["id"], -32601, "method not found")

	err := <-done
	if err == nil {
		t.Fatal("서버의 error 를 성공으로 삼켰다")
	}
	if !strings.Contains(err.Error(), "method not found") {
		t.Fatalf("서버가 준 사유가 남지 않았다: %v", err)
	}
}

// TC-LSP-53 (FR-LSP-32): 알림은 요청 없이 온다 — 대기 중인 요청과 섞이지 않는다.
func TestConn_Notification(t *testing.T) {
	var mu sync.Mutex
	got := map[string]string{}
	c, s := newPair(t, func(method string, params json.RawMessage) {
		var p struct {
			URI string `json:"uri"`
		}
		json.Unmarshal(params, &p)
		mu.Lock()
		got[method] = p.URI
		mu.Unlock()
	})

	// 요청을 걸어 둔 채 알림이 와도 요청이 그것을 자기 응답으로 착각하지 않는다.
	done := make(chan error, 1)
	go func() { done <- c.Call(context.Background(), "waiting", nil, nil) }()
	req := s.next(t)
	s.notify(t, "textDocument/publishDiagnostics", map[string]any{"uri": "file:///a.go"})
	s.reply(t, req["id"], nil)
	if err := <-done; err != nil {
		t.Fatal(err)
	}

	deadline := time.Now().Add(2 * time.Second)
	for {
		mu.Lock()
		v := got["textDocument/publishDiagnostics"]
		mu.Unlock()
		if v == "file:///a.go" {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("알림이 오지 않았다: %+v", got)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// TC-LSP-54 (FR-LSP-52): ctx 가 끝나면 Call 이 풀린다. 언어 서버가 답하지 않아도
// 종단이 멎지 않는다.
func TestConn_CallRespectsContext(t *testing.T) {
	c, s := newPair(t, nil)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- c.Call(ctx, "never", nil, nil) }()
	s.next(t) // 요청은 갔지만 답하지 않는다
	cancel()

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("취소했는데 성공했다")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("취소가 Call 을 풀지 못했다 — 종단이 멎는다")
	}
}

// TC-LSP-55 (FR-LSP-20): 통로가 끊기면 **대기 중인 요청이 모두 풀린다.** 영원히
// 매달리면 그 세션의 모든 요청이 조용히 멎는다.
func TestConn_ClosePendingCalls(t *testing.T) {
	c, s := newPair(t, nil)
	done := make(chan error, 1)
	go func() { done <- c.Call(context.Background(), "never", nil, nil) }()
	s.next(t)

	c.Close()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("통로가 닫혔는데 성공했다")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("닫아도 요청이 매달려 있다")
	}

	// 닫힌 뒤의 요청도 곧바로 오류다 — 매달리지 않는다.
	if err := c.Call(context.Background(), "after", nil, nil); err == nil {
		t.Fatal("닫힌 통로로 요청이 성공했다")
	}
}

// TC-LSP-56: Notify 는 응답을 기다리지 않는다 (`didOpen`·`didChange` 가 그것이다).
//
// 보내기를 goroutine 에 두는 이유는 시험 통로가 `io.Pipe` 라서다 — 그것은
// **언버퍼드**이므로 읽는 쪽이 오기 전에는 쓰기가 풀리지 않는다. 실제 프로세스의
// stdin 은 OS 버퍼를 갖지만, 검사가 그 버퍼에 기대면 통로가 좁은 경우를 못 잡는다.
func TestConn_Notify(t *testing.T) {
	c, s := newPair(t, nil)
	errc := make(chan error, 1)
	go func() { errc <- c.Notify("textDocument/didOpen", map[string]any{"uri": "file:///a.go"}) }()
	m := s.next(t)
	if err := <-errc; err != nil {
		t.Fatal(err)
	}
	if m["method"] != "textDocument/didOpen" {
		t.Fatalf("method 가 다르다: %v", m["method"])
	}
	if _, has := m["id"]; has {
		t.Fatalf("알림에 id 가 있다 — 그러면 서버가 응답을 보낸다: %v", m)
	}
}

func newBufReader(r io.Reader) *bufio.Reader { return bufio.NewReader(r) }

// replyRaw·replyErrorRaw·notifyRaw 는 goroutine 안에서 쓰는 판이다 — *testing.T
// 를 받지 않으므로 Fatal 하지 않는다. 검사 goroutine 밖에서 Fatal 을 부르면
// 테스트가 끝난 뒤에 보고되어 어느 검사가 실패했는지 알 수 없다.
func (f *fakeServer) replyRaw(id any, result any) {
	b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
	_ = writeFrame(f.toClient, b)
}

func (f *fakeServer) replyErrorRaw(id any, code int, msg string) {
	b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id,
		"error": map[string]any{"code": code, "message": msg}})
	_ = writeFrame(f.toClient, b)
}
