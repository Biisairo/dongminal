package mdscroll

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func newTmp(t *testing.T) (*Manager, string) {
	t.Helper()
	dir := t.TempDir()
	p := filepath.Join(dir, "mdscroll.json")
	m, err := New(FilePersister{Path: p})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = m.Close() })
	return m, p
}

func waitFile(t *testing.T, path string) []byte {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		b, err := os.ReadFile(path)
		if err == nil && len(b) > 0 {
			return b
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("file %s never written", path)
	return nil
}

func TestSetGet(t *testing.T) {
	m, _ := newTmp(t)
	if _, ok := m.Get("t1"); ok {
		t.Fatal("expected miss")
	}
	e := Entry{Top: 100, Ratio: 0.25, TS: 12345}
	m.Set("t1", e)
	got, ok := m.Get("t1")
	if !ok || got != e {
		t.Fatalf("got %+v ok=%v want %+v", got, ok, e)
	}
}

func TestPersistAndReload(t *testing.T) {
	m, p := newTmp(t)
	m.Set("a", Entry{Top: 50, Ratio: 0.1, TS: 1})
	m.Set("b", Entry{Top: 80, Ratio: 0.2, TS: 2})
	_ = m.Close()
	blob := waitFile(t, p)
	var f fileShape
	if err := json.Unmarshal(blob, &f); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(f.Tabs) != 2 {
		t.Fatalf("want 2 entries got %d", len(f.Tabs))
	}
	m2, err := New(FilePersister{Path: p})
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	defer m2.Close()
	got, ok := m2.Get("a")
	if !ok || got.Top != 50 {
		t.Fatalf("reload miss: %+v ok=%v", got, ok)
	}
}

func TestReconcile(t *testing.T) {
	m, _ := newTmp(t)
	m.Set("alive", Entry{Top: 1, TS: 1})
	m.Set("dead", Entry{Top: 2, TS: 2})
	rm := m.Reconcile(map[string]struct{}{"alive": {}})
	if rm != 1 {
		t.Fatalf("want 1 removed got %d", rm)
	}
	if _, ok := m.Get("dead"); ok {
		t.Fatal("dead entry survived")
	}
	if _, ok := m.Get("alive"); !ok {
		t.Fatal("alive entry dropped")
	}
}

func TestEmptyOrMissingFile(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "missing.json")
	m, err := New(FilePersister{Path: p})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer m.Close()
	if len(m.Snapshot()) != 0 {
		t.Fatal("expected empty snapshot")
	}
}

func TestCorruptFile(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "bad.json")
	if err := os.WriteFile(p, []byte("not-json"), 0o644); err != nil {
		t.Fatal(err)
	}
	m, err := New(FilePersister{Path: p})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer m.Close()
	if len(m.Snapshot()) != 0 {
		t.Fatal("expected empty snapshot on corrupt input")
	}
}

func TestDelete(t *testing.T) {
	m, _ := newTmp(t)
	m.Set("x", Entry{Top: 1, TS: 1})
	m.Delete("x")
	if _, ok := m.Get("x"); ok {
		t.Fatal("delete failed")
	}
	m.Delete("nope") // no-op
}
