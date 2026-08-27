package query

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"dongminal/internal/webserver/domain/git/core"
)

// diff 축. 값은 클라이언트가 보내는 문자열 그대로이며 **여기 없는 축은 실행되지
// 않는다.** commit-parent 축은 M4 다 — 지금 만들지 않는다.
const (
	AxisWorktreeIndex = "worktree-index"
	AxisIndexHead     = "index-head"
	AxisWorktreeHead  = "worktree-head"
)

// DiffSide.Kind 값. 뷰어가 본문을 그릴지 안내를 보일지 이것으로 갈린다.
const (
	DiffKindText     = "text"
	DiffKindAbsent   = "absent"
	DiffKindBinary   = "binary"
	DiffKindLFS      = "lfs"
	DiffKindTooLarge = "too_large"
)

// 상한은 상수로 못박는다 — 호출 지점마다 다른 숫자가 흩어지면 상한이 상한이
// 아니게 된다.
const (
	DiffMaxBytes       = 1 << 20 // 1MiB (O2, FR-GIT-48)
	LFSMaxPointerBytes = 1024    // LFS 포인터는 작다
	BinarySniffBytes   = 8000    // git 의 휴리스틱과 같은 폭
)

// 거부 사유는 열거한다 — 서버가 400·404 를 구분해 답해야 하고, 전부 500 으로
// 낮추면 클라이언트가 자기 요청이 잘못된 것인지 알 수 없다.
var (
	ErrDiffAxis       = errors.New("unknown_diff_axis")
	ErrDiffPath       = errors.New("unsafe_diff_path")
	ErrDiffBothAbsent = errors.New("diff_both_absent")
)

const (
	indexRevPrefix = ":"
	headRevPrefix  = "HEAD:"
	lfsPrefix      = "version https://git-lfs.github.com/spec/"
	lfsOidField    = "oid sha256:"
	lfsSizeField   = "size "
)

// DiffSide 는 비교 한쪽이다. kind 가 text 가 아니면 content 는 비어 있다 —
// 뷰어는 본문 대신 안내를 보인다.
type DiffSide struct {
	Kind    string `json:"kind"`    // text | absent | binary | lfs | too_large
	Content string `json:"content"` // Kind=="text" 일 때만 채운다
	Size    int64  `json:"size"`
	// LFS 포인터의 메타. Kind=="lfs" 일 때만 (FR-GIT-47)
	LFSOid  string `json:"lfsOid,omitempty"`
	LFSSize int64  `json:"lfsSize,omitempty"`
}

// DiffContent 는 한 축의 양쪽 전체 내용이다.
type DiffContent struct {
	Repo     string   `json:"repo"`
	Axis     string   `json:"axis"`
	Path     string   `json:"path"`
	OrigPath string   `json:"origPath"`
	Original DiffSide `json:"original"`
	Modified DiffSide `json:"modified"`
	Note     string   `json:"note,omitempty"` // 양쪽 중 하나라도 text 가 아니면 채운다
}

// DiffContentOf 는 축과 경로를 받아 양쪽 전체 내용을 준다 (FR-GIT-44).
//
// **unified diff 텍스트를 만들지 않는다** — Monaco DiffEditor 가 두 모델을
// 요구하며, diff 계산은 그쪽의 일이다 (FR-GIT-43).
//
// origPath 가 비면 path 와 같다. rename 된 파일은 original 쪽 경로가 다르고,
// 그것을 path 로 대신하면 이름이 바뀐 파일이 "전부 추가" 로 보인다 (FR-GIT-36).
func DiffContentOf(s *core.Service, ctx context.Context, repo, axis, p, origPath string) (DiffContent, error) {
	if axis != AxisWorktreeIndex && axis != AxisIndexHead && axis != AxisWorktreeHead {
		return DiffContent{}, fmt.Errorf("%w: %q", ErrDiffAxis, axis)
	}
	rel, err := diffRelPath(p)
	if err != nil {
		return DiffContent{}, err
	}
	origRel := rel
	if origPath != "" {
		if origRel, err = diffRelPath(origPath); err != nil {
			return DiffContent{}, err
		}
	}

	dc := DiffContent{Repo: repo, Axis: axis, Path: rel, OrigPath: origRel}
	// original 을 먼저 채운다 — 축의 좌우가 뒤바뀌면 diff 방향이 거꾸로 보인다.
	origRev := headRevPrefix + origRel
	if axis == AxisWorktreeIndex {
		origRev = indexRevPrefix + origRel
	}
	if dc.Original, err = diffBlobSide(s, ctx, repo, origRev); err != nil {
		return DiffContent{}, err
	}
	if axis == AxisIndexHead {
		dc.Modified, err = diffBlobSide(s, ctx, repo, indexRevPrefix+rel)
	} else {
		dc.Modified, err = diffWorktreeSide(repo, rel)
	}
	if err != nil {
		return DiffContent{}, err
	}

	// 양쪽이 모두 없으면 요청 자체가 잘못된 것이다. 빈 diff 를 그려 주면 사용자는
	// 파일이 비었다고 읽는다.
	if dc.Original.Kind == DiffKindAbsent && dc.Modified.Kind == DiffKindAbsent {
		return DiffContent{}, fmt.Errorf("%w: %s 의 %s 축 양쪽에 %q 가 없다", ErrDiffBothAbsent, repo, axis, rel)
	}
	dc.Note = diffNote(dc.Original, dc.Modified)
	return dc, nil
}

// diffRelPath 는 diff 요청의 경로를 검증한다. 거부 사유가 diff 고유의 코드여야
// 서버가 400 으로 답할 수 있다.
func diffRelPath(p string) (string, error) { return core.RelPath(p, ErrDiffPath) }

// diffBlobSide 는 blob 한쪽(`:<p>` 또는 `HEAD:<p>`)을 판정한다.
func diffBlobSide(s *core.Service, ctx context.Context, repo, rev string) (DiffSide, error) {
	out, err := s.Exec(ctx, repo, "cat-file", "-s", rev)
	if err != nil {
		if diffAbsent(err) {
			return DiffSide{Kind: DiffKindAbsent}, nil
		}
		return DiffSide{}, err
	}
	size, err := strconv.ParseInt(strings.TrimSpace(out.Stdout), 10, 64)
	if err != nil {
		return DiffSide{}, fmt.Errorf("cat-file -s %s 가 크기를 주지 않았다: %q", rev, out.Stdout)
	}
	if size > DiffMaxBytes {
		return DiffSide{Kind: DiffKindTooLarge, Size: size}, nil
	}
	body, err := s.Exec(ctx, repo, "show", rev)
	if err != nil {
		return DiffSide{}, err
	}
	// 잘린 본문을 text 로 주면 diff 가 조용히 거짓말을 한다. 상한을 넘은 것과
	// 같이 다뤄 뷰어가 안내를 보이게 한다.
	if body.StdoutTruncated {
		return DiffSide{Kind: DiffKindTooLarge, Size: size}, nil
	}
	return diffSideFromBody(body.Stdout, size), nil
}

// diffWorktreeSide 는 워킹 트리 파일 한쪽을 판정한다. git 을 경유하지 않는다 —
// `git show` 는 index/HEAD 만 알고, 워킹 트리는 파일시스템이 진실이다.
func diffWorktreeSide(repo, rel string) (DiffSide, error) {
	abs, err := diffWorktreeAbs(repo, rel)
	if err != nil {
		return DiffSide{}, err
	}
	fi, err := os.Stat(abs)
	if err != nil {
		if os.IsNotExist(err) {
			return DiffSide{Kind: DiffKindAbsent}, nil
		}
		return DiffSide{}, err
	}
	// 디렉터리를 읽으려 하면 오류가 되고, 그 오류는 사용자에게 아무것도 설명하지
	// 못한다. 비교할 본문이 없다는 사실은 absent 가 이미 뜻한다.
	if fi.IsDir() {
		return DiffSide{Kind: DiffKindAbsent}, nil
	}
	if fi.Size() > DiffMaxBytes {
		return DiffSide{Kind: DiffKindTooLarge, Size: fi.Size()}, nil
	}
	body, err := os.ReadFile(abs)
	if err != nil {
		return DiffSide{}, err
	}
	return diffSideFromBody(string(body), int64(len(body))), nil
}

// diffWorktreeAbs 는 읽을 절대경로를 확정한다. `..` 이 없어도 심링크로 리포 밖을
// 가리킬 수 있으므로 **푼 경로로 다시 확인한다** (FR-GIT-62).
//
// 존재하지 않는 파일은 풀 수 없다. 그래서 존재하는 조상까지 풀고 나머지를 이어
// 붙인다 — 새로 만든 파일의 diff 가 "풀 수 없다"는 이유로 막히면 안 된다.
func diffWorktreeAbs(repo, rel string) (string, error) {
	root, err := filepath.EvalSymlinks(repo)
	if err != nil {
		root = repo
	}
	abs := filepath.Join(repo, rel)
	target := evalExisting(abs)
	if target != root && !strings.HasPrefix(target, root+string(os.PathSeparator)) {
		return "", fmt.Errorf("%w: %q 가 리포 밖(%s)을 가리킨다", ErrDiffPath, rel, target)
	}
	return abs, nil
}

// evalExisting 은 존재하는 조상까지 심링크를 풀고 나머지 조각을 그대로 이어 준다.
// 풀 수 없는 경로에는 최선의 근사를 준다 — 그 근사가 리포 안이어야 통과한다.
func evalExisting(abs string) string {
	rest := ""
	for p := abs; ; {
		if resolved, err := filepath.EvalSymlinks(p); err == nil {
			return filepath.Join(resolved, rest)
		}
		parent := filepath.Dir(p)
		if parent == p {
			return filepath.Join(p, rest)
		}
		rest = filepath.Join(filepath.Base(p), rest)
		p = parent
	}
}

// diffSideFromBody 는 본문을 보고 kind 를 정한다. 순서가 뜻을 만든다 — LFS 포인터는
// 텍스트이기도 하므로 텍스트 판정보다 먼저 봐야 한다.
func diffSideFromBody(body string, size int64) DiffSide {
	if size <= LFSMaxPointerBytes && strings.HasPrefix(body, lfsPrefix) {
		oid, lfsSize := parseLFSPointer(body)
		return DiffSide{Kind: DiffKindLFS, Size: size, LFSOid: oid, LFSSize: lfsSize}
	}
	if hasNUL(body) {
		return DiffSide{Kind: DiffKindBinary, Size: size}
	}
	return DiffSide{Kind: DiffKindText, Content: body, Size: size}
}

// hasNUL 은 앞 BinarySniffBytes 안의 NUL 을 찾는다. git 이 바이너리를 정하는
// 휴리스틱과 같은 폭이며, 뒤쪽만 보고 판정을 바꾸지 않는다.
func hasNUL(body string) bool {
	if len(body) > BinarySniffBytes {
		body = body[:BinarySniffBytes]
	}
	return strings.ContainsRune(body, 0)
}

// parseLFSPointer 는 포인터에서 oid·size 를 뽑는다. 없는 필드는 0 값이다 —
// kind 는 이미 lfs 이고, 메타가 모자란 것이 실패는 아니다.
func parseLFSPointer(body string) (oid string, size int64) {
	for _, line := range strings.Split(body, "\n") {
		line = strings.TrimSpace(line)
		if rest, ok := strings.CutPrefix(line, lfsOidField); ok {
			oid = rest
		} else if rest, ok := strings.CutPrefix(line, lfsSizeField); ok {
			if n, err := strconv.ParseInt(rest, 10, 64); err == nil {
				size = n
			}
		}
	}
	return oid, size
}

// diffAbsentStderr 는 "그 쪽에 파일이 없다"를 뜻하는 git 의 fatal 문구들이다
// (git 2.50.1 실측). classify 가 분류하지 않는 exit 128 이므로 문구로 좁힌다 —
// **그 밖의 128 을 absent 로 뭉개면 실제 실패가 빈 diff 로 보인다.**
var diffAbsentStderr = []string{
	"does not exist in '",                    // path 'x' does not exist in 'HEAD'
	"does not exist (neither on disk nor in", // index 에도 디스크에도 없다
	"exists on disk, but not in",             // 추적되지 않는 파일
	"invalid object name 'head'",             // 커밋이 없는 저장소
}

// diffAbsent 는 실패가 "없는 blob" 인지 본다. 비교를 소문자로 하는 이유는 기본
// Runner 가 LC_ALL=C 를 거는 이유와 같다 — 판정이 로케일에 흔들리면 안 된다.
func diffAbsent(err error) bool {
	var xe *core.ExecError
	if !errors.As(err, &xe) || xe.Unwrap() != nil {
		return false
	}
	low := strings.ToLower(xe.Stderr)
	for _, pat := range diffAbsentStderr {
		if strings.Contains(low, pat) {
			return true
		}
	}
	return false
}

// diffNote 는 사람이 읽는 한 줄이다. 본문을 주지 못한 이유를 먼저 말한다 —
// 사용자가 빈 화면 앞에서 이유를 추측하지 않아야 한다.
func diffNote(orig, mod DiffSide) string {
	for _, kind := range []string{orig.Kind, mod.Kind} {
		switch kind {
		case DiffKindTooLarge:
			return fmt.Sprintf("파일이 상한(%dKiB)을 넘습니다 — 본문을 표시하지 않습니다", DiffMaxBytes/1024)
		case DiffKindLFS:
			return "Git LFS 포인터입니다 — 실제 내용은 받아오지 않았습니다"
		case DiffKindBinary:
			return "바이너리 파일입니다 — 본문을 표시하지 않습니다"
		}
	}
	switch {
	case orig.Kind == DiffKindAbsent:
		return "새로 추가된 파일입니다 — 이전 내용이 없습니다"
	case mod.Kind == DiffKindAbsent:
		return "삭제된 파일입니다 — 현재 내용이 없습니다"
	}
	return ""
}

// ── hunk 경계 (GIT_ACTIONS_SRS §3.7 FR-GIT-278·279) ──
//
// 부분 스테이징의 패치는 **서버가 만든다** (D6). 클라이언트가 만든 패치 문자열을
// 받아 `git apply` 에 넘기면 그것이 임의 쓰기 표면이다. 그러려면 서버가 자기가
// 방금 만든 diff 의 경계를 정확히 알아야 하고, 그 자리가 여기다.
//
// **DiffContentOf 와 목적이 다르다.** 그쪽은 Monaco 에 줄 두 벌을 주는 것이고
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

	out, err := s.Exec(ctx, repo, argv...)
	if err != nil {
		return FileDiff{}, err
	}
	if out.StdoutTruncated {
		return FileDiff{}, fmt.Errorf("%w: %s 의 diff 가 상한(%dKiB)에서 잘렸다",
			ErrDiffTruncated, rel, s.MaxOutput()/1024)
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
