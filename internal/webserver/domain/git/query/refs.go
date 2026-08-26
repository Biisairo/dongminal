package query

import (
	"context"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"dongminal/internal/webserver/domain/git/core"
)

// ref 종류. 사이드바의 3그룹(FR-GIT-122)이며, 커밋 배지(CommitRef.Kind)도 같은 값을
// 쓴다 — 같은 것에 두 어휘를 두면 클라이언트가 둘을 다 알아야 한다.
const (
	RefKindLocal  = "local"
	RefKindRemote = "remote"
	RefKindTag    = "tag"
)

// for-each-ref 의 필드 배치.
//
// **`-z` 가 없다** — git 2.50.1 은 `unknown switch 'z'` 로 거부한다. 그래서 레코드는
// 개행으로 끝나고 필드만 NUL 로 나뉜다. 실을 필드는 모두 한 줄짜리이므로(refname·
// oid·track·subject) 이 조합이 모호해지지 않는다.
//
// 시각은 `%(creatordate:unix)` 다. 계약이 적은 `%(committerdate:unix)` 는 annotated
// tag 에서 **비어 온다** (태그 객체에는 committer 가 없다, git 2.50.1 실측) — 그러면
// 사이드바가 1970년을 보인다. creatordate 는 커밋이면 committerdate, 태그면
// taggerdate 를 준다.
const (
	refsFields = 7
	refsFormat = "--format=%(refname)%00%(objectname)%00%(upstream:short)%00%(upstream:track)%00%(HEAD)%00%(contents:subject)%00%(creatordate:unix)"
)

// refsPatterns 는 물을 네임스페이스다. 패턴을 주지 않으면 refs/stash·refs/notes 가
// 함께 와서 종류 없는 항목이 사이드바에 섞인다.
var refsPatterns = []string{"refs/heads", "refs/remotes", "refs/tags"}

// %(upstream:track) 은 `[ahead 2, behind 1]` 형태이며 한쪽만 있을 수도, `[gone]` 일
// 수도 있다. 위치로 세면 `[behind 1]` 이 ahead 로 읽힌다.
var (
	refAheadRe  = regexp.MustCompile(`ahead (\d+)`)
	refBehindRe = regexp.MustCompile(`behind (\d+)`)
)

const refTrackGone = "[gone]"

// Ref 는 사이드바 한 줄이다 (FR-GIT-122).
type Ref struct {
	Name     string `json:"name"`  // refs/heads/main
	Short    string `json:"short"` // main
	Kind     string `json:"kind"`  // local | remote | tag
	Oid      string `json:"oid"`
	Upstream string `json:"upstream,omitempty"`
	Ahead    int    `json:"ahead"`
	Behind   int    `json:"behind"`
	// Gone 은 upstream 이 사라졌다는 뜻이다 (`[gone]`). ahead/behind 0 과 구분되지
	// 않으면 사용자는 동기화된 브랜치로 읽는다.
	Gone     bool   `json:"gone,omitempty"`
	IsHead   bool   `json:"isHead"`
	Subject  string `json:"subject,omitempty"`
	AtUnixMs int64  `json:"atUnixMs"`
}

// Refs 는 로컬·원격·태그를 한 번에 준다 (FR-GIT-122).
//
// ahead/behind 를 따로 세지 않는다 — for-each-ref 가 upstream:track 으로 이미 답하며,
// ref 마다 rev-list 를 돌리면 비용이 ref 수에 비례한다.
func Refs(s *core.Service, ctx context.Context, repo string) ([]Ref, error) {
	args := append([]string{"for-each-ref", refsFormat}, refsPatterns...)
	out, err := s.Exec(ctx, repo, args...)
	if err != nil {
		return nil, err
	}
	if out.StdoutTruncated {
		return nil, fmt.Errorf("git for-each-ref 의 출력이 상한(%dB)에서 잘렸다: ref 목록을 온전히 줄 수 없다", s.MaxOutput())
	}
	return ParseRefs(out.Stdout)
}

// ParseRefs 는 for-each-ref 의 stdout 을 해석한다.
//
// 필드 수가 모자란 레코드는 **오류다.** 조용히 건너뛰면 사이드바에서 브랜치가
// 사라지고, 사용자는 없는 브랜치를 없다고 믿는다.
func ParseRefs(out string) ([]Ref, error) {
	refs := []Ref{}
	for _, line := range strings.Split(out, "\n") {
		if line == "" {
			continue
		}
		f := strings.Split(line, "\x00")
		if len(f) != refsFields {
			return nil, fmt.Errorf("for-each-ref: 필드가 %d개다 (want %d): %q", len(f), refsFields, line)
		}
		r := Ref{Name: f[0], Oid: f[1], Upstream: f[2], Subject: f[5], AtUnixMs: core.UnixSecToMilli(f[6])}
		r.Short, r.Kind = shortRefName(r.Name)
		r.Ahead, r.Behind, r.Gone = parseTrack(f[3])
		// %(HEAD) 는 현재 ref 에 `*`, 그 밖에는 공백 한 칸이다.
		r.IsHead = strings.TrimSpace(f[4]) == "*"
		refs = append(refs, r)
	}
	return refs, nil
}

// parseTrack 은 `[ahead 2, behind 1]` 에서 수를 뽑는다. 없는 쪽은 0 이다 —
// upstream 이 없으면 track 자체가 비고, 그 판정은 Upstream 필드가 한다.
func parseTrack(track string) (ahead, behind int, gone bool) {
	if track == "" {
		return 0, 0, false
	}
	if strings.Contains(track, refTrackGone) {
		return 0, 0, true
	}
	return trackNum(refAheadRe, track), trackNum(refBehindRe, track), false
}

func trackNum(re *regexp.Regexp, track string) int {
	m := re.FindStringSubmatch(track)
	if m == nil {
		return 0
	}
	n, err := strconv.Atoi(m[1])
	if err != nil {
		return 0
	}
	return n
}
