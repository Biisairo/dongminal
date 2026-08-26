package worktree

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// 묶음 W — worktree 격리 (RUN_ORCHESTRATION_SRS §3.4, TC-WKT-1~9).
//
// 이 묶음은 저장소에서 **파일시스템을 파괴할 수 있는 유일한 경로**다. 그래서
// 안전 규칙(FR-WKT-8/9/10)을 먼저 못박는다. 테스트는 전부 격리된 임시 저장소를
// 쓴다 — 운영 저장소·사용자 홈을 대상으로 하지 않는다 (§4.3).

func git(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command(gitPath(t), args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

func gitPath(t *testing.T) string {
	t.Helper()
	p, err := exec.LookPath("git")
	if err != nil {
		t.Skip("git 이 없다 — worktree 테스트를 건너뛴다")
	}
	return p
}

// tempRepo 는 커밋 하나를 가진 임시 저장소를 만든다. 심볼릭 링크를 푸는 이유는
// git 이 toplevel 을 물리 경로로 답하기 때문이다 (macOS 의 /var → /private/var).
func tempRepo(t *testing.T) string {
	t.Helper()
	gitPath(t)
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatalf("EvalSymlinks: %v", err)
	}
	git(t, dir, "init", "-b", "main")
	git(t, dir, "config", "user.email", "t@example.com")
	git(t, dir, "config", "user.name", "tester")
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	git(t, dir, "add", ".")
	git(t, dir, "commit", "-m", "init")
	return dir
}

func tempManager(t *testing.T) *Manager {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatalf("EvalSymlinks: %v", err)
	}
	return New(filepath.Join(root, "worktrees"))
}

// TC-WKT-1 / FR-WKT-2: 생성은 --no-track 이고 base 를 repo config 에 남긴다.
//
// --no-track 이 핵심이다 — base 의 upstream 을 물려받으면 push 전에 git status 가
// "behind by N" 을 오보한다.
func TestCreate_NoTrackAndRecordsBase(t *testing.T) {
	repo := tempRepo(t)
	m := tempManager(t)
	spec := Spec{Repo: repo, Path: m.Path("run1234", "mem5678"), Branch: "dmn/run1234/writer", Base: "main"}

	if err := m.Create(spec); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if got := git(t, spec.Path, "rev-parse", "--abbrev-ref", "HEAD"); got != spec.Branch {
		t.Fatalf("worktree 의 브랜치가 어긋난다: %q", got)
	}
	if got := git(t, repo, "config", "--get", "branch."+spec.Branch+".base"); got != "main" {
		t.Fatalf("branch.<name>.base 가 기록되지 않았다: %q", got)
	}
	cmd := exec.Command(gitPath(t), "rev-parse", "--abbrev-ref", spec.Branch+"@{upstream}")
	cmd.Dir = spec.Path
	if out, err := cmd.CombinedOutput(); err == nil {
		t.Fatalf("upstream 이 붙었다 — --no-track 이 빠졌다: %s", out)
	}
	if got := git(t, spec.Path, "config", "--get", "push.autoSetupRemote"); got != "true" {
		t.Fatalf("push.autoSetupRemote 가 서지 않았다: %q", got)
	}
}

// TC-WKT-2 / FR-WKT-3/4: 경로·브랜치는 uuid 에서 파생하고 재사용하지 않는다.
func TestPathAndBranch_DeriveFromIdentifiers(t *testing.T) {
	m := tempManager(t)
	a := m.Path("run1111", "mem1111")
	b := m.Path("run2222", "mem1111")
	if a == b {
		t.Fatal("다른 Run 이 같은 경로를 쓴다 — 대화 이력이 섞인다")
	}
	if !strings.HasPrefix(a, m.Root()) {
		t.Fatalf("경로가 worktrees 루트 밖이다: %q", a)
	}
	if got := Branch("run1111", "작가", "mem1111"); got != "dmn/run1111/mem1111" {
		t.Fatalf("ASCII 로 환원할 수 없는 역할은 member short 로 떨어져야 한다: %q", got)
	}
	if got := Branch("run1111", "Writer 2", "mem1111"); got != "dmn/run1111/Writer-2" {
		t.Fatalf("역할 슬러그가 어긋난다: %q", got)
	}
	if got := Branch("run1111", "--force", "mem1111"); strings.Contains(got, "/-") {
		t.Fatalf("슬러그가 - 로 시작한다: %q", got)
	}
}

// TC-WKT-3 / FR-WKT-6: - 로 시작하는 인자는 거부한다 (git 플래그 오인).
func TestCreate_RejectsDashLeadingArguments(t *testing.T) {
	repo := tempRepo(t)
	m := tempManager(t)
	good := m.Path("run1234", "mem5678")

	cases := []struct {
		name string
		spec Spec
	}{
		{"branch", Spec{Repo: repo, Path: good, Branch: "-x", Base: "main"}},
		{"base", Spec{Repo: repo, Path: good, Branch: "dmn/a/b", Base: "-x"}},
		{"empty branch", Spec{Repo: repo, Path: good, Branch: "", Base: "main"}},
	}
	for _, c := range cases {
		if err := m.Create(c.spec); !errors.Is(err, ErrUnsafeArgument) {
			t.Errorf("%s: want ErrUnsafeArgument, got %v", c.name, err)
		}
	}
	// 경로 이탈은 별개의 사유다 — 뭉뚱그리면 호출자가 무엇이 위험했는지 모른다.
	esc := Spec{Repo: repo, Path: filepath.Join(m.Root(), "..", "elsewhere"), Branch: "dmn/a/b", Base: "main"}
	if err := m.Create(esc); !errors.Is(err, ErrUnsafePath) {
		t.Errorf("경로 이탈: want ErrUnsafePath, got %v", err)
	}
	if _, err := os.Stat(good); !os.IsNotExist(err) {
		t.Error("거부된 생성이 경로를 남겼다")
	}
}

// TC-WKT-4 / FR-WKT-8: clean 이면 worktree 를 지우고 브랜치는 -d 로 지운다.
func TestRemove_CleanRemovesWorktreeAndMergedBranch(t *testing.T) {
	repo := tempRepo(t)
	m := tempManager(t)
	spec := Spec{Repo: repo, Path: m.Path("run1234", "mem5678"), Branch: "dmn/run1234/writer", Base: "main"}
	if err := m.Create(spec); err != nil {
		t.Fatalf("Create: %v", err)
	}

	res := m.Remove(RemoveSpec{Repo: repo, Path: spec.Path, Branch: spec.Branch})
	if !res.Removed || res.Residue != "" {
		t.Fatalf("clean worktree 는 제거된다: %+v", res)
	}
	if _, err := os.Stat(spec.Path); !os.IsNotExist(err) {
		t.Error("경로가 남았다")
	}
	if out := git(t, repo, "branch", "--list", spec.Branch); out != "" {
		t.Errorf("머지된 브랜치가 남았다: %q", out)
	}
}

// TC-WKT-5 / FR-WKT-8: dirty 면 지우지 않는다. 사용자 작업의 조용한 삭제는 금지다.
func TestRemove_DirtyIsPreservedAndReported(t *testing.T) {
	repo := tempRepo(t)
	m := tempManager(t)
	spec := Spec{Repo: repo, Path: m.Path("run1234", "mem5678"), Branch: "dmn/run1234/writer", Base: "main"}
	if err := m.Create(spec); err != nil {
		t.Fatalf("Create: %v", err)
	}
	work := filepath.Join(spec.Path, "작업물.txt")
	if err := os.WriteFile(work, []byte("지우면 안 된다\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	res := m.Remove(RemoveSpec{Repo: repo, Path: spec.Path, Branch: spec.Branch})
	if res.Removed || res.Residue != ResidueDirty {
		t.Fatalf("dirty 는 보존 + 보고다: %+v", res)
	}
	if _, err := os.Stat(work); err != nil {
		t.Fatalf("사용자 작업이 사라졌다: %v", err)
	}
	if out := git(t, repo, "branch", "--list", spec.Branch); out == "" {
		t.Error("브랜치까지 지웠다")
	}
}

// FR-WKT-8/12: 트리는 clean 이지만 머지되지 않은 커밋이 있으면 브랜치가 남고,
// 그 사실이 잔여물로 보고된다.
func TestRemove_UnmergedBranchIsResidue(t *testing.T) {
	repo := tempRepo(t)
	m := tempManager(t)
	spec := Spec{Repo: repo, Path: m.Path("run1234", "mem5678"), Branch: "dmn/run1234/writer", Base: "main"}
	if err := m.Create(spec); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := os.WriteFile(filepath.Join(spec.Path, "새파일.txt"), []byte("a\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	git(t, spec.Path, "add", ".")
	git(t, spec.Path, "commit", "-m", "work")

	res := m.Remove(RemoveSpec{Repo: repo, Path: spec.Path, Branch: spec.Branch})
	if !res.Removed {
		t.Fatalf("clean 트리는 제거된다: %+v", res)
	}
	if res.Residue != ResidueBranchRetained {
		t.Fatalf("머지되지 않은 브랜치는 잔여물로 보고한다: %+v", res)
	}
	if out := git(t, repo, "branch", "--list", spec.Branch); out == "" {
		t.Error("-D 로 지워 버렸다 — 사용자 커밋이 사라진다")
	}
}

// TC-WKT-7 / FR-WKT-10: 위험 경로는 전부 거부한다.
func TestRemove_RejectsRiskyPaths(t *testing.T) {
	repo := tempRepo(t)
	m := tempManager(t)
	outside, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}

	risky := []struct {
		name string
		path string
	}{
		{"저장소 자신", repo},
		{"파일시스템 루트", "/"},
		{"빈 경로", ""},
		{"상대 경로", "worktrees/run/mem"},
		{"경로 이탈", filepath.Join(m.Root(), "..", "..", "etc")},
		{"루트 자신", m.Root()},
		{"등록 범위 밖", outside},
	}
	for _, c := range risky {
		res := m.Remove(RemoveSpec{Repo: repo, Path: c.path, Branch: "dmn/a/b"})
		if res.Removed || res.Residue != ResidueUnsafePath {
			t.Errorf("%s: 거부되어야 한다: %+v", c.name, res)
		}
	}
	if _, err := os.Stat(filepath.Join(repo, "README.md")); err != nil {
		t.Fatalf("저장소가 훼손됐다: %v", err)
	}
	if _, err := os.Stat(outside); err != nil {
		t.Fatalf("범위 밖 디렉터리가 삭제됐다: %v", err)
	}
}

// TC-WKT-8 / FR-WKT-11: 비git 디렉터리는 명확히 실패한다. none 으로 낮추지 않는다.
func TestResolve_NonRepoFails(t *testing.T) {
	m := tempManager(t)
	plain, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.Resolve(plain, ""); !errors.Is(err, ErrNotRepo) {
		t.Fatalf("want ErrNotRepo, got %v", err)
	}
	if _, err := m.Resolve("", ""); err == nil {
		t.Fatal("빈 cwd 는 실패해야 한다")
	}

	repo := tempRepo(t)
	got, err := m.Resolve(repo, "")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if got.Root != repo || got.Base != "main" {
		t.Fatalf("base 는 조정자 cwd 의 HEAD 다: %+v", got)
	}
	if _, err := m.Resolve(repo, "-x"); !errors.Is(err, ErrUnsafeArgument) {
		t.Fatal("- 로 시작하는 base 는 거부한다")
	}
	if _, err := m.Resolve(repo, "없는브랜치"); err == nil {
		t.Fatal("존재하지 않는 base 는 실패해야 한다")
	}
}

// TC-WKT-9 / FR-WKT-7: worktree 조작은 직렬화한다. 공용 common-dir 을 건드린다.
func TestOperations_AreSerialized(t *testing.T) {
	var cur, max int32
	m := New(filepath.Join(t.TempDir(), "worktrees"), WithRunner(func(dir string, args ...string) (string, error) {
		n := atomic.AddInt32(&cur, 1)
		defer atomic.AddInt32(&cur, -1)
		time.Sleep(2 * time.Millisecond) // 겹칠 기회를 준다 — 직렬화가 없으면 여기서 만난다
		for {
			old := atomic.LoadInt32(&max)
			if n <= old || atomic.CompareAndSwapInt32(&max, old, n) {
				break
			}
		}
		return "", nil
	}))

	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_ = m.Create(Spec{Repo: "/repo", Path: m.Path("run1234", "mem"+string(rune('a'+i))), Branch: "dmn/run1234/r", Base: "main"})
		}(i)
	}
	wg.Wait()
	if max > 1 {
		t.Fatalf("worktree 조작이 병렬로 돌았다 (최대 동시 %d)", max)
	}
}
