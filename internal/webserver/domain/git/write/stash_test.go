package write

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/webserver/domain/git/query"

	"dongminal/internal/webserver/domain/git/core"
)

// 묶음 O — stash (GIT_SRS §3D.2 FR-GIT-161~170, 검증 V56·V57·V58).

// stashRec 는 stash list 의 레코드 하나다. 포맷의 꼬리 NUL + 개행까지 그대로
// 만든다 — 파서가 실제 출력과 같은 것을 보게 해야 한다.
func stashRec(gd, oid, gs, ct string) string {
	return strings.Join([]string{gd, oid, gs, ct}, "\x00") + "\x00\n"
}

// T1 (FR-GIT-161): `%gs` 의 두 형태와 detached. 메시지에 `: ` 가 들 수 있으므로
// 첫 것에서만 나눈다.
func TestParseStashList_Forms(t *testing.T) {
	out := stashRec("stash@{0}", strings.Repeat("a", 40), "WIP on main: abc123 subject", "1700000000") +
		stashRec("stash@{1}", strings.Repeat("b", 40), "On feat/a: has: colon in msg", "1700000060") +
		stashRec("stash@{2}", strings.Repeat("c", 40), "WIP on (no branch): abc123 subject", "1700000120")

	got, err := ParseStashList(out)
	if err != nil {
		t.Fatalf("ParseStashList: %v", err)
	}
	want := []Stash{
		{Index: 0, Oid: strings.Repeat("a", 40), Message: "abc123 subject", Base: "main", AtUnixMs: 1700000000000},
		{Index: 1, Oid: strings.Repeat("b", 40), Message: "has: colon in msg", Base: "feat/a", AtUnixMs: 1700000060000},
		{Index: 2, Oid: strings.Repeat("c", 40), Message: "abc123 subject", Base: "(no branch)", AtUnixMs: 1700000120000},
	}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("stashes =\n%v\nwant\n%v", got, want)
	}
}

// T2 (FR-GIT-161): 필드 수가 모자란 레코드는 **오류다.** 조용히 건너뛰면 목록에서
// stash 가 사라지고, 사용자는 자기 작업이 없어진 것으로 읽는다.
func TestParseStashList_ShortRecordIsError(t *testing.T) {
	cases := []string{
		"stash@{0}\x00" + strings.Repeat("a", 40) + "\x00WIP on main: x\x00\n",
		stashRec("refs/stash", strings.Repeat("a", 40), "WIP on main: x", "1700000000"),
		stashRec("stash@{x}", strings.Repeat("a", 40), "WIP on main: x", "1700000000"),
	}
	for _, out := range cases {
		if _, err := ParseStashList(out); err == nil {
			t.Fatalf("ParseStashList(%q) = nil, want error", out)
		}
	}
}

// T3 (FR-GIT-161): `%gs` 의 형태를 모르면 **항목을 버리지 않는다.** 다른 도구가
// 만든 stash 가 목록에서 사라지는 것이 더 나쁘다 — 기준 브랜치만 비운다.
func TestParseStashList_UnknownSubjectKeepsEntry(t *testing.T) {
	out := stashRec("stash@{0}", strings.Repeat("a", 40), "made by another tool", "1700000000")
	got, err := ParseStashList(out)
	if err != nil {
		t.Fatalf("ParseStashList: %v", err)
	}
	if len(got) != 1 || got[0].Base != "" || got[0].Message != "made by another tool" {
		t.Fatalf("stash = %+v", got)
	}
}

// T4 (FR-GIT-166): 생성 옵션의 argv. 메시지는 `=` 형태로 붙인다 — 별도 인자로
// 넘기면 메시지가 옵션처럼 생겼을 때 git 이 그것을 옵션으로 읽는다.
func TestStashPush_Args(t *testing.T) {
	ctx := context.Background()
	cases := []struct {
		name string
		o    StashPushOpts
		want []string
	}{
		{"기본", StashPushOpts{}, []string{"stash", "push"}},
		{
			"전부",
			StashPushOpts{Message: "-dash leading", IncludeUntracked: true, KeepIndex: true},
			[]string{"stash", "push", "--include-untracked", "--keep-index", "--message=-dash leading"},
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := &writeFake{}
			s := core.New(core.WithRunner(stashDirtyReader), core.WithWriteRunner(f.runner))
			if _, err := StashPush(s, ctx, absTmpRepo, c.o); err != nil {
				t.Fatalf("StashPush: %v", err)
			}
			if len(f.argvs) != 1 || fmt.Sprint(f.argvs[0]) != fmt.Sprint(c.want) {
				t.Fatalf("argv = %v, want %v", f.argvs, c.want)
			}
		})
	}
}

// T5 (V58, FR-GIT-167): 저장할 변경이 없으면 **실행하지 않는다.** git 은 그 경우
// exit 0 + "No local changes to save" 로 끝나므로(2.50.1 실측), 성공으로 답하면
// 사용자는 만들어지지 않은 stash 를 찾는다.
//
// untracked 만 있고 `--include-untracked` 가 없는 경우도 같다 — 그 실행이 담을
// 것이 없다.
func TestStashPush_RefusesWhenNothingToSave(t *testing.T) {
	ctx := context.Background()
	cases := []struct {
		name   string
		read   core.Runner
		opts   StashPushOpts
		refuse bool
	}{
		{"변경 없음", stashCleanReader, StashPushOpts{}, true},
		{"untracked 만 + -u 없음", stashUntrackedReader, StashPushOpts{}, true},
		{"untracked 만 + -u", stashUntrackedReader, StashPushOpts{IncludeUntracked: true}, false},
		{"tracked 변경", stashDirtyReader, StashPushOpts{}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := &writeFake{}
			s := core.New(core.WithRunner(c.read), core.WithWriteRunner(f.runner))
			_, err := StashPush(s, ctx, absTmpRepo, c.opts)
			if c.refuse {
				if !errors.Is(err, ErrStashEmpty) {
					t.Fatalf("err = %v, want ErrStashEmpty", err)
				}
				if len(f.argvs) != 0 {
					t.Fatalf("거부됐는데 실행됐다: %v", f.argvs)
				}
				return
			}
			if err != nil {
				t.Fatalf("StashPush: %v", err)
			}
			if len(f.argvs) != 1 {
				t.Fatalf("실행 횟수 = %d", len(f.argvs))
			}
		})
	}
}

// T6 (V56, FR-GIT-163·164): apply/pop 의 argv. `--index` 는 호출자가 고를 때만
// 붙는다 (FR-GIT-163).
func TestStashApplyPop_Args(t *testing.T) {
	var repo = absTmpRepo
	ctx := context.Background()
	cases := []struct {
		name string
		run  func(*core.Service) error
		want []string
	}{
		{"apply", func(s *core.Service) error { _, err := StashApply(s, ctx, repo, 1, false); return err }, []string{"stash", "apply", "stash@{1}"}},
		{"apply --index", func(s *core.Service) error { _, err := StashApply(s, ctx, repo, 0, true); return err }, []string{"stash", "apply", "--index", "stash@{0}"}},
		{"pop", func(s *core.Service) error { _, err := StashPop(s, ctx, repo, 0, false); return err }, []string{"stash", "pop", "stash@{0}"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := &writeFake{}
			s := core.New(core.WithWriteRunner(f.runner))
			if err := c.run(s); err != nil {
				t.Fatalf("%s: %v", c.name, err)
			}
			if len(f.argvs) != 1 || fmt.Sprint(f.argvs[0]) != fmt.Sprint(c.want) {
				t.Fatalf("argv = %v, want %v", f.argvs, c.want)
			}
		})
	}
}

// T7: 음수 인덱스는 인자로 넘기기 전에 거부된다 — `stash@{-1}` 은 git 에서 다른
// 뜻이 된다.
func TestStashRef_RejectsNegative(t *testing.T) {
	if _, err := StashRef(-1); !errors.Is(err, core.ErrUnsafeArgument) {
		t.Fatalf("err = %v, want ErrUnsafeArgument", err)
	}
	got, err := StashRef(3)
	if err != nil || got != "stash@{3}" {
		t.Fatalf("StashRef(3) = %q, %v", got, err)
	}
}

// T8 (V57, FR-GIT-165): **pop 이 충돌로 끝나면 git 이 stash 를 남긴다.** 실제
// 저장소로 확인한다 — argv 만 보면 이 사실을 알 수 없고, 이 요구사항의 본질은
// 그것이다. 조용히 넘기면 사용자는 작업을 잃었다고 오해한다.
func TestStashPopChecked_KeepsStashOnConflict(t *testing.T) {
	repo := tempRepoConflictingStash(t)
	s := core.New()
	ctx := context.Background()

	before, err := StashList(s, ctx, repo)
	if err != nil {
		t.Fatalf("StashList: %v", err)
	}
	if len(before) != 1 {
		t.Fatalf("준비된 stash = %d개, want 1", len(before))
	}

	_, kept, popErr := StashPopChecked(s, ctx, repo, 0, false)
	if popErr == nil {
		t.Fatal("pop 이 성공했다 — 충돌 상태를 만들지 못했다")
	}
	if !kept.Kept {
		t.Fatalf("stashKept = false — 충돌인데 남지 않았다고 답했다: %+v", kept)
	}
	if kept.Oid != before[0].Oid {
		t.Fatalf("stashKeptOid = %q, want %q", kept.Oid, before[0].Oid)
	}
	if kept.Reason == "" {
		t.Fatal("사유가 비었다 — 사용자가 무엇을 잃지 않았는지 알 수 없다")
	}

	// 목록을 다시 찍어 실제로 남아 있는지 본다. 판정이 실행 출력의 문구에 기대면
	// git 의 문구가 바뀌는 순간 거짓이 된다.
	after, err := StashList(s, ctx, repo)
	if err != nil {
		t.Fatalf("StashList: %v", err)
	}
	if len(after) != 1 || after[0].Oid != before[0].Oid {
		t.Fatalf("stash 가 남지 않았다: %+v", after)
	}
	st, err := query.StatusOf(s, ctx, repo)
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	if len(st.Conflicts) == 0 {
		t.Fatalf("충돌이 없다: %+v", st)
	}
}

// T9 (V56, FR-GIT-164): 충돌 없이 끝난 pop 은 stash 를 남기지 않는다 — Kept 가
// 언제나 참이면 사용자는 매번 남았다는 안내를 본다.
func TestStashPopChecked_DropsStashOnSuccess(t *testing.T) {
	repo := tempRepoWithStashes(t)
	s := core.New()
	ctx := context.Background()

	_, kept, err := StashPopChecked(s, ctx, repo, 0, false)
	if err != nil {
		t.Fatalf("StashPopChecked: %v", err)
	}
	if kept.Kept {
		t.Fatalf("stashKept = true: %+v", kept)
	}
	list, err := StashList(s, ctx, repo)
	if err != nil {
		t.Fatalf("StashList: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("stash = %d개, want 1", len(list))
	}
}

// T10 (V58, FR-GIT-168): drop 은 파괴적이며 **실행 전에** recovery hint 를 남긴다.
// 실행 후에 남기면 이미 지워진 stash 의 sha·메시지를 읽을 수 없다.
func TestStashDrop_HintBeforeExecuting(t *testing.T) {
	repo := tempRepoWithStashes(t)
	ctx := context.Background()

	f := newStashWriteFake(t)
	s := core.New(core.WithWriteRunner(f.runner))
	list, err := StashList(s, ctx, repo)
	if err != nil {
		t.Fatalf("StashList: %v", err)
	}
	if _, err := StashDrop(s, ctx, repo, 0); err != nil {
		t.Fatalf("StashDrop: %v", err)
	}
	if len(f.argvs) != 1 || fmt.Sprint(f.argvs[0]) != fmt.Sprint([]string{"stash", "drop", "stash@{0}"}) {
		t.Fatalf("argv = %v", f.argvs)
	}
	recs := s.Records(0)
	if !recs[len(recs)-1].Destructive {
		t.Fatal("drop 이 파괴적으로 선언되지 않았다")
	}

	hints := s.Hints(0)
	if len(hints) != 1 {
		t.Fatalf("hint = %d개, want 1", len(hints))
	}
	h := hints[0]
	if h.Action != core.ActionStashDrop || h.Repo != repo {
		t.Fatalf("hint = %+v", h)
	}
	if fmt.Sprint(h.Targets) != fmt.Sprint([]string{"stash@{0}"}) {
		t.Fatalf("targets = %v", h.Targets)
	}
	// 값이 없으면 되살릴 수 없다 (FR-GIT-92).
	if fmt.Sprint(h.Values) != fmt.Sprint([]string{list[0].Oid}) {
		t.Fatalf("values = %v, want [%s]", h.Values, list[0].Oid)
	}
	if !strings.HasPrefix(h.Command, "git stash store ") || !strings.Contains(h.Command, list[0].Oid) {
		t.Fatalf("command = %q", h.Command)
	}
	if !strings.Contains(h.Command, list[0].Message) {
		t.Fatalf("command 에 메시지가 없다: %q", h.Command)
	}
}

// T11 (FR-GIT-168): 없는 stash 는 실행 전에 거부되고 **hint 도 남지 않는다** —
// 지우지 않은 것의 복구 안내는 거짓이다.
func TestStashDrop_MissingIndex(t *testing.T) {
	repo := tempRepoWithStashes(t)
	f := newStashWriteFake(t)
	s := core.New(core.WithWriteRunner(f.runner))

	if _, err := StashDrop(s, context.Background(), repo, 9); !errors.Is(err, ErrStashNotFound) {
		t.Fatalf("err = %v, want ErrStashNotFound", err)
	}
	if len(f.argvs) != 0 {
		t.Fatalf("거부됐는데 실행됐다: %v", f.argvs)
	}
	if n := s.Hints(0); len(n) != 0 {
		t.Fatalf("hint = %d개, want 0", len(n))
	}
}

// T12 (FR-GIT-169): 미리보기는 커밋 상세와 **같은 파서**를 쓴다 — rename 은 `-z`
// 에서 세 조각이고, 파서가 두 벌이면 한쪽만 고쳐진다. 실제 저장소로 확인한다.
func TestStashPreview_ReusesNameStatusParser(t *testing.T) {
	repo := tempRepoRenameStash(t)
	s := core.New()

	files, err := StashPreview(s, context.Background(), repo, 0)
	if err != nil {
		t.Fatalf("StashPreview: %v", err)
	}
	if len(files) != 1 {
		t.Fatalf("files = %+v, want 1개", files)
	}
	f := files[0]
	if f.Status != "R" || f.OrigPath != "old.txt" || f.Path != "new.txt" || f.Score == 0 {
		t.Fatalf("file = %+v", f)
	}
}

// stashWriteFake 은 stash 의 **읽기 하위 동작만** 실제 git 으로 보내는 쓰기
// 실행기다. `stash` 가 쓰기 목록에 있어(FR-GIT-95) `stash list`·`stash show` 도
// ExecWrite 로 가므로, 쓰기를 격리하려면 그 둘은 통과시켜야 한다.
type stashWriteFake struct {
	argvs [][]string
	real  *core.Service
}

func newStashWriteFake(t *testing.T) *stashWriteFake {
	t.Helper()
	gitPath(t)
	return &stashWriteFake{real: core.New()}
}

func (f *stashWriteFake) runner(ctx context.Context, dir string, args []string, _ string) (core.Output, error) {
	if len(args) > 1 && (args[1] == "list" || args[1] == "show") {
		return f.real.ExecWrite(ctx, dir, core.WriteSpec{Argv: args})
	}
	f.argvs = append(f.argvs, append([]string(nil), args...))
	return core.Output{}, nil
}

// stashCleanReader·stashUntrackedReader·stashDirtyReader 는 status 만 답하는 읽기
// 실행기다. StashPush 의 거부 판정이 읽기 경로를 거치므로 쓰기 실행기만 주면
// 격리되지 않는다.
func stashStatusReader(recs ...string) core.Runner {
	out := strings.Join(append([]string{
		"# branch.oid " + strings.Repeat("a", 40),
		"# branch.head main",
	}, recs...), "\x00") + "\x00"
	return func(_ context.Context, _ string, args []string) (core.Output, error) {
		if args[0] == "status" {
			return core.Output{Stdout: out}, nil
		}
		return core.Output{}, nil
	}
}

var (
	stashCleanReader     = stashStatusReader()
	stashUntrackedReader = stashStatusReader("? n.txt")
	stashDirtyReader     = stashStatusReader("1 .M N... 100644 100644 100644 " +
		strings.Repeat("1", 40) + " " + strings.Repeat("2", 40) + " a.txt")
)

// tempRepoWithStashes 는 stash 2개인 저장소다 (픽스처의 stashes 와 같은 정신).
// 두 stash 는 서로 충돌하지 않는 파일을 건드리므로 pop 이 성공한다.
func tempRepoWithStashes(t *testing.T) string {
	t.Helper()
	repo := tempRepo(t)
	for _, name := range []string{"first", "second"} {
		writeFile(t, repo, name+".txt", "stashed "+name+"\n")
		gitRun(t, repo, "add", name+".txt")
		gitRun(t, repo, "stash", "push", "-q", "--message="+name+" msg")
	}
	return repo
}

// tempRepoConflictingStash 는 pop 이 반드시 충돌하는 저장소다 — stash 를 만든 뒤
// 같은 줄을 다르게 커밋한다. V57 이 딛는 유일한 상태다.
func tempRepoConflictingStash(t *testing.T) string {
	t.Helper()
	repo := tempRepo(t)
	writeFile(t, repo, "c.txt", "line1\nline2\nline3\n")
	gitRun(t, repo, "add", "c.txt")
	gitRun(t, repo, "commit", "-qm", "base")

	writeFile(t, repo, "c.txt", "line1\nSTASHED\nline3\n")
	gitRun(t, repo, "stash", "push", "-q", "--message=conflicting")

	writeFile(t, repo, "c.txt", "line1\nOTHER\nline3\n")
	gitRun(t, repo, "add", "c.txt")
	gitRun(t, repo, "commit", "-qm", "other")
	return repo
}

// tempRepoRenameStash 는 rename 하나를 담은 stash 다 — `-z` 의 세 조각 규약을
// 실제 출력으로 확인하기 위한 것이다.
func tempRepoRenameStash(t *testing.T) string {
	t.Helper()
	repo := tempRepo(t)
	writeFile(t, repo, "old.txt", "aaaaaaaaaa\nbbbbbbbbbb\ncccccccccc\n")
	gitRun(t, repo, "add", "old.txt")
	gitRun(t, repo, "commit", "-qm", "base")

	gitRun(t, repo, "mv", "old.txt", "new.txt")
	writeFile(t, repo, "new.txt", "aaaaaaaaaa\nbbbbbbbbbb\ncccccccccc\nx\n")
	gitRun(t, repo, "stash", "push", "-q", "--message=rename")
	return repo
}

func writeFile(t *testing.T, dir, name, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

// 묶음 F — Branch from stash (GIT_ACTIONS_SRS §3.6 FR-GIT-272, 검증 V199).

// T20 (FR-GIT-272): argv 는 `stash branch <name> <stash>` 다. 순서를 고정하는
// 이유는 테스트가 **무엇을 실행하지 않았는가**까지 볼 수 있어야 하기 때문이다.
func TestStashBranchArgs(t *testing.T) {
	got, err := StashBranchArgs("feat/a", 2)
	if err != nil {
		t.Fatalf("StashBranchArgs: %v", err)
	}
	if fmt.Sprint(got) != fmt.Sprint([]string{"stash", "branch", "feat/a", "stash@{2}"}) {
		t.Fatalf("argv = %v", got)
	}
}

// T21 (FR-GIT-250.3): 이름·인덱스는 실행 **전에** 본다. 클라이언트만 막으면 API
// 직접 호출이 우회한다.
func TestStashBranchArgs_Rejects(t *testing.T) {
	cases := []struct {
		name  string
		index int
	}{
		{"", 0},
		{"   ", 0},
		{"--force", 0},
		{"a..b", 0},
		{"ok", -1},
	}
	for _, c := range cases {
		if got, err := StashBranchArgs(c.name, c.index); err == nil {
			t.Fatalf("StashBranchArgs(%q,%d) = %v, want error", c.name, c.index, got)
		}
	}
}

// T22 (V199): 실행은 ExecWrite 하나만 지나고, **파괴적이 아니다** — stash 를
// 적용해 새 브랜치로 옮겨 갈 뿐 잃는 것이 없다.
func TestStashBranch_ExecutesOnce(t *testing.T) {
	repo := tempRepoWithStashes(t)
	f := newStashWriteFake(t)
	s := core.New(core.WithWriteRunner(f.runner))

	if _, err := StashBranch(s, context.Background(), repo, "feat/a", 0); err != nil {
		t.Fatalf("StashBranch: %v", err)
	}
	if len(f.argvs) != 1 {
		t.Fatalf("실행 %d회: %v", len(f.argvs), f.argvs)
	}
	if fmt.Sprint(f.argvs[0]) != fmt.Sprint([]string{"stash", "branch", "feat/a", "stash@{0}"}) {
		t.Fatalf("argv = %v", f.argvs[0])
	}
	recs := s.Records(0)
	if recs[len(recs)-1].Destructive {
		t.Fatal("stash branch 는 파괴적이 아니다")
	}
}

// T23 (V199): 없는 인덱스는 **실행하지 않는다.** 없는 stash 로 브랜치를 만들다 만
// 상태를 남기지 않으려면 실행 전에 목록으로 확인해야 한다.
func TestStashBranch_MissingIndex(t *testing.T) {
	repo := tempRepoWithStashes(t)
	f := newStashWriteFake(t)
	s := core.New(core.WithWriteRunner(f.runner))

	if _, err := StashBranch(s, context.Background(), repo, "feat/a", 9); !errors.Is(err, ErrStashNotFound) {
		t.Fatalf("err = %v, want ErrStashNotFound", err)
	}
	if len(f.argvs) != 0 {
		t.Fatalf("실행하지 않아야 한다: %v", f.argvs)
	}
}

// T24 (V199): 진짜 저장소에서 stash 가 적용된 채 새 브랜치로 옮겨 간다.
func TestStashBranch_Real(t *testing.T) {
	repo := tempRepoWithStashes(t)
	ctx := context.Background()
	s := core.New()

	before, err := StashList(s, ctx, repo)
	if err != nil {
		t.Fatalf("StashList: %v", err)
	}
	if _, err := StashBranch(s, ctx, repo, "from-stash", 0); err != nil {
		t.Fatalf("StashBranch: %v", err)
	}
	after, err := StashList(s, ctx, repo)
	if err != nil {
		t.Fatalf("StashList(2): %v", err)
	}
	// stash branch 는 성공하면 그 stash 를 지운다.
	if len(after) != len(before)-1 {
		t.Fatalf("stash = %d개, want %d", len(after), len(before)-1)
	}
	st, err := query.StatusOf(s, ctx, repo)
	if err != nil {
		t.Fatalf("StatusOf: %v", err)
	}
	if st.Branch != "from-stash" {
		t.Fatalf("branch = %q, want from-stash", st.Branch)
	}
}
