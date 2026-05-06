package server

import (
	"net/http/httputil"
	"os/exec"
	"testing"
	"time"
)

func TestCodeServerManager_New(t *testing.T) {
	m := NewCodeServerManager()
	if m == nil {
		t.Fatal("expected manager")
	}
	if len(m.insts) != 0 {
		t.Fatal("expected empty instances")
	}
}

func TestCodeServerManager_List_Empty(t *testing.T) {
	m := NewCodeServerManager()
	list := m.List()
	if len(list) != 0 {
		t.Fatalf("expected empty list, got %d", len(list))
	}
}

func TestCodeServerManager_GetMissing(t *testing.T) {
	m := NewCodeServerManager()
	if m.Get("missing") != nil {
		t.Fatal("expected nil for missing instance")
	}
}

func TestCodeServerManager_TouchMissing(t *testing.T) {
	m := NewCodeServerManager()
	if m.Touch("missing") {
		t.Fatal("expected false for missing instance")
	}
}

func TestCodeServerManager_StopMissing(t *testing.T) {
	m := NewCodeServerManager()
	// Should not panic.
	m.Stop("missing")
}

func TestCodeServerManager_StopIdempotent(t *testing.T) {
	m := NewCodeServerManager()
	m.insts["cs1"] = &CodeServerInst{
		ID:       "cs1",
		Cmd:      &exec.Cmd{},
		Proxy:    httputil.NewSingleHostReverseProxy(nil),
		LastPing: time.Now(),
		done:     make(chan struct{}),
	}
	m.Stop("cs1")
	if m.Get("cs1") != nil {
		t.Fatal("expected instance removed")
	}
	// Second stop should not panic.
	m.Stop("cs1")
}

func TestCodeServerManager_StopAll(t *testing.T) {
	m := NewCodeServerManager()
	m.insts["cs1"] = &CodeServerInst{
		ID:       "cs1",
		Cmd:      &exec.Cmd{},
		Proxy:    httputil.NewSingleHostReverseProxy(nil),
		LastPing: time.Now(),
		done:     make(chan struct{}),
	}
	m.insts["cs2"] = &CodeServerInst{
		ID:       "cs2",
		Cmd:      &exec.Cmd{},
		Proxy:    httputil.NewSingleHostReverseProxy(nil),
		LastPing: time.Now(),
		done:     make(chan struct{}),
	}
	m.StopAll()
	if len(m.insts) != 0 {
		t.Fatalf("expected empty instances, got %d", len(m.insts))
	}
}

func TestCodeServerManager_Touch(t *testing.T) {
	m := NewCodeServerManager()
	m.insts["cs1"] = &CodeServerInst{
		ID:       "cs1",
		LastPing: time.Now().Add(-time.Hour),
		done:     make(chan struct{}),
	}
	if !m.Touch("cs1") {
		t.Fatal("expected true")
	}
	if m.insts["cs1"].LastPing.Before(time.Now().Add(-time.Minute)) {
		t.Fatal("expected LastPing updated")
	}
}

func TestCodeServerManager_List_Ordering(t *testing.T) {
	m := NewCodeServerManager()
	m.insts["cs2"] = &CodeServerInst{ID: "cs2", CreatedAt: time.Now()}
	m.insts["cs1"] = &CodeServerInst{ID: "cs1", CreatedAt: time.Now()}
	list := m.List()
	if len(list) != 2 {
		t.Fatalf("expected 2, got %d", len(list))
	}
	if list[0]["id"] != "cs1" || list[1]["id"] != "cs2" {
		t.Fatalf("ordering wrong: %v", list)
	}
}

func TestCodeServerManager_Watchdog(t *testing.T) {
	m := NewCodeServerManager()
	m.insts["cs1"] = &CodeServerInst{
		ID:       "cs1",
		Cmd:      &exec.Cmd{},
		Proxy:    httputil.NewSingleHostReverseProxy(nil),
		LastPing: time.Now().Add(-time.Hour),
		done:     make(chan struct{}),
	}
	m.insts["cs2"] = &CodeServerInst{
		ID:       "cs2",
		Cmd:      &exec.Cmd{},
		Proxy:    httputil.NewSingleHostReverseProxy(nil),
		LastPing: time.Now(),
		done:     make(chan struct{}),
	}
	// Manually run watchdog logic.
	now := time.Now()
	stale := []string{}
	for id, inst := range m.insts {
		if now.Sub(inst.LastPing) > 30*time.Second {
			stale = append(stale, id)
		}
	}
	if len(stale) != 1 || stale[0] != "cs1" {
		t.Fatalf("stale=%v want [cs1]", stale)
	}
	for _, id := range stale {
		m.Stop(id)
	}
	if m.Get("cs1") != nil {
		t.Fatal("expected cs1 stopped")
	}
	if m.Get("cs2") == nil {
		t.Fatal("expected cs2 alive")
	}
}
