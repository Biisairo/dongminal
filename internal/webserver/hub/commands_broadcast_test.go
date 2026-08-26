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
	// Next broadcast should drop.
	n := h.Broadcast([]byte("drop"))
	if n != 0 {
		t.Fatalf("delivered=%d want 0 when full", n)
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
