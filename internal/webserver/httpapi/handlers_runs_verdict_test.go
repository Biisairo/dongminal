package httpapi

import (
	"errors"
	"reflect"
	"testing"

	"dongminal/internal/webserver/domain/run"
	"dongminal/internal/webserver/domain/worktree"
)

// REFACTOR3_GO_STRUCT_SRS FR-RGS-1: Run 처리기(succeed·context·tree·close·members)에서 뗀 판정 함수.

func TestSelfSucceedMember(t *testing.T) {
	own := run.Member{ID: "m1"}
	cases := []struct {
		name      string
		requested string
		isMember  bool
		want      string
		wantErr   error
	}{
		{"멤버가 아니면 거절", "", false, "", run.ErrSenderNotMember},
		{"지목 없이 자기", "", true, "m1", nil},
		{"자기를 지목", "m1", true, "m1", nil},
		{"남을 지목하면 거절", "m2", true, "", run.ErrSenderNotMember},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := selfSucceedMember(c.requested, own, c.isMember)
			if got != c.want || !errors.Is(err, c.wantErr) || (c.wantErr == nil && err != nil) {
				t.Fatalf("got (%q, %v), want (%q, %v)", got, err, c.want, c.wantErr)
			}
		})
	}
}

func TestSucceedArgsError(t *testing.T) {
	cases := []struct {
		name    string
		body    succeedReq
		wantErr bool
	}{
		{"멤버 없음", succeedReq{}, true},
		{"공백 멤버", succeedReq{MemberID: "  "}, true},
		{"at 과 headless 함께", succeedReq{MemberID: "m", At: "t", Headless: true}, true},
		{"at 만", succeedReq{MemberID: "m", At: "t"}, false},
		{"headless 만", succeedReq{MemberID: "m", Headless: true}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := succeedArgsError(c.body)
			if (err != nil) != c.wantErr {
				t.Fatalf("err=%v, wantErr=%v", err, c.wantErr)
			}
			if err != nil && !errors.Is(err, run.ErrInvalidArgument) {
				t.Fatalf("err=%v 는 ErrInvalidArgument 여야 한다", err)
			}
		})
	}
}

func TestWorktreePath(t *testing.T) {
	cases := []struct {
		name string
		wt   *run.Worktree
		want string
		ok   bool
	}{
		{"격리 없음", nil, "", false},
		{"빈 경로", &run.Worktree{}, "", false},
		{"격리", &run.Worktree{Path: "/w"}, "/w", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, ok := worktreePath(c.wt)
			if got != c.want || ok != c.ok {
				t.Fatalf("got (%q, %v), want (%q, %v)", got, ok, c.want, c.ok)
			}
		})
	}
}

func TestSucceedResponse(t *testing.T) {
	view := memberView{Member: run.Member{ID: "next"}}
	cases := []struct {
		name string
		prev run.Member
		has  bool
	}{
		{"요약 있음", run.Member{ID: "p", State: run.Succeeded, HandoffSummary: "s"}, true},
		{"요약 없음", run.Member{ID: "p", State: run.Succeeded}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := succeedResponse(view, c.prev)
			want := map[string]any{"member": view, "prevMemberId": "p", "prevState": run.Succeeded, "hasSummary": c.has}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("got %#v, want %#v", got, want)
			}
		})
	}
}

func TestContextObservation(t *testing.T) {
	n := func(v int64) *int64 { return &v }
	base := run.ContextObservation{SessionID: "s", Compacted: true, Model: "m", Agent: "a"}
	withBytes := base
	withBytes.Bytes, withBytes.HasBytes = 10, true
	withTokens := base
	withTokens.Tokens, withTokens.HasTokens = 0, true
	cases := []struct {
		name string
		body contextReq
		want run.ContextObservation
	}{
		{"재지 못함", contextReq{SessionID: "s", Compacted: true, Model: "m", Agent: "a"}, base},
		{"바이트", contextReq{SessionID: "s", Compacted: true, Model: "m", Agent: "a", Bytes: n(10)}, withBytes},
		{"음수 바이트는 재지 못한 것", contextReq{SessionID: "s", Compacted: true, Model: "m", Agent: "a", Bytes: n(-1)}, base},
		{"0 토큰은 잰 것", contextReq{SessionID: "s", Compacted: true, Model: "m", Agent: "a", Tokens: n(0)}, withTokens},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := contextObservation(c.body); got != c.want {
				t.Fatalf("got %+v, want %+v", got, c.want)
			}
		})
	}
}

func TestContextResponse(t *testing.T) {
	common := func(entered string) map[string]any {
		return map[string]any{
			"observed": true, "level": "warn", "ratio": 0.5, "compactCount": 1, "entered": entered,
			"tokens": int64(5), "limit": float64(10),
		}
	}
	m := run.Member{RunID: "r", ContextState: run.ContextState{
		ContextLevel: "warn", ContextRatio: 0.5, CompactCount: 1, ContextTokens: 5, ContextLimit: 10,
	}}
	member := m
	member.ID = "m1"
	wantMember := common("warn")
	wantMember["memberId"] = "m1"
	wantCoord := common("")
	wantCoord["coordinator"] = true
	wantCoord["runId"] = "r"
	cases := []struct {
		name    string
		m       run.Member
		entered string
		want    map[string]any
	}{
		{"멤버", member, "warn", wantMember},
		{"조정자 자리", m, "", wantCoord},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := contextResponse(c.m, c.entered); !reflect.DeepEqual(got, c.want) {
				t.Fatalf("got %#v, want %#v", got, c.want)
			}
		})
	}
}

func TestTreeChainOrder(t *testing.T) {
	members := []run.Member{
		{ID: "a", CreatedAt: 10},
		{ID: "b", CreatedAt: 20},
		{ID: "a2", CreatedAt: 30, SucceededFrom: "a"},
		{ID: "a3", CreatedAt: 40, SucceededFrom: "a2"},
		{ID: "x", CreatedAt: 50, SucceededFrom: "없는 멤버"},
	}
	started, seq := treeChainOrder(members)
	wantStarted := map[string]int64{"a": 10, "b": 20, "a2": 10, "a3": 10, "x": 50}
	wantSeq := map[string]int{"a": 0, "b": 1, "a2": 0, "a3": 0, "x": 4}
	if !reflect.DeepEqual(started, wantStarted) || !reflect.DeepEqual(seq, wantSeq) {
		t.Fatalf("got (%v, %v), want (%v, %v)", started, seq, wantStarted, wantSeq)
	}
}

func TestLinkTree(t *testing.T) {
	node := func(id, role string, st run.MemberState, parentID string, at int64) treeNode {
		n := treeNode{graphMember: graphMember{ID: id, Role: role, State: st}, parentID: parentID, createdAt: at}
		return n
	}
	type row struct {
		ID, Parent string
		Leaf       bool
	}
	cases := []struct {
		name      string
		nodes     []treeNode
		successor map[string]string
		want      []row
	}{
		{
			name:  "사슬 이름으로 부모",
			nodes: []treeNode{node("b", "r›c", run.Working, "", 2), node("a", "r", run.Working, "", 1)},
			want:  []row{{"a", "", false}, {"b", "r", true}},
		},
		{
			name:      "배정 부모는 승계 사슬의 끝",
			nodes:     []treeNode{node("p2", "lead", run.Working, "", 1), node("c", "x", run.Working, "p1", 2)},
			successor: map[string]string{"p1": "p2"},
			want:      []row{{"p2", "", false}, {"c", "lead", true}},
		},
		{
			name:  "끝난 자식은 잎을 빼앗지 않는다",
			nodes: []treeNode{node("a", "r", run.Working, "", 1), node("b", "r›c", run.Done, "", 2)},
			want:  []row{{"a", "", true}, {"b", "r", false}},
		},
		{
			name:  "끝난 부모 이름은 사슬 부모가 아니다",
			nodes: []treeNode{node("a", "r", run.Done, "", 1), node("b", "r›c", run.Working, "", 2)},
			want:  []row{{"a", "", false}, {"b", "", true}},
		},
		{
			name:      "순환 사슬에서 멈춘다",
			nodes:     []treeNode{node("a", "ra", run.Working, "", 1), node("c", "x", run.Working, "a", 2)},
			successor: map[string]string{"a": "b", "b": "a"},
			want:      []row{{"a", "", false}, {"c", "ra", true}},
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			succ := c.successor
			if succ == nil {
				succ = map[string]string{}
			}
			var got []row
			for _, n := range linkTree(c.nodes, succ) {
				got = append(got, row{n.ID, n.Parent, n.Leaf})
			}
			if !reflect.DeepEqual(got, c.want) {
				t.Fatalf("got %+v, want %+v", got, c.want)
			}
		})
	}
}

func TestWorktreeResidue(t *testing.T) {
	cases := []struct {
		name  string
		trees []worktree.Result
		want  int
	}{
		{"없음", nil, 0},
		{"모두 지움", []worktree.Result{{Removed: true}, {Removed: true}}, 0},
		{"남은 것", []worktree.Result{{Removed: true}, {}, {}}, 2},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := worktreeResidue(c.trees); got != c.want {
				t.Fatalf("got %d, want %d", got, c.want)
			}
		})
	}
}

func TestKeepRunRecord(t *testing.T) {
	cases := []struct {
		residue, kept int
		want          bool
	}{
		{0, 0, false},
		{1, 0, true},
		{0, 1, true},
		{2, 3, true},
	}
	for _, c := range cases {
		if got := keepRunRecord(c.residue, c.kept); got != c.want {
			t.Fatalf("(%d,%d): got %v, want %v", c.residue, c.kept, got, c.want)
		}
	}
}

func TestMemberAddArgsError(t *testing.T) {
	cases := []struct {
		name    string
		body    memberAddReq
		wantErr bool
	}{
		{"둘 다 없음", memberAddReq{}, true},
		{"둘 다 있음", memberAddReq{ID: "t", Headless: true}, true},
		{"탭만", memberAddReq{ID: "t"}, false},
		{"headless 만", memberAddReq{Headless: true}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := memberAddArgsError(c.body)
			if (err != nil) != c.wantErr || (err != nil && !errors.Is(err, run.ErrInvalidArgument)) {
				t.Fatalf("err=%v, wantErr=%v", err, c.wantErr)
			}
		})
	}
}

func TestMemberAddSpec(t *testing.T) {
	wt := &run.Worktree{Path: "/w"}
	assign := &run.Assignment{Issue: "o/r#1"}
	body := memberAddReq{Role: "r", Agent: "claude", Brief: "b", Headless: true, Assign: assign}
	got := memberAddSpec(body, &memberIsolation{ID: "m1", Worktree: wt}, "tool", "tab")
	want := run.MemberSpec{
		ID: "m1", Role: "r", Agent: "claude", Brief: "b", ToolID: "tool", TabID: "tab",
		Worktree: wt, Headless: true, Assign: assign,
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}
