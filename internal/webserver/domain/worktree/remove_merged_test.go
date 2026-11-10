package worktree

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

// ISSUE_TREE_CLOSE_SRS 묶음 G — 병합 확인 뒤에만 지운다 (TC-ITX-4·5).

// commitIn 은 worktree 안에 파일 하나를 커밋한다.
func commitIn(t *testing.T, dir, name string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(name+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	git(t, dir, "add", ".")
	git(t, dir, "commit", "-m", name)
}

func createTree(t *testing.T, m *Manager, repo, slug, branch, base string) Spec {
	t.Helper()
	spec := Spec{Repo: repo, Path: m.Path("run1234", slug), Branch: branch, Base: base}
	if err := m.Create(context.Background(), spec); err != nil {
		t.Fatalf("Create: %v", err)
	}
	return spec
}

// FR-ITX-41·42: 병합 대상에 들어간 브랜치는 메인 HEAD 에 병합되지 않았어도
// worktree 와 브랜치를 모두 지운다.
func TestRemove_RequireMerged_MergedIntoTargetIsRemoved(t *testing.T) {
	repo := tempRepo(t)
	m := tempManager(t)
	parent := createTree(t, m, repo, "parent", "dmn/run1234/parent", "main")
	child := createTree(t, m, repo, "child", "dmn/run1234/child", "dmn/run1234/parent")
	commitIn(t, child.Path, "가지.txt")
	git(t, parent.Path, "merge", "--ff-only", child.Branch)

	res := m.Remove(context.Background(), RemoveSpec{
		Repo: repo, Path: child.Path, Branch: child.Branch,
		MergeInto: parent.Branch, RequireMerged: true,
	})
	if !res.Removed || res.Residue != "" {
		t.Fatalf("병합된 가지는 지운다: %+v", res)
	}
	if out := git(t, repo, "branch", "--list", child.Branch); out != "" {
		t.Errorf("병합 대상에 들어간 브랜치가 남았다: %q", out)
	}
}

// FR-ITX-41: 병합 대상에 들어가지 않은 브랜치는 깨끗해도 지우지 않는다.
func TestRemove_RequireMerged_UnmergedIsKept(t *testing.T) {
	repo := tempRepo(t)
	m := tempManager(t)
	spec := createTree(t, m, repo, "mem5678", "dmn/run1234/writer", "main")
	commitIn(t, spec.Path, "새파일.txt")

	res := m.Remove(context.Background(), RemoveSpec{
		Repo: repo, Path: spec.Path, Branch: spec.Branch,
		MergeInto: "main", RequireMerged: true,
	})
	if res.Removed || res.Residue != ResidueUnmerged {
		t.Fatalf("병합되지 않은 트리는 unmerged 잔여물이다: %+v", res)
	}
	if _, err := os.Stat(spec.Path); err != nil {
		t.Fatalf("worktree 를 지웠다: %v", err)
	}
	if out := git(t, repo, "branch", "--list", spec.Branch); out == "" {
		t.Error("브랜치를 지웠다")
	}
}

// FR-ITX-41: 병합 대상을 모르면 판정할 수 없으므로 남긴다.
func TestRemove_RequireMerged_EmptyTargetIsKept(t *testing.T) {
	repo := tempRepo(t)
	m := tempManager(t)
	spec := createTree(t, m, repo, "mem5678", "dmn/run1234/writer", "main")

	res := m.Remove(context.Background(), RemoveSpec{
		Repo: repo, Path: spec.Path, Branch: spec.Branch, RequireMerged: true,
	})
	if res.Removed || res.Residue != ResidueUnmerged {
		t.Fatalf("병합 대상이 없으면 unmerged 다: %+v", res)
	}
	if _, err := os.Stat(spec.Path); err != nil {
		t.Fatalf("worktree 를 지웠다: %v", err)
	}
}

// FR-ITX-41: 없는 병합 대상(판정 실패)도 남긴다.
func TestRemove_RequireMerged_MissingTargetIsKept(t *testing.T) {
	repo := tempRepo(t)
	m := tempManager(t)
	spec := createTree(t, m, repo, "mem5678", "dmn/run1234/writer", "main")

	res := m.Remove(context.Background(), RemoveSpec{
		Repo: repo, Path: spec.Path, Branch: spec.Branch,
		MergeInto: "없는-브랜치", RequireMerged: true,
	})
	if res.Removed || res.Residue != ResidueUnmerged {
		t.Fatalf("판정 실패는 unmerged 다: %+v", res)
	}
}

// FR-ITX-41 · FR-WKT-8: 병합됐어도 dirty 면 지금처럼 dirty 다.
func TestRemove_RequireMerged_DirtyStaysDirty(t *testing.T) {
	repo := tempRepo(t)
	m := tempManager(t)
	spec := createTree(t, m, repo, "mem5678", "dmn/run1234/writer", "main")
	if err := os.WriteFile(filepath.Join(spec.Path, "작업물.txt"), []byte("a\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	res := m.Remove(context.Background(), RemoveSpec{
		Repo: repo, Path: spec.Path, Branch: spec.Branch,
		MergeInto: "main", RequireMerged: true,
	})
	if res.Removed || res.Residue != ResidueDirty {
		t.Fatalf("dirty 는 dirty 다: %+v", res)
	}
}

// FR-ITX-40: 현재 브랜치 이름. 분리된 HEAD 면 비어 있다.
func TestCurrentBranch(t *testing.T) {
	repo := tempRepo(t)
	m := tempManager(t)
	if got := m.CurrentBranch(context.Background(), repo); got != "main" {
		t.Fatalf("CurrentBranch = %q, want main", got)
	}
	git(t, repo, "checkout", "--detach", "HEAD")
	if got := m.CurrentBranch(context.Background(), repo); got != "" {
		t.Fatalf("분리된 HEAD 의 CurrentBranch = %q, want 빈 값", got)
	}
}

// FR-ITX-47: 연결된 worktree 에서도 메인 worktree 경로를 준다.
func TestMainRoot(t *testing.T) {
	repo := tempRepo(t)
	m := tempManager(t)
	want, err := m.Resolve(context.Background(), repo, "")
	if err != nil {
		t.Fatal(err)
	}
	spec := createTree(t, m, repo, "mem5678", "dmn/run1234/writer", "main")
	for _, dir := range []string{repo, spec.Path} {
		got, err := m.MainRoot(context.Background(), dir)
		if err != nil || got != want.Root {
			t.Errorf("MainRoot(%s) = %q, %v — want %q", dir, got, err, want.Root)
		}
	}
	if _, err := m.MainRoot(context.Background(), t.TempDir()); err == nil {
		t.Error("저장소가 아닌 곳에서 답했다")
	}
}

// FR-ITX-49 (TC-ITX-10): 경로와 브랜치를 손으로 이미 지웠으면 병합 판정 없이 정리됨이다.
// 종전에는 없는 브랜치의 판정 실패를 「병합되지 않았다」로 읽어 기록이 영영 남았다.
func TestRemove_RequireMerged_PathAndBranchGoneIsRemoved(t *testing.T) {
	repo := tempRepo(t)
	m := tempManager(t)
	spec := createTree(t, m, repo, "gone", "dmn/run1234/gone", "main")
	git(t, repo, "worktree", "remove", "--force", spec.Path)
	git(t, repo, "branch", "-D", spec.Branch)

	res := m.Remove(context.Background(), RemoveSpec{
		Repo: repo, Path: spec.Path, Branch: spec.Branch,
		MergeInto: "main", RequireMerged: true,
	})
	if !res.Removed || res.Residue != "" {
		t.Fatalf("이미 지운 worktree 는 정리됨이어야 한다: %+v", res)
	}
}

// FR-ITX-49: 경로만 없고 병합되지 않은 브랜치가 남으면 지금처럼 unmerged 다 — 잃을 커밋이 있다.
func TestRemove_RequireMerged_PathGoneUnmergedBranchKept(t *testing.T) {
	repo := tempRepo(t)
	m := tempManager(t)
	spec := createTree(t, m, repo, "half", "dmn/run1234/half", "main")
	commitIn(t, spec.Path, "남은커밋.txt")
	git(t, repo, "worktree", "remove", "--force", spec.Path)

	res := m.Remove(context.Background(), RemoveSpec{
		Repo: repo, Path: spec.Path, Branch: spec.Branch,
		MergeInto: "main", RequireMerged: true,
	})
	if res.Removed || res.Residue != ResidueUnmerged {
		t.Fatalf("병합되지 않은 브랜치는 남아야 한다: %+v", res)
	}
	if out := git(t, repo, "branch", "--list", spec.Branch); out == "" {
		t.Fatal("병합되지 않은 브랜치를 지웠다")
	}
}
