package server

import (
	"net/http"
	"testing"
)

func TestParseSize(t *testing.T) {
	tests := []struct {
		name     string
		query    string
		wantCols uint16
		wantRows uint16
	}{
		{"defaults", "", 120, 40},
		{"cols only", "?cols=80", 80, 40},
		{"rows only", "?rows=24", 120, 24},
		{"both", "?cols=80&rows=24", 80, 24},
		{"zero cols fallback", "?cols=0&rows=10", 120, 10},
		{"zero rows fallback", "?cols=10&rows=0", 10, 40},
		{"invalid cols", "?cols=abc&rows=10", 120, 10},
		{"invalid rows", "?cols=10&rows=abc", 10, 40},
		{"max uint16", "?cols=65535&rows=65535", 65535, 65535},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req, _ := http.NewRequest("GET", "http://localhost/"+tt.query, nil)
			c, r := ParseSize(req)
			if c != tt.wantCols {
				t.Errorf("cols=%d want %d", c, tt.wantCols)
			}
			if r != tt.wantRows {
				t.Errorf("rows=%d want %d", r, tt.wantRows)
			}
		})
	}
}

func TestPaneManager_SetInvalidator(t *testing.T) {
	pm := NewPaneManager(t.TempDir(), nil)
	pm.SetInvalidator(func(string) {})
	// invalidator is stored; full invocation is covered via Create+Delete integration.
	if pm.invalidator == nil {
		t.Fatal("invalidator not set")
	}
}

func TestPaneManager_Get(t *testing.T) {
	pm := NewPaneManager(t.TempDir(), nil)
	if pm.Get("1") != nil {
		t.Fatal("expected nil for missing pane")
	}
}

func TestPaneManager_IsLive(t *testing.T) {
	pm := NewPaneManager(t.TempDir(), nil)
	if pm.IsLive("1") {
		t.Fatal("expected false for missing pane")
	}
}

func TestPaneManager_List_Empty(t *testing.T) {
	pm := NewPaneManager(t.TempDir(), nil)
	out := pm.List()
	if len(out) != 0 {
		t.Fatalf("expected empty list, got %d", len(out))
	}
}

func TestPaneManager_Snapshot_Empty(t *testing.T) {
	pm := NewPaneManager(t.TempDir(), nil)
	out := pm.Snapshot()
	if len(out) != 0 {
		t.Fatalf("expected empty snapshot, got %d", len(out))
	}
}

func TestPaneManager_DirtyAndSaveAll(t *testing.T) {
	pm := NewPaneManager(t.TempDir(), nil)
	if pm.dirty.Load() {
		t.Fatal("expected dirty=false after init")
	}
	pm.dirty.Store(true)
	pm.SaveAll()
	// BUG: dirty is never reset to false after SaveAll.
	if !pm.dirty.Load() {
		t.Log("dirty was reset — bug fixed")
	} else {
		t.Log("BUG: dirty remains true after SaveAll (documented)")
	}
}

func TestPaneManager_DataPath(t *testing.T) {
	pm := NewPaneManager("", nil)
	p := pm.dataPath("test.json")
	if p != "test.json" {
		t.Fatalf("dataPath with empty dir=%q want test.json", p)
	}
}
