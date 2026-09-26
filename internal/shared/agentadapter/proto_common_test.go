package agentadapter

import "testing"

func TestReqSeqIssuesPrefixedMonotonicIDs(t *testing.T) {
	var r reqSeq
	for i, want := range []string{"dm-1", "dm-2", "dm-3"} {
		if got := r.nextID(); got != want {
			t.Fatalf("#%d nextID = %q, want %q", i, got, want)
		}
	}
}

func TestExtOfCreatesOnceAndReuses(t *testing.T) {
	type ext struct{ n int }
	st := NewProtoState()
	calls := 0
	mk := func() *ext { calls++; return &ext{n: 7} }
	a := extOf(st, mk)
	b := extOf(st, mk)
	if a != b || calls != 1 || a.n != 7 {
		t.Fatalf("extOf: same=%v calls=%d n=%d", a == b, calls, a.n)
	}
}

func TestExtOfReplacesForeignExt(t *testing.T) {
	type ext struct{}
	st := NewProtoState()
	st.Ext = "other"
	if x := extOf(st, func() *ext { return &ext{} }); x == nil || st.Ext != any(x) {
		t.Fatalf("extOf did not install its own ext: %#v", st.Ext)
	}
}

func TestTurnEdgeStartsOnceUntilEnd(t *testing.T) {
	var e turnEdge
	if !e.start() {
		t.Fatal("first start must be an edge")
	}
	if e.start() {
		t.Fatal("second start inside a turn must not be an edge")
	}
	if !e.active() {
		t.Fatal("active after start")
	}
	e.end()
	if e.active() || !e.start() {
		t.Fatal("start after end must be an edge again")
	}
}
