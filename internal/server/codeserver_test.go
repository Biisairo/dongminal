package server

import (
	"bytes"
	"net/http/httputil"
	"os/exec"
	"path/filepath"
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
	// Manually run watchdog logic — uses the package-level threshold so the
	// test stays in sync with FR-D1 tuning.
	now := time.Now()
	stale := []string{}
	for id, inst := range m.insts {
		if now.Sub(inst.LastPing) > watchdogStale {
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

// FR-A1 / TC-A1-a: 평문 입력은 변경 없음.
func TestStripOSC777_NoSequence(t *testing.T) {
	in := []byte("plain text without OSC\nline 2\n")
	out := stripOSC777(in)
	if !bytes.Equal(in, out) {
		t.Fatalf("mismatch: want=%q got=%q", in, out)
	}
}

// FR-A1 / TC-A1-b: OSC 777 OpenCodeServer 한 개 strip, 주변 평문 보존.
func TestStripOSC777_RemovesOpenCodeServer(t *testing.T) {
	in := []byte("before\x1b]777;OpenCodeServer;cs1|/cs/cs1/|/home/foo\x07after")
	want := []byte("beforeafter")
	got := stripOSC777(in)
	if !bytes.Equal(want, got) {
		t.Fatalf("strip mismatch: want=%q got=%q", want, got)
	}
}

// FR-A1 / TC-A1-c: 일반 ANSI escape(`\x1b[...m`) 는 보존, 777 만 제거.
func TestStripOSC777_PreservesAnsiEscape(t *testing.T) {
	in := []byte("\x1b[31mred\x1b[0m\x1b]777;Cwd;/tmp\x07\x1b]777;OpenCodeServer;cs1|/cs/cs1/|/tmp\x07tail")
	want := []byte("\x1b[31mred\x1b[0mtail")
	got := stripOSC777(in)
	if !bytes.Equal(want, got) {
		t.Fatalf("strip mismatch: want=%q got=%q", want, got)
	}
}

// FR-A1 / TC-A1-d: BEL 으로 종료되지 않은 미완성 OSC 는 그대로 통과.
func TestStripOSC777_IncompleteSequenceUnchanged(t *testing.T) {
	in := []byte("ok\x1b]777;OpenCodeServer;cs1|/cs/cs1/|/tmp")
	got := stripOSC777(in)
	if !bytes.Equal(in, got) {
		t.Fatalf("incomplete OSC should pass through: want=%q got=%q", in, got)
	}
}

// FR-C1 / TC-C1: 동일 folder 의 instance 가 이미 있으면 신규 spawn 없이 재사용.
func TestCodeServerManager_Start_ReusesFolder(t *testing.T) {
	tmp := t.TempDir()
	abs, err := filepath.Abs(tmp)
	if err != nil {
		t.Fatalf("abs: %v", err)
	}
	m := NewCodeServerManager()
	existing := &CodeServerInst{
		ID:        "cs-existing",
		Folder:    abs,
		Cmd:       &exec.Cmd{},
		Proxy:     httputil.NewSingleHostReverseProxy(nil),
		CreatedAt: time.Now().Add(-time.Hour),
		LastPing:  time.Now().Add(-time.Hour),
		done:      make(chan struct{}),
	}
	m.insts[existing.ID] = existing

	got, err := m.Start(tmp)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if got != existing {
		t.Fatalf("expected reuse of existing instance, got %#v", got)
	}
	if len(m.insts) != 1 {
		t.Fatalf("expected exactly 1 instance, got %d", len(m.insts))
	}
	if time.Since(existing.LastPing) > time.Second {
		t.Fatalf("LastPing not refreshed: %v ago", time.Since(existing.LastPing))
	}
}

// FR-D1 / TC-D1: watchdog 임계값이 90s 이상으로 상향되었는지 가드.
func TestWatchdogThreshold(t *testing.T) {
	if watchdogStale < 90*time.Second {
		t.Fatalf("watchdogStale=%v want >=90s (FR-D1)", watchdogStale)
	}
}
