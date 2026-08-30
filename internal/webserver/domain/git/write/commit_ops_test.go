package write

import (
	"context"
	"errors"
	"strings"
	"testing"

	"dongminal/internal/webserver/domain/git/core"
)

// 묶음 D — 커밋 동작 (GIT_ACTIONS_SRS §3.4 FR-GIT-263~266, 검증 V191·V192·V193).
//
// 여기서 보는 것은 **무엇을 실행하지 않았는가**다. argv 를 만드는 자리가 순수해야
// 서버가 잘못된 요청을 실행 전에 400 으로 답할 수 있다 (FR-GIT-250).

// D1 (V191, FR-GIT-263·264): 머지 커밋은 부모 번호 없이 argv 가 되지 않는다.
// 묻지 않고 고르면 틀린 부모를 집고, 그 결과는 되돌리기 전까지 알 수 없다.
func TestPickArgs_MergeNeedsMainline(t *testing.T) {
	for _, verb := range []string{PickCherry, PickRevert} {
		argv, err := PickArgs(verb, PickOpts{Oid: "abc123", Merge: true})
		if err == nil {
			t.Fatalf("%s: 머지 커밋이 부모 없이 argv 가 됐다: %v", verb, argv)
		}
		if !errors.Is(err, ErrMergeParent) {
			t.Fatalf("%s: 오류가 ErrMergeParent 가 아니다: %v", verb, err)
		}
	}
}

// D2: 부모 번호는 머지 커밋에만 뜻이 있다. 머지가 아닌 커밋에 `-m` 을 주면 git 이
// exit 128 로만 답하므로 실행 전에 거부한다.
func TestPickArgs_MainlineOnlyForMerge(t *testing.T) {
	for _, verb := range []string{PickCherry, PickRevert} {
		if argv, err := PickArgs(verb, PickOpts{Oid: "abc123", Mainline: 1}); err == nil {
			t.Fatalf("%s: 머지가 아닌데 -m 이 붙었다: %v", verb, argv)
		}
	}
}

// D3 (FR-GIT-263·264): 옵션이 argv 로 정확히 옮겨진다. 위치 인자는 마지막 하나다.
func TestPickArgs_Shapes(t *testing.T) {
	cases := []struct {
		name string
		verb string
		o    PickOpts
		want []string
	}{
		{"cherry-pick 단순", PickCherry, PickOpts{Oid: "abc123"},
			[]string{"cherry-pick", "abc123"}},
		{"cherry-pick 머지", PickCherry, PickOpts{Oid: "abc123", Merge: true, Mainline: 2},
			[]string{"cherry-pick", "-m", "2", "abc123"}},
		{"revert 단순", PickRevert, PickOpts{Oid: "abc123"},
			[]string{"revert", "abc123"}},
		{"revert 머지", PickRevert, PickOpts{Oid: "abc123", Merge: true, Mainline: 1},
			[]string{"revert", "-m", "1", "abc123"}},
		{"revert --no-commit", PickRevert, PickOpts{Oid: "abc123", NoCommit: true},
			[]string{"revert", "--no-commit", "abc123"}},
	}
	for _, tc := range cases {
		got, err := PickArgs(tc.verb, tc.o)
		if err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		if strings.Join(got, " ") != strings.Join(tc.want, " ") {
			t.Fatalf("%s: argv = %v, want %v", tc.name, got, tc.want)
		}
	}
}

// D4 (FR-GIT-250.3): 모르는 동사·빈 oid·옵션처럼 생긴 oid·범위 표현은 실행 전에
// 거부된다. 클라이언트만 막으면 API 직접 호출이 그대로 우회한다.
func TestPickArgs_Rejects(t *testing.T) {
	cases := []struct {
		name string
		verb string
		o    PickOpts
	}{
		{"모르는 동사", "rebase", PickOpts{Oid: "abc123"}},
		{"빈 oid", PickCherry, PickOpts{}},
		{"- 로 시작하는 oid", PickCherry, PickOpts{Oid: "--hard"}},
		{"범위 표현", PickRevert, PickOpts{Oid: "a..b"}},
		{"부모 번호가 0 이하", PickCherry, PickOpts{Oid: "abc123", Merge: true, Mainline: 0}},
		{"부모 번호가 음수", PickCherry, PickOpts{Oid: "abc123", Merge: true, Mainline: -1}},
		// --no-commit 은 revert 의 옵션이다 (FR-GIT-264). cherry-pick 에 없는 것을
		// 받으면 화면이 줄 수 있는 것처럼 보인다.
		{"cherry-pick 의 --no-commit", PickCherry, PickOpts{Oid: "abc123", NoCommit: true}},
	}
	for _, tc := range cases {
		if argv, err := PickArgs(tc.verb, tc.o); err == nil {
			t.Fatalf("%s 가 거부되지 않았다: %v", tc.name, argv)
		}
	}
}

// D5 (FR-GIT-263·264): cherry-pick·revert 는 파괴적이 아니다 — 충돌로 멈추면 그것은
// 실패가 아니라 진행 중 상태이며 출구가 이미 있다 (FR-GIT-251·252).
func TestPick_NotDestructive(t *testing.T) {
	ctx := context.Background()
	for _, verb := range []string{PickCherry, PickRevert} {
		f := &writeFake{}
		s := core.New(core.WithRunner(fakeParentsRead("")), core.WithWriteRunner(f.runner))
		if _, err := Pick(s, ctx, absTmpRepo, verb, PickOpts{Oid: "abc123"}); err != nil {
			t.Fatalf("%s: %v", verb, err)
		}
		recs := s.Records(0)
		last := recs[len(recs)-1]
		if last.Destructive {
			t.Fatalf("%s 가 파괴적으로 선언됐다", verb)
		}
	}
}

// D6 (V191): 실행 함수는 **저장소에** 머지 여부를 다시 묻는다. 요청이 거짓말을 해도
// 부모 번호 없는 머지 cherry-pick 은 실행되지 않는다 — 서버가 마지막 방어선이다.
func TestPick_MergeIsAskedOfTheRepo(t *testing.T) {
	ctx := context.Background()
	f := &writeFake{}
	// 부모가 둘이다. 요청은 Merge 를 말하지 않았다.
	s := core.New(core.WithRunner(fakeParentsRead("p1 p2")), core.WithWriteRunner(f.runner))
	if _, err := Pick(s, ctx, absTmpRepo, PickCherry, PickOpts{Oid: "abc123"}); err == nil {
		t.Fatal("머지 커밋인데 부모 없이 실행됐다")
	} else if !errors.Is(err, ErrMergeParent) {
		t.Fatalf("오류가 ErrMergeParent 가 아니다: %v", err)
	}
	if len(f.argvs) != 0 {
		t.Fatalf("거부해야 하는데 실행됐다: %v", f.argvs)
	}
}

// D7 (FR-GIT-265): 세 모드가 각각의 argv 를 낸다. 기본은 --mixed 이며 그것이
// ResetModes 의 첫 값이다 (FR-GIT-173).
func TestResetArgs_Modes(t *testing.T) {
	if ResetModes[0] != ResetMixed {
		t.Fatalf("기본 모드가 mixed 가 아니다: %v", ResetModes)
	}
	cases := []struct {
		mode string
		want []string
	}{
		{ResetSoft, []string{"reset", "--soft", "abc123"}},
		{ResetMixed, []string{"reset", "--mixed", "abc123"}},
		{ResetHard, []string{"reset", "--hard", "abc123"}},
		// 비면 기본(mixed) 이다 — 모드가 빠졌다고 --hard 로 떨어지지 않는다.
		{"", []string{"reset", "--mixed", "abc123"}},
	}
	for _, tc := range cases {
		got, err := ResetArgs(ResetOpts{Oid: "abc123", Mode: tc.mode})
		if err != nil {
			t.Fatalf("%q: %v", tc.mode, err)
		}
		if strings.Join(got, " ") != strings.Join(tc.want, " ") {
			t.Fatalf("%q: argv = %v, want %v", tc.mode, got, tc.want)
		}
	}
	if argv, err := ResetArgs(ResetOpts{Oid: "abc123", Mode: "keep"}); err == nil {
		t.Fatalf("모르는 모드가 거부되지 않았다: %v", argv)
	} else if !errors.Is(err, ErrResetMode) {
		t.Fatalf("오류가 ErrResetMode 가 아니다: %v", err)
	}
	if argv, err := ResetArgs(ResetOpts{Oid: "--hard"}); err == nil {
		t.Fatalf("옵션처럼 생긴 oid 가 거부되지 않았다: %v", argv)
	}
}

// D8 (V192, FR-GIT-265·250.1): **`--hard` 만 파괴적이다.** 파괴 선언은 하위 명령이
// 아니라 옵션에서 파생한다 — 선언이 기록에 그대로 남는다 (FR-GIT-95).
func TestReset_DestructiveOnlyHard(t *testing.T) {
	ctx := context.Background()
	for _, tc := range []struct {
		mode string
		want bool
	}{
		{ResetSoft, false},
		{ResetMixed, false},
		{ResetHard, true},
	} {
		f := &writeFake{}
		s := core.New(core.WithWriteRunner(f.runner))
		if _, err := Reset(s, ctx, absTmpRepo, ResetOpts{Oid: "abc123", Mode: tc.mode}, "head0"); err != nil {
			t.Fatalf("%s: %v", tc.mode, err)
		}
		recs := s.Records(0)
		if got := recs[len(recs)-1].Destructive; got != tc.want {
			t.Fatalf("%s: Destructive = %v, want %v", tc.mode, got, tc.want)
		}
	}
}

// D9 (FR-GIT-92·250.2): `--hard` 는 **옮기기 전 HEAD oid** 를 hint 에 싣는다.
// 안내문만 남기면 되살릴 수 없다. 안전한 모드는 잃는 것이 없으므로 hint 도 없다.
func TestReset_HintCarriesOriginalHead(t *testing.T) {
	ctx := context.Background()

	f := &writeFake{}
	s := core.New(core.WithWriteRunner(f.runner))
	if _, err := Reset(s, ctx, absTmpRepo, ResetOpts{Oid: "abc123", Mode: ResetHard}, "deadbeef"); err != nil {
		t.Fatal(err)
	}
	hints := s.Hints(0)
	if len(hints) != 1 {
		t.Fatalf("hint 가 %d개다 (want 1)", len(hints))
	}
	h := hints[0]
	if h.Action != core.ActionResetHard {
		t.Fatalf("hint.Action = %q, want %q", h.Action, core.ActionResetHard)
	}
	if h.Command != "git reset --hard deadbeef" {
		t.Fatalf("hint.Command = %q — 되살릴 수 있는 명령이 아니다", h.Command)
	}

	f2 := &writeFake{}
	s2 := core.New(core.WithWriteRunner(f2.runner))
	if _, err := Reset(s2, ctx, absTmpRepo, ResetOpts{Oid: "abc123", Mode: ResetMixed}, "deadbeef"); err != nil {
		t.Fatal(err)
	}
	if n := len(s2.Hints(0)); n != 0 {
		t.Fatalf("안전한 모드가 hint 를 남겼다 (%d개)", n)
	}
}

// D10 (V193, FR-GIT-266): drop 의 argv 는 `rebase --onto <oid>^ <oid>` 다.
func TestDropArgs(t *testing.T) {
	got, err := DropArgs("abc123")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"rebase", "--onto", "abc123^", "abc123"}
	if strings.Join(got, " ") != strings.Join(want, " ") {
		t.Fatalf("argv = %v, want %v", got, want)
	}
	for _, bad := range []string{"", "--onto", "a..b"} {
		if argv, err := DropArgs(bad); err == nil {
			t.Fatalf("%q 가 거부되지 않았다: %v", bad, argv)
		}
	}
}

// D11 (V193, FR-GIT-250.1·250.2): drop 은 파괴적이며(`commit_drop`) hint 는 원래
// HEAD 로의 `reset --hard` 다.
func TestDrop_DestructiveWithHint(t *testing.T) {
	ctx := context.Background()
	f := &writeFake{}
	s := core.New(core.WithWriteRunner(f.runner))
	if _, err := Drop(s, ctx, absTmpRepo, "abc123", "deadbeef"); err != nil {
		t.Fatal(err)
	}
	recs := s.Records(0)
	if !recs[len(recs)-1].Destructive {
		t.Fatal("drop 이 파괴적으로 선언되지 않았다")
	}
	hints := s.Hints(0)
	if len(hints) != 1 || hints[0].Action != core.ActionCommitDrop {
		t.Fatalf("hint = %+v, want action %q", hints, core.ActionCommitDrop)
	}
	if hints[0].Command != "git reset --hard deadbeef" {
		t.Fatalf("hint.Command = %q — 되살릴 수 있는 명령이 아니다", hints[0].Command)
	}
}

// D12 (FR-GIT-263): 머지 여부 판정은 실제 git 에 물어야 한다. 부모 수를 세는 자리가
// 틀리면 V191 의 방어 전체가 무의미해진다.
func TestCommitIsMerge_RealRepo(t *testing.T) {
	dir := tempRepo(t)
	gitRun(t, dir, "checkout", "-b", "side")
	writeFile(t, dir, "side.txt", "s\n")
	gitRun(t, dir, "add", ".")
	gitRun(t, dir, "commit", "-m", "side")
	gitRun(t, dir, "checkout", "main")
	writeFile(t, dir, "main.txt", "m\n")
	gitRun(t, dir, "add", ".")
	gitRun(t, dir, "commit", "-m", "main2")
	gitRun(t, dir, "merge", "--no-ff", "-m", "merge", "side")

	s := core.New()
	ctx := context.Background()
	merge, err := CommitIsMerge(s, ctx, dir, "HEAD")
	if err != nil {
		t.Fatal(err)
	}
	if !merge {
		t.Fatal("머지 커밋을 머지가 아니라고 답했다")
	}
	plain, err := CommitIsMerge(s, ctx, dir, "HEAD^1")
	if err != nil {
		t.Fatal(err)
	}
	if plain {
		t.Fatal("보통 커밋을 머지라고 답했다")
	}
}

// fakeParentsRead 는 `log --format=%P` 하나만 답하는 읽기 실행기다. 머지 판정이
// 무엇을 묻는지 고정한다.
func fakeParentsRead(parents string) core.Runner {
	return func(_ context.Context, _ string, args []string) (core.Output, error) {
		if len(args) > 0 && args[0] == "log" {
			return core.Output{Stdout: parents + "\n"}, nil
		}
		return core.Output{}, nil
	}
}
