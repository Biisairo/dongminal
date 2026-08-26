package core

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// 커밋 축 (FR-GIT-138·139, 검증 V10). 다른 세 축과 달리 리비전을 인자로 받는다.

// G11: 커밋 축의 argv 가 `<parent>:<origPath>` 와 `<oid>:<path>` 다.
func TestDiffCommit_Argv(t *testing.T) {
	var argv [][]string
	svc := New(WithRunner(func(_ context.Context, _ string, args []string) (Output, error) {
		argv = append(argv, args)
		if args[0] == "cat-file" {
			return Output{Stdout: "3\n"}, nil
		}
		return Output{Stdout: "x\n"}, nil
	}))
	dc, err := svc.DiffCommit(context.Background(), "/r", "aaa", "bbb", "new.txt", "old.txt")
	if err != nil {
		t.Fatalf("DiffCommit: %v", err)
	}
	if dc.Axis != AxisCommitParent {
		t.Fatalf("axis = %q", dc.Axis)
	}
	joined := make([]string, 0, len(argv))
	for _, a := range argv {
		joined = append(joined, strings.Join(a, " "))
	}
	all := strings.Join(joined, " | ")
	for _, want := range []string{"cat-file -s bbb:old.txt", "cat-file -s aaa:new.txt"} {
		if !strings.Contains(all, want) {
			t.Fatalf("argv 에 %q 가 없다: %s", want, all)
		}
	}
}

// G12: 루트 커밋(부모 없음)은 original 이 absent 이고 오류가 아니다.
func TestDiffCommit_RootCommitOriginalAbsent(t *testing.T) {
	svc := New(WithRunner(func(_ context.Context, _ string, args []string) (Output, error) {
		if args[0] == "cat-file" {
			return Output{Stdout: "2\n"}, nil
		}
		return Output{Stdout: "a\n"}, nil
	}))
	dc, err := svc.DiffCommit(context.Background(), "/r", "aaa", "", "f.txt", "")
	if err != nil {
		t.Fatalf("DiffCommit: %v", err)
	}
	if dc.Original.Kind != DiffKindAbsent {
		t.Fatalf("original kind = %q, want absent", dc.Original.Kind)
	}
	if dc.Modified.Kind != DiffKindText {
		t.Fatalf("modified kind = %q, want text", dc.Modified.Kind)
	}
	if dc.Note == "" {
		t.Fatal("추가된 파일 안내가 비었다")
	}
}

// G13: 리비전이 - 로 시작하면 거부한다. git 이 옵션으로 읽는다.
func TestDiffCommit_RejectsOptionLikeRev(t *testing.T) {
	svc := New(WithRunner(func(_ context.Context, _ string, _ []string) (Output, error) {
		t.Fatal("거부돼야 하는데 실행됐다")
		return Output{}, nil
	}))
	for _, c := range []struct{ oid, parent string }{{"-x", "bbb"}, {"aaa", "-x"}} {
		if _, err := svc.DiffCommit(context.Background(), "/r", c.oid, c.parent, "f.txt", ""); !errors.Is(err, ErrUnsafeRev) {
			t.Fatalf("oid=%q parent=%q err = %v, want ErrUnsafeRev", c.oid, c.parent, err)
		}
	}
}

// G14: 경로 탈출은 커밋 축에서도 거부한다 (FR-GIT-62).
func TestDiffCommit_RejectsPathEscape(t *testing.T) {
	svc := New(WithRunner(func(_ context.Context, _ string, _ []string) (Output, error) {
		t.Fatal("거부돼야 하는데 실행됐다")
		return Output{}, nil
	}))
	if _, err := svc.DiffCommit(context.Background(), "/r", "aaa", "bbb", "../etc/passwd", ""); !errors.Is(err, ErrDiffPath) {
		t.Fatalf("err = %v, want ErrDiffPath", err)
	}
}

// G15: 실제 git 으로 커밋 축을 확인한다. 부모가 없는 첫 커밋도 함께 본다.
func TestDiffCommit_RealGit(t *testing.T) {
	if testing.Short() {
		t.Skip("실제 git 필요")
	}
	dir := tempRepo(t)
	svc := New()
	run := func(args ...string) {
		t.Helper()
		if _, err := svc.ExecWrite(context.Background(), dir, WriteSpec{Argv: args}); err != nil {
			t.Fatalf("git %v: %v", args, err)
		}
	}
	first := headOid(t, svc, dir)
	writeFile(t, dir, "README.md", "x\nsecond line\n")
	run("add", "-A")
	run("commit", "-qm", "second")
	second := headOid(t, svc, dir)

	dc, err := svc.DiffCommit(context.Background(), dir, second, first, "README.md", "")
	if err != nil {
		t.Fatalf("DiffCommit: %v", err)
	}
	if dc.Original.Content != "x\n" || dc.Modified.Content != "x\nsecond line\n" {
		t.Fatalf("내용이 다르다: orig=%q mod=%q", dc.Original.Content, dc.Modified.Content)
	}

	// 부모가 없는 커밋은 original 이 absent 다 — 오류가 아니다.
	root, err := svc.DiffCommit(context.Background(), dir, first, "", "README.md", "")
	if err != nil {
		t.Fatalf("루트 커밋 DiffCommit: %v", err)
	}
	if root.Original.Kind != DiffKindAbsent {
		t.Fatalf("루트 커밋의 original kind = %q, want absent", root.Original.Kind)
	}
}

func headOid(t *testing.T, svc *Service, dir string) string {
	t.Helper()
	out, err := svc.Exec(context.Background(), dir, "rev-parse", "HEAD")
	if err != nil {
		t.Fatalf("rev-parse HEAD: %v", err)
	}
	return strings.TrimSpace(out.Stdout)
}
