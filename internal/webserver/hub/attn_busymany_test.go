package hub

import (
	"sort"
	"testing"
)

// OPTIMIZE_REFACTOR_SRS FR-OPT-2-4 — busy 일괄 조회와 판정 보류.

// countingProbe 는 부른 횟수와 받은 ids 를 적는다. ok=false 면 "모른다" 를 답한다.
type countingProbe struct {
	calls int
	ids   [][]string
	busy  map[string]bool
	ok    bool
}

func (c *countingProbe) probe(ids []string) (map[string]bool, bool) {
	c.calls++
	got := append([]string(nil), ids...)
	sort.Strings(got)
	c.ids = append(c.ids, got)
	if !c.ok {
		return nil, false
	}
	out := map[string]bool{}
	for _, id := range ids {
		out[id] = c.busy[id]
	}
	return out, true
}

func workingTracker(ids ...string) *AttnTracker {
	tr := NewAttnTracker(&fakeBroker{}, 1000)
	for _, id := range ids {
		tr.SetActivity(id, "working", "Bash", "make")
	}
	tr.SetActivity("idle1", "done", "", "")
	return tr
}

// working 도구 N개의 스냅샷: busy RPC N번 → 1번. working 이 아닌 도구는 묻지 않는다.
func TestActivitySnapshotOneProbe(t *testing.T) {
	tr := workingTracker("a", "b", "c")
	cp := &countingProbe{ok: true, busy: map[string]bool{"a": true, "c": true}}
	tr.SetBusyProbe(cp.probe)
	got := map[string]bool{}
	for _, s := range tr.ActivitySnapshot() {
		got[s.ToolID] = true
	}
	if cp.calls != 1 || len(cp.ids[0]) != 3 {
		t.Fatalf("probe calls=%d ids=%v — 한 번에 working 셋을 물어야 한다", cp.calls, cp.ids)
	}
	if !got["a"] || got["b"] || !got["c"] || !got["idle1"] {
		t.Fatalf("snapshot=%v — 죽은 working(b)만 빠져야 한다", got)
	}
}

// working 이 없으면 묻지 않는다.
func TestActivitySnapshotNoWorkingNoProbe(t *testing.T) {
	tr := workingTracker()
	cp := &countingProbe{ok: true}
	tr.SetBusyProbe(cp.probe)
	if n := len(tr.ActivitySnapshot()); n != 1 || cp.calls != 0 {
		t.Fatalf("snapshot=%d calls=%d", n, cp.calls)
	}
}

// IPC-M2: RPC 오류는 판정 보류다 — working 카드를 빼지 않는다.
func TestActivitySnapshotUnknownKeepsWorking(t *testing.T) {
	tr := workingTracker("a", "b")
	cp := &countingProbe{ok: false}
	tr.SetBusyProbe(cp.probe)
	if n := len(tr.ActivitySnapshot()); n != 3 {
		t.Fatalf("snapshot=%d — 모를 때 working 카드가 빠졌다", n)
	}
}

// 스위퍼는 로컬 판정을 먼저 한다 — 에이전트가 아닌 도구·턴이 끝난 도구는 묻지
// 않고, 남은 후보를 한 번에 묻는다.
func TestSweepLocalFirstOneProbe(t *testing.T) {
	tr, fb := firingTracker(1000)
	tr.nowFn = func() int64 { return 0 }
	cp := &countingProbe{ok: true, busy: map[string]bool{"a1": true, "a2": true}}
	tr.SetBusyProbe(cp.probe)
	startStaleWork(tr, "a1")
	startStaleWork(tr, "a2")
	tr.FeedOutput("a1", []byte("x"))
	tr.FeedOutput("a2", []byte("x"))
	tr.FeedOutput("plain", []byte("x"))

	tr.SweepIdleAt(int64(2_000) * 1e6)

	if cp.calls != 1 || len(cp.ids[0]) != 2 || cp.ids[0][0] != "a1" || cp.ids[0][1] != "a2" {
		t.Fatalf("probe calls=%d ids=%v — 후보(a1,a2)만 한 번에 물어야 한다", cp.calls, cp.ids)
	}
	if firedIdle(fb, "a1") != 1 || firedIdle(fb, "a2") != 1 {
		t.Fatalf("a1=%d a2=%d", firedIdle(fb, "a1"), firedIdle(fb, "a2"))
	}
}

// 후보가 없으면 묻지 않는다.
func TestSweepNoCandidateNoProbe(t *testing.T) {
	tr, _ := firingTracker(1000)
	tr.nowFn = func() int64 { return 0 }
	cp := &countingProbe{ok: true}
	tr.SetBusyProbe(cp.probe)
	tr.FeedOutput("plain", []byte("x"))
	tr.SweepIdleAt(int64(2_000) * 1e6)
	if cp.calls != 0 {
		t.Fatalf("후보가 없는데 %d번 물었다", cp.calls)
	}
}

// IPC-M2: RPC 오류는 판정 보류다 — 울지도 않고 무장을 잃지도 않는다. 다음 패스에
// 답을 받으면 운다.
func TestSweepUnknownHolds(t *testing.T) {
	tr, fb := firingTracker(1000)
	tr.nowFn = func() int64 { return 0 }
	cp := &countingProbe{ok: false, busy: map[string]bool{"agent": true}}
	tr.SetBusyProbe(cp.probe)
	startStaleWork(tr, "agent")
	tr.FeedOutput("agent", []byte("x"))

	tr.SweepIdleAt(int64(2_000) * 1e6)
	if got := firedIdle(fb, "agent"); got != 0 {
		t.Fatalf("모르는데 울었다: %d", got)
	}
	cp.ok = true
	tr.SweepIdleAt(int64(3_000) * 1e6)
	if got := firedIdle(fb, "agent"); got != 1 {
		t.Fatalf("보류 뒤 답을 받고도 울지 않았다: %d", got)
	}
}

// busyAll 은 모든 도구를 b 로 답하는 탐침이다.
func busyAll(b bool) func([]string) (map[string]bool, bool) {
	return func(ids []string) (map[string]bool, bool) {
		out := make(map[string]bool, len(ids))
		for _, id := range ids {
			out[id] = b
		}
		return out, true
	}
}
