package core

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// 묶음 M 서버측 — 커밋 상세 (GIT_SRS §3C.2 FR-GIT-136·137·139, 검증 V45·V51).

// detailFake 은 하위 명령별로 stdout 을 답하며 argv 를 기록한다. log 와 diff-tree 가
// 한 호출 안에서 잇달아 나가므로 **어느 쪽이 무엇을 받았는지** 갈라 봐야 한다.
type detailFake struct {
	logOut  string
	treeOut string
	stderr  string
	exit    int
	argvs   [][]string
}

func (f *detailFake) run(_ context.Context, _ string, args []string) (Output, error) {
	f.argvs = append(f.argvs, append([]string(nil), args...))
	if f.exit != 0 {
		return Output{ExitCode: f.exit, Stderr: f.stderr}, nil
	}
	if args[0] == "log" {
		return Output{Stdout: f.logOut}, nil
	}
	return Output{Stdout: f.treeOut}, nil
}

func (f *detailFake) calls() []string {
	out := make([]string, 0, len(f.argvs))
	for _, a := range f.argvs {
		out = append(out, strings.Join(a, " "))
	}
	return out
}

// detailRec 은 상세 레코드 하나를 만든다 (12 필드).
func detailRec(oid, parents, dec, subject, body string) string {
	return strings.Join([]string{
		oid, oid[:4], parents, "김 동민", "dy@example.com", "1700000000", "1700000060",
		dec, subject, "커미터", "c@example.com", body,
	}, "\x00")
}

// M1 (V45, FR-GIT-137): name-status -z 를 조각 단위로 읽는다. rename 은 세 조각이며
// 두 조각으로 세면 다음 파일의 상태가 경로 자리에 들어간다.
func TestParseNameStatusZ(t *testing.T) {
	// diff-tree -z 는 **모든 필드를 NUL 로 끝낸다** (git 2.50.1 실측) — log -z 와
	// 다르며, 그래서 꼬리 빈 토큰을 떼야 한다.
	out := "M\x00a.txt\x00" +
		"R100\x00old name.txt\x00d ir/한글 파일.txt\x00" +
		"A\x00b.txt\x00" +
		"C75\x00src.txt\x00copy.txt\x00" +
		"D\x00gone.txt\x00" +
		"T\x00link\x00"
	fs, err := ParseNameStatusZ(out)
	if err != nil {
		t.Fatalf("ParseNameStatusZ: %v", err)
	}
	want := []CommitFile{
		{Status: "M", Path: "a.txt"},
		{Status: "R", Path: "d ir/한글 파일.txt", OrigPath: "old name.txt", Score: 100},
		{Status: "A", Path: "b.txt"},
		{Status: "C", Path: "copy.txt", OrigPath: "src.txt", Score: 75},
		{Status: "D", Path: "gone.txt"},
		{Status: "T", Path: "link"},
	}
	if len(fs) != len(want) {
		t.Fatalf("파일 수 = %d, want %d: %+v", len(fs), len(want), fs)
	}
	for i, w := range want {
		if fs[i] != w {
			t.Fatalf("files[%d] = %+v, want %+v", i, fs[i], w)
		}
	}
}

func TestParseNameStatusZ_Empty(t *testing.T) {
	fs, err := ParseNameStatusZ("")
	if err != nil {
		t.Fatalf("ParseNameStatusZ: %v", err)
	}
	if fs == nil || len(fs) != 0 {
		t.Fatalf("fs = %#v", fs)
	}
}

// M2 (V45): 조각이 모자란 레코드는 오류다. 조용히 버리면 상세가 변경 파일을 빠뜨린다.
func TestParseNameStatusZ_ShortRecordIsError(t *testing.T) {
	for _, tc := range []struct {
		name string
		out  string
	}{
		{"경로가_없다", "M\x00"},
		{"rename_대상이_없다", "R100\x00old.txt\x00"},
		{"상태가_비었다", "\x00a.txt\x00"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := ParseNameStatusZ(tc.out); err == nil {
				t.Fatal("오류가 아니다")
			}
		})
	}
}

// M3 (FR-GIT-139): 머지 커밋은 비교 부모를 골라야 한다. 부모 n 은 `<oid>^<n+1>` 이며,
// 부모가 없는 루트 커밋만 --root 로 간다.
func TestCommitDetail_Argv(t *testing.T) {
	const oid = "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0"
	logCall := "log -z " + detailFormat + " " + logDecorate + " -n 1 " + oid
	tree := "diff-tree --no-commit-id --name-status -r -z -M "
	for _, tc := range []struct {
		name    string
		parents string
		index   int
		want    []string
	}{
		{"단일부모_기본", "p1", 0, []string{logCall, tree + oid + "^1 " + oid}},
		{"머지_두번째_부모", "p1 p2", 1, []string{logCall, tree + oid + "^2 " + oid}},
		{"루트커밋", "", 0, []string{logCall, tree + "--root " + oid}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := &detailFake{logOut: detailRec(oid, tc.parents, "", "s", "s\n"), treeOut: "M\x00a.txt\x00"}
			d, err := New(WithRunner(f.run)).CommitDetail(context.Background(), "/repo", oid, tc.index)
			if err != nil {
				t.Fatalf("CommitDetail: %v", err)
			}
			if got := f.calls(); !equalStrings(got, tc.want) {
				t.Fatalf("argv = %v\nwant   %v", got, tc.want)
			}
			// 루트 커밋은 비교한 부모가 없다 — 0 을 답하면 "첫 부모와 비교했다"로 읽힌다.
			wantIdx := tc.index
			if tc.parents == "" {
				wantIdx = CommitNoParent
			}
			if d.ParentIndex != wantIdx {
				t.Fatalf("ParentIndex = %d, want %d", d.ParentIndex, wantIdx)
			}
		})
	}
}

// M4 (FR-GIT-136): 상세는 커미터와 메시지 전문을 싣는다. %B 는 제목까지 포함한다.
func TestCommitDetail_Fields(t *testing.T) {
	const oid = "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0"
	body := "제목 줄\n\n본문 첫 줄\n본문 둘째 줄\n"
	f := &detailFake{
		logOut:  detailRec(oid, "p1 p2", "HEAD -> refs/heads/main", "제목 줄", body),
		treeOut: "A\x00new.txt\x00",
	}
	d, err := New(WithRunner(f.run)).CommitDetail(context.Background(), "/repo", oid, 0)
	if err != nil {
		t.Fatalf("CommitDetail: %v", err)
	}
	if d.Oid != oid || d.Subject != "제목 줄" || d.Body != body {
		t.Fatalf("d = %+v", d)
	}
	if d.CommitterName != "커미터" || d.CommitterMail != "c@example.com" {
		t.Fatalf("committer = %q / %q", d.CommitterName, d.CommitterMail)
	}
	if len(d.Parents) != 2 || !d.IsHead {
		t.Fatalf("parents/head = %v / %v", d.Parents, d.IsHead)
	}
	if len(d.Files) != 1 || d.Files[0].Path != "new.txt" {
		t.Fatalf("files = %+v", d.Files)
	}
}

// M5 (FR-GIT-139): 범위를 벗어난 부모 번호는 거부한다. 클램프하면 사용자는 자기가
// 고르지 않은 부모와의 비교를 보고 있다고 모른 채 읽는다.
func TestCommitDetail_RejectsBadParentIndex(t *testing.T) {
	const oid = "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0"
	for _, tc := range []struct {
		name    string
		parents string
		index   int
	}{
		{"음수", "p1", -1},
		{"부모수_초과", "p1", 1},
		{"머지_부모수_초과", "p1 p2", 2},
		{"루트에_1", "", 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := &detailFake{logOut: detailRec(oid, tc.parents, "", "s", "s\n")}
			_, err := New(WithRunner(f.run)).CommitDetail(context.Background(), "/repo", oid, tc.index)
			if !errors.Is(err, ErrCommitParent) {
				t.Fatalf("err = %v, want ErrCommitParent", err)
			}
			// log 는 나갔지만 diff-tree 는 나가지 않았다.
			if len(f.argvs) != 1 {
				t.Fatalf("호출 = %v", f.calls())
			}
		})
	}
}

func TestCommitDetail_RejectsOptionLikeOid(t *testing.T) {
	f := &detailFake{}
	_, err := New(WithRunner(f.run)).CommitDetail(context.Background(), "/repo", "--all", 0)
	if !errors.Is(err, ErrUnsafeRev) {
		t.Fatalf("err = %v, want ErrUnsafeRev", err)
	}
	if len(f.argvs) != 0 {
		t.Fatalf("거부했는데 실행했다: %v", f.calls())
	}
}

func TestCommitDetail_UnknownOidIsNotFound(t *testing.T) {
	f := &detailFake{exit: 128, stderr: "fatal: bad object deadbeef\n"}
	_, err := New(WithRunner(f.run)).CommitDetail(context.Background(), "/repo", "deadbeef", 0)
	if !errors.Is(err, ErrRevNotFound) {
		t.Fatalf("err = %v, want ErrRevNotFound", err)
	}
}

// 상세가 비면 커밋이 없다는 뜻이다 — 빈 CommitDetail 을 성공으로 돌려주면 사용자는
// 내용 없는 커밋을 본다.
func TestCommitDetail_EmptyLogIsNotFound(t *testing.T) {
	f := &detailFake{logOut: ""}
	_, err := New(WithRunner(f.run)).CommitDetail(context.Background(), "/repo", "a1b2c3d4", 0)
	if !errors.Is(err, ErrRevNotFound) {
		t.Fatalf("err = %v, want ErrRevNotFound", err)
	}
}

// M6 (V45·V51, FR-GIT-137·139): 실제 git 으로 부모별 변경 파일과 rename 을 고정한다.
func TestCommitDetail_RealGit(t *testing.T) {
	repo := logRealRepo(t)
	s := New()
	ctx := context.Background()
	cs, err := s.Log(ctx, LogQuery{Repo: repo, Order: LogOrderTopo})
	if err != nil {
		t.Fatalf("Log: %v", err)
	}
	bySubject := map[string]Commit{}
	for _, c := range cs {
		bySubject[c.Subject] = c
	}

	// 머지 커밋: 부모 0(main 쪽)과 비교하면 side 가 들여온 파일이, 부모 1(side 쪽)과
	// 비교하면 main 쪽 rename 이 보인다.
	merge := bySubject["merge side"]
	if len(merge.Parents) != 2 {
		t.Fatalf("merge parents = %v", merge.Parents)
	}
	d0, err := s.CommitDetail(ctx, repo, merge.Oid, 0)
	if err != nil {
		t.Fatalf("CommitDetail(p0): %v", err)
	}
	if len(d0.Files) != 1 || d0.Files[0].Path != "d ir/한글 파일.txt" || d0.Files[0].Status != "A" {
		t.Fatalf("p0 files = %+v", d0.Files)
	}
	if d0.ParentIndex != 0 || d0.Body == "" || d0.CommitterName == "" {
		t.Fatalf("d0 = %+v", d0)
	}
	d1, err := s.CommitDetail(ctx, repo, merge.Oid, 1)
	if err != nil {
		t.Fatalf("CommitDetail(p1): %v", err)
	}
	paths := map[string]CommitFile{}
	for _, f := range d1.Files {
		paths[f.Path] = f
	}
	if _, ok := paths["RE ADME.md"]; !ok {
		t.Fatalf("p1 files = %+v", d1.Files)
	}
	if d1.ParentIndex != 1 {
		t.Fatalf("ParentIndex = %d", d1.ParentIndex)
	}

	// rename 커밋: -M 이 없으면 D+A 두 줄이 되고 origPath 를 잃는다 (FR-GIT-36).
	ren, err := s.CommitDetail(ctx, repo, bySubject["rename with space"].Oid, 0)
	if err != nil {
		t.Fatalf("CommitDetail(rename): %v", err)
	}
	if len(ren.Files) != 1 {
		t.Fatalf("rename files = %+v", ren.Files)
	}
	if f := ren.Files[0]; f.Status != "R" || f.Path != "RE ADME.md" || f.OrigPath != "README.md" || f.Score != 100 {
		t.Fatalf("rename = %+v", f)
	}

	// 루트 커밋: --root 경로. 부모가 없으므로 ParentIndex 는 CommitNoParent 다.
	root, err := s.CommitDetail(ctx, repo, bySubject["init"].Oid, 0)
	if err != nil {
		t.Fatalf("CommitDetail(root): %v", err)
	}
	if root.ParentIndex != CommitNoParent || len(root.Parents) != 0 {
		t.Fatalf("root = %+v", root)
	}
	if len(root.Files) != 1 || root.Files[0].Path != "README.md" || root.Files[0].Status != "A" {
		t.Fatalf("root files = %+v", root.Files)
	}

	// 메시지 전문은 본문 줄을 잃지 않는다 (FR-GIT-136).
	second, err := s.CommitDetail(ctx, repo, bySubject["두 번째 · 유니코드"].Oid, 0)
	if err != nil {
		t.Fatalf("CommitDetail(second): %v", err)
	}
	if !strings.Contains(second.Body, "본문 둘째 줄") {
		t.Fatalf("body = %q", second.Body)
	}
}
