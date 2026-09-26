package toolhub

import (
	"sync"
	"testing"

	"dongminal/internal/shared/platform"
)

// OPTIMIZE_REFACTOR_SRS FR-OPT-8-3 (SHR-8 · SHR-28) — 도구 N개의 cwd·busy 는 조회 한 번이다.
// darwin 에서 조회 하나가 lsof·pgrep fork 하나다.

// pidTerm 은 PID 만 답하는 터미널이다. 나머지 메서드는 이 검사가 부르지 않는다.
type pidTerm struct {
	platform.Terminal
	pid int
}

func (t pidTerm) PID() int { return t.pid }

// countingInfo 는 조회 종류별 호출 수를 센다.
type countingInfo struct {
	platform.ProcInfo
	mu                            sync.Mutex
	cwd, cwds, children, childrOf int
	busy                          map[int]bool
}

func (c *countingInfo) CWD(pid int) (string, bool) {
	c.mu.Lock()
	c.cwd++
	c.mu.Unlock()
	return "/one", true
}
func (c *countingInfo) CWDs(pids []int) map[int]string {
	c.mu.Lock()
	c.cwds++
	c.mu.Unlock()
	out := map[int]string{}
	for _, p := range pids {
		out[p] = "/many"
	}
	return out
}
func (c *countingInfo) HasChildren(pid int) bool {
	c.mu.Lock()
	c.children++
	c.mu.Unlock()
	return c.busy[pid]
}
func (c *countingInfo) ChildrenOf(pids []int) map[int]bool {
	c.mu.Lock()
	c.childrOf++
	c.mu.Unlock()
	out := map[int]bool{}
	for _, p := range pids {
		out[p] = c.busy[p]
	}
	return out
}

func withProcInfo(t *testing.T, info platform.ProcInfo) {
	t.Helper()
	orig := toolProcInfo
	toolProcInfo = func() platform.ProcInfo { return info }
	t.Cleanup(func() { toolProcInfo = orig })
}

func batchManager(t *testing.T, n int) *ToolManager {
	t.Helper()
	m := NewToolManager("", nil)
	t.Cleanup(m.StopSaving)
	for i := 1; i <= n; i++ {
		m.Adopt(&Tool{ID: string(rune('a' + i - 1)), term: pidTerm{pid: 1000 + i}})
	}
	return m
}

func TestBackgroundList_OneCWDsQuery(t *testing.T) {
	info := &countingInfo{}
	withProcInfo(t, info)
	m := batchManager(t, 5)
	for _, id := range []string{"a", "b", "c", "d", "e"} {
		m.SetBackground(id, true)
	}
	got := m.BackgroundList()
	if len(got) != 5 {
		t.Fatalf("항목 = %d", len(got))
	}
	for _, e := range got {
		if e.Cwd != "/many" {
			t.Fatalf("%s cwd = %q — 일괄 조회의 답이 아니다", e.ToolID, e.Cwd)
		}
	}
	if info.cwds != 1 || info.cwd != 0 {
		t.Fatalf("CWDs=%d CWD=%d, want 1·0 (도구 5개)", info.cwds, info.cwd)
	}
}

func TestActivitySnapshot_OneChildrenQuery(t *testing.T) {
	info := &countingInfo{busy: map[int]bool{1001: true, 1003: true}}
	withProcInfo(t, info)
	m := batchManager(t, 4)
	for _, id := range []string{"a", "b", "c", "d"} {
		m.Get(id).SetActivity("working", "Bash", "")
	}
	snap := m.ActivitySnapshot()
	var ids []string
	for _, s := range snap {
		ids = append(ids, s.ToolID)
	}
	// FR-AAP-20: 프로세스가 사라진 working 은 걸러진다.
	if len(ids) != 2 || ids[0] != "a" || ids[1] != "c" {
		t.Fatalf("snapshot = %v, want [a c]", ids)
	}
	if info.childrOf != 1 || info.children != 0 {
		t.Fatalf("ChildrenOf=%d HasChildren=%d, want 1·0 (working 4개)", info.childrOf, info.children)
	}
}

func TestBusyMany_OneChildrenQuery(t *testing.T) {
	info := &countingInfo{busy: map[int]bool{1002: true}}
	withProcInfo(t, info)
	m := batchManager(t, 3)
	busy, ok := m.BusyMany([]string{"a", "b", "c", "없음"})
	if !ok || busy["a"] || !busy["b"] || busy["c"] || busy["없음"] {
		t.Fatalf("busy = %v", busy)
	}
	if info.childrOf != 1 || info.children != 0 {
		t.Fatalf("ChildrenOf=%d HasChildren=%d, want 1·0", info.childrOf, info.children)
	}
}
