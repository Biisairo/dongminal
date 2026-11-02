package hub

import (
	"testing"
	"time"
)

func TestCommandHub_Broadcast(t *testing.T) {
	h := NewCommandHub()
	s1 := h.Add()
	s2 := h.Add()

	payload := []byte(`{"action":"test"}`)
	n := h.Broadcast(payload)
	if n != 2 {
		t.Fatalf("delivered=%d want 2", n)
	}

	select {
	case msg := <-s1.Messages():
		if string(msg) != string(payload) {
			t.Fatalf("s1 msg=%q want %q", msg, payload)
		}
	case <-time.After(time.Second):
		t.Fatal("s1 did not receive")
	}

	select {
	case msg := <-s2.Messages():
		if string(msg) != string(payload) {
			t.Fatalf("s2 msg=%q want %q", msg, payload)
		}
	case <-time.After(time.Second):
		t.Fatal("s2 did not receive")
	}

	h.Remove(s1)
	h.Remove(s2)
}

func TestCommandHub_Broadcast_DropWhenFull(t *testing.T) {
	h := NewCommandHub()
	s := h.Add()
	// Fill channel to capacity (cmdSubQueue).
	for i := 0; i < cap(s.ch); i++ {
		s.ch <- []byte("fill")
	}
	// REPO_FIX 02 §3A-2: 가득 찬 구독은 조용히 버리지 않고 **닫는다** — 클라이언트가
	// 재연결해 다시 받는다.
	//	이전 동작: 그 이벤트만 버렸다(git_changed 를 잃으면 30s 안전망까지 낡았다)
	//	새  동작: 구독을 닫는다
	n := h.Broadcast([]byte("drop"))
	if n != 0 {
		t.Fatalf("delivered=%d want 0 when full", n)
	}
	select {
	case <-s.Closed():
	default:
		t.Fatal("가득 찬 구독이 닫히지 않았다")
	}
	h.Remove(s)
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
