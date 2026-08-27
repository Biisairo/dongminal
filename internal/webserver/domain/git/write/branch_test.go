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

// ── 묶음 B — 브랜치 동작 (GIT_ACTIONS_SRS §3.2 FR-GIT-253~259 · §3.5 FR-GIT-268) ──
//
// 검증 V171·V172·V174 가 여기 산다: `…Args` 는 git 을 돌리지 않고, 파괴 선언은
// **옵션에서 파생하며**, ref 를 지우는 동작의 hint 에는 **지우기 전 oid** 가 있다.

// B20 (FR-GIT-253): rename 은 `-m` 하나뿐이다. `-M` 을 만들 자리가 없다 —
// 기존 ref 를 덮는 것은 이름 변경이 아니다.
func TestBranchRenameArgs(t *testing.T) {
	got, err := BranchRenameArgs(BranchRenameOpts{From: "old", To: "new"})
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	want := []string{"branch", "-m", "old", "new"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("argv = %v, want %v", got, want)
	}
	for _, o := range []BranchRenameOpts{
		{From: "", To: "new"}, {From: "old", To: ""},
		{From: "-x", To: "new"}, {From: "old", To: "a..b"},
		{From: "same", To: "same"},
	} {
		if argv, err := BranchRenameArgs(o); err == nil {
			t.Fatalf("%+v 가 거부되지 않았다: %v", o, argv)
		}
	}
}

// B21 (FR-GIT-254): `-d` 가 기본이고 `-D` 는 명시할 때만이다. **다중 선택 일괄
// 삭제는 `-d` 로만** — 한 번의 확인으로 여러 개를 강제 삭제하는 자리를 만들지 않는다.
func TestBranchDeleteArgs(t *testing.T) {
	cases := []struct {
		opts BranchDeleteOpts
		want []string
	}{
		{BranchDeleteOpts{Names: []string{"feat"}}, []string{"branch", "-d", "feat"}},
		{BranchDeleteOpts{Names: []string{"feat"}, Force: true}, []string{"branch", "-D", "feat"}},
		{BranchDeleteOpts{Names: []string{"a", "b"}}, []string{"branch", "-d", "a", "b"}},
	}
	for _, c := range cases {
		got, err := BranchDeleteArgs(c.opts)
		if err != nil {
			t.Fatalf("%+v: %v", c.opts, err)
		}
		if fmt.Sprint(got) != fmt.Sprint(c.want) {
			t.Fatalf("argv = %v, want %v", got, c.want)
		}
	}
	for _, o := range []BranchDeleteOpts{
		{Names: nil},
		{Names: []string{}},
		{Names: []string{"-x"}},
		{Names: []string{"a", "b"}, Force: true}, // 일괄 강제 삭제는 없다
	} {
		if argv, err := BranchDeleteArgs(o); err == nil {
			t.Fatalf("%+v 가 거부되지 않았다: %v", o, argv)
		} else if !errors.Is(err, ErrBranchDelete) && !errors.Is(err, core.ErrRefName) {
			t.Fatalf("%+v 의 오류가 분류되지 않았다: %v", o, err)
		}
	}
}

// B22 (FR-GIT-250.2 / V174): 삭제 hint 는 **지우기 전 oid** 로 만든 되살릴 명령이다.
// 안내문만 남기면 되살릴 수 없다.
func TestBranchDelete_HintCarriesPreDeleteOid(t *testing.T) {
	repo := tempRepoWithBranch(t, "feat")
	f := &writeFake{}
	s := core.New(core.WithRunner(realReader(t, repo)), core.WithWriteRunner(f.runner))
	ctx := context.Background()

	oid, err := query.BranchOid(s, ctx, repo, "feat")
	if err != nil {
		t.Fatalf("BranchOid: %v", err)
	}
	if _, plan, err := BranchDelete(s, ctx, repo, BranchDeleteOpts{Names: []string{"feat"}}); err != nil {
		t.Fatalf("BranchDelete: %v (plan=%+v)", err, plan)
	} else if len(plan.Oids) != 1 || plan.Oids[0] != oid {
		t.Fatalf("plan.Oids = %v, want [%s]", plan.Oids, oid)
	}
	hints := s.Hints(0)
	if len(hints) != 1 {
		t.Fatalf("hint 가 %d개다: %+v", len(hints), hints)
	}
	h := hints[0]
	if h.Action != core.ActionBranchDelete {
		t.Fatalf("Action = %q, want %q", h.Action, core.ActionBranchDelete)
	}
	if len(h.Values) != 1 || h.Values[0] != oid {
		t.Fatalf("Values = %v, want [%s]", h.Values, oid)
	}
	if want := "git branch feat " + oid; h.Command != want {
		t.Fatalf("Command = %q, want %q", h.Command, want)
	}
}

// B23 (FR-GIT-254 / V172): 삭제는 `-d` 든 `-D` 든 **파괴적으로 선언된다** —
// 되살리려면 reflog 나 hint 의 oid 가 필요하다. 그 선언이 기록에 남는다.
func TestBranchDelete_DestructiveInRecord(t *testing.T) {
	for _, force := range []bool{false, true} {
		repo := tempRepoWithBranch(t, "feat")
		f := &writeFake{}
		s := core.New(core.WithRunner(realReader(t, repo)), core.WithWriteRunner(f.runner))
		if _, _, err := BranchDelete(s, context.Background(), repo,
			BranchDeleteOpts{Names: []string{"feat"}, Force: force}); err != nil {
			t.Fatalf("force=%v: %v", force, err)
		}
		recs := s.Records(0)
		if len(recs) == 0 || !recs[len(recs)-1].Destructive {
			t.Fatalf("force=%v: 파괴적으로 선언되지 않았다", force)
		}
	}
}

// B24 (FR-GIT-255): merge 의 방식은 셋이고 기본은 플래그 없음이다. 모르는 방식은
// **실행 전에** 오류다 — 통과시키면 다이얼로그가 제공하지 않는 플래그가 흘러든다.
func TestMergeArgs(t *testing.T) {
	cases := []struct {
		mode string
		want []string
	}{
		{MergeDefault, []string{"merge", "side"}},
		{MergeFFOnly, []string{"merge", "--ff-only", "side"}},
		{MergeNoFF, []string{"merge", "--no-ff", "side"}},
		{MergeSquash, []string{"merge", "--squash", "side"}},
	}
	for _, c := range cases {
		got, err := MergeArgs(MergeOpts{Ref: "side", Mode: c.mode})
		if err != nil {
			t.Fatalf("%q: %v", c.mode, err)
		}
		if fmt.Sprint(got) != fmt.Sprint(c.want) {
			t.Fatalf("%q: argv = %v, want %v", c.mode, got, c.want)
		}
	}
	if _, err := MergeArgs(MergeOpts{Ref: "side", Mode: "octopus"}); !errors.Is(err, ErrMergeMode) {
		t.Fatalf("err = %v, want ErrMergeMode", err)
	}
	if _, err := MergeArgs(MergeOpts{Ref: ""}); !errors.Is(err, core.ErrRefName) {
		t.Fatalf("err = %v, want ErrRefName", err)
	}
}

// B25 (FR-GIT-256 / V172·V174): rebase 는 **파괴적이다** — 커밋 해시가 바뀐다.
// hint 는 `git reset --hard <원래 HEAD oid>` 이며 값이 실려 있다.
func TestRebase_DestructiveAndHint(t *testing.T) {
	repo := tempRepoWithBranch(t, "feat")
	f := &writeFake{}
	s := core.New(core.WithRunner(realReader(t, repo)), core.WithWriteRunner(f.runner))
	ctx := context.Background()

	head, err := query.BranchOid(s, ctx, repo, "main")
	if err != nil {
		t.Fatalf("BranchOid: %v", err)
	}
	if _, err := Rebase(s, ctx, repo, RebaseOpts{Ref: "feat"}); err != nil {
		t.Fatalf("Rebase: %v", err)
	}
	recs := s.Records(0)
	if len(recs) == 0 || !recs[len(recs)-1].Destructive {
		t.Fatal("rebase 가 파괴적으로 선언되지 않았다")
	}
	hints := s.Hints(0)
	if len(hints) != 1 {
		t.Fatalf("hint 가 %d개다", len(hints))
	}
	if hints[0].Action != core.ActionRebase {
		t.Fatalf("Action = %q, want %q", hints[0].Action, core.ActionRebase)
	}
	if want := "git reset --hard " + head; hints[0].Command != want {
		t.Fatalf("Command = %q, want %q", hints[0].Command, want)
	}
}

// B26 (FR-GIT-256): `--onto` 는 옵션이다. 주면 위치 인자보다 앞선다.
func TestRebaseArgs(t *testing.T) {
	got, err := RebaseArgs(RebaseOpts{Ref: "main"})
	if err != nil || fmt.Sprint(got) != fmt.Sprint([]string{"rebase", "main"}) {
		t.Fatalf("argv = %v, err = %v", got, err)
	}
	got, err = RebaseArgs(RebaseOpts{Ref: "main", Onto: "v1"})
	if err != nil || fmt.Sprint(got) != fmt.Sprint([]string{"rebase", "--onto", "v1", "main"}) {
		t.Fatalf("argv = %v, err = %v", got, err)
	}
	if _, err := RebaseArgs(RebaseOpts{}); !errors.Is(err, core.ErrRefName) {
		t.Fatalf("err = %v, want ErrRefName", err)
	}
}

// B27 (FR-GIT-257): set 과 unset 은 다른 argv 이고 **둘 다 파괴적이 아니다** —
// 되돌리는 것이 set 하나다.
func TestUpstreamArgs(t *testing.T) {
	got, err := UpstreamArgs(UpstreamOpts{Branch: "feat", Upstream: "origin/feat"})
	want := []string{"branch", "--set-upstream-to=origin/feat", "feat"}
	if err != nil || fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("argv = %v, err = %v, want %v", got, err, want)
	}
	got, err = UpstreamArgs(UpstreamOpts{Branch: "feat", Unset: true})
	want = []string{"branch", "--unset-upstream", "feat"}
	if err != nil || fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("argv = %v, err = %v, want %v", got, err, want)
	}
	for _, o := range []UpstreamOpts{
		{Branch: "feat"},                               // upstream 도 unset 도 없다
		{Branch: "", Upstream: "origin/feat"},          // 대상이 없다
		{Branch: "feat", Upstream: "-x"},               // 옵션처럼 생긴 값
		{Branch: "feat", Upstream: "o/f", Unset: true}, // 둘을 함께 받지 않는다
	} {
		if argv, err := UpstreamArgs(o); err == nil {
			t.Fatalf("%+v 가 거부되지 않았다: %v", o, argv)
		}
	}
	f := &writeFake{}
	s := core.New(core.WithWriteRunner(f.runner))
	if _, err := SetUpstream(s, context.Background(), "/tmp/repo",
		UpstreamOpts{Branch: "feat", Unset: true}); err != nil {
		t.Fatalf("SetUpstream: %v", err)
	}
	if recs := s.Records(0); len(recs) == 0 || recs[len(recs)-1].Destructive {
		t.Fatal("upstream 조작이 파괴적으로 선언됐다 — 되돌리는 것이 set 하나다")
	}
}

// B28 (FR-GIT-268): 원격 ref 를 같은 이름의 로컬로 가져오는 fetch 와, 원격 ref 를
// 지우는 push 는 **다른 항목**이다. 삭제만 파괴적이며 hint 는 되살리는 push 다.
func TestRemoteBranchSpecs(t *testing.T) {
	spec, err := RemoteFetchSpec(RemoteBranchOpts{Remote: "origin", Branch: "feat"})
	want := []string{"fetch", progressFlag, "origin", "feat:feat"}
	if err != nil || fmt.Sprint(spec.Argv) != fmt.Sprint(want) {
		t.Fatalf("argv = %v, err = %v, want %v", spec.Argv, err, want)
	}
	if spec.Destructive {
		t.Fatal("fetch 가 파괴적으로 선언됐다")
	}

	repo := tempRepoWithRemote(t)
	s := core.New()
	ctx := context.Background()
	dspec, err := RemoteBranchDeleteSpec(s, ctx, repo, RemoteBranchOpts{Remote: "origin", Branch: "feat"})
	if err != nil {
		t.Fatalf("RemoteBranchDeleteSpec: %v", err)
	}
	want = []string{"push", progressFlag, "origin", "--delete", "feat"}
	if fmt.Sprint(dspec.Argv) != fmt.Sprint(want) {
		t.Fatalf("argv = %v, want %v", dspec.Argv, want)
	}
	if !dspec.Destructive {
		t.Fatal("원격 ref 삭제가 파괴적으로 선언되지 않았다")
	}
	hints := s.Hints(0)
	if len(hints) != 1 || hints[0].Action != core.ActionRemoteRefDelete {
		t.Fatalf("hint = %+v", hints)
	}
	oid, err := query.RemoteBranchOid(s, ctx, repo, "origin/feat")
	if err != nil {
		t.Fatalf("RemoteBranchOid: %v", err)
	}
	if len(hints[0].Values) != 1 || hints[0].Values[0] != oid {
		t.Fatalf("Values = %v, want [%s] — 지우기 전 oid 가 없으면 되살릴 수 없다", hints[0].Values, oid)
	}
	if want := "git push origin " + oid + ":refs/heads/feat"; hints[0].Command != want {
		t.Fatalf("Command = %q, want %q", hints[0].Command, want)
	}
}

// B29 (FR-GIT-258): 대상이 **현재 브랜치가 아니어도** upstream 이 없으면 publish 다.
// 그 사실을 실행 전에 알려야 하므로 계획만 돌려주고 멈춘다.
func TestBranchPushSpec_PublishForNonCurrentBranch(t *testing.T) {
	repo := tempRepoWithBranch(t, "feat") // feat 에는 upstream 이 없다
	gitRun(t, repo, "remote", "add", "origin", filepath.Join(t.TempDir(), "r.git"))
	s := core.New()
	ctx := context.Background()

	_, plan, err := BranchPushSpec(s, ctx, repo, BranchPushOpts{Branch: "feat"})
	if !errors.Is(err, ErrPublishRequired) {
		t.Fatalf("err = %v, want ErrPublishRequired", err)
	}
	if !plan.Publish || plan.Remote != "origin" || plan.Branch != "feat" {
		t.Fatalf("plan = %+v", plan)
	}
	spec, plan, err := BranchPushSpec(s, ctx, repo, BranchPushOpts{Branch: "feat", Publish: true})
	if err != nil {
		t.Fatalf("publish: %v", err)
	}
	want := []string{"push", progressFlag, "-u", "origin", "feat"}
	if fmt.Sprint(spec.Argv) != fmt.Sprint(want) {
		t.Fatalf("argv = %v, want %v", spec.Argv, want)
	}
	if spec.Destructive {
		t.Fatal("force 가 아닌 push 가 파괴적으로 선언됐다")
	}
	if !plan.Publish {
		t.Fatalf("plan = %+v", plan)
	}
}

// B30 (FR-GIT-258 / V172): force 는 `--force` 만 2단계 확인을 요구하고, 둘 다
// 파괴적이다 — 판정이 **옵션에서 파생한다**.
func TestBranchPushSpec_Force(t *testing.T) {
	repo := tempRepoWithRemote(t)
	gitRun(t, repo, "checkout", "-q", "-b", "feat", "--track", "origin/feat")
	gitRun(t, repo, "checkout", "-q", "main")
	s := core.New()
	ctx := context.Background()

	if _, _, err := BranchPushSpec(s, ctx, repo, BranchPushOpts{Branch: "feat", Force: PushForce}); !errors.Is(err, ErrForceConfirm) {
		t.Fatalf("err = %v, want ErrForceConfirm", err)
	}
	spec, _, err := BranchPushSpec(s, ctx, repo, BranchPushOpts{Branch: "feat", Force: PushLease})
	if err != nil {
		t.Fatalf("lease: %v", err)
	}
	if !spec.Destructive {
		t.Fatal("force push 가 파괴적으로 선언되지 않았다")
	}
	want := []string{"push", progressFlag, "--force-with-lease", "origin", "feat"}
	if fmt.Sprint(spec.Argv) != fmt.Sprint(want) {
		t.Fatalf("argv = %v, want %v", spec.Argv, want)
	}
	if _, _, err := BranchPushSpec(s, ctx, repo, BranchPushOpts{Branch: "feat", Force: "yolo"}); !errors.Is(err, ErrPushForce) {
		t.Fatalf("err = %v, want ErrPushForce", err)
	}
}

// B31 (FR-GIT-253): 새 이름의 검사는 생성과 **같은 자리**를 쓴다 — 이미 있는
// 이름으로는 실행되지 않는다.
func TestBranchRename_RejectsTakenName(t *testing.T) {
	repo := tempRepoWithBranch(t, "feat")
	f := &writeFake{}
	s := core.New(core.WithRunner(realReader(t, repo)), core.WithWriteRunner(f.runner))
	if _, err := BranchRename(s, context.Background(), repo,
		BranchRenameOpts{From: "feat", To: "main"}); !errors.Is(err, ErrBranchExists) {
		t.Fatalf("err = %v, want ErrBranchExists", err)
	}
	if len(f.argvs) != 0 {
		t.Fatalf("거부됐는데 실행됐다: %v", f.argvs)
	}
}
