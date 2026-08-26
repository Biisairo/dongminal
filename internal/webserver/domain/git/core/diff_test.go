package core

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// 묶음 F 서버측 — diff 양쪽 내용 (GIT_SRS §3.6 FR-GIT-44~48·62, 검증 V10).
//
// 실제 git 없이 결정론적으로 돈다. Runner 주입(FR-GIT-4)이 argv 를 관찰하게 해
// **무엇을 실행하지 않았는가**까지 고정할 수 있다 (G6).

// diffFake 은 rev 문자열로 blob 을 들고 있는 Runner 다. 없는 rev 에는 실제 git 의
// fatal 문구를 그대로 흉내낸다 — absent 판정이 그 문구에 의존하기 때문이다.
type diffFake struct {
	blobs map[string]string
	// sizes 는 본문과 다른 크기를 답할 때만 쓴다. 상한 초과를 1MiB 픽스처 없이
	// 시험하려면 크기와 본문을 분리할 수 있어야 한다.
	sizes map[string]int64
	argvs [][]string
}

func newDiffFake() *diffFake {
	return &diffFake{blobs: map[string]string{}, sizes: map[string]int64{}}
}

func (f *diffFake) run(_ context.Context, _ string, args []string) (Output, error) {
	f.argvs = append(f.argvs, append([]string(nil), args...))
	rev := args[len(args)-1]
	body, ok := f.blobs[rev]
	if !ok {
		p := strings.TrimPrefix(strings.TrimPrefix(rev, "HEAD:"), ":")
		return Output{ExitCode: 128, Stderr: "fatal: path '" + p + "' does not exist in 'HEAD'\n"}, nil
	}
	if args[0] == "cat-file" {
		if n, ok := f.sizes[rev]; ok {
			return Output{Stdout: strconv.FormatInt(n, 10) + "\n"}, nil
		}
		return Output{Stdout: strconv.Itoa(len(body)) + "\n"}, nil
	}
	return Output{Stdout: body}, nil
}

// calls 는 기록된 argv 를 공백으로 이어 준다. 순서까지 비교하기 위한 형태다.
func (f *diffFake) calls() []string {
	out := make([]string, 0, len(f.argvs))
	for _, a := range f.argvs {
		out = append(out, strings.Join(a, " "))
	}
	return out
}

func diffWrite(t *testing.T, dir, rel, body string) {
	t.Helper()
	p := filepath.Join(dir, rel)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

// diffRepo 는 심링크를 푼 빈 디렉터리다. macOS 의 /var → /private/var 때문에
// 리포 경계 검사가 헛되게 실패하지 않도록 미리 푼다.
func diffRepo(t *testing.T) string {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatalf("EvalSymlinks: %v", err)
	}
	return dir
}

// G1 (V10, FR-GIT-44): 3개 축이 각각 정해진 rev 를 만든다. 축이 어긋나면 사용자는
// 다른 두 상태를 비교하고 있는 줄도 모른다.
func TestDiffContent_AxisArgv(t *testing.T) {
	for _, tc := range []struct {
		axis string
		want []string
	}{
		{AxisWorktreeIndex, []string{"cat-file -s :p.txt", "show :p.txt"}},
		{AxisIndexHead, []string{"cat-file -s HEAD:p.txt", "show HEAD:p.txt", "cat-file -s :p.txt", "show :p.txt"}},
		{AxisWorktreeHead, []string{"cat-file -s HEAD:p.txt", "show HEAD:p.txt"}},
	} {
		t.Run(tc.axis, func(t *testing.T) {
			repo := diffRepo(t)
			diffWrite(t, repo, "p.txt", "work\n")
			f := newDiffFake()
			f.blobs[":p.txt"] = "index\n"
			f.blobs["HEAD:p.txt"] = "head\n"
			dc, err := New(WithRunner(f.run)).DiffContent(context.Background(), repo, tc.axis, "p.txt", "")
			if err != nil {
				t.Fatalf("DiffContent: %v", err)
			}
			if got := f.calls(); !equalStrings(got, tc.want) {
				t.Fatalf("argv = %v, want %v", got, tc.want)
			}
			if dc.Axis != tc.axis || dc.Path != "p.txt" || dc.OrigPath != "p.txt" || dc.Repo != repo {
				t.Fatalf("응답 식별자 = %+v", dc)
			}
			if dc.Original.Kind != DiffKindText || dc.Modified.Kind != DiffKindText {
				t.Fatalf("kind = %q/%q", dc.Original.Kind, dc.Modified.Kind)
			}
			if dc.Note != "" {
				t.Fatalf("양쪽이 text 인데 note = %q", dc.Note)
			}
		})
	}
}

// 축별 양쪽 내용이 표와 같은지 본다 — argv 가 맞아도 좌우가 뒤바뀌면 diff 방향이
// 거꾸로 보인다.
func TestDiffContent_AxisSides(t *testing.T) {
	repo := diffRepo(t)
	diffWrite(t, repo, "p.txt", "work\n")
	newFake := func() *diffFake {
		f := newDiffFake()
		f.blobs[":p.txt"] = "index\n"
		f.blobs["HEAD:p.txt"] = "head\n"
		return f
	}
	for _, tc := range []struct{ axis, orig, mod string }{
		{AxisWorktreeIndex, "index\n", "work\n"},
		{AxisIndexHead, "head\n", "index\n"},
		{AxisWorktreeHead, "head\n", "work\n"},
	} {
		dc, err := New(WithRunner(newFake().run)).DiffContent(context.Background(), repo, tc.axis, "p.txt", "")
		if err != nil {
			t.Fatalf("%s: %v", tc.axis, err)
		}
		if dc.Original.Content != tc.orig || dc.Modified.Content != tc.mod {
			t.Fatalf("%s: %q/%q, want %q/%q", tc.axis, dc.Original.Content, dc.Modified.Content, tc.orig, tc.mod)
		}
	}
}

// G2 (V10, FR-GIT-45): 추가된 파일은 original 이 absent 다. 오류로 올려보내면 새
// 파일의 diff 가 전부 실패한다.
func TestDiffContent_AddedFile(t *testing.T) {
	repo := diffRepo(t)
	diffWrite(t, repo, "new.txt", "hello\n")
	f := newDiffFake()
	dc, err := New(WithRunner(f.run)).DiffContent(context.Background(), repo, AxisWorktreeIndex, "new.txt", "")
	if err != nil {
		t.Fatalf("DiffContent: %v", err)
	}
	if dc.Original.Kind != DiffKindAbsent || dc.Original.Content != "" || dc.Original.Size != 0 {
		t.Fatalf("original = %+v", dc.Original)
	}
	if dc.Modified.Kind != DiffKindText || dc.Modified.Content != "hello\n" || dc.Modified.Size != 6 {
		t.Fatalf("modified = %+v", dc.Modified)
	}
	if dc.Note == "" {
		t.Fatal("한쪽이 absent 인데 note 가 비었다")
	}
	// 없는 blob 에는 show 를 부르지 않는다.
	for _, c := range f.calls() {
		if strings.HasPrefix(c, "show") {
			t.Fatalf("absent 인데 %q 를 불렀다", c)
		}
	}
}

// 추적되지 않는 파일도 absent 다 — git 은 "exists on disk, but not in the index"
// 라는 다른 문구를 준다. 문구 하나만 보면 untracked 파일이 500 이 된다.
func TestDiffContent_UntrackedIsAbsent(t *testing.T) {
	repo := diffRepo(t)
	diffWrite(t, repo, "u.txt", "u\n")
	run := func(_ context.Context, _ string, _ []string) (Output, error) {
		return Output{ExitCode: 128, Stderr: "fatal: path 'u.txt' exists on disk, but not in the index\n"}, nil
	}
	dc, err := New(WithRunner(run)).DiffContent(context.Background(), repo, AxisWorktreeIndex, "u.txt", "")
	if err != nil {
		t.Fatalf("DiffContent: %v", err)
	}
	if dc.Original.Kind != DiffKindAbsent {
		t.Fatalf("original = %+v", dc.Original)
	}
}

// 커밋이 없는 저장소의 HEAD 도 absent 다 (fatal: invalid object name 'HEAD').
func TestDiffContent_InitialRepoHeadIsAbsent(t *testing.T) {
	repo := diffRepo(t)
	diffWrite(t, repo, "a.txt", "a\n")
	run := func(_ context.Context, _ string, _ []string) (Output, error) {
		return Output{ExitCode: 128, Stderr: "fatal: invalid object name 'HEAD'.\n"}, nil
	}
	dc, err := New(WithRunner(run)).DiffContent(context.Background(), repo, AxisWorktreeHead, "a.txt", "")
	if err != nil {
		t.Fatalf("DiffContent: %v", err)
	}
	if dc.Original.Kind != DiffKindAbsent || dc.Modified.Kind != DiffKindText {
		t.Fatalf("kind = %q/%q", dc.Original.Kind, dc.Modified.Kind)
	}
}

// 분류되지 않는 exit 128 은 오류다. absent 로 뭉개면 실제 실패가 빈 diff 로 보인다.
func TestDiffContent_OtherFatalIsError(t *testing.T) {
	repo := diffRepo(t)
	run := func(_ context.Context, _ string, _ []string) (Output, error) {
		return Output{ExitCode: 128, Stderr: "fatal: unable to read object\n"}, nil
	}
	if _, err := New(WithRunner(run)).DiffContent(context.Background(), repo, AxisIndexHead, "a.txt", ""); err == nil {
		t.Fatal("분류되지 않은 fatal 인데 오류가 아니다")
	}
}

// G3 (V10, FR-GIT-45): 삭제된 파일은 modified 가 absent 다.
func TestDiffContent_DeletedFile(t *testing.T) {
	repo := diffRepo(t)
	f := newDiffFake()
	f.blobs[":gone.txt"] = "bye\n"
	dc, err := New(WithRunner(f.run)).DiffContent(context.Background(), repo, AxisWorktreeIndex, "gone.txt", "")
	if err != nil {
		t.Fatalf("DiffContent: %v", err)
	}
	if dc.Original.Kind != DiffKindText || dc.Original.Content != "bye\n" {
		t.Fatalf("original = %+v", dc.Original)
	}
	if dc.Modified.Kind != DiffKindAbsent || dc.Modified.Content != "" {
		t.Fatalf("modified = %+v", dc.Modified)
	}
	if dc.Note == "" {
		t.Fatal("삭제인데 note 가 비었다")
	}
}

// 디렉터리는 absent 다. 워킹 트리 쪽에서 디렉터리를 읽으려 하면 오류가 되고,
// 그 오류는 사용자에게 아무것도 설명하지 못한다.
func TestDiffContent_WorktreeDirIsAbsent(t *testing.T) {
	repo := diffRepo(t)
	if err := os.MkdirAll(filepath.Join(repo, "d"), 0o755); err != nil {
		t.Fatal(err)
	}
	f := newDiffFake()
	f.blobs[":d"] = "x\n"
	dc, err := New(WithRunner(f.run)).DiffContent(context.Background(), repo, AxisWorktreeIndex, "d", "")
	if err != nil {
		t.Fatalf("DiffContent: %v", err)
	}
	if dc.Modified.Kind != DiffKindAbsent {
		t.Fatalf("modified = %+v", dc.Modified)
	}
}

// G4 (V10, FR-GIT-46): NUL 이 있으면 바이너리고 본문을 주지 않는다.
func TestDiffContent_Binary(t *testing.T) {
	repo := diffRepo(t)
	diffWrite(t, repo, "b.bin", "PNG\x00\x01\x02")
	f := newDiffFake()
	f.blobs[":b.bin"] = "GIF\x00head"
	dc, err := New(WithRunner(f.run)).DiffContent(context.Background(), repo, AxisWorktreeIndex, "b.bin", "")
	if err != nil {
		t.Fatalf("DiffContent: %v", err)
	}
	for name, side := range map[string]DiffSide{"original": dc.Original, "modified": dc.Modified} {
		if side.Kind != DiffKindBinary || side.Content != "" || side.Size == 0 {
			t.Fatalf("%s = %+v", name, side)
		}
	}
	if dc.Note == "" {
		t.Fatal("바이너리인데 note 가 비었다")
	}
}

// NUL 이 탐지 폭 뒤에만 있으면 text 다 — git 의 휴리스틱과 같은 폭을 쓴다.
func TestDiffContent_NULBeyondSniffWindowIsText(t *testing.T) {
	repo := diffRepo(t)
	body := strings.Repeat("a", BinarySniffBytes) + "\x00"
	diffWrite(t, repo, "late.txt", body)
	f := newDiffFake()
	f.blobs[":late.txt"] = "x\n"
	dc, err := New(WithRunner(f.run)).DiffContent(context.Background(), repo, AxisWorktreeIndex, "late.txt", "")
	if err != nil {
		t.Fatalf("DiffContent: %v", err)
	}
	if dc.Modified.Kind != DiffKindText {
		t.Fatalf("modified = %q", dc.Modified.Kind)
	}
}

// G5 (V10, FR-GIT-47): LFS 포인터는 oid·size 를 뽑고 kind 를 lfs 로 둔다.
func TestDiffContent_LFSPointer(t *testing.T) {
	repo := diffRepo(t)
	ptr := "version https://git-lfs.github.com/spec/v1\n" +
		"oid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\n" +
		"size 12345\n"
	diffWrite(t, repo, "big.psd", ptr)
	f := newDiffFake()
	f.blobs[":big.psd"] = ptr
	dc, err := New(WithRunner(f.run)).DiffContent(context.Background(), repo, AxisWorktreeIndex, "big.psd", "")
	if err != nil {
		t.Fatalf("DiffContent: %v", err)
	}
	for name, side := range map[string]DiffSide{"original": dc.Original, "modified": dc.Modified} {
		if side.Kind != DiffKindLFS || side.Content != "" {
			t.Fatalf("%s = %+v", name, side)
		}
		if side.LFSOid != "4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393" || side.LFSSize != 12345 {
			t.Fatalf("%s 메타 = %+v", name, side)
		}
	}
	if dc.Note == "" {
		t.Fatal("LFS 인데 note 가 비었다")
	}
}

// 포인터 크기 상한을 넘는 본문은 LFS 가 아니다 — 우연히 같은 첫 줄로 시작하는
// 텍스트 파일을 포인터로 오인하지 않는다.
func TestDiffContent_LFSPrefixTooLargeIsText(t *testing.T) {
	repo := diffRepo(t)
	body := "version https://git-lfs.github.com/spec/v1\n" + strings.Repeat("x", LFSMaxPointerBytes)
	diffWrite(t, repo, "notlfs.txt", body)
	f := newDiffFake()
	f.blobs[":notlfs.txt"] = "x\n"
	dc, err := New(WithRunner(f.run)).DiffContent(context.Background(), repo, AxisWorktreeIndex, "notlfs.txt", "")
	if err != nil {
		t.Fatalf("DiffContent: %v", err)
	}
	if dc.Modified.Kind != DiffKindText {
		t.Fatalf("modified = %q", dc.Modified.Kind)
	}
}

// G6 (V10, FR-GIT-48): 상한을 넘으면 본문을 **읽지 않는다.** blob 쪽에서는
// git show 를 부르지 않는 것으로 확인한다.
func TestDiffContent_TooLargeSkipsRead(t *testing.T) {
	repo := diffRepo(t)
	big := strings.Repeat("z", DiffMaxBytes+1)
	diffWrite(t, repo, "huge.txt", big)
	f := newDiffFake()
	f.blobs[":huge.txt"] = "index\n"
	f.sizes[":huge.txt"] = DiffMaxBytes + 1
	dc, err := New(WithRunner(f.run)).DiffContent(context.Background(), repo, AxisWorktreeIndex, "huge.txt", "")
	if err != nil {
		t.Fatalf("DiffContent: %v", err)
	}
	if dc.Original.Kind != DiffKindTooLarge || dc.Original.Content != "" || dc.Original.Size != DiffMaxBytes+1 {
		t.Fatalf("original = %+v (size %d)", dc.Original.Kind, dc.Original.Size)
	}
	if dc.Modified.Kind != DiffKindTooLarge || dc.Modified.Content != "" {
		t.Fatalf("modified = %+v", dc.Modified)
	}
	if got := f.calls(); !equalStrings(got, []string{"cat-file -s :huge.txt"}) {
		t.Fatalf("argv = %v — 상한 초과인데 본문을 읽었다", got)
	}
	if dc.Note == "" {
		t.Fatal("상한 초과인데 note 가 비었다")
	}
}

// 상한과 같은 크기는 통과한다 — 경계는 초과에서만 걸린다.
func TestDiffContent_SizeAtLimitIsText(t *testing.T) {
	repo := diffRepo(t)
	f := newDiffFake()
	f.blobs[":at.txt"] = strings.Repeat("z", 8)
	f.sizes[":at.txt"] = DiffMaxBytes
	dc, err := New(WithRunner(f.run)).DiffContent(context.Background(), repo, AxisWorktreeIndex, "at.txt", "")
	if err != nil {
		t.Fatalf("DiffContent: %v", err)
	}
	if dc.Original.Kind != DiffKindText {
		t.Fatalf("original = %+v", dc.Original)
	}
}

// G7 (V10, FR-GIT-44): rename 은 original 쪽에 origPath 를 쓴다. path 를 쓰면
// 이름이 바뀐 파일이 "전부 추가" 로 보인다.
func TestDiffContent_RenameUsesOrigPath(t *testing.T) {
	repo := diffRepo(t)
	f := newDiffFake()
	f.blobs["HEAD:old.txt"] = "old\n"
	f.blobs[":new.txt"] = "new\n"
	dc, err := New(WithRunner(f.run)).DiffContent(context.Background(), repo, AxisIndexHead, "new.txt", "old.txt")
	if err != nil {
		t.Fatalf("DiffContent: %v", err)
	}
	want := []string{"cat-file -s HEAD:old.txt", "show HEAD:old.txt", "cat-file -s :new.txt", "show :new.txt"}
	if got := f.calls(); !equalStrings(got, want) {
		t.Fatalf("argv = %v, want %v", got, want)
	}
	if dc.OrigPath != "old.txt" || dc.Path != "new.txt" {
		t.Fatalf("경로 = %q/%q", dc.OrigPath, dc.Path)
	}
	if dc.Original.Content != "old\n" || dc.Modified.Content != "new\n" {
		t.Fatalf("내용 = %q/%q", dc.Original.Content, dc.Modified.Content)
	}
}

// G8 (FR-GIT-62): 리포를 벗어나는 경로는 거부한다. 워킹 트리 파일을 직접 읽는
// 경로이므로 여기가 뚫리면 임의 파일 읽기다.
func TestDiffContent_RejectsPathEscape(t *testing.T) {
	repo := diffRepo(t)
	f := newDiffFake()
	svc := New(WithRunner(f.run))
	for _, tc := range []struct{ name, path, orig string }{
		{"빈 경로", "", ""},
		{"부모 참조", "../secret.txt", ""},
		{"중간 부모 참조", "a/../../secret.txt", ""},
		{"절대경로", "/etc/passwd", ""},
		{"origPath 부모 참조", "a.txt", "../secret.txt"},
		{"origPath 절대경로", "a.txt", "/etc/passwd"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := svc.DiffContent(context.Background(), repo, AxisWorktreeIndex, tc.path, tc.orig)
			if !errors.Is(err, ErrDiffPath) {
				t.Fatalf("err = %v, want ErrDiffPath", err)
			}
		})
	}
	if len(f.argvs) != 0 {
		t.Fatalf("거부된 요청인데 git 을 %d회 불렀다: %v", len(f.argvs), f.calls())
	}
}

// 심링크로 리포 밖을 가리키는 경우도 막는다. 경로 문자열에는 `..` 이 없다.
func TestDiffContent_RejectsSymlinkEscape(t *testing.T) {
	outside := diffRepo(t)
	if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("s\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	repo := diffRepo(t)
	if err := os.Symlink(filepath.Join(outside, "secret.txt"), filepath.Join(repo, "link.txt")); err != nil {
		t.Skipf("심링크를 만들 수 없다: %v", err)
	}
	if err := os.Symlink(outside, filepath.Join(repo, "dir")); err != nil {
		t.Skipf("심링크를 만들 수 없다: %v", err)
	}
	f := newDiffFake()
	f.blobs[":link.txt"] = "x\n"
	f.blobs[":dir/secret.txt"] = "x\n"
	svc := New(WithRunner(f.run))
	for _, p := range []string{"link.txt", "dir/secret.txt"} {
		if _, err := svc.DiffContent(context.Background(), repo, AxisWorktreeIndex, p, ""); !errors.Is(err, ErrDiffPath) {
			t.Fatalf("%s: err = %v, want ErrDiffPath", p, err)
		}
	}
}

// 존재하지 않는 경로는 거부가 아니라 absent 다 — 심링크를 풀 수 없다는 이유로
// 새 파일의 diff 를 막으면 안 된다.
func TestDiffContent_MissingPathIsAbsentNotRejected(t *testing.T) {
	repo := diffRepo(t)
	f := newDiffFake()
	f.blobs[":deep/gone.txt"] = "x\n"
	dc, err := New(WithRunner(f.run)).DiffContent(context.Background(), repo, AxisWorktreeIndex, "deep/gone.txt", "")
	if err != nil {
		t.Fatalf("DiffContent: %v", err)
	}
	if dc.Modified.Kind != DiffKindAbsent {
		t.Fatalf("modified = %+v", dc.Modified)
	}
}

// G9: 양쪽 모두 absent 면 요청 자체가 잘못된 것이다. 빈 diff 를 그리지 않는다.
func TestDiffContent_BothAbsentIsError(t *testing.T) {
	repo := diffRepo(t)
	f := newDiffFake()
	_, err := New(WithRunner(f.run)).DiffContent(context.Background(), repo, AxisWorktreeIndex, "nowhere.txt", "")
	if !errors.Is(err, ErrDiffBothAbsent) {
		t.Fatalf("err = %v, want ErrDiffBothAbsent", err)
	}
}

// 모르는 축은 거부한다. commit-parent 는 M4 이며 지금은 없는 축이다.
func TestDiffContent_RejectsUnknownAxis(t *testing.T) {
	repo := diffRepo(t)
	f := newDiffFake()
	svc := New(WithRunner(f.run))
	for _, axis := range []string{"", "commit-parent", "worktree", "INDEX-HEAD"} {
		if _, err := svc.DiffContent(context.Background(), repo, axis, "a.txt", ""); !errors.Is(err, ErrDiffAxis) {
			t.Fatalf("axis %q: err = %v, want ErrDiffAxis", axis, err)
		}
	}
	if len(f.argvs) != 0 {
		t.Fatalf("거부된 축인데 git 을 %d회 불렀다: %v", len(f.argvs), f.calls())
	}
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// 실제 git 으로 absent 판정의 근거인 fatal 문구를 고정한다. 단위 테스트의 픽스처는
// 내가 믿는 문구일 뿐이므로, git 이 문구를 바꾸면 여기서 먼저 깨져야 한다.
func TestDiffContent_RealGit(t *testing.T) {
	repo := tempRepo(t)
	svc := New()
	ctx := context.Background()

	// 추가: index 에 없고 워킹 트리에만 있다.
	diffWrite(t, repo, "added.txt", "new\n")
	dc, err := svc.DiffContent(ctx, repo, AxisWorktreeIndex, "added.txt", "")
	if err != nil {
		t.Fatalf("추가: %v", err)
	}
	if dc.Original.Kind != DiffKindAbsent || dc.Modified.Kind != DiffKindText {
		t.Fatalf("추가 = %q/%q", dc.Original.Kind, dc.Modified.Kind)
	}

	// 삭제: HEAD 에 있고 워킹 트리에 없다.
	if err := os.Remove(filepath.Join(repo, "README.md")); err != nil {
		t.Fatal(err)
	}
	dc, err = svc.DiffContent(ctx, repo, AxisWorktreeHead, "README.md", "")
	if err != nil {
		t.Fatalf("삭제: %v", err)
	}
	if dc.Original.Kind != DiffKindText || dc.Original.Content != "x\n" || dc.Modified.Kind != DiffKindAbsent {
		t.Fatalf("삭제 = %+v / %+v", dc.Original, dc.Modified)
	}

	// rename: HEAD 의 옛 경로와 index 의 새 경로를 비교한다.
	gitIn(t, repo, "add", "added.txt")
	gitIn(t, repo, "mv", "added.txt", "moved.txt")
	dc, err = svc.DiffContent(ctx, repo, AxisIndexHead, "moved.txt", "README.md")
	if err != nil {
		t.Fatalf("rename: %v", err)
	}
	if dc.Original.Content != "x\n" || dc.Modified.Content != "new\n" {
		t.Fatalf("rename = %q/%q", dc.Original.Content, dc.Modified.Content)
	}

	// 커밋이 없는 저장소의 HEAD 는 absent 다.
	initial, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	gitIn(t, initial, "init", "-b", "main")
	diffWrite(t, initial, "only.txt", "o\n")
	dc, err = svc.DiffContent(ctx, initial, AxisWorktreeHead, "only.txt", "")
	if err != nil {
		t.Fatalf("초기 저장소: %v", err)
	}
	if dc.Original.Kind != DiffKindAbsent || dc.Modified.Kind != DiffKindText {
		t.Fatalf("초기 저장소 = %q/%q", dc.Original.Kind, dc.Modified.Kind)
	}
}
