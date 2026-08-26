package write

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"testing"

	"dongminal/internal/webserver/domain/git/core"
	"dongminal/internal/webserver/domain/git/query"
)

// 묶음 N — 브랜치 조작 (GIT_SRS §3D.1 FR-GIT-155~159, 검증 V53·V54·V55).
//
// 목록은 여기서 다루지 않는다 — Refs 가 이미 답한다 (FR-GIT-147).

// B1 (FR-GIT-155·156): argv 의 순서와 조합. 순서를 고정해 두면 테스트가 **무엇을
// 실행하지 않았는가**까지 볼 수 있다.
func TestCheckoutArgs_Order(t *testing.T) {
	cases := []struct {
		name string
		o    CheckoutOpts
		want []string
	}{
		{"브랜치 전환", CheckoutOpts{Ref: "main"}, []string{"checkout", "main"}},
		{"detached", CheckoutOpts{Ref: "abc123", Detach: true}, []string{"checkout", "--detach", "abc123"}},
		{"강제", CheckoutOpts{Ref: "main", Force: true}, []string{"checkout", "--force", "main"}},
		{"생성 후 전환", CheckoutOpts{Create: "feat"}, []string{"checkout", "-b", "feat"}},
		{"시작점 지정 생성", CheckoutOpts{Create: "feat", Ref: "abc123"}, []string{"checkout", "-b", "feat", "abc123"}},
		{
			"원격 추적 생성",
			CheckoutOpts{Create: "feat", Track: "origin/feat"},
			[]string{"checkout", "-b", "feat", "--track", "origin/feat"},
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := CheckoutArgs(c.o)
			if err != nil {
				t.Fatalf("CheckoutArgs: %v", err)
			}
			if fmt.Sprint(got) != fmt.Sprint(c.want) {
				t.Fatalf("argv = %v, want %v", got, c.want)
			}
		})
	}
}

// B2 (FR-GIT-62·159): 인자로 넘기기 전에 거부되는 값들. 옵션처럼 생긴 ref 가
// 통과하면 git 이 그것을 옵션으로 읽는다.
func TestCheckoutArgs_Rejects(t *testing.T) {
	cases := []struct {
		name string
		o    CheckoutOpts
		want error
	}{
		{"대상 없음", CheckoutOpts{}, ErrCheckoutTarget},
		{"track 만", CheckoutOpts{Track: "origin/feat"}, ErrCheckoutTarget},
		{"track + ref", CheckoutOpts{Create: "f", Track: "origin/f", Ref: "main"}, ErrCheckoutTarget},
		{"- 로 시작하는 ref", CheckoutOpts{Ref: "-x"}, core.ErrRefName},
		{"범위 표현", CheckoutOpts{Ref: "a..b"}, core.ErrRefName},
		{"NUL 포함", CheckoutOpts{Ref: "a\x00b"}, core.ErrRefName},
		{"공백만", CheckoutOpts{Create: "  "}, core.ErrRefName},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if _, err := CheckoutArgs(c.o); !errors.Is(err, c.want) {
				t.Fatalf("err = %v, want %v", err, c.want)
			}
		})
	}
}

// B3 (V55, FR-GIT-97·157): `Force` 는 **파괴적으로 선언된다** — 워킹 트리의 변경을
// 버린다. 선언이 실행 기록에 남지 않으면 감사할 수 없다 (I5).
func TestCheckout_ForceDeclaredDestructive(t *testing.T) {
	ctx := context.Background()
	for _, force := range []bool{false, true} {
		f := &writeFake{}
		s := core.New(core.WithRunner(headRunner), core.WithWriteRunner(f.runner))
		if _, err := Checkout(s, ctx, "/tmp/repo", CheckoutOpts{Ref: "main", Force: force}); err != nil {
			t.Fatalf("Checkout(force=%v): %v", force, err)
		}
		recs := s.Records(0)
		if len(recs) == 0 {
			t.Fatalf("force=%v: 기록이 없다", force)
		}
		if got := recs[len(recs)-1].Destructive; got != force {
			t.Fatalf("force=%v: Destructive = %v", force, got)
		}
	}
}

// B4 (V54, FR-GIT-156): 같은 이름의 로컬 브랜치가 있으면 **실행하지 않는다.**
// 클라이언트만 막으면 API 직접 호출이 우회하고, git 에 맡기면 사용자에게 줄
// 선택지를 만들 수 없다.
func TestCheckout_RemoteBranchNameConflict(t *testing.T) {
	repo := tempRepoWithBranch(t, "feat")
	f := &writeFake{}
	s := core.New(core.WithRunner(realReader(t, repo)), core.WithWriteRunner(f.runner))

	_, err := Checkout(s, context.Background(), repo, CheckoutOpts{Create: "feat", Track: "origin/feat"})
	if !errors.Is(err, ErrBranchExists) {
		t.Fatalf("err = %v, want ErrBranchExists", err)
	}
	if len(f.argvs) != 0 {
		t.Fatalf("거부됐는데 실행됐다: %v", f.argvs)
	}
}

// B5 (V54, FR-GIT-156): 이름이 비어 있으면 원격 브랜치 checkout 이 실제로 로컬을
// 만들고 추적을 설정한다. argv 만 보면 그 명령이 성공하는지 알 수 없다.
func TestCheckout_RemoteBranchCreatesTracking(t *testing.T) {
	repo := tempRepoWithRemote(t)
	s := core.New()
	ctx := context.Background()

	if _, err := Checkout(s, ctx, repo, CheckoutOpts{Create: "feat", Track: "origin/feat"}); err != nil {
		t.Fatalf("Checkout: %v", err)
	}
	st, err := query.StatusOf(s, ctx, repo)
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	if st.Branch != "feat" {
		t.Fatalf("branch = %q, want feat", st.Branch)
	}
	if !st.HasUpstream || st.Upstream != "origin/feat" {
		t.Fatalf("upstream = %q (has=%v), want origin/feat", st.Upstream, st.HasUpstream)
	}
}

// B9 (FR-GIT-158): 생성은 checkout 여부로 명령이 갈린다. 시작점은 마지막 위치
// 인자다.
func TestBranchCreate_Args(t *testing.T) {
	repo := tempRepo(t)
	ctx := context.Background()
	cases := []struct {
		name string
		o    BranchCreateOpts
		want []string
	}{
		{"생성만", BranchCreateOpts{Name: "feat"}, []string{"branch", "feat"}},
		{"생성 후 전환", BranchCreateOpts{Name: "feat", Checkout: true}, []string{"checkout", "-b", "feat"}},
		{"시작점 지정", BranchCreateOpts{Name: "feat", StartRef: "HEAD~0"}, []string{"branch", "feat", "HEAD~0"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := &writeFake{}
			s := core.New(core.WithRunner(realReader(t, repo)), core.WithWriteRunner(f.runner))
			if _, err := BranchCreate(s, ctx, repo, c.o); err != nil {
				t.Fatalf("BranchCreate: %v", err)
			}
			if len(f.argvs) != 1 || fmt.Sprint(f.argvs[0]) != fmt.Sprint(c.want) {
				t.Fatalf("argv = %v, want %v", f.argvs, c.want)
			}
		})
	}
}

// B10 (FR-GIT-158·159): 이름 규칙 위반과 이름 충돌은 **실행 전에** 거부된다.
func TestBranchCreate_RejectsBeforeExecuting(t *testing.T) {
	repo := tempRepoWithBranch(t, "feat")
	ctx := context.Background()
	cases := []struct {
		name string
		o    BranchCreateOpts
		want error
	}{
		{"이름 규칙 위반", BranchCreateOpts{Name: "bad name"}, core.ErrRefName},
		{"이미 있는 이름", BranchCreateOpts{Name: "feat"}, ErrBranchExists},
		{"- 로 시작하는 시작점", BranchCreateOpts{Name: "new", StartRef: "-x"}, core.ErrRefName},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := &writeFake{}
			s := core.New(core.WithRunner(realReader(t, repo)), core.WithWriteRunner(f.runner))
			if _, err := BranchCreate(s, ctx, repo, c.o); !errors.Is(err, c.want) {
				t.Fatalf("err = %v, want %v", err, c.want)
			}
			if len(f.argvs) != 0 {
				t.Fatalf("거부됐는데 실행됐다: %v", f.argvs)
			}
		})
	}
}

// B11 (FR-GIT-156): 선택지는 **서버가 준다.** 클라이언트가 목록을 복제하면 서버가
// 선택지를 늘려도 그것을 보이지 못한다.
func TestBranchConflictOptions_Enumerated(t *testing.T) {
	want := []string{BranchConflictCheckout, BranchConflictRename, BranchConflictCancel}
	if fmt.Sprint(BranchConflictOptions) != fmt.Sprint(want) {
		t.Fatalf("options = %v, want %v", BranchConflictOptions, want)
	}
}

// realReader 는 읽기만 실제 git 으로 보내는 Runner 다. 쓰기를 격리한 채로 이름
// 검사·존재 확인을 진짜로 하게 한다.
func realReader(t *testing.T, repo string) core.Runner {
	t.Helper()
	gitPath(t)
	real := core.New()
	return func(ctx context.Context, dir string, args []string) (core.Output, error) {
		return real.Exec(ctx, dir, args...)
	}
}

// tempRepoWithBranch 는 커밋 하나 + 추가 브랜치 하나인 저장소다.
func tempRepoWithBranch(t *testing.T, branch string) string {
	t.Helper()
	repo := tempRepo(t)
	gitRun(t, repo, "branch", branch)
	return repo
}

// tempRepoWithRemote 는 bare 원격 + `origin/feat` 만 있고 로컬 `feat` 는 없는
// 저장소다 (픽스처의 with-remote 와 같은 정신) — FR-GIT-156 이 딛는 상태다.
func tempRepoWithRemote(t *testing.T) string {
	t.Helper()
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatalf("EvalSymlinks: %v", err)
	}
	bare := filepath.Join(base, "remote.git")
	gitRun(t, base, "init", "-q", "--bare", bare)

	repo := tempRepo(t)
	gitRun(t, repo, "remote", "add", "origin", bare)
	gitRun(t, repo, "checkout", "-q", "-b", "feat")
	gitRun(t, repo, "push", "-q", "origin", "feat")
	gitRun(t, repo, "checkout", "-q", "main")
	gitRun(t, repo, "branch", "-D", "feat")
	gitRun(t, repo, "fetch", "-q", "origin")
	return repo
}
