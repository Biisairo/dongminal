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

func TestPendingReqsIssueTakeOnce(t *testing.T) {
	var p pendingReqs[string]
	a, b := p.issue("initialize"), p.issue("set_model")
	if a != "dm-1" || b != "dm-2" {
		t.Fatalf("ids = %q %q", a, b)
	}
	if v, ok := p.take(b); !ok || v != "set_model" {
		t.Fatalf("take(%s) = %q %v", b, v, ok)
	}
	if _, ok := p.take(b); ok {
		t.Fatal("같은 id 를 두 번 꺼냈다 — 대기표에서 지워지지 않았다")
	}
	if _, ok := p.take("dm-99"); ok {
		t.Fatal("발급하지 않은 id 를 꺼냈다")
	}
	if v, ok := p.take(a); !ok || v != "initialize" {
		t.Fatalf("take(%s) = %q %v", a, v, ok)
	}
}
