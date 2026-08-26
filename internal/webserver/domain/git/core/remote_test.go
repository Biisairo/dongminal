package core

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
)

// 13단계 — Fetch / Pull / Push 의 argv (GIT_SRS §3B.1 FR-GIT-98~106,
// 검증 V41·V43·V44).

const remoteRepo = "/work/repo"

// remoteFake 는 status 와 config 만 답한다. 원격 작업의 argv 는 이 둘로 결정된다.
type remoteFake struct {
	branch   string
	upstream string
	detached bool
	config   string
}

func (f remoteFake) read(_ context.Context, _ string, args []string) (Output, error) {
	switch args[0] {
	case "status":
		return Output{Stdout: f.statusOut()}, nil
	case "config":
		return Output{Stdout: f.config}, nil
	}
	return Output{}, nil
}

func (f remoteFake) statusOut() string {
	head := "# branch.head " + f.branch
	if f.detached {
		head = "# branch.head (detached)"
	}
	toks := []string{"# branch.oid " + strings.Repeat("a", 40), head}
	if f.upstream != "" {
		toks = append(toks, "# branch.upstream "+f.upstream, "# branch.ab +1 -0")
	}
	return strings.Join(toks, "\x00") + "\x00"
}

func remoteSvc(f remoteFake) *Service {
	return New(
		WithRunner(f.read),
		WithWriteRunner(func(context.Context, string, []string, string) (Output, error) { return Output{}, nil }),
	)
}

// R5 (V43, FR-GIT-104): sanitizeRemote 가 URL 의 자격증명을 지운다.
func TestSanitizeRemote(t *testing.T) {
	cases := []struct{ in, want string }{
		{"https://u:p@host/x.git", "https://***@host/x.git"},
		{"remote: https://ghp_abcdef@github.com/o/r.git 에 밀었다", "remote: https://***@github.com/o/r.git 에 밀었다"},
		{"ssh://git@host:22/o/r.git", "ssh://***@host:22/o/r.git"},
		{"git@github.com:o/r.git", "git@github.com:o/r.git"},         // scp 형태는 비밀이 들어갈 자리가 없다
		{"https://github.com/o/r.git", "https://github.com/o/r.git"}, // userinfo 가 없다
		{"진행 중 50%", "진행 중 50%"},
	}
	for _, c := range cases {
		if got := SanitizeRemote(c.in); got != c.want {
			t.Errorf("SanitizeRemote(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// R6 (V41, FR-GIT-100): upstream 이 없으면 Push 는 Publish 다.
func TestPushSpec_PublishSetsUpstream(t *testing.T) {
	svc := remoteSvc(remoteFake{branch: "no-upstream", config: "remote.origin.url=/tmp/remote.git\ncore.bare=false\n"})
	spec, plan, err := svc.PushSpec(context.Background(), remoteRepo, PushOpts{Publish: true})
	if err != nil {
		t.Fatalf("PushSpec: %v", err)
	}
	want := []string{"push", "--progress", "-u", "origin", "no-upstream"}
	if fmt.Sprint(spec.Argv) != fmt.Sprint(want) {
		t.Fatalf("argv = %v, want %v", spec.Argv, want)
	}
	if !plan.Publish || plan.Remote != "origin" || plan.Branch != "no-upstream" {
		t.Fatalf("plan = %+v", plan)
	}
}

// R6 (V41): Publish 는 **실행 전에 알린다.** 확인 없이 오면 거부하고 계획을 준다.
func TestPushSpec_PublishNeedsAcknowledgement(t *testing.T) {
	svc := remoteSvc(remoteFake{branch: "no-upstream", config: "remote.origin.url=/tmp/remote.git\n"})
	_, plan, err := svc.PushSpec(context.Background(), remoteRepo, PushOpts{})
	if !errors.Is(err, ErrPublishRequired) {
		t.Fatalf("err = %v, want ErrPublishRequired", err)
	}
	if !plan.Publish || plan.Remote != "origin" || plan.Branch != "no-upstream" {
		t.Fatalf("plan = %+v — 무엇을 확인해야 하는지 알 수 없다", plan)
	}
}

// upstream 이 있으면 기본 push 다. `-u` 를 덧붙이지 않는다 (FR-GIT-99).
func TestPushSpec_WithUpstreamIsPlain(t *testing.T) {
	svc := remoteSvc(remoteFake{branch: "main", upstream: "origin/main"})
	spec, plan, err := svc.PushSpec(context.Background(), remoteRepo, PushOpts{})
	if err != nil {
		t.Fatalf("PushSpec: %v", err)
	}
	if fmt.Sprint(spec.Argv) != fmt.Sprint([]string{"push", "--progress"}) {
		t.Fatalf("argv = %v", spec.Argv)
	}
	if plan.Publish || spec.Destructive {
		t.Fatalf("plan = %+v, destructive = %v", plan, spec.Destructive)
	}
}

// 원격을 정하는 규칙: 하나면 그것, 여럿이면 origin, 없으면 오류 (FR-GIT-100).
func TestPushSpec_RemoteSelection(t *testing.T) {
	cases := []struct {
		name   string
		config string
		want   string
		err    error
	}{
		{"하나", "remote.up.url=/tmp/a.git\n", "up", nil},
		{"여럿 + origin", "remote.fork.url=/a\nremote.origin.url=/b\n", "origin", nil},
		{"여럿 + origin 없음", "remote.a.url=/a\nremote.b.url=/b\n", "", ErrNoRemote},
		{"없음", "core.bare=false\n", "", ErrNoRemote},
		{"url 아닌 키만", "remote.origin.prune=true\n", "", ErrNoRemote},
		{"점이 든 이름", "remote.my.fork.url=/a\n", "my.fork", nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			svc := remoteSvc(remoteFake{branch: "b", config: c.config})
			spec, plan, err := svc.PushSpec(context.Background(), remoteRepo, PushOpts{Publish: true})
			if c.err != nil {
				if !errors.Is(err, c.err) {
					t.Fatalf("err = %v, want %v", err, c.err)
				}
				return
			}
			if err != nil {
				t.Fatalf("PushSpec: %v", err)
			}
			if plan.Remote != c.want {
				t.Fatalf("remote = %q, want %q (argv=%v)", plan.Remote, c.want, spec.Argv)
			}
		})
	}
}

// detached HEAD 에는 밀 브랜치가 없다. 조용히 기본 push 로 넘기면 무엇이 밀리는지
// 사용자가 알 수 없다.
func TestPushSpec_DetachedIsRejected(t *testing.T) {
	svc := remoteSvc(remoteFake{detached: true, config: "remote.origin.url=/a\n"})
	if _, _, err := svc.PushSpec(context.Background(), remoteRepo, PushOpts{Publish: true}); !errors.Is(err, ErrDetachedPush) {
		t.Fatalf("err = %v, want ErrDetachedPush", err)
	}
}

// R7 (V44, FR-GIT-106): force 기본은 --force-with-lease 다. --force 는 명시 +
// 2단계 확인이 있을 때만이다.
func TestPushSpec_ForceDefaults(t *testing.T) {
	svc := remoteSvc(remoteFake{branch: "main", upstream: "origin/main"})
	ctx := context.Background()

	base, _, err := svc.PushSpec(ctx, remoteRepo, PushOpts{})
	if err != nil {
		t.Fatalf("기본: %v", err)
	}
	if strings.Contains(fmt.Sprint(base.Argv), "force") {
		t.Fatalf("기본 argv 에 force 가 있다: %v", base.Argv)
	}

	lease, plan, err := svc.PushSpec(ctx, remoteRepo, PushOpts{Force: PushLease})
	if err != nil {
		t.Fatalf("lease: %v", err)
	}
	if fmt.Sprint(lease.Argv) != fmt.Sprint([]string{"push", "--progress", "--force-with-lease"}) {
		t.Fatalf("lease argv = %v", lease.Argv)
	}
	if !lease.Destructive || plan.Force != PushLease {
		t.Fatalf("destructive = %v, plan = %+v", lease.Destructive, plan)
	}

	if _, _, err := svc.PushSpec(ctx, remoteRepo, PushOpts{Force: PushForce}); !errors.Is(err, ErrForceConfirm) {
		t.Fatalf("확인 없는 --force err = %v, want ErrForceConfirm", err)
	}

	forced, _, err := svc.PushSpec(ctx, remoteRepo, PushOpts{Force: PushForce, Confirm: true})
	if err != nil {
		t.Fatalf("force: %v", err)
	}
	if fmt.Sprint(forced.Argv) != fmt.Sprint([]string{"push", "--progress", "--force"}) {
		t.Fatalf("force argv = %v", forced.Argv)
	}
	if !forced.Destructive {
		t.Fatal("--force 가 파괴적으로 선언되지 않았다")
	}

	if _, _, err := svc.PushSpec(ctx, remoteRepo, PushOpts{Force: "hard"}); !errors.Is(err, ErrPushForce) {
		t.Fatalf("모르는 force err = %v, want ErrPushForce", err)
	}
}

// FR-GIT-99·109: fetch 는 기본이 `fetch --progress` 이고 변형은 옵션으로만 붙는다.
func TestFetchSpec(t *testing.T) {
	yes, no := true, false
	cases := []struct {
		name string
		opts FetchOpts
		want []string
	}{
		{"기본", FetchOpts{}, []string{"fetch", "--progress"}},
		{"prune", FetchOpts{Prune: true}, []string{"fetch", "--progress", "--prune"}},
		{"tags", FetchOpts{Tags: &yes}, []string{"fetch", "--progress", "--tags"}},
		{"no-tags", FetchOpts{Tags: &no}, []string{"fetch", "--progress", "--no-tags"}},
		{"prune + no-tags", FetchOpts{Prune: true, Tags: &no}, []string{"fetch", "--progress", "--prune", "--no-tags"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := FetchSpec(c.opts); fmt.Sprint(got.Argv) != fmt.Sprint(c.want) {
				t.Fatalf("argv = %v, want %v", got.Argv, c.want)
			}
			if FetchSpec(c.opts).Destructive {
				t.Fatal("fetch 는 파괴적이 아니다")
			}
		})
	}
}

// FR-GIT-99·110: pull 의 변형은 다이얼로그의 세 값뿐이다.
func TestPullSpec(t *testing.T) {
	cases := []struct {
		mode string
		want []string
		err  error
	}{
		{PullDefault, []string{"pull", "--progress"}, nil},
		{PullRebase, []string{"pull", "--progress", "--rebase"}, nil},
		{PullFFOnly, []string{"pull", "--progress", "--ff-only"}, nil},
		{PullNoFF, []string{"pull", "--progress", "--no-ff"}, nil},
		{"--exec-path=/x", nil, ErrPullMode},
		{"squash", nil, ErrPullMode},
	}
	for _, c := range cases {
		t.Run("mode="+c.mode, func(t *testing.T) {
			got, err := PullSpec(PullOpts{Mode: c.mode})
			if c.err != nil {
				if !errors.Is(err, c.err) {
					t.Fatalf("err = %v, want %v", err, c.err)
				}
				return
			}
			if err != nil {
				t.Fatalf("PullSpec: %v", err)
			}
			if fmt.Sprint(got.Argv) != fmt.Sprint(c.want) {
				t.Fatalf("argv = %v, want %v", got.Argv, c.want)
			}
		})
	}
}

// 만들어진 argv 는 쓰기 허용 목록을 통과한다 (FR-GIT-95). 통과하지 못하면 작업이
// 시작조차 못 하므로 여기서 못박는다.
func TestRemoteSpecs_PassWriteGuard(t *testing.T) {
	yes := true
	svc := remoteSvc(remoteFake{branch: "no-upstream", config: "remote.origin.url=/a\n"})
	push, _, err := svc.PushSpec(context.Background(), remoteRepo, PushOpts{Publish: true, Force: PushLease})
	if err != nil {
		t.Fatalf("PushSpec: %v", err)
	}
	pull, err := PullSpec(PullOpts{Mode: PullRebase})
	if err != nil {
		t.Fatalf("PullSpec: %v", err)
	}
	for _, spec := range []WriteSpec{FetchSpec(FetchOpts{Prune: true, Tags: &yes}), pull, push} {
		if gerr := GuardWriteArgs(spec.Argv); gerr != nil {
			t.Errorf("%v: %v", spec.Argv, gerr)
		}
	}
}
