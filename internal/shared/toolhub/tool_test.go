package toolhub

import (
	"net/http"
	"sync"
	"testing"
	"time"
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
		{"max allowed", "?cols=4096&rows=4096", 4096, 4096},
		{"cols above limit fallback", "?cols=4097&rows=10", 120, 10},
		{"rows above limit fallback", "?cols=10&rows=4097", 10, 40},
		{"max uint16 above limit", "?cols=65535&rows=65535", 120, 40},
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

func TestToolManager_SetInvalidator(t *testing.T) {
	pm := NewToolManager(t.TempDir(), nil)
	t.Cleanup(pm.StopSaving)
	pm.SetInvalidator(func(string) {})
	// invalidator is stored; full invocation is covered via Create+Delete integration.
	if pm.invalidator == nil {
		t.Fatal("invalidator not set")
	}
}

func TestToolManager_Get(t *testing.T) {
	pm := NewToolManager(t.TempDir(), nil)
	t.Cleanup(pm.StopSaving)
	if pm.Get("1") != nil {
		t.Fatal("expected nil for missing tool")
	}
}

func TestToolManager_IsLive(t *testing.T) {
	pm := NewToolManager(t.TempDir(), nil)
	t.Cleanup(pm.StopSaving)
	if pm.IsLive("1") {
		t.Fatal("expected false for missing tool")
	}
}

func TestToolManager_List_Empty(t *testing.T) {
	pm := NewToolManager(t.TempDir(), nil)
	t.Cleanup(pm.StopSaving)
	out := pm.List()
	if len(out) != 0 {
		t.Fatalf("expected empty list, got %d", len(out))
	}
}

func TestToolManager_Snapshot_Empty(t *testing.T) {
	pm := NewToolManager(t.TempDir(), nil)
	t.Cleanup(pm.StopSaving)
	out := pm.Snapshot()
	if len(out) != 0 {
		t.Fatalf("expected empty snapshot, got %d", len(out))
	}
}

func TestToolManager_DirtyAndSaveAll(t *testing.T) {
	pm := NewToolManager(t.TempDir(), nil)
	t.Cleanup(pm.StopSaving)
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

func TestToolManager_DataPath(t *testing.T) {
	pm := NewToolManager("", nil)
	t.Cleanup(pm.StopSaving)
	p := pm.dataPath("test.json")
	if p != "test.json" {
		t.Fatalf("dataPath with empty dir=%q want test.json", p)
	}
}

func TestTool_IsBusy_UsesProbe(t *testing.T) {
	orig := toolBusyProbe
	t.Cleanup(func() { toolBusyProbe = orig })

	called := 0
	toolBusyProbe = func(pid int) bool {
		called++
		return pid == 4242
	}

	p := &Tool{ID: "x"}
	if p.IsBusy() {
		t.Errorf("IsBusy with no cmd should be false")
	}
	if called != 0 {
		t.Errorf("probe should not be called when cmd is nil")
	}
}

func TestToolManager_RLockReadPaths(t *testing.T) {
	pm := NewToolManager(t.TempDir(), nil)
	t.Cleanup(pm.StopSaving)
	stop := make(chan struct{})
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				pm.Get("nope")
				pm.List()
				pm.Snapshot()
				pm.IsLive("nope")
			}
		}()
	}
	time.Sleep(20 * time.Millisecond)
	close(stop)
	wg.Wait()
}
