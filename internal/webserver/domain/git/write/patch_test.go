package write

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"dongminal/internal/webserver/domain/git/core"
	"dongminal/internal/webserver/domain/git/query"
)

// 묶음 G — 부분 스테이징 (GIT_ACTIONS_SRS §3.7 FR-GIT-278·279, 검증 V204·V205·V206).
//
// **패치는 서버가 만든다** (D6). 클라이언트가 만든 패치 문자열을 받아 git apply 에
// 넘기면 그것이 임의 쓰기 표면이다 — 그런 경로가 없다는 것을 여기서 못박는다.

// patchFile 은 n 줄짜리 파일을 쓴다. edit 에 든 줄만 다른 내용이 된다.
func patchFile(t *testing.T, dir, name string, n int, edit map[int]string) {
	t.Helper()
	lines := make([]string, 0, n)
	for i := 1; i <= n; i++ {
		if v, ok := edit[i]; ok {
			lines = append(lines, v)
			continue
		}
		lines = append(lines, "line"+strconv.Itoa(i))
	}
	if err := os.WriteFile(filepath.Join(dir, name), []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

// patchRepo 는 30줄 파일 하나를 커밋해 둔 저장소와 실제 git 을 쓰는 Service 다.
func patchRepo(t *testing.T) (*core.Service, string) {
	t.Helper()
	dir := tempRepo(t)
	patchFile(t, dir, "f.txt", 30, nil)
	gitIn(t, dir, "add", "f.txt")
	gitIn(t, dir, "commit", "-m", "f")
	return core.New(), dir
}

// worktreeLines·indexLines 는 두 쪽의 현재 내용이다.
func worktreeLines(t *testing.T, dir, name string) []string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil {
		t.Fatal(err)
	}
	return strings.Split(strings.TrimRight(string(b), "\n"), "\n")
}

func indexLines(t *testing.T, dir, name string) []string {
	t.Helper()
	s := core.New()
	out, err := s.Exec(context.Background(), dir, "show", ":"+name)
	if err != nil {
		t.Fatalf("show :%s: %v", name, err)
	}
	return strings.Split(strings.TrimRight(out.Stdout, "\n"), "\n")
}

func hasLine(lines []string, want string) bool {
	for _, l := range lines {
		if l == want {
			return true
		}
	}
	return false
}

// ── V204: 클라이언트가 보낸 패치를 실행하는 경로가 없다 ──

// W1 (V204): PatchOpts 에 패치·본문 필드가 없다. 문자열 필드는 **열거된 것뿐**이며
// 그 어느 것도 패치를 담을 수 없다.
//
// 구조를 테스트로 고정하는 이유: 필드 하나가 늘어나는 순간 `git apply` 가 임의
// 쓰기 표면이 되고, 그 변화는 리뷰에서 조용히 지나간다.
func TestPatchOpts_HasNoPatchField(t *testing.T) {
	allowed := map[string]bool{"Op": true, "Axis": true, "Path": true, "DiffID": true}
	rt := reflect.TypeOf(PatchOpts{})
	for i := range rt.NumField() {
		f := rt.Field(i)
		switch f.Type.Kind() {
		case reflect.String:
			if !allowed[f.Name] {
				t.Fatalf("PatchOpts.%s 는 허용되지 않은 문자열 필드다 — 패치를 담을 수 있다 (D6)", f.Name)
			}
		case reflect.Int:
			// hunk 번호·줄 범위. 패치를 담을 수 없다.
		default:
			t.Fatalf("PatchOpts.%s 의 종류(%v)는 받지 않는다 — 클라이언트가 보낼 수 있는 것은 좌표뿐이다",
				f.Name, f.Type.Kind())
		}
	}
	// 이름으로도 한 번 더 막는다 — 허용 목록을 넓히는 변경이 눈에 띄어야 한다.
	for _, bad := range []string{"Patch", "Diff", "Body", "Content", "Text", "Lines", "Hunks"} {
		if _, ok := rt.FieldByName(bad); ok {
			t.Fatalf("PatchOpts 에 %s 필드가 있다 (D6)", bad)
		}
	}
}

// W2 (V171·V204): PatchArgs 는 git 을 돌리지 않고 argv 만 만든다. 파괴적 여부가
// **op 에서 파생한다** — revert 만 참이다.
func TestPatchArgs_PureAndDerivesDestructive(t *testing.T) {
	cases := []struct {
		op          string
		want        []string
		destructive bool
	}{
		{PatchStage, []string{"apply", "--cached", "--whitespace=nowarn", "-"}, false},
		{PatchUnstage, []string{"apply", "--cached", "-R", "--whitespace=nowarn", "-"}, false},
		{PatchRevert, []string{"apply", "-R", "--whitespace=nowarn", "-"}, true},
	}
	for _, c := range cases {
		argv, destructive, err := PatchArgs(c.op)
		if err != nil {
			t.Fatalf("PatchArgs(%q): %v", c.op, err)
		}
		if !reflect.DeepEqual(argv, c.want) {
			t.Fatalf("PatchArgs(%q) argv = %v, 기대 %v", c.op, argv, c.want)
		}
		if destructive != c.destructive {
			t.Fatalf("PatchArgs(%q) destructive = %v, 기대 %v", c.op, destructive, c.destructive)
		}
	}
	if _, _, err := PatchArgs("rm -rf"); !errors.Is(err, ErrPatchOp) {
		t.Fatalf("모르는 op = %v, 기대 ErrPatchOp", err)
	}
	// argv 는 쓰기 허용 목록을 지나야 한다 (FR-GIT-95).
	for _, c := range cases {
		argv, _, _ := PatchArgs(c.op)
		if err := core.GuardWriteArgs(argv); err != nil {
			t.Fatalf("PatchArgs(%q) 가 쓰기 가드를 지나지 못한다: %v", c.op, err)
		}
	}
}

// W3 (V204): 실행 **전에** 축과 op 의 짝이 검증된다. 방향이 맞지 않는 짝은 git 을
// 돌리지 않는다.
func TestPatch_RejectsWrongAxisBeforeExec(t *testing.T) {
	f := &writeFake{}
	s := core.New(core.WithWriteRunner(f.runner))
	bad := []PatchOpts{
		{Op: PatchStage, Axis: query.AxisIndexHead, Path: "f.txt", DiffID: "x"},
		{Op: PatchUnstage, Axis: query.AxisWorktreeIndex, Path: "f.txt", DiffID: "x"},
		{Op: PatchRevert, Axis: query.AxisIndexHead, Path: "f.txt", DiffID: "x"},
		{Op: PatchStage, Axis: query.AxisWorktreeHead, Path: "f.txt", DiffID: "x"},
	}
	for _, o := range bad {
		if _, err := Patch(s, context.Background(), absRepo, o); !errors.Is(err, ErrPatchAxis) {
			t.Fatalf("%+v = %v, 기대 ErrPatchAxis", o, err)
		}
	}
	if len(f.argvs) != 0 {
		t.Fatalf("거부된 요청이 git 을 돌렸다: %v", f.argvs)
	}
}

// W4 (V204): 관측 식별자가 없으면 실행하지 않는다. 빈 값을 통과시키면 stale 가드가
// 뜻을 잃는다 — 요청을 직접 보내면 그대로 우회된다.
func TestPatch_RequiresDiffID(t *testing.T) {
	f := &writeFake{}
	s := core.New(core.WithWriteRunner(f.runner))
	o := PatchOpts{Op: PatchStage, Axis: query.AxisWorktreeIndex, Path: "f.txt"}
	if _, err := Patch(s, context.Background(), absRepo, o); !errors.Is(err, ErrPatchStale) {
		t.Fatalf("빈 diffId = %v, 기대 ErrPatchStale", err)
	}
	if len(f.argvs) != 0 {
		t.Fatalf("거부된 요청이 git 을 돌렸다: %v", f.argvs)
	}
}

// ── V205: hunk 하나만 스테이지되고 나머지는 남는다 ──

// W5 (V205): 세 hunk 중 가운데 하나만 스테이지한다. 나머지 둘은 워킹 트리에 남고
// index 에는 들어가지 않는다.
func TestPatch_StagesOneHunkOnly(t *testing.T) {
	s, dir := patchRepo(t)
	ctx := context.Background()
	patchFile(t, dir, "f.txt", 30, map[int]string{5: "FIVE", 15: "FIFTEEN", 25: "TWENTYFIVE"})

	fd, err := query.HunksOf(s, ctx, dir, query.AxisWorktreeIndex, "f.txt")
	if err != nil {
		t.Fatalf("HunksOf: %v", err)
	}
	if len(fd.Hunks) != 3 {
		t.Fatalf("hunk 수 = %d, 기대 3", len(fd.Hunks))
	}
	if _, err := Patch(s, ctx, dir, PatchOpts{
		Op: PatchStage, Axis: query.AxisWorktreeIndex, Path: "f.txt", Hunk: 1, DiffID: fd.DiffID,
	}); err != nil {
		t.Fatalf("Patch(stage hunk 1): %v", err)
	}

	idx := indexLines(t, dir, "f.txt")
	if !hasLine(idx, "FIFTEEN") {
		t.Fatalf("고른 hunk 가 index 에 없다: %v", idx)
	}
	if hasLine(idx, "FIVE") || hasLine(idx, "TWENTYFIVE") {
		t.Fatalf("고르지 않은 hunk 가 index 에 들어갔다: %v", idx)
	}
	// 워킹 트리는 그대로다 — 스테이지는 워킹 트리를 건드리지 않는다.
	wt := worktreeLines(t, dir, "f.txt")
	for _, want := range []string{"FIVE", "FIFTEEN", "TWENTYFIVE"} {
		if !hasLine(wt, want) {
			t.Fatalf("워킹 트리에서 %q 가 사라졌다: %v", want, wt)
		}
	}
	// 남은 hunk 는 여전히 두 개다.
	rest, err := query.HunksOf(s, ctx, dir, query.AxisWorktreeIndex, "f.txt")
	if err != nil {
		t.Fatalf("HunksOf: %v", err)
	}
	if len(rest.Hunks) != 2 {
		t.Fatalf("남은 hunk 수 = %d, 기대 2", len(rest.Hunks))
	}
}

// W6 (V205): 관측이 그 사이 바뀌었으면 거부한다. 낡은 hunk 번호로 다른 곳을
// 고치지 않는다.
func TestPatch_RejectsStaleObservation(t *testing.T) {
	s, dir := patchRepo(t)
	ctx := context.Background()
	patchFile(t, dir, "f.txt", 30, map[int]string{5: "FIVE", 25: "TWENTYFIVE"})
	fd, err := query.HunksOf(s, ctx, dir, query.AxisWorktreeIndex, "f.txt")
	if err != nil {
		t.Fatalf("HunksOf: %v", err)
	}
	// 사용자가 보던 사이에 파일이 바뀌었다 — 같은 hunk 번호가 다른 곳을 가리킨다.
	patchFile(t, dir, "f.txt", 30, map[int]string{5: "FIVE", 15: "FIFTEEN", 25: "TWENTYFIVE"})

	_, err = Patch(s, ctx, dir, PatchOpts{
		Op: PatchStage, Axis: query.AxisWorktreeIndex, Path: "f.txt", Hunk: 1, DiffID: fd.DiffID,
	})
	if !errors.Is(err, ErrPatchStale) {
		t.Fatalf("낡은 관측 = %v, 기대 ErrPatchStale", err)
	}
	// 아무것도 스테이지되지 않았다.
	idx := indexLines(t, dir, "f.txt")
	for _, bad := range []string{"FIVE", "FIFTEEN", "TWENTYFIVE"} {
		if hasLine(idx, bad) {
			t.Fatalf("거부된 요청이 index 를 바꿨다 (%q): %v", bad, idx)
		}
	}
}

// W7 (V205): 범위를 벗어난 hunk 번호는 실행 전에 거부된다.
func TestPatch_RejectsHunkOutOfRange(t *testing.T) {
	s, dir := patchRepo(t)
	ctx := context.Background()
	patchFile(t, dir, "f.txt", 30, map[int]string{5: "FIVE"})
	fd, err := query.HunksOf(s, ctx, dir, query.AxisWorktreeIndex, "f.txt")
	if err != nil {
		t.Fatalf("HunksOf: %v", err)
	}
	for _, n := range []int{-1, 1, 99} {
		_, err := Patch(s, ctx, dir, PatchOpts{
			Op: PatchStage, Axis: query.AxisWorktreeIndex, Path: "f.txt", Hunk: n, DiffID: fd.DiffID,
		})
		if !errors.Is(err, ErrPatchRange) {
			t.Fatalf("hunk %d = %v, 기대 ErrPatchRange", n, err)
		}
	}
}

// W8 (V205): unstage 는 index↔HEAD 축의 그 hunk 만 되돌린다.
func TestPatch_UnstagesOneHunkOnly(t *testing.T) {
	s, dir := patchRepo(t)
	ctx := context.Background()
	patchFile(t, dir, "f.txt", 30, map[int]string{5: "FIVE", 25: "TWENTYFIVE"})
	gitIn(t, dir, "add", "f.txt")

	fd, err := query.HunksOf(s, ctx, dir, query.AxisIndexHead, "f.txt")
	if err != nil {
		t.Fatalf("HunksOf: %v", err)
	}
	if len(fd.Hunks) != 2 {
		t.Fatalf("hunk 수 = %d, 기대 2", len(fd.Hunks))
	}
	if _, err := Patch(s, ctx, dir, PatchOpts{
		Op: PatchUnstage, Axis: query.AxisIndexHead, Path: "f.txt", Hunk: 0, DiffID: fd.DiffID,
	}); err != nil {
		t.Fatalf("Patch(unstage hunk 0): %v", err)
	}
	idx := indexLines(t, dir, "f.txt")
	if hasLine(idx, "FIVE") {
		t.Fatalf("내린 hunk 가 index 에 남았다: %v", idx)
	}
	if !hasLine(idx, "TWENTYFIVE") {
		t.Fatalf("내리지 않은 hunk 가 index 에서 사라졌다: %v", idx)
	}
	// 워킹 트리는 그대로다.
	wt := worktreeLines(t, dir, "f.txt")
	if !hasLine(wt, "FIVE") || !hasLine(wt, "TWENTYFIVE") {
		t.Fatalf("unstage 가 워킹 트리를 바꿨다: %v", wt)
	}
}

// ── V206: 줄 범위가 그 범위에만 적용된다 ──

// W9 (V206): 한 hunk 안의 두 변경 중 고른 범위만 스테이지된다. 고르지 않은 쪽은
// index 에서 **원래 내용 그대로** 남는다.
func TestPatch_LineRangeStagesOnlySelected(t *testing.T) {
	s, dir := patchRepo(t)
	ctx := context.Background()
	// 한 줄 건너 두 곳을 고친다 — 한 hunk 안에 변경 짝이 둘이다.
	patchFile(t, dir, "f.txt", 30, map[int]string{10: "TEN", 12: "TWELVE"})
	fd, err := query.HunksOf(s, ctx, dir, query.AxisWorktreeIndex, "f.txt")
	if err != nil {
		t.Fatalf("HunksOf: %v", err)
	}
	if len(fd.Hunks) != 1 {
		t.Fatalf("hunk 수 = %d, 기대 1", len(fd.Hunks))
	}
	h := fd.Hunks[0]
	// 첫 변경 짝(-line10 / +TEN) 만 고른다.
	from := lineIndexOf(t, h.Lines, "-line10")
	to := lineIndexOf(t, h.Lines, "+TEN")
	if _, err := Patch(s, ctx, dir, PatchOpts{
		Op: PatchStage, Axis: query.AxisWorktreeIndex, Path: "f.txt",
		Hunk: 0, From: from, To: to, DiffID: fd.DiffID,
	}); err != nil {
		t.Fatalf("Patch(line range): %v", err)
	}
	idx := indexLines(t, dir, "f.txt")
	if !hasLine(idx, "TEN") || hasLine(idx, "line10") {
		t.Fatalf("고른 범위가 index 에 반영되지 않았다: %v", idx)
	}
	if hasLine(idx, "TWELVE") || !hasLine(idx, "line12") {
		t.Fatalf("고르지 않은 범위가 index 에 들어갔다: %v", idx)
	}
	// 워킹 트리는 그대로다.
	wt := worktreeLines(t, dir, "f.txt")
	if !hasLine(wt, "TEN") || !hasLine(wt, "TWELVE") {
		t.Fatalf("stage 가 워킹 트리를 바꿨다: %v", wt)
	}
}

// W10 (V206): revert 는 워킹 트리의 그 줄만 버린다. **파괴적이다** —
// core.ActionDiscard 로 recovery hint 를 실행 전에 남긴다 (FR-GIT-92·250.2).
func TestPatch_RevertDropsOnlySelectedLines(t *testing.T) {
	s, dir := patchRepo(t)
	ctx := context.Background()
	patchFile(t, dir, "f.txt", 30, map[int]string{10: "TEN", 12: "TWELVE"})
	fd, err := query.HunksOf(s, ctx, dir, query.AxisWorktreeIndex, "f.txt")
	if err != nil {
		t.Fatalf("HunksOf: %v", err)
	}
	h := fd.Hunks[0]
	from := lineIndexOf(t, h.Lines, "-line10")
	to := lineIndexOf(t, h.Lines, "+TEN")
	if _, err := Patch(s, ctx, dir, PatchOpts{
		Op: PatchRevert, Axis: query.AxisWorktreeIndex, Path: "f.txt",
		Hunk: 0, From: from, To: to, DiffID: fd.DiffID,
	}); err != nil {
		t.Fatalf("Patch(revert): %v", err)
	}
	wt := worktreeLines(t, dir, "f.txt")
	if hasLine(wt, "TEN") || !hasLine(wt, "line10") {
		t.Fatalf("고른 범위가 워킹 트리에서 되돌려지지 않았다: %v", wt)
	}
	if !hasLine(wt, "TWELVE") || hasLine(wt, "line12") {
		t.Fatalf("고르지 않은 범위까지 되돌렸다: %v", wt)
	}
	// hint 는 되살릴 명령이다 (FR-GIT-92) — 안내문만 남기지 않는다.
	hints := s.Hints(0)
	if len(hints) == 0 {
		t.Fatal("revert 가 hint 를 남기지 않았다")
	}
	last := hints[len(hints)-1]
	if last.Action != core.ActionDiscard {
		t.Fatalf("hint.Action = %q, 기대 %q", last.Action, core.ActionDiscard)
	}
	if !strings.Contains(last.Command, "git stash push") || !strings.Contains(last.Command, "f.txt") {
		t.Fatalf("hint.Command = %q — 되살릴 명령이 아니다", last.Command)
	}
}

// W11 (V206): 뒤집힌 범위와 범위 밖 번호는 실행 전에 거부된다.
func TestPatch_RejectsBadLineRange(t *testing.T) {
	s, dir := patchRepo(t)
	ctx := context.Background()
	patchFile(t, dir, "f.txt", 30, map[int]string{10: "TEN"})
	fd, err := query.HunksOf(s, ctx, dir, query.AxisWorktreeIndex, "f.txt")
	if err != nil {
		t.Fatalf("HunksOf: %v", err)
	}
	n := len(fd.Hunks[0].Lines)
	bad := [][2]int{{3, 2}, {0, 2}, {1, n + 1}, {-1, 1}}
	for _, r := range bad {
		_, err := Patch(s, ctx, dir, PatchOpts{
			Op: PatchStage, Axis: query.AxisWorktreeIndex, Path: "f.txt",
			Hunk: 0, From: r[0], To: r[1], DiffID: fd.DiffID,
		})
		if !errors.Is(err, ErrPatchRange) {
			t.Fatalf("범위 %v = %v, 기대 ErrPatchRange", r, err)
		}
	}
}

// W12 (V206): 고른 범위에 바뀐 줄이 하나도 없으면 빈 패치가 된다 — 실행하지 않고
// 거부한다. 빈 패치를 git 에 넘기면 아무 일도 없이 성공으로 보인다.
func TestPatch_RejectsSelectionWithoutChange(t *testing.T) {
	s, dir := patchRepo(t)
	ctx := context.Background()
	patchFile(t, dir, "f.txt", 30, map[int]string{10: "TEN"})
	fd, err := query.HunksOf(s, ctx, dir, query.AxisWorktreeIndex, "f.txt")
	if err != nil {
		t.Fatalf("HunksOf: %v", err)
	}
	// 첫 줄은 문맥이다.
	if _, err := Patch(s, ctx, dir, PatchOpts{
		Op: PatchStage, Axis: query.AxisWorktreeIndex, Path: "f.txt",
		Hunk: 0, From: 1, To: 1, DiffID: fd.DiffID,
	}); !errors.Is(err, ErrPatchEmpty) {
		t.Fatalf("문맥만 고른 범위 = %v, 기대 ErrPatchEmpty", err)
	}
}

// lineIndexOf 는 hunk 본문에서 그 줄의 1-기반 번호다.
func lineIndexOf(t *testing.T, lines []string, want string) int {
	t.Helper()
	for i, l := range lines {
		if l == want {
			return i + 1
		}
	}
	t.Fatalf("hunk 본문에 %q 가 없다: %v", want, lines)
	return 0
}

// W13 (V205): 끝 개행이 없는 파일. `\ No newline at end of file` 은 앞 줄에 딸린
// 표식이므로 앞 줄을 뺐으면 함께 빠져야 한다 — 남기면 없는 줄에 대한 표식이 되고
// git 이 패치를 거부한다.
func TestPatch_HandlesNoNewlineAtEOF(t *testing.T) {
	s, dir := patchRepo(t)
	ctx := context.Background()
	if err := os.WriteFile(filepath.Join(dir, "n.txt"), []byte("a\nb\nc"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitIn(t, dir, "add", "n.txt")
	gitIn(t, dir, "commit", "-m", "n")
	if err := os.WriteFile(filepath.Join(dir, "n.txt"), []byte("a\nb\nC"), 0o644); err != nil {
		t.Fatal(err)
	}

	fd, err := query.HunksOf(s, ctx, dir, query.AxisWorktreeIndex, "n.txt")
	if err != nil {
		t.Fatalf("HunksOf: %v", err)
	}
	if len(fd.Hunks) != 1 {
		t.Fatalf("hunk 수 = %d, 기대 1", len(fd.Hunks))
	}
	if _, err := Patch(s, ctx, dir, PatchOpts{
		Op: PatchStage, Axis: query.AxisWorktreeIndex, Path: "n.txt", Hunk: 0, DiffID: fd.DiffID,
	}); err != nil {
		t.Fatalf("Patch(stage): %v", err)
	}
	if idx := indexLines(t, dir, "n.txt"); !hasLine(idx, "C") {
		t.Fatalf("index = %v", idx)
	}
}
