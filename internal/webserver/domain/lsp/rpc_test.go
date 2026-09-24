package lsp

import (
	"context"
	"encoding/json"
	"io"
	"sync"
	"testing"
	"time"
)

// REPO_FIX 02 §3A-5 — 서버발 요청·id 원문 보존·응답 비차단·취소·동기화 순서.

// newPairReq 는 서버발 요청 처리기를 가진 conn 과 fakeServer 다.
func newPairReq(t *testing.T, onNotify func(string, json.RawMessage), onReq requestFunc) (*conn, *fakeServer) {
	t.Helper()
	cr, sw := io.Pipe()
	sr, cw := io.Pipe()
	c := newConn(rwc{Reader: cr, Writer: cw, closeFn: func() error {
		cw.Close()
		cr.Close()
		return nil
	}}, onNotify, onReq)
	t.Cleanup(func() { c.Close(); sw.Close(); sr.Close() })
	return c, &fakeServer{fromClient: newBufReader(sr), toClient: sw}
}

func (f *fakeServer) request(t *testing.T, id any, method string, params any) {
	t.Helper()
	b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params})
	if err := writeFrame(f.toClient, b); err != nil {
		t.Fatal(err)
	}
}

// 서버발 요청은 응답 매칭에 섞이지 않는다 — 대기 중인 Call 과 id 가 같아도.
func TestConn_ServerRequestNotMatchedAsResponse(t *testing.T) {
	c, s := newPairReq(t, nil, func(method string, params json.RawMessage) (any, *rpcError) {
		return serverRequestResult("/root", method, params)
	})
	done := make(chan error, 1)
	var got map[string]any
	go func() { done <- c.Call(context.Background(), "textDocument/hover", nil, &got) }()
	call := s.next(t)
	// 같은 id 로 서버가 요청을 보낸다.
	s.request(t, call["id"], "workspace/configuration", map[string]any{"items": []any{map[string]any{}, map[string]any{}}})
	resp := s.next(t)
	if resp["method"] != nil || resp["id"] != call["id"] {
		t.Fatalf("서버발 요청의 응답 모양 = %v", resp)
	}
	if res, _ := resp["result"].([]any); len(res) != 2 || res[0] != nil {
		t.Fatalf("configuration 결과 = %v, want [null null]", resp["result"])
	}
	select {
	case err := <-done:
		t.Fatalf("서버발 요청이 Call 의 응답으로 쓰였다: %v", err)
	default:
	}
	s.reply(t, call["id"], map[string]any{"ok": true})
	if err := <-done; err != nil || got["ok"] != true {
		t.Fatalf("Call = %v %v", err, got)
	}
}

// 문자열 id 도 원문 그대로 되싣는다. 모르는 메서드는 -32601.
func TestConn_ServerRequestStringIDAndMethodNotFound(t *testing.T) {
	_, s := newPairReq(t, nil, func(method string, params json.RawMessage) (any, *rpcError) {
		return serverRequestResult("/root", method, params)
	})
	s.request(t, "abc", "workspace/unknownThing", nil)
	resp := s.next(t)
	if resp["id"] != "abc" {
		t.Fatalf("id = %v, want \"abc\"", resp["id"])
	}
	e, _ := resp["error"].(map[string]any)
	if e == nil || e["code"] != float64(-32601) {
		t.Fatalf("error = %v, want -32601", resp["error"])
	}
}

// 서버가 stdin 을 읽지 않아도 읽기 루프는 막히지 않는다 — 응답은 별도 고루틴이 쓴다.
func TestConn_ServerRequestReplyDoesNotBlockReadLoop(t *testing.T) {
	notified := make(chan string, 1)
	_, s := newPairReq(t, func(method string, _ json.RawMessage) { notified <- method }, func(string, json.RawMessage) (any, *rpcError) {
		return nil, nil
	})
	s.request(t, 7, "client/registerCapability", nil) // 응답을 읽지 않는다
	s.notify(t, "window/logMessage", map[string]any{})
	select {
	case m := <-notified:
		if m != "window/logMessage" {
			t.Fatalf("알림 = %q", m)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("응답 쓰기가 읽기 루프를 막았다")
	}
	_ = s.next(t) // 뒤늦게 읽어 고루틴을 풀어 준다
}

// ctx 로 빠진 Call 은 $/cancelRequest {id} 를 보낸다.
func TestConn_CanceledCallSendsCancelRequest(t *testing.T) {
	c, s := newPairReq(t, nil, nil)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- c.Call(ctx, "textDocument/references", nil, nil) }()
	call := s.next(t)
	cancel()
	<-done
	m := s.next(t)
	if m["method"] != "$/cancelRequest" {
		t.Fatalf("취소 뒤 보낸 것 = %v", m)
	}
	p, _ := m["params"].(map[string]any)
	if p["id"] != call["id"] || m["id"] != nil {
		t.Fatalf("cancelRequest = %v, want 알림 {id:%v}", m, call["id"])
	}
}

// 알려진 서버발 요청의 최소 응답표.
func TestServerRequestResult_Table(t *testing.T) {
	for _, m := range []string{"client/registerCapability", "client/unregisterCapability", "window/workDoneProgress/create"} {
		if res, err := serverRequestResult("/root", m, nil); err != nil || res != nil {
			t.Fatalf("%s = %v %v, want null", m, res, err)
		}
	}
	res, err := serverRequestResult("/root", "workspace/workspaceFolders", nil)
	folders, _ := res.([]map[string]any)
	if err != nil || len(folders) != 1 || folders[0]["uri"] != pathToURI("/root") {
		t.Fatalf("workspaceFolders = %v %v", res, err)
	}
	res, err = serverRequestResult("/root", "workspace/configuration", json.RawMessage(`{"items":[{},{},{}]}`))
	if arr, _ := res.([]any); err != nil || len(arr) != 3 {
		t.Fatalf("configuration = %v %v", res, err)
	}
}

// 판 번호 증가와 전송이 한 임계구역이다 — 서버가 받는 판은 늘 증가한다.
func TestSession_SyncVersionsArriveInOrder(t *testing.T) {
	var mu sync.Mutex
	var versions []float64
	start, _ := fakeStarter(t, func(s *fakeServer, m map[string]any) {
		p, _ := m["params"].(map[string]any)
		td, _ := p["textDocument"].(map[string]any)
		if v, ok := td["version"].(float64); ok {
			mu.Lock()
			versions = append(versions, v)
			mu.Unlock()
		}
	})
	sess := newSession(tRoot(), mustDesc(t, ".go"), "/fake/gopls", start, nil)
	defer sess.Close()
	var wg sync.WaitGroup
	for i := 0; i < 64; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); _ = sess.sync(tFile("a.go"), "x") }()
	}
	wg.Wait()
	deadline := time.Now().Add(2 * time.Second)
	for {
		mu.Lock()
		n := len(versions)
		mu.Unlock()
		if n == 64 || time.Now().After(deadline) {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	mu.Lock()
	defer mu.Unlock()
	for i := 1; i < len(versions); i++ {
		if versions[i] <= versions[i-1] {
			t.Fatalf("판 번호가 역전됐다: %v", versions)
		}
	}
}
