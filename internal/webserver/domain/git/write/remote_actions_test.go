package write

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"dongminal/internal/webserver/domain/git/core"
)

// 묶음 E — 원격 동작 (GIT_ACTIONS_SRS §3.5 FR-GIT-269·270·271,
// 검증 V196·V197·V198).
//
// **argv 만 만든다** (FR-GIT-250 ①). 여기서 git 을 돌리지 않으므로 서버가 잘못된
// 요청을 실행 **전에** 400 으로 답할 수 있고, 테스트가 "무엇을 실행하지 않았는가"를
// 볼 수 있다.

// ── FR-GIT-269 remote add / remove ──

func TestRemoteAddArgs(t *testing.T) {
	got, err := RemoteAddArgs("upstream", "https://example.test/a.git")
	if err != nil {
		t.Fatalf("RemoteAddArgs: %v", err)
	}
	want := []string{"remote", "add", "upstream", "https://example.test/a.git"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("argv = %v, want %v", got, want)
	}
	if err := core.GuardWriteArgs(got); err != nil {
		t.Fatalf("쓰기 가드를 통과하지 못했다: %v", err)
	}
}

func TestRemoteRemoveArgs(t *testing.T) {
	got, err := RemoteRemoveArgs("origin")
	if err != nil {
		t.Fatalf("RemoteRemoveArgs: %v", err)
	}
	want := []string{"remote", "remove", "origin"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("argv = %v, want %v", got, want)
	}
	if err := core.GuardWriteArgs(got); err != nil {
		t.Fatalf("쓰기 가드를 통과하지 못했다: %v", err)
	}
}

// FR-GIT-250.3: 이름·URL 은 실행 **전에** 검증한다. 클라이언트만 막으면 API 직접
// 호출이 우회한다.
func TestRemoteAddArgs_Rejects(t *testing.T) {
	cases := []struct {
		name, remote, url string
		want              error
	}{
		{"빈 이름", "", "/tmp/a.git", ErrRemoteName},
		{"옵션처럼 생긴 이름", "-x", "/tmp/a.git", ErrRemoteName},
		{"슬래시가 든 이름", "a/b", "/tmp/a.git", ErrRemoteName},
		{"공백이 든 이름", "a b", "/tmp/a.git", ErrRemoteName},
		{"NUL 이 든 이름", "a\x00b", "/tmp/a.git", ErrRemoteName},
		{"범위 표현", "a..b", "/tmp/a.git", ErrRemoteName},
		{"빈 URL", "origin", "", ErrRemoteURL},
		{"옵션처럼 생긴 URL", "origin", "--upload-pack=evil", ErrRemoteURL},
		{"공백이 든 URL", "origin", "http://a b", ErrRemoteURL},
		{"NUL 이 든 URL", "origin", "http://a\x00", ErrRemoteURL},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			argv, err := RemoteAddArgs(c.remote, c.url)
			if !errors.Is(err, c.want) {
				t.Fatalf("err = %v, want %v", err, c.want)
			}
			if argv != nil {
				t.Fatalf("거부했는데 argv 가 있다: %v", argv)
			}
		})
	}
}

func TestRemoteRemoveArgs_Rejects(t *testing.T) {
	for _, name := range []string{"", "-x", "a/b", "a b"} {
		if _, err := RemoteRemoveArgs(name); !errors.Is(err, ErrRemoteName) {
			t.Errorf("RemoteRemoveArgs(%q) err = %v, want ErrRemoteName", name, err)
		}
	}
}

// remoteHintSvc 는 remote.<n>.url 을 답하는 서비스와 실행된 argv 를 함께 준다.
func remoteHintSvc(config string, seen *[][]string) *core.Service {
	return core.New(
		core.WithRunner(func(_ context.Context, _ string, args []string) (core.Output, error) {
			if args[0] == "config" {
				return core.Output{Stdout: config}, nil
			}
			return core.Output{}, nil
		}),
		core.WithWriteRunner(func(_ context.Context, _ string, args []string, _ string) (core.Output, error) {
			*seen = append(*seen, append([]string(nil), args...))
			return core.Output{}, nil
		}),
	)
}

// FR-GIT-269: remove 는 파괴적이 아니다 — 설정만 지운다. **다만 되살릴 명령을
// hint 로 남긴다** (FR-GIT-92·250.2): 지운 뒤에는 URL 을 읽을 자리가 없다.
func TestRemoteRemove_LeavesRecoveryHint(t *testing.T) {
	var seen [][]string
	svc := remoteHintSvc("remote.origin.url=/tmp/remote.git\n", &seen)
	if _, err := RemoteRemove(svc, context.Background(), "/work/repo", "origin"); err != nil {
		t.Fatalf("RemoteRemove: %v", err)
	}
	if len(seen) != 1 || fmt.Sprint(seen[0]) != fmt.Sprint([]string{"remote", "remove", "origin"}) {
		t.Fatalf("실행된 argv = %v", seen)
	}
	hints := svc.Hints(0)
	if len(hints) != 1 {
		t.Fatalf("hint 가 %d 개다: %+v", len(hints), hints)
	}
	h := hints[0]
	if !strings.Contains(h.Command, "remote add origin") || !strings.Contains(h.Command, "/tmp/remote.git") {
		t.Fatalf("되살릴 명령이 아니다: %q", h.Command)
	}
	if len(h.Values) == 0 || h.Values[0] != "/tmp/remote.git" {
		t.Fatalf("Values 에 URL 이 없다: %+v", h)
	}
	// 파괴적 선언은 하지 않는다 — 확인 절차가 뜻 없이 붙으면 규약이 흐려진다.
	recs := svc.Records(0)
	if len(recs) == 0 || recs[len(recs)-1].Destructive {
		t.Fatalf("파괴적으로 기록됐다: %+v", recs)
	}
}

// FR-GIT-104: URL 에 자격증명이 박혀 올 수 있다. hint 는 **세션 동안 보관되고 화면에
// 나가는** 값이므로 지운 값이어야 한다.
func TestRemoteRemove_HintRedactsURL(t *testing.T) {
	var seen [][]string
	svc := remoteHintSvc("remote.origin.url=https://user:abc123@example.test/a.git\n", &seen)
	if _, err := RemoteRemove(svc, context.Background(), "/work/repo", "origin"); err != nil {
		t.Fatalf("RemoteRemove: %v", err)
	}
	h := svc.Hints(0)
	if len(h) != 1 {
		t.Fatalf("hint 가 %d 개다", len(h))
	}
	if strings.Contains(h[0].Command, "abc123") || strings.Contains(fmt.Sprint(h[0].Values), "abc123") {
		t.Fatalf("자격증명이 hint 에 남았다: %+v", h[0])
	}
}

// 없는 원격을 지운 척하지 않는다 — 되살릴 값이 없는 hint 는 거짓이다.
func TestRemoteRemove_MissingIsRejected(t *testing.T) {
	var seen [][]string
	svc := remoteHintSvc("remote.origin.url=/tmp/a.git\n", &seen)
	_, err := RemoteRemove(svc, context.Background(), "/work/repo", "nope")
	if !errors.Is(err, ErrRemoteMissing) {
		t.Fatalf("err = %v, want ErrRemoteMissing", err)
	}
	if len(seen) != 0 {
		t.Fatalf("거부했는데 실행됐다: %v", seen)
	}
	if svc.Hints(0) != nil && len(svc.Hints(0)) != 0 {
		t.Fatalf("지우지 않은 것의 hint 를 남겼다: %+v", svc.Hints(0))
	}
}

// 같은 이름을 두 번 더하지 않는다 — git 도 막지만 사유를 우리 코드로 답해야
// 클라이언트가 무엇을 할지 안다.
func TestRemoteAdd_ExistingIsRejected(t *testing.T) {
	var seen [][]string
	svc := remoteHintSvc("remote.origin.url=/tmp/a.git\n", &seen)
	_, err := RemoteAdd(svc, context.Background(), "/work/repo", "origin", "/tmp/b.git")
	if !errors.Is(err, ErrRemoteExists) {
		t.Fatalf("err = %v, want ErrRemoteExists", err)
	}
	if len(seen) != 0 {
		t.Fatalf("거부했는데 실행됐다: %v", seen)
	}
}

// ── FR-GIT-270 Sync ──

// V197: **앞이 실패하면 뒤를 돌리지 않는다.** 이 판정은 순수하다 — job 을 그대로
// 받지 않으므로 단위로 고정된다.
func TestSyncNext_StopsWhenPullFails(t *testing.T) {
	cases := []struct {
		name string
		step string
		prev StepOutcome
		want string
		run  bool
	}{
		{"시작은 pull 이다", "", StepOutcome{}, SyncStepPull, true},
		{"pull 이 성공하면 push 다", SyncStepPull, StepOutcome{}, SyncStepPush, true},
		{"pull 이 exit != 0 이면 멈춘다", SyncStepPull, StepOutcome{ExitCode: 1}, "", false},
		{"pull 이 사유를 남기면 멈춘다", SyncStepPull, StepOutcome{Err: "충돌"}, "", false},
		{"pull 을 취소하면 멈춘다", SyncStepPull, StepOutcome{Canceled: true}, "", false},
		{"push 뒤에는 없다", SyncStepPush, StepOutcome{}, "", false},
		{"모르는 단계", "merge", StepOutcome{}, "", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			next, run, reason := SyncNext(c.step, c.prev)
			if next != c.want || run != c.run {
				t.Fatalf("SyncNext(%q, %+v) = (%q, %v), want (%q, %v)", c.step, c.prev, next, run, c.want, c.run)
			}
			// 멈춘 이유는 말해야 한다 — 조용히 멈추면 사용자는 push 가 돈 줄 안다.
			if !run && c.step == SyncStepPull && reason == "" {
				t.Fatal("멈춘 사유가 비었다")
			}
		})
	}
}

func TestSyncSteps_OrderIsTheContract(t *testing.T) {
	if fmt.Sprint(SyncSteps) != fmt.Sprint([]string{"pull", "push"}) {
		t.Fatalf("SyncSteps = %v — 순서가 곧 규약이다 (FR-GIT-270)", SyncSteps)
	}
}

// ── FR-GIT-271 Push preview ──

// 대상 remote/branch 를 고쳐 밀 수 있어야 한다. **upstream 을 건드리지 않는 것이
// 기본이다** — `-u` 는 사용자가 명시할 때만 붙는다 (FR-GIT-97·100).
func TestPushSpec_ExplicitTarget(t *testing.T) {
	svc := remoteSvc(remoteFake{branch: "main", upstream: "origin/main", config: "remote.origin.url=/a\n"})
	cases := []struct {
		name string
		opts PushOpts
		want []string
	}{
		{
			"대상 지정",
			PushOpts{Remote: "upstream", Branch: "feat"},
			[]string{"push", "--progress", "upstream", "feat"},
		},
		{
			"대상 지정 + force-with-lease",
			PushOpts{Remote: "upstream", Branch: "feat", Force: PushLease},
			[]string{"push", "--progress", "--force-with-lease", "upstream", "feat"},
		},
		{
			"대상 지정 + upstream 설정",
			PushOpts{Remote: "upstream", Branch: "feat", Publish: true},
			[]string{"push", "--progress", "-u", "upstream", "feat"},
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			spec, plan, err := PushSpec(svc, context.Background(), remoteRepo, c.opts)
			if err != nil {
				t.Fatalf("PushSpec: %v", err)
			}
			if fmt.Sprint(spec.Argv) != fmt.Sprint(c.want) {
				t.Fatalf("argv = %v, want %v", spec.Argv, c.want)
			}
			if plan.Remote != c.opts.Remote || plan.Branch != c.opts.Branch {
				t.Fatalf("plan = %+v", plan)
			}
			if err := core.GuardWriteArgs(spec.Argv); err != nil {
				t.Fatalf("쓰기 가드: %v", err)
			}
		})
	}
}

// 대상 이름도 실행 전에 검증한다 (FR-GIT-250.3).
func TestPushSpec_ExplicitTargetRejects(t *testing.T) {
	svc := remoteSvc(remoteFake{branch: "main", upstream: "origin/main", config: "remote.origin.url=/a\n"})
	bad := []PushOpts{
		{Remote: "-x", Branch: "feat"},
		{Remote: "origin", Branch: "-x"},
		{Remote: "origin", Branch: "a..b"},
		{Remote: "origin"}, // 브랜치만 비면 대상이 반쪽이다
		{Branch: "feat"},
	}
	for _, o := range bad {
		spec, _, err := PushSpec(svc, context.Background(), remoteRepo, o)
		if err == nil {
			t.Errorf("PushSpec(%+v) = %v, want error", o, spec.Argv)
		}
	}
}

// PushRange 는 outgoing 목록의 리비전 범위다 (FR-GIT-271). **새 조회를 만들지
// 않는다** — query.Log 의 Ref 로 그대로 들어간다.
func TestPushRange(t *testing.T) {
	if got := PushRange("origin/main", "main"); got != "origin/main..main" {
		t.Fatalf("PushRange = %q", got)
	}
	// 원격에 그 브랜치가 없으면 범위가 없다 — 브랜치 전부가 올라간다.
	if got := PushRange("", "main"); got != "main" {
		t.Fatalf("PushRange = %q", got)
	}
}
