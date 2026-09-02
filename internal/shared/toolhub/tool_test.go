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

func TestToolManager_MutatedSurvivesSaveAll(t *testing.T) {
	pm := NewToolManager(t.TempDir(), nil)
	t.Cleanup(pm.StopSaving)
	if pm.mutated.Load() {
		t.Fatal("갓 만든 매니저가 변경됐다고 답한다 — 그러면 아무 일도 없던 실행이 사용자 파일을 덮는다")
	}

	pm.mutated.Store(true)
	pm.SaveAll()

	// **저장해도 내려가지 않는다.** 이 값의 뜻이 "미저장 변경" 이 아니라 "기동 후
	// 변경 여부" 이기 때문이다 (FR-CAF-13). 종전 이 테스트는 두 갈래를 모두
	// t.Log 로 흘려 어느 쪽이든 초록이었다 — 아무것도 지키지 않는 검사였다.
	if !pm.mutated.Load() {
		t.Fatal("SaveAll 이 mutated 를 내렸다 — 그 뒤의 저장이 건너뛰어져 종료 시 CWD 변경을 잃는다")
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
