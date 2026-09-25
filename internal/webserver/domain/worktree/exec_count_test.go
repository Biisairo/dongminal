package worktree

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"dongminal/internal/shared/gittest"
	"dongminal/internal/webserver/domain/git/core"
)

// OPTIMIZE_REFACTOR_SRS FR-OPT-7-2 (DOM-17): 성공한 git 이 stderr 에 경고 한 줄을
// 내도 깨끗한 트리는 dirty 가 아니다. 판정은 stdout 만 읽는다.
func TestIsDirty_IgnoresStderrOnSuccess(t *testing.T) {
	svc := core.New(core.WithWriteRunner(func(_ context.Context, _ string, _ []string, _ string) (core.Output, error) {
		return core.Output{Stderr: "warning: could not open directory 'x/': Permission denied\n"}, nil
	}))
	m := New(t.TempDir(), WithService(svc))
	dirty, err := m.isDirty(context.Background(), absRepo)
	if err != nil {
		t.Fatalf("isDirty: %v", err)
	}
	if dirty {
		t.Fatal("stderr 경고만으로 dirty 로 판정했다")
	}
}

// FR-OPT-7-3 (DOM-24): base 를 주지 않은 Resolve 는 rev-parse 를 **한 번** 부른다
// (이전: --show-toplevel · --abbrev-ref HEAD, detached 면 rev-parse HEAD 까지 2~3회).
func TestResolve_OneRevParse(t *testing.T) {
	repo := gittest.Repo(t)
	m := New(t.TempDir(), WithService(core.New()))
	c := gittest.Count(t)

	got, err := m.Resolve(context.Background(), repo, "")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if got.Root != repo || got.Base != "main" {
		t.Fatalf("Resolve = %+v", got)
	}
	if n := c.N(); n != 1 {
		t.Fatalf("git %d 회 (%q), want 1", n, c.Calls())
	}

	// detached 면 base 는 커밋이다 — 그래도 한 번이다.
	gittest.Run(t, repo, "checkout", "-q", "--detach")
	sha := gittest.Run(t, repo, "rev-parse", "HEAD")
	c.Reset()
	got, err = m.Resolve(context.Background(), repo, "")
	if err != nil || got.Base != sha {
		t.Fatalf("detached Resolve = %+v, %v; want base %s", got, err, sha)
	}
	if n := c.N(); n != 1 {
		t.Fatalf("detached: git %d 회 (%q), want 1", n, c.Calls())
	}

	// base 를 주면 toplevel 과 검증을 한 번에 묻는다 (이전: 2회).
	c.Reset()
	got, err = m.Resolve(context.Background(), repo, "main")
	if err != nil || got.Base != "main" || got.Root != repo {
		t.Fatalf("base Resolve = %+v, %v", got, err)
	}
	if n := c.N(); n != 1 {
		t.Fatalf("base: git %d 회 (%q), want 1", n, c.Calls())
	}
}

// 실패 갈래는 종전 판정 그대로다 — 저장소 아님 · HEAD 없음 · base 없음.
func TestResolve_FailureKindsPreserved(t *testing.T) {
	m := New(t.TempDir(), WithService(core.New()))
	ctx := context.Background()

	notRepo := t.TempDir()
	if _, err := m.Resolve(ctx, notRepo, ""); !errors.Is(err, ErrNotRepo) {
		t.Fatalf("저장소 아님: %v", err)
	}
	unborn := gittest.Init(t)
	if _, err := m.Resolve(ctx, unborn, ""); !errors.Is(err, ErrNotRepo) {
		t.Fatalf("HEAD 없음: %v", err)
	}
	repo := gittest.Repo(t)
	if _, err := m.Resolve(ctx, repo, "nope"); !errors.Is(err, ErrUnsafeArgument) {
		t.Fatalf("base 없음: %v", err)
	}
	if _, err := m.Resolve(ctx, notRepo, "main"); !errors.Is(err, ErrNotRepo) {
		t.Fatalf("base 를 준 저장소 아님: %v", err)
	}
	// 하위 디렉터리에서 물어도 root 는 toplevel 이다.
	sub := filepath.Join(repo, "sub")
	if err := os.Mkdir(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	if got, err := m.Resolve(ctx, sub, ""); err != nil || got.Root != repo {
		t.Fatalf("하위 디렉터리 Resolve = %+v, %v", got, err)
	}
}

// FR-OPT-7-5 (DOM-31): validRef 는 core.CheckRefArg 가 막는 것을 전부 막고, 그 위에
// 이 표면의 규칙을 얹는다. 사유는 이 패키지의 것이다 (apierr 가 코드를 정한다).
func TestValidRef_SupersetOfCheckRefArg(t *testing.T) {
	for _, v := range []string{"", " ", "-x", "a\x00b", "a..b", "x.lock", "/a", "a/", "a//b", "a b", "a~1", "a^", "a:b", "a;b"} {
		err := validRef(v)
		if !errors.Is(err, ErrUnsafeArgument) {
			t.Errorf("validRef(%q) = %v, want ErrUnsafeArgument", v, err)
		}
		if errors.Is(err, core.ErrRefName) {
			t.Errorf("validRef(%q) 가 core 의 사유를 드러냈다 — apierr 의 코드가 바뀐다", v)
		}
	}
	for _, v := range []string{"main", "feat/x", "v1.2", "dmn/run1234/a"} {
		if err := validRef(v); err != nil {
			t.Errorf("validRef(%q) = %v", v, err)
		}
		if err := core.CheckRefArg("ref", v); err != nil {
			t.Errorf("CheckRefArg(%q) = %v", v, err)
		}
	}
}

// FR-OPT-7-3: 합친 rev-parse 의 출력에 빈 줄이 끼어도(옛 git·CRLF) 줄 수 판정이
// 흔들리지 않는다. 빈 줄은 답이 아니므로 세지 않는다.
func TestResolve_TolerantOfBlankLines(t *testing.T) {
	for _, out := range []string{
		absRepo + "\n\nabc123\nmain",
		absRepo + "\r\nabc123\r\n\r\nmain",
	} {
		m := New(t.TempDir(), WithRunner(func(context.Context, string, ...string) (string, error) { return out, nil }))
		got, err := m.Resolve(context.Background(), absRepo, "")
		if err != nil || got.Root != absRepo || got.Base != "main" {
			t.Fatalf("out=%q: Resolve = %+v, %v", out, got, err)
		}
	}
}
