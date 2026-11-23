// goref 는 Rust 포팅의 Run 도메인을 Go 와 비교하는 참조 시나리오다 (FR-RSP-3).
// dm-webserver-domain-run 의 시험이 격리 실행으로 빌드해 부른다. 출력 한 줄이 한 걸음이다.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"dongminal/internal/webserver/domain/run"
)

func p(label string, v any, err error) {
	if err != nil {
		fmt.Printf("%s: ERR %s\n", label, err.Error())
		return
	}
	b, merr := json.Marshal(v)
	if merr != nil {
		fmt.Printf("%s: MARSHAL %s\n", label, merr.Error())
		return
	}
	fmt.Printf("%s: %s\n", label, b)
}

func main() {
	dir := os.Args[1]
	n := 0
	s := run.NewStore(dir, run.WithClock(func() int64 { return 1700000000 }), run.WithIDGen(func() string {
		n++
		return fmt.Sprintf("0000000%d-aaaa-bbbb-cccc-00000000000%d", n%10, n%10)
	}))
	s.Load()
	wt := &run.Worktree{Path: "/w/a", Branch: "dm/a", Base: "main"}

	_, err := s.Start(run.StartOptions{Objective: "  ", Projection: run.Inline, Isolation: run.IsolationNone})
	p("start-empty", nil, err)
	_, err = s.Start(run.StartOptions{Objective: "x", Projection: "bogus", Isolation: run.IsolationNone})
	p("start-proj", nil, err)
	_, err = s.Start(run.StartOptions{Objective: "x", Projection: run.Inline, Isolation: "x"})
	p("start-iso", nil, err)
	a, err := s.Start(run.StartOptions{Objective: " 목적 <&> ", Projection: run.DedicatedWindow, Isolation: run.IsolationPerMember, CoordinatorToolID: "coord-tool", WindowID: "win", Repo: "/r", Base: "main", MergeInto: "dev", Worktree: wt})
	p("start-a", a, err)

	_, err = s.AddMember(a.ID, run.MemberSpec{Role: "dev", Agent: "gpt", ToolID: "t1"})
	p("add-unknown-agent", nil, err)
	_, err = s.AddMember(a.ID, run.MemberSpec{Role: " ", Agent: "claude", ToolID: "t1"})
	p("add-empty-role", nil, err)
	_, err = s.AddMember("nope", run.MemberSpec{Role: "dev", Agent: "claude", ToolID: "t1"})
	p("add-unknown-run", nil, err)
	m1, err := s.AddMember(a.ID, run.MemberSpec{Role: " dev ", Agent: " claude ", ToolID: "t1", TabID: "tab1", Brief: " 일을 한다\n둘째 줄 ", Worktree: &run.Worktree{Path: "/w/m1", Branch: "dm/m1", Base: "main"}})
	p("add-m1", m1, err)
	_, err = s.AddMember(a.ID, run.MemberSpec{Role: "x", Agent: "claude", ToolID: "t1"})
	p("add-dup-tool", nil, err)
	m2, err := s.AddMember(a.ID, run.MemberSpec{ID: "pre-m2", Role: "qa", Agent: "omp", ToolID: "t2", Headless: true})
	p("add-m2", m2, err)
	_, err = s.AddMember(a.ID, run.MemberSpec{Role: "x", Agent: "claude", ToolID: "t5", Assign: &run.Assignment{Issue: "#1"}})
	p("add-assign-nontree", nil, err)

	rec, _ := s.Get(a.ID)
	fmt.Print("PREAMBLE-m1\n" + run.Preamble(rec, m1) + "END\n")

	_, err = s.Report("t9", run.ReportSpec{Outcome: run.OutcomeSucceeded, Summary: "s"})
	p("report-stranger", nil, err)
	_, err = s.Report("t1", run.ReportSpec{Outcome: "maybe", Summary: "s"})
	p("report-outcome", nil, err)
	_, err = s.Report("t1", run.ReportSpec{Outcome: run.OutcomeFailed, Summary: " "})
	p("report-summary", nil, err)
	_, err = s.Report("t1", run.ReportSpec{RunID: "other", Outcome: run.OutcomeFailed, Summary: "s"})
	p("report-mismatch", nil, err)
	r1, err := s.Report("t1", run.ReportSpec{RunID: a.ID, MemberID: m1.ID, Outcome: run.OutcomeSucceeded, Summary: " 했다 ", FilesModified: []string{"a.go", "b.go"}})
	p("report-ok", r1, err)
	_, err = s.Report("t1", run.ReportSpec{Outcome: run.OutcomeSucceeded, Summary: "s"})
	p("report-again", nil, err)

	_, pending, err := s.Close(a.ID, false)
	p("close-guard", nil, err)
	p("close-guard-pending", pending, nil)

	pol := run.DefaultContextPolicy()
	for i, obs := range []run.ContextObservation{
		{Bytes: 100000, HasBytes: true, Agent: "omp", SessionID: "s1"},
		{Bytes: 600000, HasBytes: true, Agent: "omp"},
		{Tokens: 900000, HasTokens: true, Agent: "omp"},
		{Compacted: true, Agent: "omp"},
		{Tokens: 1200000, HasTokens: true, Agent: "omp", Window: 2000000},
	} {
		m, entered, found := s.ObserveContext("t2", obs, pol)
		p(fmt.Sprintf("observe-m2-%d %q %v", i, entered, found), m, nil)
	}
	for i, obs := range []run.ContextObservation{
		{Tokens: 150000, HasTokens: true, Agent: "claude", Model: "claude-opus-5"},
		{Tokens: 150000, HasTokens: true, Agent: "claude", Model: "claude-opus-5"},
		{Bytes: 5000, HasBytes: true},
	} {
		m, entered, found := s.ObserveContext("coord-tool", obs, run.ContextPolicy{BytesPerToken: 2, WarnRatio: 0.9, CriticalRatio: 0.5})
		p(fmt.Sprintf("observe-coord-%d %q %v", i, entered, found), m, nil)
	}
	_, entered, found := s.ObserveContext("nobody", run.ContextObservation{Bytes: 1, HasBytes: true}, pol)
	p(fmt.Sprintf("observe-nobody %q %v", entered, found), nil, nil)

	p("msg-ok", nil, s.AppendMessage(a.ID, run.MsgEvent{From: run.CoordinatorParty, To: m1.ID, Kind: run.MsgKindAgent, Size: 12}))
	p("msg-at", nil, s.AppendMessage(a.ID, run.MsgEvent{From: m1.ID, To: "pre-m2", At: 5, Size: 1}))
	p("msg-stranger", nil, s.AppendMessage(a.ID, run.MsgEvent{From: "x", To: "y"}))
	p("msg-empty", nil, s.AppendMessage(a.ID, run.MsgEvent{From: "x"}))
	p("msg-unknown-run", nil, s.AppendMessage("nope", run.MsgEvent{From: "x", To: "y"}))

	_, _, err = s.Detach("pre-m2")
	p("detach-not-attached", nil, err)
	_, _, err = s.Attach("pre-m2", "")
	p("attach-empty", nil, err)
	_, am, err := s.Attach("pre-m2", "tab9")
	p("attach", am, err)
	_, _, err = s.Attach("pre-m2", "tab10")
	p("attach-again", nil, err)
	_, dm, err := s.Detach("pre-m2")
	p("detach", dm, err)
	_, _, err = s.Attach("nope", "tab")
	p("attach-unknown", nil, err)

	_, _, err = s.Succeed(run.SucceedSpec{PrevMemberID: m1.ID})
	p("succeed-no-tool", nil, err)
	_, _, err = s.Succeed(run.SucceedSpec{PrevMemberID: m1.ID, ToolID: "t2"})
	p("succeed-dup-tool", nil, err)
	prev, next, err := s.Succeed(run.SucceedSpec{PrevMemberID: m1.ID, ToolID: "t3", TabID: "tab3", HandoffAsked: true})
	p("succeed-prev", prev, err)
	p("succeed-next", next, nil)
	fmt.Printf("handoff-waiting: %v\n", s.HandoffWaiting(next.ID))
	_, err = s.Handoff("t1", "wrong", "요약")
	p("handoff-mismatch", nil, err)
	hm, err := s.Handoff("t1", "", " 요약 첫 줄\n둘째 ")
	p("handoff", hm, err)
	fmt.Printf("handoff-waiting-after: %v\n", s.HandoffWaiting(next.ID))
	_, _, err = s.Succeed(run.SucceedSpec{PrevMemberID: m1.ID, ToolID: "t4"})
	p("succeed-twice", nil, err)
	rec, _ = s.Get(a.ID)
	fmt.Print("PREAMBLE-next\n" + run.Preamble(rec, next) + "END\n")
	fmt.Print("CLAUSE-m2\n" + run.HandoffClause(rec, m2) + "END\n")

	b, err := s.Start(run.StartOptions{Objective: "트리", Projection: run.Background, Isolation: run.IsolationPerRun, Tree: " T1 ", CoordinatorToolID: "coord-b"})
	p("start-tree", b, err)
	_, err = s.Start(run.StartOptions{Objective: "트리2", Projection: run.Background, Isolation: run.IsolationPerRun, Tree: "T1"})
	p("start-tree-dup", nil, err)
	_, err = s.Start(run.StartOptions{Objective: "가지", Projection: run.Inline, Isolation: run.IsolationNone, Tree: "T2", TreeBranch: true})
	p("start-branch-noroot", nil, err)
	c, err := s.Start(run.StartOptions{ID: "branch-run-id-1234567890", Objective: "가지", Projection: run.Inline, Isolation: run.IsolationNone, Tree: "T1", TreeBranch: true})
	p("start-branch", c, err)
	_, err = s.AddMember(b.ID, run.MemberSpec{Role: "chain1", Agent: "claude", ToolID: "t10"})
	p("add-tree-noissue", nil, err)
	_, err = s.AddMember(b.ID, run.MemberSpec{Role: "chain1", Agent: "claude", ToolID: "t10", Assign: &run.Assignment{Issue: "#1", CtxPct: 200}})
	p("add-tree-ctx", nil, err)
	_, err = s.AddMember(b.ID, run.MemberSpec{Role: "chain1", Agent: "claude", ToolID: "t10", Assign: &run.Assignment{Issue: "#1", Parent: "ghost"}})
	p("add-tree-parent", nil, err)
	mb, err := s.AddMember(b.ID, run.MemberSpec{Role: "chain1", Agent: "claude", ToolID: "t10", Assign: &run.Assignment{Issue: "#1", Title: "제목", Goal: "1.2", Parallel: true, CtxPct: 50, NoCommit: true}})
	p("add-tree-root", mb, err)
	_, err = s.AddMember(c.ID, run.MemberSpec{Role: "chain1", Agent: "claude", ToolID: "t11", Assign: &run.Assignment{Issue: "#2", Parent: mb.ID}})
	p("add-tree-taken", nil, err)
	mc, err := s.AddMember(c.ID, run.MemberSpec{Role: "chain2", Agent: "claude", ToolID: "t11", Assign: &run.Assignment{Issue: "#2", Title: "자식", Parent: mb.ID}})
	p("add-tree-child", mc, err)
	fmt.Printf("has-open-child: %v %v\n", s.HasOpenChild(mb.ID), s.HasOpenChild(mc.ID))
	recC, _ := s.Get(c.ID)
	recB, _ := s.Get(b.ID)
	fmt.Print("TREE-child\n" + run.TreePreamble(recC, mc, run.TreeContext{ParentToolID: "t10", GroupID: "g-1", DocPath: "/d/issue-tree.md", CtxPct: 50}) + "END\n")
	fmt.Print("TREE-root\n" + run.TreePreamble(recB, mb, run.TreeContext{ParentToolID: "coord-b", DocPath: "/d/issue-tree.md"}) + "END\n")
	fmt.Print("TREE-lone\n" + run.TreePreamble(recB, run.Member{ID: "x", Role: "r"}, run.TreeContext{}) + "END\n")
	title, zero, goal, yes := "  새 제목 ", 0, " 2.1 ", true
	_, err = s.UpdateAssign("t99", mc.ID, run.AssignPatch{Title: &title})
	p("assign-stranger", nil, err)
	_, err = s.UpdateAssign("t10", mc.ID, run.AssignPatch{CtxPct: &zero})
	p("assign-ctx", nil, err)
	_, err = s.UpdateAssign("t10", m2.ID, run.AssignPatch{Title: &title})
	p("assign-none", nil, err)
	ua, err := s.UpdateAssign("t10", mc.ID, run.AssignPatch{Title: &title, Goal: &goal, NoCommit: &yes})
	p("assign-ok", ua, err)
	_, nb, err := s.Succeed(run.SucceedSpec{PrevMemberID: mb.ID, ToolID: "t12", Summary: "넘김"})
	p("succeed-tree", nb, err)
	_, cm, _ := s.FindMember(mc.ID)
	p("child-parent-moved", cm, nil)

	p("mark", nil, s.MarkWorktrees(a.ID, []run.WorktreeMark{{Path: "/w/m1", Removed: true, Residue: "r", Detail: "d"}, {}}))
	rec, _ = s.Get(a.ID)
	p("targets", rec.WorktreeTargets(), nil)
	mv, err := s.MoveCoordinator("coord-tool", "coord2")
	p("move", len(mv), err)
	mv, err = s.MoveCoordinator("none", "x")
	p("move-none", mv, err)

	cr, pending, err := s.Close(a.ID, true)
	p("close-force", cr, err)
	p("close-force-pending", pending, nil)
	_, err = s.Report("t2", run.ReportSpec{Outcome: run.OutcomeFailed, Summary: "s"})
	p("report-closed", nil, err)
	_, err = s.Handoff("t2", "", "s")
	p("handoff-closed", nil, err)
	_, _, err = s.Close(a.ID, true)
	p("close-again", nil, err)
	_, err = s.Sweep(b.ID)
	p("sweep-open", nil, err)
	sw, err := s.Sweep(a.ID)
	p("sweep", sw.ID, err)
	reap := s.ReapTargets(func(t string) bool { return t == "coord-b" })
	ids := []string{}
	for _, r := range reap {
		ids = append(ids, r.ID)
	}
	p("reap", ids, nil)
	fmt.Printf("has-open: %v\n", s.HasOpen())
	if mm, ok := s.MemberByTool("t11"); ok {
		p("by-tool", mm.ID, nil)
	}
	for _, id := range []string{"", "abc", "12345678", "123456789", a.ID, "0123456789abcdef-x"} {
		fmt.Printf("slug %q %q %q\n", id, run.Short(id), run.PathSlug(id))
	}
	fmt.Printf("widen %v %v %v\n", run.WidenWindow(200000, 100), run.WidenWindow(200000, 300000), run.WidenWindow(200000, 3e6))

	blob, _ := os.ReadFile(filepath.Join(dir, "runs.json"))
	fmt.Printf("FILE %s\n", blob)
	d, err := s.Delete(a.ID)
	p("delete", d.ID, err)
	_, err = s.Delete(a.ID)
	p("delete-again", nil, err)
	s2 := run.NewStore(dir)
	s2.Load()
	p("reload", s2.List(), nil)
}
