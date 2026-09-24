package jobs

import (
	"fmt"
	"strings"
)

// REPO_FIX 01 §6.1 — 잡 경로를 탈 수 있는 kind 와 그 argv 의 모양.
//
// argv 는 write 의 `*Args`·`*Spec` 순수 함수가 만든다. 여기 있는 것은 **그 결과가
// 가질 수 있는 모양의 울타리**다 — 잡 경로가 열린 kind 에 다른 플래그가 흘러들면
// 동기 쓰기가 받지 않던 동작이 잡으로 새어 나간다. 판정(무엇을 만들까)은 저쪽,
// 울타리(무엇이 올 수 있나)는 이쪽이다.

// shapeRule 은 argv(argv[0]==kind)와 stdin 이 그 kind 의 모양인가다.
type shapeRule func(argv []string, stdin string) bool

// jobKinds 는 Start 가 받는 kind 다. nil 규칙은 "현행" — 원격 잡은 이 표 이전부터
// 가드(GuardWriteArgs)만으로 받아 왔다.
var jobKinds = map[string]shapeRule{
	"fetch":       nil,
	"push":        nil,
	"pull":        nil,
	"commit":      commitShape,
	"merge":       controlOr([]string{"--continue", "--abort"}, mergeShape),
	"rebase":      controlOr([]string{"--continue", "--skip", "--abort"}, rebaseShape),
	"cherry-pick": controlOr([]string{"--continue", "--skip", "--abort"}, pickShape(false)),
	"revert":      controlOr([]string{"--continue", "--skip", "--abort"}, pickShape(true)),
	"checkout":    checkoutShape,
	"am":          controlOr([]string{"--continue", "--skip", "--abort"}, nil),
	"bisect":      exactly("bisect", "reset"),
}

// unguardedKinds 는 StartUnguarded 가 받는 kind 다 — 인가를 도메인이 진다.
var unguardedKinds = map[string]shapeRule{
	"submodule": nil,
	"worktree":  func(argv []string, _ string) bool { return len(argv) > 1 && argv[1] == "add" },
}

// remoteKinds 는 원격 전용 판정(인증·거부·후속 선택지)과 원격 취소 문구가 뜻을
// 갖는 kind 다 (§6.3). merge 의 stderr 에 "rejected" 가 있다고 force push 를
// 권하지 않는다.
var remoteKinds = map[string]bool{"fetch": true, "pull": true, "push": true}

func checkShape(table map[string]shapeRule, kind string, argv []string, stdin string) error {
	rule, ok := table[kind]
	if !ok {
		return fmt.Errorf("%w: %q 는 잡 경로에 없다", ErrJobKind, kind)
	}
	if len(argv) == 0 || argv[0] != kind {
		return fmt.Errorf("%w: kind %q 와 argv %q 가 어긋난다", ErrJobKind, kind, argv)
	}
	if rule != nil && !rule(argv, stdin) {
		return fmt.Errorf("%w: %s 의 모양이 아니다: %q", ErrJobKind, kind, argv)
	}
	return nil
}

// positional 은 옵션이 아닌 인자다. ref 는 `-` 로 시작할 수 없다 (core.CheckRefArg).
func positional(a string) bool { return a != "" && !strings.HasPrefix(a, "-") }

// controlOr 는 `<kind> --continue` 같은 진행 중 작업의 출구이거나 rest 다.
func controlOr(controls []string, rest shapeRule) shapeRule {
	return func(argv []string, stdin string) bool {
		if len(argv) == 2 {
			for _, c := range controls {
				if argv[1] == c {
					return true
				}
			}
		}
		return rest != nil && rest(argv, stdin)
	}
}

func exactly(want ...string) shapeRule {
	return func(argv []string, _ string) bool {
		return strings.Join(argv, "\x00") == strings.Join(want, "\x00")
	}
}

// commitShape: `commit --file=- --cleanup=strip [--amend] [--signoff] [--no-verify] [-a]`,
// 메시지는 stdin 으로만 온다.
func commitShape(argv []string, stdin string) bool {
	if stdin == "" || len(argv) < 3 || argv[1] != "--file=-" || argv[2] != "--cleanup=strip" {
		return false
	}
	return flagsOnly(argv[3:], "--amend", "--signoff", "--no-verify", "-a")
}

func flagsOnly(args []string, allowed ...string) bool {
	seen := map[string]bool{}
	for _, a := range args {
		ok := false
		for _, f := range allowed {
			ok = ok || a == f
		}
		if !ok || seen[a] {
			return false
		}
		seen[a] = true
	}
	return true
}

// mergeShape: `merge [--ff-only|--no-ff|--squash] <ref>`.
func mergeShape(argv []string, _ string) bool {
	rest := argv[1:]
	if len(rest) == 2 && flagsOnly(rest[:1], "--ff-only", "--no-ff", "--squash") {
		rest = rest[1:]
	}
	return len(rest) == 1 && positional(rest[0])
}

// rebaseShape: `rebase [--onto <x>] <ref>` — RebaseArgs·DropArgs.
func rebaseShape(argv []string, _ string) bool {
	rest := argv[1:]
	if len(rest) == 3 && rest[0] == "--onto" && positional(rest[1]) {
		rest = rest[2:]
	}
	return len(rest) == 1 && positional(rest[0])
}

// pickShape: `cherry-pick|revert [-m <n>] [--no-commit] <oid>` — --no-commit 은 revert 만.
func pickShape(noCommit bool) shapeRule {
	return func(argv []string, _ string) bool {
		rest := argv[1:]
		if len(rest) >= 2 && rest[0] == "-m" {
			if !digits(rest[1]) {
				return false
			}
			rest = rest[2:]
		}
		if noCommit && len(rest) >= 1 && rest[0] == "--no-commit" {
			rest = rest[1:]
		}
		return len(rest) == 1 && positional(rest[0])
	}
}

func digits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// checkoutShape: CheckoutArgs·BranchCreateArgs(Checkout:true) —
// `checkout [--force] [--detach] [-b <name>] [--track <ref> | <ref>]`.
func checkoutShape(argv []string, _ string) bool {
	rest := argv[1:]
	take := func(flag string) bool {
		if len(rest) > 0 && rest[0] == flag {
			rest = rest[1:]
			return true
		}
		return false
	}
	take("--force")
	take("--detach")
	created := false
	if take("-b") {
		if len(rest) == 0 || !positional(rest[0]) {
			return false
		}
		rest, created = rest[1:], true
	}
	if take("--track") {
		return created && len(rest) == 1 && positional(rest[0])
	}
	switch len(rest) {
	case 0:
		return created
	case 1:
		return positional(rest[0])
	}
	return false
}
