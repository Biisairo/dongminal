package server

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestCommandHub_Broadcast(t *testing.T) {
	h := NewCommandHub()
	s1 := h.add()
	s2 := h.add()

	payload := []byte(`{"action":"test"}`)
	n := h.Broadcast(payload)
	if n != 2 {
		t.Fatalf("delivered=%d want 2", n)
	}

	select {
	case msg := <-s1.ch:
		if string(msg) != string(payload) {
			t.Fatalf("s1 msg=%q want %q", msg, payload)
		}
	case <-time.After(time.Second):
		t.Fatal("s1 did not receive")
	}

	select {
	case msg := <-s2.ch:
		if string(msg) != string(payload) {
			t.Fatalf("s2 msg=%q want %q", msg, payload)
		}
	case <-time.After(time.Second):
		t.Fatal("s2 did not receive")
	}

	h.remove(s1)
	h.remove(s2)
}

func TestCommandHub_Broadcast_DropWhenFull(t *testing.T) {
	h := NewCommandHub()
	s := h.add()
	// Fill channel to capacity (16).
	for i := 0; i < 16; i++ {
		s.ch <- []byte("fill")
	}
	// Next broadcast should drop.
	n := h.Broadcast([]byte("drop"))
	if n != 0 {
		t.Fatalf("delivered=%d want 0 when full", n)
	}
	h.remove(s)
}

func TestCommandHub_AllowedAction(t *testing.T) {
	h := NewCommandHub()
	if !h.AllowedAction("focus") {
		t.Fatal("focus should be allowed")
	}
	if h.AllowedAction("invalid") {
		t.Fatal("invalid should not be allowed")
	}
}

func TestHandleCommandPost(t *testing.T) {
	// fakeCommandBroker does not implement add/remove, so we use a real hub for the handler
	// and just verify the handler logic via the real hub integration.
	hub := NewCommandHub()
	srv, err := New(Config{DataDir: t.TempDir()}, Deps{Commands: hub})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	// allowed action
	body := `{"action":"focus","args":{"location":"1.1.1"}}`
	resp, err := http.Post(ts.URL+"/api/commands", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("status=%d body=%s", resp.StatusCode, b)
	}

	// unknown action
	body2 := `{"action":"hack"}`
	resp2, err := http.Post(ts.URL+"/api/commands", "application/json", strings.NewReader(body2))
	if err != nil {
		t.Fatalf("POST2: %v", err)
	}
	defer resp2.Body.Close()
	if resp2.StatusCode != 400 {
		t.Fatalf("status=%d want 400", resp2.StatusCode)
	}

	// invalid json
	resp3, err := http.Post(ts.URL+"/api/commands", "application/json", strings.NewReader("{bad"))
	if err != nil {
		t.Fatalf("POST3: %v", err)
	}
	defer resp3.Body.Close()
	if resp3.StatusCode != 400 {
		t.Fatalf("status=%d want 400", resp3.StatusCode)
	}
}

func TestHandleCommandPost_MethodNotAllowed(t *testing.T) {
	srv, err := New(Config{DataDir: t.TempDir()}, Deps{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/commands", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 405 {
		t.Fatalf("status=%d want 405", resp.StatusCode)
	}
}

func TestHandleCommandSSE_ConnectAndClose(t *testing.T) {
	srv, err := New(Config{DataDir: t.TempDir()}, Deps{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/api/commands/sse")
	if err != nil {
		t.Fatalf("GET SSE: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status=%d want 200", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("Content-Type=%q want text/event-stream", ct)
	}
	// Read first line to confirm stream started.
	buf := make([]byte, 1024)
	n, _ := resp.Body.Read(buf)
	if n == 0 {
		t.Fatal("SSE stream empty")
	}
	if !bytes.Contains(buf[:n], []byte(": connected")) {
		t.Fatalf("expected ': connected', got %q", buf[:n])
	}
}
