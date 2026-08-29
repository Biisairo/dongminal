package toolhub

import (
	"sync"
	"testing"
)

// newActivityPane builds a bare Tool wired with a capturing activity notifier,
// without spawning a PTY/shell (activity state is independent of the shell).
func newActivityPane(id string, mu *sync.Mutex, events *[]string) *Tool {
	return NewDetachedTool(id, &ToolHooks{
		OnActivity: func(pid, state, tool, detail string) {
			mu.Lock()
			*events = append(*events, pid+":"+state+":"+tool+":"+detail)
			mu.Unlock()
		},
	})
}

// FR-AAP-2 / TC-AAP-8: setActivity fires on every transition (not edge-gated)
// and the latest value overwrites the previous one (tool keeps one snapshot).
func TestTool_SetActivity_AlwaysFiresAndOverwrites(t *testing.T) {
	var mu sync.Mutex
	var events []string
	p := newActivityPane("1", &mu, &events)

	p.SetActivity("working", "Bash", "npm test")
	p.SetActivity("done", "", "")

	if len(events) != 2 {
		t.Fatalf("each transition must fire, got %v", events)
	}
	if events[0] != "1:working:Bash:npm test" || events[1] != "1:done::" {
		t.Fatalf("unexpected events: %v", events)
	}
	got := p.Activity()
	if got == nil || got.State != "done" || got.Tool != "" || got.Detail != "" {
		t.Fatalf("latest activity should be done, got %+v", got)
	}
}

// FR-AAP-7/16: SessionEnd → "ended" clears the activity so the card is removed.
func TestTool_SetActivity_EndedClears(t *testing.T) {
	var mu sync.Mutex
	var events []string
	p := newActivityPane("1", &mu, &events)
	p.SetActivity("working", "Bash", "x")
	if p.Activity() == nil {
		t.Fatalf("working should be set")
	}
	p.SetActivity("ended", "", "")
	if p.Activity() != nil {
		t.Fatalf("ended must clear activity, got %+v", p.Activity())
	}
	if len(events) != 2 || events[1] != "1:ended::" {
		t.Fatalf("ended must fire notifier, got %v", events)
	}
}

// A tool that never reported activity has a nil snapshot and is excluded from
// ActivitySnapshot (FR-AAP-16: only tools with reported activity show a card).
func TestTool_Activity_NilUntilReported(t *testing.T) {
	p := &Tool{ID: "x"}
	if p.Activity() != nil {
		t.Fatalf("activity must be nil until reported")
	}
}

// FR-AAP-4 / TC-AAP-7: ActivitySnapshot returns only tools that have reported
// activity, sorted by id for determinism.
func TestToolManager_ActivitySnapshot(t *testing.T) {
	defer func(o func(*Tool) bool) { attnBusyProbe = o }(attnBusyProbe)
	attnBusyProbe = func(*Tool) bool { return true } // agents alive
	m := NewToolManager("", nil)
	t.Cleanup(m.WaitSaves)
	p1 := &Tool{ID: "1"}
	p1.SetActivity("working", "Edit", "app.js")
	p5 := &Tool{ID: "5"}
	p5.SetActivity("done", "", "")
	p2 := &Tool{ID: "2"} // no activity reported → excluded
	m.mu.Lock()
	m.tools["1"] = p1
	m.tools["5"] = p5
	m.tools["2"] = p2
	m.mu.Unlock()

	snap := m.ActivitySnapshot()
	if len(snap) != 2 {
		t.Fatalf("snapshot want 2 active tools, got %v", snap)
	}
	if snap[0].ToolID != "1" || snap[0].State != "working" || snap[0].Tool != "Edit" || snap[0].Detail != "app.js" {
		t.Fatalf("snapshot[0] unexpected: %+v", snap[0])
	}
	if snap[1].ToolID != "5" || snap[1].State != "done" {
		t.Fatalf("snapshot[1] unexpected: %+v", snap[1])
	}
}

// FR-AAP-20: a `working` card whose agent process has died (not busy) is pruned
// from the snapshot so a stale "working" never lingers after an abnormal exit.
// Terminal states (done/waiting/idle) are kept regardless of busy.
func TestToolManager_ActivitySnapshot_PrunesDeadWorking(t *testing.T) {
	defer func(o func(*Tool) bool) { attnBusyProbe = o }(attnBusyProbe)
	attnBusyProbe = func(*Tool) bool { return false } // agent dead
	m := NewToolManager("", nil)
	t.Cleanup(m.WaitSaves)
	pw := &Tool{ID: "1"}
	pw.SetActivity("working", "Bash", "x")
	pd := &Tool{ID: "2"}
	pd.SetActivity("done", "", "")
	m.mu.Lock()
	m.tools["1"] = pw
	m.tools["2"] = pd
	m.mu.Unlock()

	snap := m.ActivitySnapshot()
	if len(snap) != 1 || snap[0].ToolID != "2" {
		t.Fatalf("dead working pruned, done kept; got %+v", snap)
	}
}

// FR-AAP-2: a tool with no activity notifier wired must not panic on setActivity.
func TestTool_SetActivity_NilNotifierSafe(t *testing.T) {
	p := &Tool{ID: "1"}
	p.SetActivity("working", "Bash", "ls")
	if got := p.Activity(); got == nil || got.State != "working" {
		t.Fatalf("activity stored without notifier, got %+v", got)
	}
}
