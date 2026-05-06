package workspace

import (
	"errors"
	"testing"
)

func TestManager_New_ReadError(t *testing.T) {
	// memPersister returns nil, os.ErrNotExist for empty; simulate other error.
	bad := &errorPersister{err: errors.New("disk fail")}
	_, err := New(newFakeLive(), bad)
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestManager_Raw_Nil(t *testing.T) {
	store := &memPersister{empty: true}
	m, err := New(newFakeLive(), store)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if m.Raw() != nil {
		t.Fatalf("expected nil Raw for empty manager")
	}
}

func TestManager_Resolve_Empty(t *testing.T) {
	store := &memPersister{empty: true}
	m, err := New(newFakeLive(), store)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if _, err := m.Resolve(""); err == nil {
		t.Fatal("expected error for empty id")
	}
}

func TestManager_Resolve_NonNumeric(t *testing.T) {
	store := &memPersister{empty: true}
	m, err := New(newFakeLive(), store)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if _, err := m.Resolve("UNKNOWN"); err == nil {
		t.Fatal("expected error for unknown non-numeric id")
	}
}

func TestManager_Labels_Empty(t *testing.T) {
	store := &memPersister{empty: true}
	m, err := New(newFakeLive(), store)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	labels := m.Labels()
	if len(labels) != 0 {
		t.Fatalf("expected empty labels, got %d", len(labels))
	}
}

func TestManager_Entries_Empty(t *testing.T) {
	store := &memPersister{empty: true}
	m, err := New(newFakeLive(), store)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	entries := m.Entries()
	if len(entries) != 0 {
		t.Fatalf("expected empty entries, got %d", len(entries))
	}
}

func TestManager_InvalidatePane(t *testing.T) {
	store := &memPersister{empty: true}
	m, err := New(newFakeLive(), store)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	// Should not panic.
	m.InvalidatePane("any")
}

func TestManager_Close_Idempotent(t *testing.T) {
	store := &memPersister{empty: true}
	m, err := New(newFakeLive(), store)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if err := m.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if err := m.Close(); err != nil {
		t.Fatalf("second Close: %v", err)
	}
}

func TestManager_Save_InvalidJSON(t *testing.T) {
	store := &memPersister{empty: true}
	m, err := New(newFakeLive(), store)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	_, err = m.Save([]byte("not json"), "")
	if err == nil {
		t.Fatal("expected error for invalid JSON")
	}
}

func TestManager_Save_EmptyIfMatch(t *testing.T) {
	store := &memPersister{empty: true}
	m, err := New(newFakeLive(), store)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	rev, err := m.Save([]byte(sampleWS), "")
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	if rev != 1 {
		t.Fatalf("rev=%d want 1", rev)
	}
}

func TestManager_CurrentRev_Atomic(t *testing.T) {
	store := &memPersister{empty: true}
	m, err := New(newFakeLive(), store)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if m.CurrentRev() != 0 {
		t.Fatalf("CurrentRev=%d want 0", m.CurrentRev())
	}
}

func TestBuildIndex_Empty(t *testing.T) {
	ix, err := buildIndex(nil)
	if err != nil {
		t.Fatalf("buildIndex(nil): %v", err)
	}
	if len(ix.labels) != 0 || len(ix.entries) != 0 {
		t.Fatal("expected empty index")
	}
	ix2, err := buildIndex([]byte{})
	if err != nil {
		t.Fatalf("buildIndex([]): %v", err)
	}
	if len(ix2.labels) != 0 || len(ix2.entries) != 0 {
		t.Fatal("expected empty index")
	}
}

func TestBuildIndex_InvalidJSON(t *testing.T) {
	_, err := buildIndex([]byte("bad"))
	if err == nil {
		t.Fatal("expected error for invalid JSON")
	}
}

func TestBuildIndex_Active(t *testing.T) {
	data := `{"activeSession":"s1","sessions":[{"id":"s1","name":"x","focusedRegion":"r1","layout":{"type":"region","id":"r1","activeTab":"t1","tabs":[{"id":"t1","name":"a","paneId":"1"}]}}]}`
	ix, err := buildIndex([]byte(data))
	if err != nil {
		t.Fatalf("buildIndex: %v", err)
	}
	if len(ix.entries) != 1 {
		t.Fatalf("entries=%d want 1", len(ix.entries))
	}
	if !ix.entries[0].IsActive {
		t.Fatal("expected active")
	}
}

type errorPersister struct {
	err error
}

func (e *errorPersister) Read() ([]byte, error)  { return nil, e.err }
func (e *errorPersister) Write([]byte) error     { return nil }
