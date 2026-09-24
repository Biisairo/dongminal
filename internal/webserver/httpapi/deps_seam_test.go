package httpapi

import (
	"context"
	"testing"

	"dongminal/internal/webserver/domain/run"
	"dongminal/internal/webserver/domain/worktree"
)

// M8 `GO-44`: worktree 관리자는 인터페이스로 주입된다 — 핸들러 테스트가 git 없이
// 돈다. 이 파일의 가짜는 `git` 을 한 번도 부르지 않는다.
type fakeWorktrees struct {
	removed []worktree.RemoveSpec
	result  worktree.Result
}

func (f *fakeWorktrees) Root() string { return "/fake/worktrees" }
func (f *fakeWorktrees) Path(runShort, leaf string) string {
	return "/fake/worktrees/" + runShort + "/" + leaf
}
func (f *fakeWorktrees) Resolve(context.Context, string, string) (worktree.Repo, error) {
	return worktree.Repo{}, nil
}
func (f *fakeWorktrees) Create(context.Context, worktree.Spec) error            { return nil }
func (f *fakeWorktrees) Rollback(context.Context, worktree.Spec)                {}
func (f *fakeWorktrees) BranchExists(context.Context, string, string) bool      { return false }
func (f *fakeWorktrees) List(context.Context, string) ([]worktree.Entry, error) { return nil, nil }
func (f *fakeWorktrees) AddSpec(worktree.Spec) (worktree.ExecSpec, error) {
	return worktree.ExecSpec{}, nil
}
func (f *fakeWorktrees) Configure(context.Context, worktree.Spec) {}
func (f *fakeWorktrees) Remove(_ context.Context, s worktree.RemoveSpec) worktree.Result {
	f.removed = append(f.removed, s)
	r := f.result
	r.Path, r.Branch = s.Path, s.Branch
	return r
}

// fakeRuns 는 RunStore 중 이 테스트가 쓰는 메서드만 채운다 — 나머지는 임베드된
// nil 인터페이스라 호출되면 패닉이고, 그것이 곧 "이 경로는 그것을 쓰지 않는다"
// 는 단정이다.
type fakeRuns struct {
	RunStore
	marks []run.WorktreeMark
}

func (f *fakeRuns) MarkWorktrees(_ string, marks []run.WorktreeMark) error {
	f.marks = append(f.marks, marks...)
	return nil
}

func TestCleanupWorktrees_ReportsManagerResidueWithoutGit(t *testing.T) {
	fw := &fakeWorktrees{result: worktree.Result{Residue: worktree.ResidueDirty}}
	fr := &fakeRuns{}
	s := &Server{Deps: Deps{Worktrees: fw, Runs: fr}}
	rec := run.Record{
		ID: "r1", Repo: "/fake/repo", Isolation: run.IsolationPerMember,
		Members: []run.Member{
			{ID: "m1", Worktree: &run.Worktree{Path: "/fake/worktrees/r1/m1", Branch: "b1"}},
			{ID: "m2", Worktree: &run.Worktree{Path: "/fake/worktrees/r1/m2", Branch: "b2", Removed: true}},
		},
	}
	trees := s.cleanupWorktrees(context.Background(), rec, false)
	if len(fw.removed) != 1 || fw.removed[0].Path != "/fake/worktrees/r1/m1" {
		t.Fatalf("이미 제거된 트리를 건너뛰고 하나만 지워야 한다: %+v", fw.removed)
	}
	if len(trees) != 1 || trees[0].Residue != worktree.ResidueDirty || trees[0].Removed {
		t.Fatalf("관리자의 잔여물 보고가 그대로 실려야 한다: %+v", trees)
	}
	if len(fr.marks) != 1 || fr.marks[0].Residue != worktree.ResidueDirty {
		t.Fatalf("정리 결과가 레코드에 표식으로 남아야 한다: %+v", fr.marks)
	}
}
