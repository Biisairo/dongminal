package write

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"dongminal/internal/webserver/domain/git/core"
	"dongminal/internal/webserver/domain/git/query"
)

// 묶음 F — 미커밋 행 (GIT_ACTIONS_SRS §3.6 FR-GIT-277, 검증 V203).

// T1 (FR-GIT-277): Reset 은 **mixed** 다. `--hard` 가 섞이면 워킹 트리를 잃는다.
func TestUncommittedResetArgs_IsMixed(t *testing.T) {
	got := UncommittedResetArgs()
	if fmt.Sprint(got) != fmt.Sprint([]string{"reset", "-q", "--mixed", "HEAD"}) {
		t.Fatalf("argv = %v", got)
	}
	for _, a := range got {
		if a == "--hard" || a == "--soft" {
			t.Fatalf("argv 에 %s 가 있다: %v", a, got)
		}
	}
}

// T2 (FR-GIT-277): Clean 은 `-x` 를 붙이지 않는다 — `.gitignore` 가 무시하는
// 것까지 지우는 것은 다른 뜻이다.
func TestCleanUntrackedArgs(t *testing.T) {
	got := CleanUntrackedArgs()
	if fmt.Sprint(got) != fmt.Sprint([]string{"clean", "-q", "-f", "-d"}) {
		t.Fatalf("argv = %v", got)
	}
}

// T3 (V203): Reset 은 **파괴적이 아니다.** 실행은 ExecWrite 하나만 지난다.
func TestUncommittedReset_NotDestructive(t *testing.T) {
	repo := tempRepo(t)
	writeFile(t, repo, "a.txt", "a\n")
	gitIn(t, repo, "add", "a.txt")

	f := &writeFake{}
	s := core.New(core.WithWriteRunner(f.runner))
	if _, err := UncommittedReset(s, context.Background(), repo); err != nil {
		t.Fatalf("UncommittedReset: %v", err)
	}
	if len(f.argvs) != 1 || fmt.Sprint(f.argvs[0]) != fmt.Sprint(UncommittedResetArgs()) {
		t.Fatalf("argv = %v", f.argvs)
	}
	recs := s.Records(0)
	if recs[len(recs)-1].Destructive {
		t.Fatal("mixed reset 이 파괴적으로 선언됐다")
	}
	if len(s.Hints(0)) != 0 {
		t.Fatalf("파괴적이 아닌 동작이 hint 를 남겼다: %v", s.Hints(0))
	}
}

// T4 (V203): 커밋이 없으면 **실행하지 않는다.** git 의 stderr 로 사유를 흘리면
// 사용자는 왜 막혔는지 알 수 없다.
func TestUncommittedReset_NoHead(t *testing.T) {
	repo := tempEmptyRepo(t)
	f := &writeFake{}
	s := core.New(core.WithWriteRunner(f.runner))

	if _, err := UncommittedReset(s, context.Background(), repo); !errors.Is(err, ErrUncommittedNoHead) {
		t.Fatalf("err = %v, want ErrUncommittedNoHead", err)
	}
	if len(f.argvs) != 0 {
		t.Fatalf("실행하지 않아야 한다: %v", f.argvs)
	}
}

// tempEmptyRepo 는 커밋이 하나도 없는 저장소다 (HEAD 가 없다).
func tempEmptyRepo(t *testing.T) string {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatalf("EvalSymlinks: %v", err)
	}
	gitIn(t, dir, "init", "-b", "main")
	return dir
}

// T5 (V203): Reset 은 index 만 되돌리고 워킹 트리의 내용은 남긴다.
func TestUncommittedReset_KeepsWorktree(t *testing.T) {
	repo := tempRepo(t)
	ctx := context.Background()
	writeFile(t, repo, "a.txt", "a\n")
	gitIn(t, repo, "add", "a.txt")

	s := core.New()
	if _, err := UncommittedReset(s, ctx, repo); err != nil {
		t.Fatalf("UncommittedReset: %v", err)
	}
	st, err := query.StatusOf(s, ctx, repo)
	if err != nil {
		t.Fatalf("StatusOf: %v", err)
	}
	if len(st.Staged) != 0 {
		t.Fatalf("staged = %v, want []", st.Staged)
	}
	if len(st.Untracked) != 1 || st.Untracked[0].Path != "a.txt" {
		t.Fatalf("untracked = %v, want [a.txt]", st.Untracked)
	}
	if _, err := os.Stat(filepath.Join(repo, "a.txt")); err != nil {
		t.Fatalf("워킹 트리의 파일이 사라졌다: %v", err)
	}
}

// T6 (V203): Clean 은 **파괴적으로 선언되고** 실행 전에 hint 를 남긴다. hint 의
// 명령은 `git stash push -u` 다 — 되살릴 수 없으므로 먼저 담아 두는 명령이다.
func TestCleanUntracked_DestructiveWithHint(t *testing.T) {
	repo := tempRepo(t)
	writeFile(t, repo, "u1.txt", "u\n")
	writeFile(t, repo, "u2.txt", "u\n")

	f := &writeFake{}
	s := core.New(core.WithWriteRunner(f.runner))
	if _, err := CleanUntracked(s, context.Background(), repo, Paths{"u2.txt", "u1.txt"}); err != nil {
		t.Fatalf("CleanUntracked: %v", err)
	}
	want := append(CleanUntrackedArgs(), "--", ":(literal)u1.txt", ":(literal)u2.txt")
	if len(f.argvs) != 1 || fmt.Sprint(f.argvs[0]) != fmt.Sprint(want) {
		t.Fatalf("argv = %v, want %v", f.argvs, want)
	}
	recs := s.Records(0)
	if !recs[len(recs)-1].Destructive {
		t.Fatal("clean 이 파괴적으로 선언되지 않았다")
	}
	hints := s.Hints(0)
	if len(hints) != 1 {
		t.Fatalf("hint = %d개, want 1", len(hints))
	}
	h := hints[0]
	if h.Action != core.ActionCleanUntracked || h.Repo != repo {
		t.Fatalf("hint = %+v", h)
	}
	if h.Command != "git stash push -u" {
		t.Fatalf("command = %q, want git stash push -u", h.Command)
	}
	// 무엇이 지워지는지 이름으로 말해야 사용자가 확인할 수 있다 (FR-GIT-91).
	if fmt.Sprint(h.Targets) != fmt.Sprint([]string{"u1.txt", "u2.txt"}) {
		t.Fatalf("targets = %v", h.Targets)
	}
}

// T7 (V203): 지울 것이 없으면 **실행하지 않는다.** git 은 그 실행을 exit 0 으로
// 끝내므로 성공으로 답하면 사용자는 지워진 것이 있다고 읽는다.
func TestCleanUntracked_NothingToClean(t *testing.T) {
	repo := tempRepo(t)
	f := &writeFake{}
	s := core.New(core.WithWriteRunner(f.runner))

	if _, err := CleanUntracked(s, context.Background(), repo, Paths{"u.txt"}); !errors.Is(err, ErrNothingToClean) {
		t.Fatalf("err = %v, want ErrNothingToClean", err)
	}
	if len(f.argvs) != 0 {
		t.Fatalf("실행하지 않아야 한다: %v", f.argvs)
	}
	if len(s.Hints(0)) != 0 {
		t.Fatalf("실행하지 않았는데 hint 가 남았다: %v", s.Hints(0))
	}
}

// T8 (V203): 진짜 저장소에서 untracked 만 사라지고 tracked 변경은 남는다.
func TestCleanUntracked_Real(t *testing.T) {
	repo := tempRepo(t)
	ctx := context.Background()
	writeFile(t, repo, "README.md", "x\nchanged\n")
	writeFile(t, repo, "u.txt", "u\n")
	if err := os.MkdirAll(filepath.Join(repo, "d"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, repo, "d/inner.txt", "i\n")

	s := core.New()
	if _, err := CleanUntracked(s, ctx, repo, Paths{"u.txt", "d/inner.txt"}); err != nil {
		t.Fatalf("CleanUntracked: %v", err)
	}
	// 경로 단위로 지우면 git 은 부모 디렉터리를 남긴다 — 빈 조상은 함께 지운다.
	for _, p := range []string{"u.txt", "d/inner.txt", "d"} {
		if _, err := os.Stat(filepath.Join(repo, p)); !os.IsNotExist(err) {
			t.Fatalf("%s 가 남았다: %v", p, err)
		}
	}
	st, err := query.StatusOf(s, ctx, repo)
	if err != nil {
		t.Fatalf("StatusOf: %v", err)
	}
	if len(st.Changes) != 1 || st.Changes[0].Path != "README.md" {
		t.Fatalf("changes = %v, want [README.md]", st.Changes)
	}
}

// T9 (FR-GIT-277 개정): `paths` 가 없으면 실행하지 않는다 — 빈 목록은 "확인한
// 것" 이 아니다.
func TestCleanUntracked_RequiresPaths(t *testing.T) {
	repo := tempRepo(t)
	writeFile(t, repo, "u.txt", "u\n")
	f := &writeFake{}
	s := core.New(core.WithWriteRunner(f.runner))

	if _, err := CleanUntracked(s, context.Background(), repo, nil); !errors.Is(err, core.ErrUnsafeArgument) {
		t.Fatalf("err = %v, want ErrUnsafeArgument", err)
	}
	if len(f.argvs) != 0 || len(s.Hints(0)) != 0 {
		t.Fatalf("실행하지 않아야 한다: argv %v, hint %v", f.argvs, s.Hints(0))
	}
}

// T10 (FR-GIT-277 개정): 확인한 목록과 지금의 untracked 가 다르면 실행하지 않는다.
// 확인 뒤 생긴 파일(더 많음)과 사라진 파일(더 적음) 둘 다다.
func TestCleanUntracked_ChangedSet(t *testing.T) {
	cases := map[string]Paths{
		"새로 생김": {"u1.txt"},
		"사라짐":   {"u1.txt", "u2.txt", "gone.txt"},
		"다른 이름": {"u1.txt", "other.txt"},
	}
	for name, paths := range cases {
		t.Run(name, func(t *testing.T) {
			repo := tempRepo(t)
			writeFile(t, repo, "u1.txt", "u\n")
			writeFile(t, repo, "u2.txt", "u\n")
			f := &writeFake{}
			s := core.New(core.WithWriteRunner(f.runner))

			if _, err := CleanUntracked(s, context.Background(), repo, paths); !errors.Is(err, ErrCleanChanged) {
				t.Fatalf("err = %v, want ErrCleanChanged", err)
			}
			if len(f.argvs) != 0 || len(s.Hints(0)) != 0 {
				t.Fatalf("실행하지 않아야 한다: argv %v, hint %v", f.argvs, s.Hints(0))
			}
		})
	}
}

// T11 (FR-GIT-277 개정): 같은 경로가 두 번 와도 집합으로 비교한다.
func TestCleanUntracked_DuplicatePaths(t *testing.T) {
	repo := tempRepo(t)
	writeFile(t, repo, "u.txt", "u\n")
	f := &writeFake{}
	s := core.New(core.WithWriteRunner(f.runner))

	if _, err := CleanUntracked(s, context.Background(), repo, Paths{"u.txt", "u.txt"}); err != nil {
		t.Fatalf("CleanUntracked: %v", err)
	}
	want := append(CleanUntrackedArgs(), "--", ":(literal)u.txt")
	if len(f.argvs) != 1 || fmt.Sprint(f.argvs[0]) != fmt.Sprint(want) {
		t.Fatalf("argv = %v, want %v", f.argvs, want)
	}
}

// T12 (FR-GIT-277 개정, 실측): glob 문자가 든 파일명도 literal pathspec 으로
// 지워진다. `[b]` 인 이유는 `*`·`?` 를 Windows 가 파일명으로 받지 않기 때문이다.
// 지운 경로의 조상이라도 비지 않았으면 남긴다 — 확인 뒤 생긴 파일이 든
// 디렉터리다.
func TestCleanUntracked_RealLiteralAndKeepsNonEmptyParent(t *testing.T) {
	repo := tempRepo(t)
	ctx := context.Background()
	writeFile(t, repo, "a[b]", "u\n")

	s := core.New()
	if _, err := CleanUntracked(s, ctx, repo, Paths{"a[b]"}); err != nil {
		t.Fatalf("CleanUntracked: %v", err)
	}
	if _, err := os.Stat(filepath.Join(repo, "a[b]")); !os.IsNotExist(err) {
		t.Fatalf("a[b] 가 남았다: %v", err)
	}

	if err := os.MkdirAll(filepath.Join(repo, "d", "e"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, repo, "d/new.txt", "keep\n")
	removeEmptyParents(repo, Paths{"d/e/gone.txt"})
	if _, err := os.Stat(filepath.Join(repo, "d", "e")); !os.IsNotExist(err) {
		t.Fatalf("빈 d/e 가 남았다: %v", err)
	}
	if _, err := os.Stat(filepath.Join(repo, "d", "new.txt")); err != nil {
		t.Fatalf("d/new.txt 가 지워졌다: %v", err)
	}
}
