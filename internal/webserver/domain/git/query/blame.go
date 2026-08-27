package query

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"dongminal/internal/webserver/domain/git/core"
)

// FR-GIT-276 — blame. 줄마다 어느 커밋에서 왔는지를 답한다.
//
// `--porcelain` 을 쓴다. `--line-porcelain` 은 줄마다 커밋 메타를 되풀이해 파싱이
// 단순해지지만, 큰 파일에서 출력이 본문의 몇 배가 되어 상한을 먼저 먹는다.

// ErrBlameTruncated 는 상한에서 잘린 blame 이다. 잘린 목록을 주면 사용자는 없는
// 줄을 없다고 믿는다 (ErrDiffTruncated 와 같은 규약).
var ErrBlameTruncated = errors.New("blame_truncated")

// ErrBlameParse 는 porcelain 형식이 어긋난 것이다.
var ErrBlameParse = errors.New("blame_parse")

// ErrBlamePathNotFound 는 그 리비전에 그 경로가 없는 것이다 — **아직 커밋되지
// 않은 파일도 여기로 온다** (git 2.50.1 은 둘 다 `no such path ... in HEAD` 로
// 답한다). 500 으로 뭉개면 사용자는 고장으로 읽는다.
var ErrBlamePathNotFound = errors.New("blame_path_not_found")

// blamePathNotFoundStderr 는 그 문구다. exit 128 은 blame 의 모든 실패가 쓰므로
// 문구로 좁힌다 — 그 밖의 128 을 404 로 뭉개면 실제 실패가 "없는 경로" 로 보인다.
const blamePathNotFoundStderr = "no such path"

// blameNullOid 는 아직 커밋되지 않은 줄의 oid 다 — git 이 40개의 0 으로 답한다.
const blameNullOid = "0000000000000000000000000000000000000000"

// BlameQuery 는 blame 한 번이다. Rev 가 비면 워킹 트리를 본다.
type BlameQuery struct {
	Repo string
	Rev  string
	Path string
}

// BlameCommit 은 줄들이 가리키는 커밋 하나다. 줄마다 되풀이하지 않고 한 벌만
// 싣는다 — 큰 파일에서 메타가 본문보다 커진다.
type BlameCommit struct {
	Oid        string `json:"oid"`
	AuthorName string `json:"authorName"`
	AuthorMail string `json:"authorMail"`
	AuthorAt   int64  `json:"authorAt"` // unix ms
	Summary    string `json:"summary"`
	// Uncommitted 는 아직 커밋되지 않은 줄이다. 커밋으로 그리면 사용자는 없는
	// 커밋을 열려고 한다.
	Uncommitted bool `json:"uncommitted"`
}

// BlameLine 은 최종 파일의 한 줄이다.
type BlameLine struct {
	Oid  string `json:"oid"`
	Line int    `json:"line"`
	Text string `json:"text"`
}

// FileBlame 은 파일 하나의 줄별 출처다. 이름이 Blame 이 아닌 것은 조회 함수가
// 그 이름을 쓰기 때문이다.
type FileBlame struct {
	Repo    string                 `json:"repo"`
	Rev     string                 `json:"rev"`
	Path    string                 `json:"path"`
	Lines   []BlameLine            `json:"lines"`
	Commits map[string]BlameCommit `json:"commits"`
}

// Blame 은 파일 하나를 blame 한다 (FR-GIT-276).
func Blame(s *core.Service, ctx context.Context, q BlameQuery) (FileBlame, error) {
	args, err := blameArgs(q)
	if err != nil {
		return FileBlame{}, err
	}
	out, err := s.Exec(ctx, q.Repo, args...)
	if err != nil {
		if strings.Contains(err.Error(), blamePathNotFoundStderr) {
			return FileBlame{}, fmt.Errorf("%w: %s", ErrBlamePathNotFound, q.Path)
		}
		return FileBlame{}, revError(err)
	}
	// 잘린 출력을 목록으로 주면 조용히 짧은 파일이 된다.
	if out.StdoutTruncated {
		return FileBlame{}, fmt.Errorf("%w: blame 의 출력이 상한(%dB)에서 잘렸다: 파일이 너무 크다",
			ErrBlameTruncated, s.MaxOutput())
	}
	b, err := ParseBlame(out.Stdout)
	if err != nil {
		return FileBlame{}, err
	}
	b.Repo, b.Rev, b.Path = q.Repo, q.Rev, q.Path
	return b, nil
}

// blameArgs 는 질의를 argv 로 옮긴다. 순서를 고정하는 이유는 테스트가 **무엇을
// 실행하지 않았는가**까지 볼 수 있어야 하기 때문이다.
func blameArgs(q BlameQuery) ([]string, error) {
	if err := checkRev("rev", q.Rev); err != nil {
		return nil, err
	}
	rel, err := core.RelPath(q.Path, ErrDiffPath)
	if err != nil {
		return nil, err
	}
	args := []string{"blame", "--porcelain"}
	if q.Rev != "" {
		args = append(args, q.Rev)
	}
	// 경로는 반드시 `--` 뒤다. 앞에 두면 같은 이름의 ref 와 구분되지 않는다.
	return append(args, "--", rel), nil
}

// ParseBlame 은 `--porcelain` 출력을 읽는다.
//
// 형식은 (헤더 줄 → 메타 줄들 → `\t본문`) 의 되풀이다. **메타는 커밋이 처음
// 나올 때만** 온다 — 두 번째 등장을 "메타 없는 커밋" 으로 읽으면 그 줄부터
// 작성자가 빈다.
func ParseBlame(out string) (FileBlame, error) {
	b := FileBlame{Lines: []BlameLine{}, Commits: map[string]BlameCommit{}}
	var cur string // 지금 헤더가 연 커밋
	for _, ln := range strings.Split(strings.TrimSuffix(out, "\n"), "\n") {
		if ln == "" {
			continue
		}
		// 본문 줄. 앞의 탭 하나만 떼고 나머지는 그대로다 — 들여쓴 줄의 탭까지
		// 떼면 파일 내용이 조용히 바뀐다.
		if strings.HasPrefix(ln, "\t") {
			if cur == "" {
				return FileBlame{}, fmt.Errorf("%w: 헤더 없는 본문 줄: %q", ErrBlameParse, ln)
			}
			b.Lines[len(b.Lines)-1].Text = ln[1:]
			cur = ""
			continue
		}
		if oid, line, ok := blameHeader(ln); ok {
			cur = oid
			if _, seen := b.Commits[oid]; !seen {
				b.Commits[oid] = BlameCommit{Oid: oid, Uncommitted: oid == blameNullOid}
			}
			b.Lines = append(b.Lines, BlameLine{Oid: oid, Line: line})
			continue
		}
		if cur == "" {
			return FileBlame{}, fmt.Errorf("%w: 헤더 없는 메타 줄: %q", ErrBlameParse, ln)
		}
		b.Commits[cur] = blameMeta(b.Commits[cur], ln)
	}
	return b, nil
}

// blameHeader 는 `<oid> <원본줄> <최종줄> [<개수>]` 를 읽는다. oid 는 40자 16진수다 —
// 길이를 보지 않으면 `author ...` 같은 메타 줄이 헤더로 오인된다.
func blameHeader(ln string) (oid string, line int, ok bool) {
	f := strings.Fields(ln)
	if len(f) < 3 || len(f[0]) != 40 || !isHex(f[0]) {
		return "", 0, false
	}
	n, err := strconv.Atoi(f[2])
	if err != nil || n <= 0 {
		return "", 0, false
	}
	return f[0], n, true
}

func isHex(s string) bool {
	for _, r := range s {
		if !(r >= '0' && r <= '9' || r >= 'a' && r <= 'f' || r >= 'A' && r <= 'F') {
			return false
		}
	}
	return true
}

// blameMeta 는 커밋 메타 한 줄을 얹는다. 모르는 키는 조용히 버린다 — porcelain 은
// committer·previous·boundary 등을 함께 내며, 그것들은 이 화면이 읽지 않는다.
func blameMeta(c BlameCommit, ln string) BlameCommit {
	key, val, _ := strings.Cut(ln, " ")
	switch key {
	case "author":
		c.AuthorName = val
	case "author-mail":
		// git 은 `<메일>` 로 싼다. 꺾쇠는 주소가 아니다.
		c.AuthorMail = strings.TrimSuffix(strings.TrimPrefix(val, "<"), ">")
	case "author-time":
		// unix 초를 ms 로 옮긴다 — 초를 그대로 실으면 표시 계층이 1000배 틀린다.
		if n, err := strconv.ParseInt(val, 10, 64); err == nil {
			c.AuthorAt = n * 1000
		}
	case "summary":
		c.Summary = val
	}
	return c
}
