package query

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"dongminal/internal/webserver/domain/git/core"
)

// 묶음 G — hunk 경계 (GIT_ACTIONS_SRS §3.7 FR-GIT-278, 검증 V204·V205).
//
// hunk 경계를 아는 것은 diff 를 만드는 이 자리다. **패치는 서버가 만든다** (D6) —
// 그러려면 서버가 자기가 만든 diff 의 경계를 정확히 알아야 한다.

// hunkFile 은 hunk 가 여럿 생기도록 멀리 떨어진 줄만 고친 파일을 만든다.
// U3 문맥이 겹치지 않으려면 변경 사이가 최소 7줄이어야 한다.
func hunkFile(t *testing.T, dir, name string, n int, edit map[int]string) {
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

// hunkRepo 는 30줄 파일 하나를 커밋해 둔 저장소다.
func hunkRepo(t *testing.T) (*core.Service, string) {
	t.Helper()
	dir := tempRepo(t)
	hunkFile(t, dir, "f.txt", 30, nil)
	gitRun(t, dir, "add", "f.txt")
	gitRun(t, dir, "commit", "-m", "f")
	return core.New(), dir
}

// Q1 (V204): 서버가 만든 diff 에서 hunk 경계가 정확히 나온다. 멀리 떨어진 세 곳을
// 고치면 hunk 도 셋이다.
func TestHunksOf_ParsesBoundaries(t *testing.T) {
	s, dir := hunkRepo(t)
	hunkFile(t, dir, "f.txt", 30, map[int]string{5: "FIVE", 15: "FIFTEEN", 25: "TWENTYFIVE"})

	fd, err := HunksOf(s, context.Background(), dir, AxisWorktreeIndex, "f.txt")
	if err != nil {
		t.Fatalf("HunksOf: %v", err)
	}
	if len(fd.Hunks) != 3 {
		t.Fatalf("hunk 수 = %d, 기대 3: %+v", len(fd.Hunks), fd.Hunks)
	}
	for i, h := range fd.Hunks {
		if h.Index != i {
			t.Fatalf("hunk[%d].Index = %d", i, h.Index)
		}
		if !strings.HasPrefix(h.Header, "@@") {
			t.Fatalf("hunk[%d].Header = %q", i, h.Header)
		}
		if h.OldLines != len(hunkSide(h.Lines, '-')) || h.NewLines != len(hunkSide(h.Lines, '+')) {
			t.Fatalf("hunk[%d] 의 머리 개수가 본문과 다르다: %+v", i, h)
		}
	}
	// 첫 hunk 는 5번째 줄을 담는다 — 문맥 3줄이므로 2에서 시작한다.
	if got := fd.Hunks[0].OldStart; got != 2 {
		t.Fatalf("hunk[0].OldStart = %d, 기대 2", got)
	}
	if fd.DiffID == "" {
		t.Fatal("DiffID 가 비었다 — 관측 식별자가 없으면 stale 을 판정할 수 없다")
	}
	if len(fd.Preamble) == 0 {
		t.Fatal("Preamble 이 비었다 — --- / +++ 없이는 패치가 성립하지 않는다")
	}
}

// hunkSide 는 한쪽에 남는 줄들이다. ' ' 는 양쪽에 든다.
func hunkSide(lines []string, sign byte) []string {
	out := []string{}
	for _, l := range lines {
		if l == "" {
			continue
		}
		if l[0] == ' ' || l[0] == sign {
			out = append(out, l)
		}
	}
	return out
}

// Q2 (V204): 관측이 바뀌면 DiffID 도 바뀐다. 값이 변화를 놓치면 낡은 hunk 번호가
// 다른 곳을 고친다.
func TestHunksOf_DiffIDTracksContent(t *testing.T) {
	s, dir := hunkRepo(t)
	ctx := context.Background()
	hunkFile(t, dir, "f.txt", 30, map[int]string{5: "FIVE"})
	a, err := HunksOf(s, ctx, dir, AxisWorktreeIndex, "f.txt")
	if err != nil {
		t.Fatalf("HunksOf: %v", err)
	}
	same, err := HunksOf(s, ctx, dir, AxisWorktreeIndex, "f.txt")
	if err != nil {
		t.Fatalf("HunksOf: %v", err)
	}
	if a.DiffID != same.DiffID {
		t.Fatalf("같은 관측인데 DiffID 가 다르다: %q vs %q", a.DiffID, same.DiffID)
	}
	hunkFile(t, dir, "f.txt", 30, map[int]string{5: "FIVE!"})
	b, err := HunksOf(s, ctx, dir, AxisWorktreeIndex, "f.txt")
	if err != nil {
		t.Fatalf("HunksOf: %v", err)
	}
	if a.DiffID == b.DiffID {
		t.Fatal("내용이 바뀌었는데 DiffID 가 같다")
	}
}

// Q3: index↔HEAD 축은 staged 분만 본다. 축을 틀리면 반대쪽 변경에 패치를 건다.
func TestHunksOf_CachedAxisSeesStagedOnly(t *testing.T) {
	s, dir := hunkRepo(t)
	ctx := context.Background()
	hunkFile(t, dir, "f.txt", 30, map[int]string{5: "FIVE"})
	gitRun(t, dir, "add", "f.txt")
	hunkFile(t, dir, "f.txt", 30, map[int]string{5: "FIVE", 25: "TWENTYFIVE"})

	staged, err := HunksOf(s, ctx, dir, AxisIndexHead, "f.txt")
	if err != nil {
		t.Fatalf("HunksOf(index-head): %v", err)
	}
	if len(staged.Hunks) != 1 {
		t.Fatalf("index-head hunk 수 = %d, 기대 1", len(staged.Hunks))
	}
	unstaged, err := HunksOf(s, ctx, dir, AxisWorktreeIndex, "f.txt")
	if err != nil {
		t.Fatalf("HunksOf(worktree-index): %v", err)
	}
	if len(unstaged.Hunks) != 1 {
		t.Fatalf("worktree-index hunk 수 = %d, 기대 1", len(unstaged.Hunks))
	}
	if staged.DiffID == unstaged.DiffID {
		t.Fatal("두 축의 DiffID 가 같다 — 축이 식별자에 들어가지 않았다")
	}
}

// Q4: 부분 스테이징이 없는 축과 위험한 경로는 **실행 전에** 거부된다.
func TestHunksOf_RejectsAxisAndPath(t *testing.T) {
	s, dir := hunkRepo(t)
	ctx := context.Background()
	if _, err := HunksOf(s, ctx, dir, AxisWorktreeHead, "f.txt"); !errors.Is(err, ErrDiffAxis) {
		t.Fatalf("worktree-head 축 = %v, 기대 ErrDiffAxis", err)
	}
	if _, err := HunksOf(s, ctx, dir, "nope", "f.txt"); !errors.Is(err, ErrDiffAxis) {
		t.Fatalf("모르는 축 = %v, 기대 ErrDiffAxis", err)
	}
	if _, err := HunksOf(s, ctx, dir, AxisWorktreeIndex, "../etc/passwd"); !errors.Is(err, ErrDiffPath) {
		t.Fatalf("부모 참조 = %v, 기대 ErrDiffPath", err)
	}
}

// Q5: 변경이 없으면 hunk 도 없다 — 빈 목록이지 오류가 아니다.
func TestHunksOf_NoChangeIsEmpty(t *testing.T) {
	s, dir := hunkRepo(t)
	fd, err := HunksOf(s, context.Background(), dir, AxisWorktreeIndex, "f.txt")
	if err != nil {
		t.Fatalf("HunksOf: %v", err)
	}
	if len(fd.Hunks) != 0 {
		t.Fatalf("hunk 수 = %d, 기대 0", len(fd.Hunks))
	}
}
