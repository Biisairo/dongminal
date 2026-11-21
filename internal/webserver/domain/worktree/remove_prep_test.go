package worktree

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// REFACTOR3_DEDUP_GO_SRS FR-RDG-60: Remove·RemoveListed 의 전처리는 한 함수다.
func TestPrepareRemove(t *testing.T) {
	repo := tempRepo(t)
	m := tempManager(t)
	inside := filepath.Join(m.Root(), "w")
	errBad := errors.New("나쁜 경로")
	reject := func(string) error { return errBad }
	accept := func(string) error { return nil }

	cases := []struct {
		name      string
		s         RemoveSpec
		check     func(string) error
		honorKeep bool
		ok        bool
		residue   string
		detail    string
	}{
		{"경로 거부", RemoveSpec{Repo: repo, Path: inside}, reject, true, false, ResidueUnsafePath, errBad.Error()},
		{"저장소 자신", RemoveSpec{Repo: repo, Path: repo + "/"}, accept, true, false, ResidueUnsafePath, "저장소 자신은 제거하지 않는다"},
		{"Keep 존중", RemoveSpec{Repo: repo, Path: inside, Keep: true}, accept, true, false, ResidueKept, ""},
		{"Keep 무시", RemoveSpec{Repo: repo, Path: inside, Keep: true}, accept, false, true, "", ""},
		{"통과", RemoveSpec{Repo: repo, Path: inside}, accept, true, true, "", ""},
	}
	for _, c := range cases {
		res, release, ok := m.prepareRemove(context.Background(), c.s, c.check, c.honorKeep)
		if ok != c.ok || res.Residue != c.residue || res.Detail != c.detail {
			t.Errorf("%s: ok=%v res=%+v, want ok=%v residue=%q detail=%q", c.name, ok, res, c.ok, c.residue, c.detail)
		}
		if res.Path != c.s.Path {
			t.Errorf("%s: Path=%q", c.name, res.Path)
		}
		if ok {
			if release == nil {
				t.Fatalf("%s: ok 인데 release 가 없다", c.name)
			}
			release()
		}
	}
}

// FR-RDG-60: prune 뒤 "사라졌나" 판정은 헬퍼 하나다.
func TestPruneAndCheckGone(t *testing.T) {
	repo := tempRepo(t)
	m := tempManager(t)
	p := outsideWorktree(t, repo, "prune-branch")
	ctx := context.Background()

	if m.pruneAndCheckGone(ctx, repo, p) {
		t.Fatal("아직 있는 worktree 를 사라졌다고 본다")
	}
	if err := os.RemoveAll(p); err != nil {
		t.Fatal(err)
	}
	if !m.pruneAndCheckGone(ctx, repo, p) {
		t.Fatal("디스크에서 지운 worktree 가 prune 뒤에도 남았다고 본다")
	}
	out := git(t, repo, "worktree", "list", "--porcelain")
	if slices.Contains(strings.Split(out, "\n"), "worktree "+p) {
		t.Fatalf("prune 하지 않았다: %s", out)
	}
}
