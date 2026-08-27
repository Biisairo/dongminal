package query

import (
	"context"
	"errors"
	"strings"
	"testing"

	"dongminal/internal/webserver/domain/git/core"
)

// FR-GIT-276 — blame. 줄마다 어느 커밋에서 왔는지를 답한다.
//
// 파싱은 실제 git 없이 결정론적으로 돈다. argv 는 Runner 주입으로 관찰해 **무엇을
// 실행하지 않았는가**까지 고정한다 (log_test.go 와 같은 규약).

type blameFake struct {
	stdout    string
	truncated bool
	argvs     [][]string
}

func (f *blameFake) run(_ context.Context, _ string, args []string) (core.Output, error) {
	f.argvs = append(f.argvs, append([]string(nil), args...))
	return core.Output{Stdout: f.stdout, StdoutTruncated: f.truncated}, nil
}

func (f *blameFake) lastCall() string {
	if len(f.argvs) == 0 {
		return ""
	}
	return strings.Join(f.argvs[len(f.argvs)-1], " ")
}

// porcelain 은 커밋 메타를 **처음 한 번만** 낸다. 두 번째 등장은 헤더 한 줄과
// 본문뿐이다 — 그것을 "메타 없는 커밋" 으로 읽으면 두 번째 줄부터 작성자가 빈다.
const blamePorcelain = "" +
	"1111111111111111111111111111111111111111 1 1 2\n" +
	"author 김 동민\n" +
	"author-mail <dy@example.com>\n" +
	"author-time 1700000000\n" +
	"author-tz +0900\n" +
	"summary 첫 커밋 · 유니코드\n" +
	"filename f.txt\n" +
	"\ta\n" +
	"1111111111111111111111111111111111111111 2 2\n" +
	"\t\t들여쓴 줄\n" +
	"2222222222222222222222222222222222222222 3 3 1\n" +
	"author tester\n" +
	"author-mail <t@example.com>\n" +
	"author-time 1700000060\n" +
	"author-tz +0900\n" +
	"summary 둘째\n" +
	"previous 1111111111111111111111111111111111111111 f.txt\n" +
	"filename f.txt\n" +
	"\tc\n"

func TestParseBlame_LinesAndCommits(t *testing.T) {
	b, err := ParseBlame(blamePorcelain)
	if err != nil {
		t.Fatalf("ParseBlame: %v", err)
	}
	if len(b.Lines) != 3 {
		t.Fatalf("줄 수 = %d, want 3: %+v", len(b.Lines), b.Lines)
	}
	want := []struct {
		oid  string
		line int
		text string
	}{
		{"1111111111111111111111111111111111111111", 1, "a"},
		{"1111111111111111111111111111111111111111", 2, "\t들여쓴 줄"},
		{"2222222222222222222222222222222222222222", 3, "c"},
	}
	for i, w := range want {
		got := b.Lines[i]
		if got.Oid != w.oid || got.Line != w.line || got.Text != w.text {
			t.Fatalf("lines[%d] = %+v, want %+v", i, got, w)
		}
	}
	// 커밋 메타는 한 벌만 싣는다 — 줄마다 되풀이하면 큰 파일에서 응답이 본문보다
	// 커진다.
	if len(b.Commits) != 2 {
		t.Fatalf("커밋 수 = %d, want 2: %+v", len(b.Commits), b.Commits)
	}
	c := b.Commits["1111111111111111111111111111111111111111"]
	if c.AuthorName != "김 동민" || c.AuthorMail != "dy@example.com" {
		t.Fatalf("author = %q / %q", c.AuthorName, c.AuthorMail)
	}
	// unix 초를 ms 로 옮긴다 — 초를 그대로 실으면 표시 계층이 1000배 틀린다
	// (ParseLog 와 같은 규약).
	if c.AuthorAt != 1700000000000 {
		t.Fatalf("authorAt = %d", c.AuthorAt)
	}
	if c.Summary != "첫 커밋 · 유니코드" {
		t.Fatalf("summary = %q", c.Summary)
	}
	if c.Uncommitted {
		t.Fatalf("커밋된 줄인데 uncommitted 다: %+v", c)
	}
}

// 미커밋 줄의 oid 는 40개의 0 이다. 그것을 커밋으로 그리면 사용자는 없는 커밋을
// 열려고 한다.
func TestParseBlame_UncommittedLine(t *testing.T) {
	out := "" +
		"0000000000000000000000000000000000000000 1 1 1\n" +
		"author Not Committed Yet\n" +
		"author-mail <not.committed.yet>\n" +
		"author-time 1700000000\n" +
		"summary Version of f.txt from f.txt\n" +
		"filename f.txt\n" +
		"\t새 줄\n"
	b, err := ParseBlame(out)
	if err != nil {
		t.Fatalf("ParseBlame: %v", err)
	}
	if len(b.Lines) != 1 || b.Lines[0].Text != "새 줄" {
		t.Fatalf("lines = %+v", b.Lines)
	}
	c := b.Commits[b.Lines[0].Oid]
	if !c.Uncommitted {
		t.Fatalf("미커밋 줄이 커밋으로 온다: %+v", c)
	}
}

// 빈 파일은 줄 0개다. nil 이 아니라 빈 슬라이스여야 JSON 이 [] 가 된다.
func TestParseBlame_EmptyIsNoLines(t *testing.T) {
	b, err := ParseBlame("")
	if err != nil {
		t.Fatalf("ParseBlame: %v", err)
	}
	if b.Lines == nil || len(b.Lines) != 0 || b.Commits == nil {
		t.Fatalf("b = %#v", b)
	}
}

// 헤더 없이 본문이 오면 오류다. 조용히 건너뛰면 줄 번호가 밀리고 사용자는 남의
// 커밋을 자기 줄의 것으로 읽는다.
func TestParseBlame_BodyWithoutHeaderIsError(t *testing.T) {
	if _, err := ParseBlame("\ta\n"); err == nil {
		t.Fatal("오류가 아니다")
	}
}

func TestBlame_Argv(t *testing.T) {
	for _, tc := range []struct {
		name string
		q    BlameQuery
		want string
	}{
		{"기본", BlameQuery{Path: "d ir/한글.txt"},
			"blame --porcelain -- d ir/한글.txt"},
		{"rev", BlameQuery{Rev: "HEAD~1", Path: "f.txt"},
			"blame --porcelain HEAD~1 -- f.txt"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := &blameFake{}
			q := tc.q
			q.Repo = "/repo"
			if _, err := Blame(core.New(core.WithRunner(f.run)), context.Background(), q); err != nil {
				t.Fatalf("Blame: %v", err)
			}
			if got := f.lastCall(); got != tc.want {
				t.Fatalf("argv = %q\nwant   %q", got, tc.want)
			}
		})
	}
}

// rev 는 위치 인자로 들어가므로 옵션처럼 생긴 값은 받지 않는다 (FR-GIT-62).
func TestBlame_RejectsOptionLikeRev(t *testing.T) {
	f := &blameFake{}
	_, err := Blame(core.New(core.WithRunner(f.run)), context.Background(),
		BlameQuery{Repo: "/repo", Rev: "--all", Path: "f.txt"})
	if !errors.Is(err, ErrUnsafeRev) {
		t.Fatalf("err = %v, want ErrUnsafeRev", err)
	}
	if len(f.argvs) != 0 {
		t.Fatalf("거부했는데 실행했다: %v", f.argvs)
	}
}

// 경로는 리포 상대여야 한다 (FR-GIT-62).
func TestBlame_RejectsUnsafePath(t *testing.T) {
	f := &blameFake{}
	_, err := Blame(core.New(core.WithRunner(f.run)), context.Background(),
		BlameQuery{Repo: "/repo", Path: "../etc/passwd"})
	if err == nil {
		t.Fatal("오류가 아니다")
	}
	if len(f.argvs) != 0 {
		t.Fatalf("거부했는데 실행했다: %v", f.argvs)
	}
}

// 잘린 출력을 목록으로 주면 사용자는 없는 줄을 없다고 믿는다 (diff 의 상한 규약을
// 물려받는다 — FR-GIT-48).
func TestBlame_TruncatedOutputIsError(t *testing.T) {
	f := &blameFake{stdout: blamePorcelain, truncated: true}
	_, err := Blame(core.New(core.WithRunner(f.run)), context.Background(),
		BlameQuery{Repo: "/repo", Path: "f.txt"})
	if !errors.Is(err, ErrBlameTruncated) {
		t.Fatalf("err = %v, want ErrBlameTruncated", err)
	}
}

// 실제 git 으로 본다. 커밋 둘과 미커밋 한 줄이 각각 제 커밋을 가리켜야 한다.
func TestBlame_RealGit(t *testing.T) {
	repo := tempRepo(t)
	writeFile(t, repo, "f.txt", "a\nb\n")
	gitIn(t, repo, "add", "-A")
	gitIn(t, repo, "commit", "-m", "첫 줄들")
	writeFile(t, repo, "f.txt", "a\nBB\n")
	gitIn(t, repo, "add", "-A")
	gitIn(t, repo, "commit", "-m", "둘째 줄 고침")
	writeFile(t, repo, "f.txt", "a\nBB\n아직 커밋 안 함\n")

	b, err := Blame(core.New(), context.Background(), BlameQuery{Repo: repo, Path: "f.txt"})
	if err != nil {
		t.Fatalf("Blame: %v", err)
	}
	if len(b.Lines) != 3 {
		t.Fatalf("줄 수 = %d: %+v", len(b.Lines), b.Lines)
	}
	if b.Lines[0].Oid == b.Lines[1].Oid {
		t.Fatalf("첫 줄과 둘째 줄이 같은 커밋이다: %+v", b.Lines)
	}
	if s := b.Commits[b.Lines[0].Oid].Summary; s != "첫 줄들" {
		t.Fatalf("lines[0] summary = %q", s)
	}
	if s := b.Commits[b.Lines[1].Oid].Summary; s != "둘째 줄 고침" {
		t.Fatalf("lines[1] summary = %q", s)
	}
	if !b.Commits[b.Lines[2].Oid].Uncommitted {
		t.Fatalf("셋째 줄이 미커밋이 아니다: %+v", b.Commits[b.Lines[2].Oid])
	}
	if b.Lines[2].Text != "아직 커밋 안 함" {
		t.Fatalf("lines[2].Text = %q", b.Lines[2].Text)
	}
}

// rev 를 주면 그 시점의 파일을 본다 — 미커밋 줄이 없어야 한다.
func TestBlame_RealGit_AtRev(t *testing.T) {
	repo := tempRepo(t)
	writeFile(t, repo, "f.txt", "a\n")
	gitIn(t, repo, "add", "-A")
	gitIn(t, repo, "commit", "-m", "하나")
	writeFile(t, repo, "f.txt", "a\nb\n")
	gitIn(t, repo, "add", "-A")
	gitIn(t, repo, "commit", "-m", "둘")

	b, err := Blame(core.New(), context.Background(),
		BlameQuery{Repo: repo, Rev: "HEAD~1", Path: "f.txt"})
	if err != nil {
		t.Fatalf("Blame: %v", err)
	}
	if len(b.Lines) != 1 || b.Lines[0].Text != "a" {
		t.Fatalf("lines = %+v", b.Lines)
	}
}

// 없는 경로는 오류다 — 빈 blame 으로 답하면 사용자는 파일이 빈 것으로 읽는다.
func TestBlame_UnknownPathIsError(t *testing.T) {
	repo := tempRepo(t)
	_, err := Blame(core.New(), context.Background(), BlameQuery{Repo: repo, Path: "없는파일.txt"})
	if !errors.Is(err, ErrBlamePathNotFound) {
		t.Fatalf("err = %v, want ErrBlamePathNotFound", err)
	}
}
