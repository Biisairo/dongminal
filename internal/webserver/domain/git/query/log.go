package query

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"dongminal/internal/webserver/domain/git/core"
)

// 로그 레코드의 필드 배치. 숫자를 파싱 코드에 흩뿌리면 어느 포맷의 규칙인지 알 수
// 없게 된다.
//
// **`-z` 를 반드시 준다.** `-z` 없이 `--pretty=format:` 만 쓰면 git 이 레코드 사이에
// `\n` 을 끼우고, 다음 레코드의 첫 필드가 `\n<hash>` 가 되어 조용히 틀린다
// (git 2.50.1 실측).
//
// `--decorate=full` 을 함께 준다 — 짧은 형태(`main`, `origin/main`)로는 슬래시가 든
// 로컬 브랜치(`feature/a`)와 원격 브랜치를 가릴 수 없다. 배지의 종류를 이름 모양으로
// 추측하지 않는다 (FR-GIT-126).
const (
	logFields   = 9
	logFormat   = "--pretty=format:%H%x00%h%x00%P%x00%an%x00%ae%x00%at%x00%ct%x00%D%x00%s"
	logDecorate = "--decorate=full"
)

// 페이징 기본값과 상한 (FR-GIT-114). 상한을 넘은 요청은 오류가 아니라 상한으로
// 접는다 — 목록은 페이징으로 오고, 한 페이지가 큰 것은 요청의 잘못이 아니다.
const (
	LogInitialLimit = 300  // 초기 로드
	LogPageLimit    = 100  // 추가 로드 한 페이지
	LogMaxLimit     = 2000 // 한 번에 받을 수 있는 최대
)

// 정렬 (FR-GIT-128). date 가 git 의 기본이므로 옵션을 붙이지 않는다.
const (
	LogOrderDate       = "date"
	LogOrderAuthorDate = "author-date"
	LogOrderTopo       = "topo"
)

// %D 의 조각을 가르는 문자열들.
const (
	logDecSep     = ", "
	logDecHead    = "HEAD"
	logDecHeadTo  = "HEAD -> "
	logDecTag     = "tag: "
	logRefHeads   = "refs/heads/"
	logRefRemotes = "refs/remotes/"
	logRefTags    = "refs/tags/"
)

// 거부 사유는 열거한다 — 서버가 400·404 를 구분해 답해야 하고, 전부 500 으로 낮추면
// 클라이언트가 자기 요청이 잘못된 것인지 알 수 없다.
var (
	ErrLogOrder    = errors.New("unknown_log_order")
	ErrUnsafeRev   = errors.New("unsafe_rev")
	ErrRevNotFound = errors.New("rev_not_found")
)

// CommitRef 는 %D 에서 뽑은 배지 하나다. 종류와 HEAD 여부를 이름 문자열에 남기지
// 않는다 — 표시 계층이 `HEAD -> `·`tag: ` 를 다시 파싱하게 만들면 파싱이 두 곳에
// 생기고, 두 곳은 반드시 갈라진다 (FR-GIT-126).
type CommitRef struct {
	Name   string `json:"name"`   // main, origin/main, v1.0
	Kind   string `json:"kind"`   // local | remote | tag. 모르는 네임스페이스면 ""
	IsHead bool   `json:"isHead"` // HEAD -> 로 붙어 있었다
}

// Commit 은 목록 한 줄이다. 부모 목록이 그래프의 유일한 입력이다 (FR-GIT-117).
type Commit struct {
	Oid        string      `json:"oid"`
	Abbrev     string      `json:"abbrev"`
	Parents    []string    `json:"parents"`
	AuthorName string      `json:"authorName"`
	AuthorMail string      `json:"authorMail"`
	AuthorAt   int64       `json:"authorAtUnixMs"`
	CommitAt   int64       `json:"commitAtUnixMs"`
	Subject    string      `json:"subject"`
	Refs       []CommitRef `json:"refs"`   // %D 의 배지들
	IsHead     bool        `json:"isHead"` // HEAD 가 이 커밋이다 (detached 포함)
}

// LogQuery 는 목록 한 페이지의 요청이다. 필터는 가능한 것을 git 옵션으로 내려보낸다
// (FR-GIT-130) — 받아 놓고 서버에서 거르면 페이징 개수가 요청과 어긋난다.
type LogQuery struct {
	Repo   string
	Ref    string // "" 이면 --all (FR-GIT-123)
	Skip   int
	Limit  int
	Order  string // date | author-date | topo
	Author string
	Since  string
	Until  string
	Path   string
	Grep   string
}

// Log 는 커밋 목록 한 페이지를 준다 (FR-GIT-113).
//
// 캐시를 두지 않는다 — 히스토리는 페이징으로 오고, 페이지마다 다른 질의이므로
// Store 의 TTL 캐시가 지킬 것이 없다.
func Log(s *core.Service, ctx context.Context, q LogQuery) ([]Commit, error) {
	args, err := logArgs(q)
	if err != nil {
		return nil, err
	}
	out, err := s.Exec(ctx, q.Repo, args...)
	if err != nil {
		return nil, revError(err)
	}
	// 잘린 stdout 을 목록으로 주면 조용히 짧은 목록이 된다 — 사용자는 없는 커밋을
	// 없다고 믿는다.
	if out.StdoutTruncated {
		return nil, fmt.Errorf("git log 의 출력이 상한(%dB)에서 잘렸다: limit 을 줄여 다시 요청해야 한다", s.MaxOutput())
	}
	return ParseLog(out.Stdout)
}

// LogLimit 은 요청 개수를 기본값·상한으로 접는다. 0 이하는 초기 로드다 (FR-GIT-114).
func LogLimit(n int) int {
	switch {
	case n <= 0:
		return LogInitialLimit
	case n > LogMaxLimit:
		return LogMaxLimit
	}
	return n
}

// logArgs 는 질의를 argv 로 옮긴다. 순서를 고정하는 이유는 테스트가 **무엇을
// 실행하지 않았는가**까지 볼 수 있어야 하기 때문이다.
func logArgs(q LogQuery) ([]string, error) {
	if err := checkRev("ref", q.Ref); err != nil {
		return nil, err
	}
	args := []string{"log", "-z", logFormat, logDecorate}
	switch q.Order {
	case "", LogOrderDate:
		// git 의 기본이다. 옵션을 붙이지 않는다.
	case LogOrderAuthorDate:
		args = append(args, "--author-date-order")
	case LogOrderTopo:
		args = append(args, "--topo-order")
	default:
		// 조용히 기본값으로 낮추지 않는다 — 사용자는 자기가 고른 순서로 보고
		// 있다고 믿는다 (FR-GIT-128).
		return nil, fmt.Errorf("%w: %q", ErrLogOrder, q.Order)
	}
	if q.Skip > 0 {
		args = append(args, "--skip="+strconv.Itoa(q.Skip))
	}
	args = append(args, "-n", strconv.Itoa(LogLimit(q.Limit)))
	// 값은 `=` 형태로만 붙인다 — 별도 인자로 넘기면 값이 옵션처럼 생겼을 때
	// git 이 그것을 옵션으로 읽는다.
	for _, f := range []struct{ flag, val string }{
		{"--author=", q.Author}, {"--since=", q.Since}, {"--until=", q.Until}, {"--grep=", q.Grep},
	} {
		if f.val != "" {
			args = append(args, f.flag+f.val)
		}
	}
	if q.Ref == "" {
		args = append(args, "--all")
	} else {
		args = append(args, q.Ref)
	}
	// 경로는 반드시 `--` 뒤다. 앞에 두면 같은 이름의 ref 와 구분되지 않는다.
	if q.Path != "" {
		args = append(args, "--", q.Path)
	}
	return args, nil
}

// checkRev 는 위치 인자로 들어갈 리비전 문자열을 본다. 옵션처럼 생긴 값은 받지
// 않는다 (FR-GIT-62) — guardArgs 가 걸러내는 것은 알려진 위험 접두뿐이다.
func checkRev(name, rev string) error {
	if strings.HasPrefix(rev, "-") {
		return fmt.Errorf("%w: %s 는 - 로 시작할 수 없다: %q", ErrUnsafeRev, name, rev)
	}
	return nil
}

// revNotFoundStderr 는 "그런 리비전이 없다"를 뜻하는 git 의 fatal 문구들이다
// (git 2.50.1 실측). classify 가 분류하지 않는 exit 128 이므로 문구로 좁힌다 —
// **그 밖의 128 을 404 로 뭉개면 실제 실패가 "없는 커밋" 으로 보인다.**
var revNotFoundStderr = []string{
	"unknown revision or path not in the working tree",
	"bad object",
	"bad revision",
	"does not have any commits yet",
	"not a valid object name",
}

// revError 는 실패가 "없는 리비전" 이면 404 로 갈라 준다. 저장소 실패(500)와
// 구분되지 않으면 클라이언트는 자기 요청이 틀렸다는 것을 알 수 없다.
func revError(err error) error {
	var xe *core.ExecError
	if !errors.As(err, &xe) || xe.Unwrap() != nil {
		return err
	}
	low := strings.ToLower(xe.Stderr)
	for _, pat := range revNotFoundStderr {
		if strings.Contains(low, pat) {
			return fmt.Errorf("%w: %v", ErrRevNotFound, err)
		}
	}
	return err
}

// ParseLog 는 `git log -z --pretty=format:…` 의 stdout 을 해석한다.
//
// `-z` 는 NUL 을 **스트림 전체의 순수 구분자**로 만든다 — 레코드마다 끝을 표시하지
// 않고 마지막에도 NUL 이 붙지 않는다 (N 레코드 × 9 필드 = NUL 9N-1개, git 2.50.1
// 실측). 그래서 파서는 레코드당 정확히 logFields 개를 소비하며, **레코드 종료 표식
// 필드를 두지 않는다.**
//
// 꼬리의 빈 토큰을 떼지 않는 이유가 여기 있다 — 마지막 커밋의 제목이 비면 스트림이
// NUL 로 끝나고, 그 빈 토큰이 바로 제목 필드다. status.go 가 꼬리를 떼는 것은
// porcelain v2 -z 가 레코드를 NUL 로 **종료**하기 때문이며, 규약이 다르다.
//
// 필드 수가 모자란 레코드는 **오류다.** 조용히 건너뛰면 목록이 조용히 틀리고,
// 그래프는 없는 부모를 그린다.
func ParseLog(out string) ([]Commit, error) {
	if out == "" {
		return []Commit{}, nil
	}
	toks := strings.Split(out, "\x00")
	if rem := len(toks) % logFields; rem != 0 {
		return nil, fmt.Errorf("git log: 마지막 레코드의 필드가 %d개다 (want %d): %q", rem, logFields, toks[len(toks)-rem:])
	}
	commits := make([]Commit, 0, len(toks)/logFields)
	for i := 0; i+logFields <= len(toks); i += logFields {
		c, err := commitFromFields(toks[i : i+logFields])
		if err != nil {
			return nil, err
		}
		commits = append(commits, c)
	}
	return commits, nil
}

// commitFromFields 는 9개 필드를 Commit 으로 옮긴다.
func commitFromFields(f []string) (Commit, error) {
	if len(f) < logFields {
		return Commit{}, fmt.Errorf("git log: 필드가 %d개다 (want %d)", len(f), logFields)
	}
	c := Commit{
		Oid:        f[0],
		Abbrev:     f[1],
		Parents:    splitParents(f[2]),
		AuthorName: f[3],
		AuthorMail: f[4],
		AuthorAt:   core.UnixSecToMilli(f[5]),
		CommitAt:   core.UnixSecToMilli(f[6]),
		Subject:    f[8],
	}
	c.Refs, c.IsHead = parseDecoration(f[7])
	return c, nil
}

// splitParents 는 %P 를 쪼갠다. 루트 커밋은 **빈 슬라이스**다 — nil 은 JSON 에서
// null 이 되고, 레인 계산의 입력이 되지 못한다 (FR-GIT-117).
func splitParents(s string) []string {
	if p := strings.Fields(s); len(p) > 0 {
		return p
	}
	return []string{}
}

// parseDecoration 은 %D 를 배지로 쪼갠다. `--decorate=full` 이므로 조각은
// `HEAD -> refs/heads/main`, `tag: refs/tags/v1`, `refs/remotes/origin/main`,
// 또는 detached 의 `HEAD` 다 (git 2.50.1 실측).
//
// ref 이름에는 공백이 들 수 없으므로 `, ` 로 나누는 것이 안전하다.
func parseDecoration(d string) ([]CommitRef, bool) {
	refs := []CommitRef{}
	isHead := false
	if strings.TrimSpace(d) == "" {
		return refs, false
	}
	for _, piece := range strings.Split(d, logDecSep) {
		piece = strings.TrimSpace(piece)
		if piece == "" {
			continue
		}
		// detached HEAD 는 가리키는 ref 가 없다 — 배지를 만들지 않고 커밋 표식만 켠다.
		if piece == logDecHead {
			isHead = true
			continue
		}
		r := CommitRef{}
		if rest, ok := strings.CutPrefix(piece, logDecHeadTo); ok {
			isHead, r.IsHead, piece = true, true, rest
		}
		if rest, ok := strings.CutPrefix(piece, logDecTag); ok {
			r.Name, r.Kind = strings.TrimPrefix(rest, logRefTags), RefKindTag
			refs = append(refs, r)
			continue
		}
		r.Name, r.Kind = shortRefName(piece)
		refs = append(refs, r)
	}
	return refs, isHead
}

// shortRefName 은 전체 refname 에서 네임스페이스를 떼고 종류를 정한다.
//
// 모르는 네임스페이스는 이름 그대로 담고 종류를 비운다 — 조용히 버리면 배지가
// 사라지고, 사용자는 ref 가 없다고 믿는다.
func shortRefName(name string) (short, kind string) {
	for _, ns := range []struct{ prefix, kind string }{
		{logRefHeads, RefKindLocal}, {logRefRemotes, RefKindRemote}, {logRefTags, RefKindTag},
	} {
		if rest, ok := strings.CutPrefix(name, ns.prefix); ok {
			return rest, ns.kind
		}
	}
	return name, ""
}
