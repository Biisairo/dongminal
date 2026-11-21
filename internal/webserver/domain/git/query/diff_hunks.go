package query

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"dongminal/internal/shared/editorlimit"
	"dongminal/internal/webserver/domain/git/core"
)

// ── hunk 경계 (GIT_ACTIONS_SRS §3.7 FR-GIT-278·279) ──
//
// 부분 스테이징의 패치는 **서버가 만든다** (D6). 클라이언트가 만든 패치 문자열을
// 받아 `git apply` 에 넘기면 그것이 임의 쓰기 표면이다. 그러려면 서버가 자기가
// 방금 만든 diff 의 경계를 정확히 알아야 하고, 그 자리가 여기다.
//
// **DiffContentOf 와 목적이 다르다.** 그쪽은 Diff 편집기에 줄 두 벌을 주는 것이고
// (FR-GIT-43), 이쪽은 git 에 넘길 조각을 잘라내는 것이다 — unified diff 가 없으면
// 조각의 경계가 없다.

// HunkContext 는 diff 의 문맥 줄 수다. 상수로 못박는다 — 조각을 만든 쪽과 자른
// 쪽이 다른 값을 쓰면 패치가 어긋난다.
const HunkContext = 3

// 패치 본문의 앞 글자. 뜻이 이 한 글자에서 갈리므로 문자로 흩어 두지 않는다.
const (
	HunkContextMark = ' '  // 양쪽에 있는 줄
	HunkAddMark     = '+'  // 새 쪽에만 있는 줄
	HunkDelMark     = '-'  // 옛 쪽에만 있는 줄
	HunkNoNewline   = '\\' // `\ No newline at end of file` — 앞 줄에 딸린 표식
)

const (
	hunkHeadMark   = "@@"
	hunkBinaryMark = "Binary files"
)

// ErrDiffTruncated 는 상한에서 잘린 diff 다. 잘린 diff 로 패치를 만들면 조용히
// 틀린 조각을 넣는다 — 부분 스테이징을 그 위에서 하지 않는다 (FR-GIT-6·48).
var ErrDiffTruncated = errors.New("diff_truncated")

// Hunk 는 unified diff 의 덩어리 하나다. Lines 는 앞 글자를 **그대로 달고 있다** —
// 떼면 문맥과 변경을 구분할 수 없고, 그 구분이 조각을 자르는 유일한 근거다.
type Hunk struct {
	Index    int      `json:"index"` // 0부터. 클라이언트가 되돌려 보내는 좌표다
	Header   string   `json:"header"`
	OldStart int      `json:"oldStart"`
	OldLines int      `json:"oldLines"`
	NewStart int      `json:"newStart"`
	NewLines int      `json:"newLines"`
	Lines    []string `json:"lines"`
}

// FileDiff 는 한 축·한 경로의 unified diff 다.
//
// DiffID 는 **관측 식별자**다. 클라이언트가 hunk 번호와 함께 되돌려 보내고, 서버가
// 다시 만든 diff 의 값과 다르면 거부한다 — 낡은 번호로 다른 곳을 고치지 않는다.
type FileDiff struct {
	Repo   string `json:"repo"`
	Axis   string `json:"axis"`
	Path   string `json:"path"`
	DiffID string `json:"diffId"`
	// Preamble 은 `diff --git` 부터 `+++` 까지의 머리다. 패치를 만드는 쪽이 쓴다.
	// **클라이언트에게 보내지 않는다** — 패치의 재료는 서버 안에만 있다.
	Preamble []string `json:"-"`
	Hunks    []Hunk   `json:"hunks"`
	Note     string   `json:"note,omitempty"` // hunk 가 없을 때 그 이유
}

// HunksOf 는 축과 경로의 hunk 경계를 준다 (FR-GIT-278).
//
// 부분 스테이징이 있는 축은 둘뿐이다 — worktree↔index 는 올리고 되돌리는 축,
// index↔HEAD 는 내리는 축이다. 나머지 축은 거부한다: 방향이 정해지지 않은 축에서
// 조각을 넣으면 어느 쪽을 고치는지 말할 수 없다.
func HunksOf(s *core.Service, ctx context.Context, repo, axis, p string) (FileDiff, error) {
	if axis != AxisWorktreeIndex && axis != AxisIndexHead {
		return FileDiff{}, fmt.Errorf("%w: %q 축에는 부분 스테이징이 없다", ErrDiffAxis, axis)
	}
	rel, err := diffRelPath(p)
	if err != nil {
		return FileDiff{}, err
	}
	// 사용자의 diff 설정이 조각의 모양을 바꾸면 안 된다 — 외부 diff·textconv·색은
	// 패치가 아니고, 접두어가 없으면 `git apply` 의 -p1 이 어긋난다.
	argv := []string{"diff", "--no-color", "--no-ext-diff", "--no-textconv",
		"--src-prefix=a/", "--dst-prefix=b/", "-U" + strconv.Itoa(HunkContext)}
	if axis == AxisIndexHead {
		argv = append(argv, "--cached")
	}
	argv = append(argv, "--", rel)

	// FR-OPT-16-4: 공용 출력 상한(1 MiB)이면 편집기가 여는 파일이 여기서 잘린다. 읽기
	// 조회이므로 `Sized` 로 상한만 바꾼다 — 실행 기록은 공용과 나누고, 패치 적용(쓰기)은
	// 부르는 쪽이 원래 Service 의 ExecWrite 로 한다.
	ds := s.Sized(int(editorlimit.PatchDiffMaxBytes(DiffMaxBytes)))
	out, err := ds.Exec(ctx, repo, argv...)
	if err != nil {
		return FileDiff{}, err
	}
	if out.StdoutTruncated {
		return FileDiff{}, fmt.Errorf("%w: %s 의 diff 가 상한(%dMiB)에서 잘렸다",
			ErrDiffTruncated, rel, ds.MaxOutput()>>20)
	}
	fd := FileDiff{Repo: repo, Axis: axis, Path: rel, DiffID: hunkDiffID(axis, rel, out.Stdout)}
	fd.Preamble, fd.Hunks = parseHunks(out.Stdout)
	if len(fd.Hunks) == 0 {
		fd.Note = hunkEmptyNote(out.Stdout)
	}
	return fd, nil
}

// hunkDiffID 는 관측 하나의 식별자다. 축과 경로까지 넣는 이유는 같은 본문이 두 축에
// 나올 수 있기 때문이다 — 식별자가 겹치면 축을 바꾼 요청이 stale 로 걸리지 않는다.
func hunkDiffID(axis, rel, body string) string {
	sum := sha256.Sum256([]byte(axis + "\x00" + rel + "\x00" + body))
	return hex.EncodeToString(sum[:])
}

// hunkEmptyNote 는 hunk 가 없는 이유다. 빈 목록만 주면 사용자는 조각을 고를 수
// 없는 이유를 추측한다.
func hunkEmptyNote(body string) string {
	if strings.Contains(body, hunkBinaryMark) {
		return "바이너리 파일입니다 — 부분 스테이징을 할 수 없습니다"
	}
	if strings.TrimSpace(body) == "" {
		return ""
	}
	return "이 축에 적용할 수 있는 조각이 없습니다"
}

// parseHunks 는 unified diff 를 머리와 덩어리로 나눈다.
//
// 본문 줄은 앞 글자로만 판정한다 — 그 밖의 줄(`diff --git`, `Binary files …`)이
// 나오면 그 파일의 덩어리가 끝난 것이다. 경로 하나만 물었으므로 파일은 하나지만,
// 그 가정에 기대지 않는다.
func parseHunks(body string) ([]string, []Hunk) {
	lines := strings.Split(body, "\n")
	if n := len(lines); n > 0 && lines[n-1] == "" {
		lines = lines[:n-1] // 끝 개행이 만든 빈 조각
	}
	var preamble []string
	var hunks []Hunk
	cur := -1
	for _, l := range lines {
		if strings.HasPrefix(l, hunkHeadMark) {
			h, ok := parseHunkHead(l)
			if !ok {
				cur = -1
				continue
			}
			h.Index = len(hunks)
			hunks = append(hunks, h)
			cur = len(hunks) - 1
			continue
		}
		if cur < 0 {
			preamble = append(preamble, l)
			continue
		}
		if l == "" || !hunkBodyMark(l[0]) {
			cur = -1
			continue
		}
		hunks[cur].Lines = append(hunks[cur].Lines, l)
	}
	return preamble, hunks
}

func hunkBodyMark(c byte) bool {
	return c == HunkContextMark || c == HunkAddMark || c == HunkDelMark || c == HunkNoNewline
}

// parseHunkHead 는 `@@ -a,b +c,d @@ …` 를 읽는다. 읽지 못한 머리는 덩어리로 치지
// 않는다 — 셈이 틀린 조각을 만드느니 그 파일의 부분 스테이징을 포기한다.
func parseHunkHead(l string) (Hunk, bool) {
	end := strings.Index(l[len(hunkHeadMark):], hunkHeadMark)
	if end < 0 {
		return Hunk{}, false
	}
	spec := strings.Fields(l[len(hunkHeadMark) : len(hunkHeadMark)+end])
	if len(spec) != 2 || spec[0][0] != HunkDelMark || spec[1][0] != HunkAddMark {
		return Hunk{}, false
	}
	oldStart, oldLines, ok := parseHunkRange(spec[0][1:])
	if !ok {
		return Hunk{}, false
	}
	newStart, newLines, ok := parseHunkRange(spec[1][1:])
	if !ok {
		return Hunk{}, false
	}
	return Hunk{
		Header: l, OldStart: oldStart, OldLines: oldLines,
		NewStart: newStart, NewLines: newLines,
	}, true
}

// parseHunkRange 는 `start` 또는 `start,count` 다. count 가 없으면 1 이다 (unified
// diff 규약) — 0 으로 두면 한 줄짜리 덩어리가 통째로 사라진다.
func parseHunkRange(s string) (start, count int, ok bool) {
	count = 1
	if i := strings.IndexByte(s, ','); i >= 0 {
		n, err := strconv.Atoi(s[i+1:])
		if err != nil {
			return 0, 0, false
		}
		count = n
		s = s[:i]
	}
	n, err := strconv.Atoi(s)
	if err != nil {
		return 0, 0, false
	}
	return n, count, true
}
