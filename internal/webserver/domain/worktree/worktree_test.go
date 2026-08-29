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
//
// **동작 변경(FR-GIT-242)**: 이전에는 Branch 가 비면 항상 ErrUnsafeArgument 였다.
// 이제는 Branch 가 비어도 Base 가 있으면 "새 브랜치 없이 체크아웃"이라는 유효한
// 요청이다(TestCreate_ChecksOutExistingRefWithoutNewBranch 가 그 성공 경로를
// 본다) — 그래서 여기서는 **Branch·Base 가 둘 다 빈** 경우로 케이스를 바꿨다.
// 그 경우는 지금도 거부된다: 체크아웃할 대상도, 만들 브랜치도 없기 때문이다.
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
		{"branch·base 둘 다 빔", Spec{Repo: repo, Path: good, Branch: "", Base: ""}},
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
//
// V153 (FR-WKT-13): 사용자 worktree 영역(`$DONGMINAL_HOME/git-worktrees`)은 Run
// 격리 영역(`$DONGMINAL_HOME/worktrees`)의 형제다. Run 의 Manager 는 root 아래만
// 다루므로 그 형제 경로에는 구조적으로 닿지 않는다 — checkPath 가 "등록 범위 밖"과
// 같은 사유로 거부한다.
func TestRemove_RejectsRiskyPaths(t *testing.T) {
	repo := tempRepo(t)
	m := tempManager(t)
	outside, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	// FR-WKT-13: m.Root() 는 <home>/worktrees 다. 사용자 영역은 <home>/git-worktrees
	// 이며 형제 디렉터리다 — outside(순수 무관 디렉터리)와는 다른 케이스로, "루트와
	// 이름이 닮았지만 실제로는 형제"라는 실수를 별도로 잡는다.
	userArea := filepath.Join(filepath.Dir(m.Root()), "git-worktrees", "repo", "feature")

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
		{"사용자 worktree 영역(FR-WKT-13, V153)", userArea},
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

// V163 (FR-WKT-13 전제): 데이터 디렉터리 자체가 symlink 경유여도 소유 판정·제거가
// 동작한다.
//
// `git worktree list` 는 항상 realpath 를 보고하는데(아래에서 List 로 직접
// 확인한다), New 가 심볼릭 링크를 풀지 않으면 checkPath 의 문자열 prefix 판정이
// 영원히 어긋난다 — macOS 의 `/tmp`→`/private/tmp` 처럼 데이터 디렉터리 자체가
// symlink 경유인 흔한 경우에, 사용자 것도 Run 것도 전부 영역 밖으로 보이고
// 정당한 제거가 unsafe_path 로 거부된다(다른 팀원이 e2e 로 잡은 결함).
//
// 합성 문자열로는 이 결함이 재현되지 않는다 — 실제 심볼릭 링크를 만든다.
func TestNew_ResolvesSymlinkedRoot(t *testing.T) {
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	realDir := filepath.Join(base, "actual")
	if err := os.MkdirAll(realDir, 0o755); err != nil {
		t.Fatal(err)
	}
	linkDir := filepath.Join(base, "link")
	if err := os.Symlink(realDir, linkDir); err != nil {
		t.Skip("이 환경은 심볼릭 링크를 만들 수 없다")
	}

	// 심링크를 지나는 경로로 Manager 를 만든다 — "worktrees" 는 아직 없는
	// 하위 디렉터리다(첫 실행과 같다, Create 가 비로소 MkdirAll 한다).
	m := New(filepath.Join(linkDir, "worktrees"))
	wantRoot := filepath.Join(realDir, "worktrees")
	if m.Root() != wantRoot {
		t.Fatalf("Root() 가 realpath 가 아니다: got %q want %q", m.Root(), wantRoot)
	}

	repo := tempRepo(t)
	spec := Spec{Repo: repo, Path: m.Path("run1234", "mem5678"), Branch: "dmn/run1234/writer", Base: "main"}
	if err := m.Create(spec); err != nil {
		t.Fatalf("Create: %v", err)
	}

	// 전제 확인: git worktree list 가 실제로 realpath 를 보고하는가. 이게 깨지면
	// 이 테스트 전체가 무의미하다.
	entries, err := m.List(repo)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	var reported string
	for _, e := range entries {
		if e.Path != repo {
			reported = e.Path
		}
	}
	if reported != spec.Path {
		t.Fatalf("git worktree list 가 realpath 를 안 준다 — 이 테스트의 전제가 깨졌다: got %q want %q", reported, spec.Path)
	}

	// gone() 도 같은 realpath 정합성에 기댄다(List 를 그대로 쓰므로 원리상
	// List 가 맞으면 같이 맞지만, checkPath·Remove 의 내부 분기 구조와 무관하게
	// 직접 확인한다 — Remove 는 정상 삭제 시 gone() 을 안 거치는 경로도 있다).
	if m.gone(repo, spec.Path) {
		t.Fatalf("gone() 이 아직 있는 worktree(%q) 를 사라졌다고 본다", spec.Path)
	}

	// symlink 를 지나는 root 아래의 정당한 worktree 가 제거된다 — checkPath 가
	// 거부하면(수정 전 결함) Residue 가 unsafe-path 로 남는다.
	res := m.Remove(RemoveSpec{Repo: repo, Path: spec.Path, Branch: spec.Branch})
	if !res.Removed || res.Residue != "" {
		t.Fatalf("symlink 경유 root 아래의 정당한 worktree 가 거부됐다: %+v", res)
	}

	if !m.gone(repo, spec.Path) {
		t.Fatalf("gone() 이 지워진 worktree(%q) 를 여전히 있다고 본다", spec.Path)
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
			_ = m.Create(Spec{Repo: absRepo, Path: m.Path("run1234", "mem"+string(rune('a'+i))), Branch: "dmn/run1234/r", Base: "main"})
		}(i)
	}
	wg.Wait()
	if max > 1 {
		t.Fatalf("worktree 조작이 병렬로 돌았다 (최대 동시 %d)", max)
	}
}

// V157 (FR-WKT-7 개정, D13): 같은 저장소를 대상으로 하는 **두 Manager 인스턴스**의
// 생성·제거는 직렬화되어야 한다. 지금 mu 는 인스턴스 필드(worktree.go:55)이고
// FR-WKT-7 의 근거("git worktree 가 저장소의 공용 common-dir 를 건드린다")는
// **저장소**를 말하는데 구현은 **인스턴스**를 잠근다 — 그래서 이 테스트는 지금
// 실패해야 한다(RED). FR-WKT-7 이 저장소 단위 직렬화로 개정 구현되면 통과한다.
//
// time.Sleep 으로 "겹칠 기회"를 만들지 않는다(부하에서 흔들린다). 대신 러너가
// 채널로 막혀 확정적으로 임계구역에 머문다 — 직렬화가 없으면 두 번째 호출이 반드시
// 그 사이에 들어온다. 직렬화가 이미 있다면(미래) 두 번째는 짧은 상한 안에 들어오지
// 않고, 첫 번째를 풀어준 뒤에야 뒤이어 들어온다 — 그때도 데드락 없이 끝난다.
func TestOperations_SerializeAcrossManagersForSameRepo(t *testing.T) {
	var repo = absRepo
	var cur, max int32
	release := make(chan struct{})
	entered := make(chan struct{}, 2)

	// Create 는 git 을 여러 번 부른다(worktree add, push.autoSetupRemote 설정,
	// base 기록 — worktree.go:194,197,201). 임계구역 관찰은 실제 저장소 변경이
	// 일어나는 "worktree add" 호출 하나로만 좁힌다 — 그러지 않으면 부수 config
	// 호출까지 채널을 막아서 버퍼가 넘친다.
	runner := func(dir string, args ...string) (string, error) {
		if len(args) < 2 || args[0] != "worktree" {
			return "", nil
		}
		n := atomic.AddInt32(&cur, 1)
		for {
			old := atomic.LoadInt32(&max)
			if n <= old || atomic.CompareAndSwapInt32(&max, old, n) {
				break
			}
		}
		entered <- struct{}{}
		<-release
		atomic.AddInt32(&cur, -1)
		return "", nil
	}

	// FR-WKT-13 처럼 서로 다른 root 를 가진 두 Manager — Run 영역용 하나, 사용자
	// 영역용 하나를 흉내낸다. 대상 저장소(repo)는 같다.
	m1 := New(filepath.Join(t.TempDir(), "worktrees"), WithRunner(runner))
	m2 := New(filepath.Join(t.TempDir(), "git-worktrees"), WithRunner(runner))

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		_ = m1.Create(Spec{Repo: repo, Path: m1.Path("run1234", "a"), Branch: "dmn/run1234/a", Base: "main"})
	}()
	go func() {
		defer wg.Done()
		_ = m2.Create(Spec{Repo: repo, Path: m2.Path("run1234", "b"), Branch: "dmn/run1234/b", Base: "main"})
	}()

	<-entered
	select {
	case <-entered:
		// 상한 안에 둘 다 임계구역에 있었다 — 직렬화되지 않았다.
	case <-time.After(200 * time.Millisecond):
		// 두 번째가 아직 안 왔다 — 직렬화됐을 수 있다. 첫 번째를 풀어 마저 재확인한다.
	}
	close(release)
	wg.Wait()

	if max > 1 {
		t.Fatalf("서로 다른 Manager 인스턴스가 같은 저장소에서 동시에 실행됐다 (최대 동시 %d) — FR-WKT-7(개정) 미구현, D13 근거", max)
	}
}

// V160 (FR-WKT-7 개정): 잠금 키는 Manager 안에서 정규화된다 — 호출자가 같은
// 저장소를 다른 표기(트레일링 슬래시)로 줘도 같은 잠금을 문다. Resolve 가 항상
// canonical 값을 주는 프로덕션 경로에서는 안 드러나지만, 그 관례에 기대지 않는다는
// 것을 여기서 직접 확인한다.
func TestOperations_SerializeSameRepoDifferentSpelling(t *testing.T) {
	var cur, max int32
	release := make(chan struct{})
	entered := make(chan struct{}, 2)

	runner := func(dir string, args ...string) (string, error) {
		if len(args) < 2 || args[0] != "worktree" {
			return "", nil
		}
		n := atomic.AddInt32(&cur, 1)
		for {
			old := atomic.LoadInt32(&max)
			if n <= old || atomic.CompareAndSwapInt32(&max, old, n) {
				break
			}
		}
		entered <- struct{}{}
		<-release
		atomic.AddInt32(&cur, -1)
		return "", nil
	}

	m := New(filepath.Join(t.TempDir(), "worktrees"), WithRunner(runner))

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		_ = m.Create(Spec{Repo: absRepo, Path: m.Path("run1234", "a"), Branch: "dmn/run1234/a", Base: "main"})
	}()
	go func() {
		defer wg.Done()
		// 같은 저장소, 트레일링 슬래시만 다른 표기.
		_ = m.Create(Spec{Repo: "/repo/", Path: m.Path("run1234", "b"), Branch: "dmn/run1234/b", Base: "main"})
	}()

	<-entered
	select {
	case <-entered:
	case <-time.After(200 * time.Millisecond):
	}
	close(release)
	wg.Wait()

	if max > 1 {
		t.Fatalf("같은 저장소를 다른 표기로 줬는데 잠금이 갈라졌다 (최대 동시 %d) — 잠금 키가 정규화되지 않았다", max)
	}
}

// V159 (FR-WKT-13): 베이스이름이 같고 루트가 다른 두 저장소의 <repo> 버킷이
// 갈라진다. 같은 저장소를 다른 표기로 줘도 같은 버킷이다.
func TestRepoBucket_SeparatesSameBasenameDifferentRoots(t *testing.T) {
	a := RepoBucket("/home/x/app")
	b := RepoBucket("/home/y/app")
	if a == b {
		t.Fatalf("베이스이름이 같은 서로 다른 저장소가 같은 버킷을 쓴다: %q", a)
	}
	if !strings.HasPrefix(a, "app-") || !strings.HasPrefix(b, "app-") {
		t.Fatalf("버킷이 베이스이름으로 시작하지 않는다 — FR-GIT-242 의 '경로를 보인다'가 사람이 읽을 수 없다: a=%q b=%q", a, b)
	}
	// 같은 저장소, 트레일링 슬래시만 다른 표기 — 같은 버킷이어야 한다.
	if RepoBucket("/home/x/app") != RepoBucket("/home/x/app/") {
		t.Fatal("같은 저장소를 다른 표기로 줬는데 버킷이 갈라졌다")
	}
}

// FR-GIT-240/246: List 는 main worktree 를 포함해 전부를 준다. gone() 이 같은
// 함수를 쓴다는 사실은 소스 리뷰로 이미 확인했다 — 여기서는 List 자체의 파싱을
// 본다(분리·detached·branch 셋 다).
func TestList_IncludesMainAndParsesEntries(t *testing.T) {
	repo := tempRepo(t)
	m := tempManager(t)
	spec := Spec{Repo: repo, Path: m.Path("run1234", "mem5678"), Branch: "dmn/run1234/writer", Base: "main"}
	if err := m.Create(spec); err != nil {
		t.Fatalf("Create: %v", err)
	}
	// detach 된 세 번째 worktree 도 하나 만든다. git 이 물리 경로로 답하므로(맥OS
	// /var → /private/var) 심볼릭 링크를 미리 푼다 — tempRepo 와 같은 이유다.
	detachedParent, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	detachedPath := filepath.Join(detachedParent, "detached")
	if _, err := m.git(repo, "worktree", "add", "--detach", detachedPath, "main"); err != nil {
		t.Fatalf("detach worktree 준비 실패: %v", err)
	}

	entries, err := m.List(repo)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	byPath := map[string]Entry{}
	for _, e := range entries {
		byPath[e.Path] = e
	}
	if _, ok := byPath[repo]; !ok {
		t.Fatalf("main worktree 가 목록에 없다: %+v", entries)
	}
	linked, ok := byPath[spec.Path]
	if !ok || linked.Branch != spec.Branch || linked.Detached {
		t.Fatalf("연결된 worktree 항목이 어긋난다: %+v", linked)
	}
	det, ok := byPath[detachedPath]
	if !ok || !det.Detached || det.Branch != "" {
		t.Fatalf("detached worktree 항목이 어긋난다: %+v", det)
	}
	if !byPath[repo].Main {
		t.Fatalf("main worktree 항목에 Main 이 서지 않았다: %+v", byPath[repo])
	}
	if linked.Main || det.Main {
		t.Fatalf("main 이 아닌 항목에 Main 이 섰다: linked=%+v det=%+v", linked, det)
	}
}

// V162: main worktree 판정은 porcelain 출력의 **순서**에서 나며, List 를 무엇의
// 디렉터리에서 호출했는지(조회 경로)를 따라가지 않는다.
//
// **판정문**: 링크드 worktree 를 대상으로 List 를 다시 호출해도(그 worktree 를
// 활성 리포로 연 뒤 다시 조회하는 것과 같다) main 배지는 원래 main worktree 에
// 그대로 남는다.
//
// 예전엔 main 을 "조회에 쓴 경로와 같다"로 판정했다 — 그러면 사용자가 Worktrees
// 탭에서 어떤 worktree 를 "Open"(활성 리포로 전환)한 뒤 다시 목록을 보면 main
// 배지가 그 worktree 로 옮겨갔다. 이 테스트는 그 결함을 고정한다.
func TestList_MainStaysOnOriginRegardlessOfQueryPath(t *testing.T) {
	repo := tempRepo(t)
	m := tempManager(t)
	spec := Spec{Repo: repo, Path: m.Path("run1234", "mem5678"), Branch: "dmn/run1234/writer", Base: "main"}
	if err := m.Create(spec); err != nil {
		t.Fatalf("Create: %v", err)
	}

	// repo 자신에서 조회 — main 은 repo 다.
	entries, err := m.List(repo)
	if err != nil {
		t.Fatalf("List(repo): %v", err)
	}
	assertMainIs(t, entries, repo)

	// **링크드 worktree 의 경로에서** 같은 저장소를 다시 조회한다 — git worktree
	// list 는 어느 worktree 디렉터리에서 불러도 같은 전체 목록을 준다(공용
	// 관리 영역을 읽으므로). main 배지는 여전히 repo 에 있어야 한다 — spec.Path
	// (지금 조회에 쓴 경로) 로 옮겨가면 안 된다.
	entries, err = m.List(spec.Path)
	if err != nil {
		t.Fatalf("List(spec.Path): %v", err)
	}
	assertMainIs(t, entries, repo)
}

func assertMainIs(t *testing.T, entries []Entry, wantMainPath string) {
	t.Helper()
	for _, e := range entries {
		if e.Path == wantMainPath && !e.Main {
			t.Fatalf("%s 가 main 이어야 하는데 아니다: %+v", wantMainPath, entries)
		}
		if e.Path != wantMainPath && e.Main {
			t.Fatalf("%s 가 아닌 %s 에 main 이 섰다: %+v", wantMainPath, e.Path, entries)
		}
	}
}

// FR-GIT-242: Branch 가 비면 새 브랜치 없이 Base 를 그대로 체크아웃한다.
func TestCreate_ChecksOutExistingRefWithoutNewBranch(t *testing.T) {
	repo := tempRepo(t)
	m := tempManager(t)
	// main 은 이미 repo 자신에 체크아웃돼 있어 다른 worktree 가 그대로 쓸 수 없다
	// (git 이 "already used by worktree" 로 거부한다) — 아무 데도 체크아웃되지 않은
	// 별도 브랜치를 대상 ref 로 쓴다.
	git(t, repo, "branch", "other")
	path := m.Path("bucket", "existing-ref")

	if err := m.Create(Spec{Repo: repo, Path: path, Base: "other"}); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if got := git(t, path, "rev-parse", "--abbrev-ref", "HEAD"); got != "other" {
		t.Fatalf("other 를 그대로 체크아웃해야 한다: %q", got)
	}
	// 새 브랜치를 만들지 않았다 — dmn/ 접두 브랜치가 하나도 없어야 한다.
	if out := git(t, repo, "branch", "--list", "dmn/*"); out != "" {
		t.Fatalf("새 브랜치가 생겼다: %q", out)
	}
}

// FR-WTP-3 — 파서를 빠져나온 경로는 언제나 OS 형태다.
//
// Windows 의 git 은 `C:/Users/x` 처럼 낸다. 그 형태가 그대로 나가면 `gone` 의
// 완전 일치 비교와 `gitWorktreeOwner` 의 접두사 판정이 어긋난다 — 오류가 아니라
// **조용한 오판**이라 실기에서 늦게 드러난다. 불변식을 파서에 못박는다.
func TestParseWorktreeList_NormalizesPaths(t *testing.T) {
	raw := strings.Join([]string{
		"worktree C:/Users/x/repo",
		"HEAD 1111111111111111111111111111111111111111",
		"branch refs/heads/main",
		"",
		"worktree /srv/repo/../repo/wt",
		"HEAD 2222222222222222222222222222222222222222",
		"detached",
		"",
	}, "\n")

	entries := parseWorktreeList(raw)
	if len(entries) != 2 {
		t.Fatalf("레코드 수 = %d, want 2: %+v", len(entries), entries)
	}
	for _, e := range entries {
		if e.Path == "" {
			t.Fatal("빈 경로")
		}
		if got := filepath.Clean(e.Path); got != e.Path {
			t.Errorf("정규화되지 않은 경로가 파서를 빠져나왔다: %q (Clean=%q)", e.Path, got)
		}
	}
	// 첫 레코드가 main 이라는 기존 불변식은 그대로다 (V162).
	if !entries[0].Main || entries[1].Main {
		t.Errorf("main 판정이 어긋났다: %+v", entries)
	}
	if entries[0].Branch != "main" || !entries[1].Detached {
		t.Errorf("레코드 해석이 어긋났다: %+v", entries)
	}
}
