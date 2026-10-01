package worktree

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

// WORKTREE_REMOVE_ALL_SRS §4 W1~W5 — RemoveListed 는 영역이 아니라 등록으로 인가한다.

// outsideWorktree 는 Manager 영역 밖에 git 으로 직접 만든 worktree 다.
func outsideWorktree(t *testing.T, repo, branch string) string {
	t.Helper()
	parent, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(parent, "outside")
	git(t, repo, "worktree", "add", "--no-track", "-b", branch, p)
	return p
}

// W1 (FR-WRA-1·2): 영역 밖이라도 등록된 worktree 면 지운다.
func TestRemoveListed_RemovesRegisteredOutsideRoot(t *testing.T) {
	repo := tempRepo(t)
	m := tempManager(t)
	p := outsideWorktree(t, repo, "outside-branch")

	res := m.RemoveListed(context.Background(), RemoveSpec{Repo: repo, Path: p})
	if !res.Removed || res.Residue != "" {
		t.Fatalf("등록된 worktree 는 지워진다: %+v", res)
	}
	if _, err := os.Stat(p); !os.IsNotExist(err) {
		t.Error("경로가 남았다")
	}
	if !m.gone(context.Background(), repo, p) {
		t.Error("등록이 남았다")
	}
	if out := git(t, repo, "branch", "--list", "outside-branch"); out == "" {
		t.Error("Branch 를 주지 않았는데 브랜치를 지웠다")
	}
}

// W2 (FR-WRA-2): main·미등록·위험 경로는 거부한다.
func TestRemoveListed_RejectsUnlistedMainAndRiskyPaths(t *testing.T) {
	repo := tempRepo(t)
	m := tempManager(t)
	unlisted, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct{ name, path string }{
		{"main(저장소 자신)", repo},
		{"미등록", unlisted},
		{"빈 경로", ""},
		{"상대 경로", "a/b"},
		{"경로 이탈", filepath.Join(unlisted, "..", "x")},
		{"파일시스템 루트", "/"},
	}
	for _, c := range cases {
		res := m.RemoveListed(context.Background(), RemoveSpec{Repo: repo, Path: c.path})
		if res.Removed || res.Residue != ResidueUnsafePath {
			t.Errorf("%s: 거부되어야 한다: %+v", c.name, res)
		}
	}
	if _, err := os.Stat(filepath.Join(repo, "README.md")); err != nil {
		t.Fatalf("저장소가 훼손됐다: %v", err)
	}
	if _, err := os.Stat(unlisted); err != nil {
		t.Fatalf("미등록 경로가 지워졌다: %v", err)
	}
}

// W2 (FR-WRA-2): main worktree 는 링크드 worktree 를 Repo 로 줘도 거부한다 —
// "Repo 와 같다" 만으로는 막히지 않는 경우다.
func TestRemoveListed_RejectsMainQueriedFromLinked(t *testing.T) {
	repo := tempRepo(t)
	m := tempManager(t)
	linked := outsideWorktree(t, repo, "linked")

	res := m.RemoveListed(context.Background(), RemoveSpec{Repo: linked, Path: repo})
	if res.Removed || res.Residue != ResidueUnsafePath {
		t.Fatalf("main worktree 는 거부된다: %+v", res)
	}
	if _, err := os.Stat(filepath.Join(repo, "README.md")); err != nil {
		t.Fatalf("저장소가 훼손됐다: %v", err)
	}
}

// W3 (FR-WRA-3): dirty 는 Force 없이 남고, Force 면 지워진다.
func TestRemoveListed_DirtyNeedsForce(t *testing.T) {
	repo := tempRepo(t)
	m := tempManager(t)
	p := outsideWorktree(t, repo, "dirty-branch")
	if err := os.WriteFile(filepath.Join(p, "작업물.txt"), []byte("x\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	res := m.RemoveListed(context.Background(), RemoveSpec{Repo: repo, Path: p})
	if res.Removed || res.Residue != ResidueDirty {
		t.Fatalf("Force 없는 dirty 는 보존 + 보고다: %+v", res)
	}
	if _, err := os.Stat(filepath.Join(p, "작업물.txt")); err != nil {
		t.Fatalf("사용자 작업이 사라졌다: %v", err)
	}

	res = m.RemoveListed(context.Background(), RemoveSpec{Repo: repo, Path: p, Force: true})
	if !res.Removed || res.Residue != "" {
		t.Fatalf("Force 면 dirty 도 지워진다: %+v", res)
	}
	if _, err := os.Stat(p); !os.IsNotExist(err) {
		t.Error("경로가 남았다")
	}
}

// W4 (FR-WRA-3): Remove(자동 정리)는 Force 를 무시한다.
func TestRemove_IgnoresForce(t *testing.T) {
	repo := tempRepo(t)
	m := tempManager(t)
	spec := Spec{Repo: repo, Path: m.Path("run1234", "mem5678"), Branch: "dmn/run1234/writer", Base: "main"}
	if err := m.Create(context.Background(), spec); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := os.WriteFile(filepath.Join(spec.Path, "작업물.txt"), []byte("x\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	res := m.Remove(context.Background(), RemoveSpec{Repo: repo, Path: spec.Path, Force: true})
	if res.Removed || res.Residue != ResidueDirty {
		t.Fatalf("Remove 는 Force 와 무관하게 dirty 를 보존한다: %+v", res)
	}
}

// W5 (FR-WRA-4): 잠긴 worktree 는 Force 한 번으로 지워지지 않고 실패로 보고된다.
func TestRemoveListed_LockedIsReportedAsFailure(t *testing.T) {
	repo := tempRepo(t)
	m := tempManager(t)
	p := outsideWorktree(t, repo, "locked-branch")
	git(t, repo, "worktree", "lock", p)

	res := m.RemoveListed(context.Background(), RemoveSpec{Repo: repo, Path: p, Force: true})
	if res.Removed || res.Residue != ResidueRemoveFailed || res.Detail == "" {
		t.Fatalf("잠긴 worktree 는 remove-failed + 사유다: %+v", res)
	}
	if _, err := os.Stat(p); err != nil {
		t.Fatalf("잠긴 worktree 가 지워졌다: %v", err)
	}
}
