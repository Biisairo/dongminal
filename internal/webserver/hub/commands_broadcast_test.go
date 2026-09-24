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
	// Fill channel to capacity (16).
	for i := 0; i < 16; i++ {
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

// 진단은 큐가 아니라 구독별 슬롯(uri → 최신)에 덮어쓴다 — git 이벤트를 밀어내지
// 않고 넘침 판정 대상이 아니다.
func TestCommandHub_DiagnosticsCoalesceAndDoNotOverflow(t *testing.T) {
	h := NewCommandHub()
	s := h.Add()
	defer h.Remove(s)
	for i := 0; i < 1000; i++ {
		h.BroadcastDiagnostics("/a.go", []byte(`{"n":`+string(rune('0'+i%10))+`}`), false)
	}
	h.BroadcastDiagnostics("/b.go", []byte(`{"b":1}`), false)
	if n := h.Broadcast([]byte(`{"action":"git_changed"}`)); n != 1 {
		t.Fatalf("진단 폭주 뒤 git_changed 전달 = %d, want 1", n)
	}
	select {
	case <-s.Closed():
		t.Fatal("진단이 넘침 판정에 걸려 구독이 닫혔다")
	default:
	}
	<-s.DiagnosticsReady()
	got := s.TakeDiagnostics()
	if len(got) != 2 {
		t.Fatalf("슬롯 %d건, want 2 (uri 마다 최신 하나)", len(got))
	}
	if len(s.TakeDiagnostics()) != 0 {
		t.Fatal("비운 슬롯이 다시 나왔다")
	}
}

// 새 구독은 최신 진단 스냅샷을 받는다. 비운(clear) uri 는 스냅샷에서 빠진다.
func TestCommandHub_NewSubscriberGetsDiagnosticsSnapshot(t *testing.T) {
	h := NewCommandHub()
	h.BroadcastDiagnostics("/a.go", []byte(`{"a":1}`), false)
	h.BroadcastDiagnostics("/b.go", []byte(`{"b":1}`), false)
	h.BroadcastDiagnostics("/b.go", []byte(`{"b":[]}`), true)
	s := h.Add()
	defer h.Remove(s)
	select {
	case <-s.DiagnosticsReady():
	default:
		t.Fatal("스냅샷 신호가 없다")
	}
	got := s.TakeDiagnostics()
	if len(got) != 1 || string(got[0]) != `{"a":1}` {
		t.Fatalf("스냅샷 = %q, want /a.go 만", got)
	}
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
