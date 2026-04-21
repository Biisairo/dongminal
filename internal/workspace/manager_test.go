package workspace

import (
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"
)

type fakeLive struct {
	mu    sync.Mutex
	alive map[string]bool
}

func newFakeLive(ids ...string) *fakeLive {
	f := &fakeLive{alive: map[string]bool{}}
	for _, id := range ids {
		f.alive[id] = true
	}
	return f
}

func (f *fakeLive) IsLive(id string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.alive[id]
}

func (f *fakeLive) set(id string, live bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.alive[id] = live
}

type memPersister struct {
	mu    sync.Mutex
	data  []byte
	empty bool
	wrote int
}

func (p *memPersister) Read() ([]byte, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.empty {
		return nil, os.ErrNotExist
	}
	return append([]byte(nil), p.data...), nil
}

func (p *memPersister) Write(b []byte) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.data = append([]byte(nil), b...)
	p.empty = false
	p.wrote++
	return nil
}

const sampleWS = `{
  "activeSession": "s1",
  "sessions": [
    {
      "id": "s1",
      "name": "main",
      "focusedRegion": "r1",
      "layout": {
        "type": "split",
        "direction": "row",
        "children": [
          {
            "type": "region",
            "id": "r1",
            "activeTab": "t1",
            "tabs": [
              {"id": "t1", "name": "build", "paneId": "10"},
              {"id": "t2", "name": "run",   "paneId": "11"}
            ]
          },
          {
            "type": "region",
            "id": "r2",
            "activeTab": "t3",
            "tabs": [
              {"id": "t3", "name": "logs", "paneId": "12"}
            ]
          }
        ]
      }
    }
  ]
}`

func TestResolveByLabel(t *testing.T) {
	live := newFakeLive("10", "11", "12")
	store := &memPersister{data: []byte(sampleWS)}
	m, err := New(live, store)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if _, err := m.Save([]byte(sampleWS), ""); err != nil {
		t.Fatalf("Save: %v", err)
	}

	cases := map[string]string{
		"S1.P1.T1": "10",
		"s1.p1.t2": "11",
		"S1.P2.T1": "12",
		"11":       "11",
	}
	for in, want := range cases {
		got, err := m.Resolve(in)
		if err != nil {
			t.Errorf("Resolve(%q): %v", in, err)
			continue
		}
		if got != want {
			t.Errorf("Resolve(%q)=%s want %s", in, got, want)
		}
	}

	if _, err := m.Resolve("S9.P9.T9"); err == nil {
		t.Error("expected error for unknown label")
	}
}

func TestResolveDeadPane(t *testing.T) {
	live := newFakeLive("10", "11", "12")
	store := &memPersister{data: []byte(sampleWS)}
	m, err := New(live, store)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if _, err := m.Save([]byte(sampleWS), ""); err != nil {
		t.Fatalf("Save: %v", err)
	}

	live.set("11", false)

	if _, err := m.Resolve("S1.P1.T2"); err == nil {
		t.Error("expected error for dead pane via label")
	}
	if _, err := m.Resolve("11"); err == nil {
		t.Error("expected error for dead pane via numeric id")
	}
	if pid, err := m.Resolve("S1.P1.T1"); err != nil || pid != "10" {
		t.Errorf("Resolve(S1.P1.T1)=%s err=%v, want 10 nil", pid, err)
	}
}

func TestSaveStale(t *testing.T) {
	live := newFakeLive("10", "11", "12")
	store := &memPersister{empty: true}
	m, err := New(live, store)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if m.CurrentRev() != 0 {
		t.Fatalf("CurrentRev=%d want 0", m.CurrentRev())
	}

	rev, err := m.Save([]byte(sampleWS), "")
	if err != nil {
		t.Fatalf("Save empty if-match: %v", err)
	}
	if rev != 1 {
		t.Fatalf("rev=%d want 1", rev)
	}

	if _, err := m.Save([]byte(sampleWS), "0"); !errors.Is(err, ErrStale) {
		t.Errorf("Save with ifMatch=0 err=%v want ErrStale", err)
	}
	if _, err := m.Save([]byte(sampleWS), "abc"); !errors.Is(err, ErrStale) {
		t.Errorf("Save with ifMatch=abc err=%v want ErrStale", err)
	}

	rev2, err := m.Save([]byte(sampleWS), "1")
	if err != nil {
		t.Fatalf("Save with matching ifMatch: %v", err)
	}
	if rev2 != 2 {
		t.Fatalf("rev2=%d want 2", rev2)
	}
}

func TestSaveRevIncrement(t *testing.T) {
	live := newFakeLive("10", "11", "12")
	store := &memPersister{empty: true}
	m, err := New(live, store)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	for i := uint64(1); i <= 5; i++ {
		rev, err := m.Save([]byte(sampleWS), "")
		if err != nil {
			t.Fatalf("Save #%d: %v", i, err)
		}
		if rev != i {
			t.Fatalf("rev=%d want %d", rev, i)
		}
		if got := m.CurrentRev(); got != i {
			t.Fatalf("CurrentRev=%d want %d", got, i)
		}
	}
	if store.wrote != 5 {
		t.Errorf("wrote=%d want 5", store.wrote)
	}
	if string(m.Raw()) != sampleWS {
		t.Errorf("Raw mismatch")
	}

	labels := m.Labels()
	if labels["10"] != "S1.P1.T1" {
		t.Errorf("labels[10]=%q want S1.P1.T1", labels["10"])
	}
	entries := m.Entries()
	if len(entries) != 3 {
		t.Errorf("entries=%d want 3", len(entries))
	}
	// Sanity: active-ness follows activeSession+focusedRegion+activeTab
	activeCount := 0
	for _, e := range entries {
		if e.IsActive {
			activeCount++
		}
	}
	if activeCount != 1 {
		t.Errorf("activeCount=%d want 1 (entries=%+v)", activeCount, entries)
	}
	_ = fmt.Sprint(entries)
}
