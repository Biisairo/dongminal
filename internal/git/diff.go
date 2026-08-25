package git

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
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

// DiffContent 는 축과 경로를 받아 양쪽 전체 내용을 준다 (FR-GIT-44).
//
// **unified diff 텍스트를 만들지 않는다** — Monaco DiffEditor 가 두 모델을
// 요구하며, diff 계산은 그쪽의 일이다 (FR-GIT-43).
//
// origPath 가 비면 path 와 같다. rename 된 파일은 original 쪽 경로가 다르고,
// 그것을 path 로 대신하면 이름이 바뀐 파일이 "전부 추가" 로 보인다 (FR-GIT-36).
func (s *Service) DiffContent(ctx context.Context, repo, axis, p, origPath string) (DiffContent, error) {
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
	if dc.Original, err = s.diffBlobSide(ctx, repo, origRev); err != nil {
		return DiffContent{}, err
	}
	if axis == AxisIndexHead {
		dc.Modified, err = s.diffBlobSide(ctx, repo, indexRevPrefix+rel)
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

// diffRelPath 는 리포 상대경로를 검증한다 (FR-GIT-62). 워킹 트리 파일을 직접 읽는
// 경로이므로 여기가 뚫리면 임의 파일 읽기다.
//
// 정규화한 값을 돌려주지 않는다 — git 의 rev 와 워킹 트리 경로가 같은 문자열이어야
// 클라이언트가 보낸 경로와 응답이 짝을 이룬다. 다듬을 여지가 있으면 거부한다.
func diffRelPath(p string) (string, error) {
	if strings.TrimSpace(p) == "" {
		return "", fmt.Errorf("%w: 경로가 비었다", ErrDiffPath)
	}
	if filepath.IsAbs(p) || strings.HasPrefix(p, "/") {
		return "", fmt.Errorf("%w: 절대경로는 받지 않는다: %q", ErrDiffPath, p)
	}
	if strings.ContainsRune(p, 0) {
		return "", fmt.Errorf("%w: NUL 을 포함한 경로", ErrDiffPath)
	}
	for _, seg := range strings.Split(p, "/") {
		if seg == ".." {
			return "", fmt.Errorf("%w: 부모 참조가 있다: %q", ErrDiffPath, p)
		}
	}
	if path.Clean(p) != p {
		return "", fmt.Errorf("%w: 정규화되지 않은 경로다: %q", ErrDiffPath, p)
	}
	return p, nil
}

// diffBlobSide 는 blob 한쪽(`:<p>` 또는 `HEAD:<p>`)을 판정한다.
func (s *Service) diffBlobSide(ctx context.Context, repo, rev string) (DiffSide, error) {
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
	var xe *ExecError
	if !errors.As(err, &xe) || xe.kind != nil {
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
