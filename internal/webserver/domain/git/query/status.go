package query

import (
	"context"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"dongminal/internal/webserver/domain/git/core"
)

// FileEntry 는 변경 파일 한 개다. porcelain v2 의 XY 를 그대로 보존한다 —
// 표시 계층이 해석을 바꿀 수 있어야 하고, 서버가 의미를 미리 뭉개면 되돌릴 수 없다.
type FileEntry struct {
	Path      string `json:"path"`
	OrigPath  string `json:"origPath,omitempty"` // rename/copy 원본 (FR-GIT-36)
	XY        string `json:"xy"`                 // 2문자. '.' 는 변화 없음
	Staged    bool   `json:"staged"`             // X != '.'
	Unstaged  bool   `json:"unstaged"`           // Y != '.'
	Conflict  bool   `json:"conflict"`           // porcelain 레코드 종류가 'u'
	Untracked bool   `json:"untracked"`          // 레코드 종류가 '?'
	Score     int    `json:"score,omitempty"`    // rename/copy 유사도 (R100 의 100)
	Sub       string `json:"sub,omitempty"`      // 서브모듈 상태 필드. "N..." 이면 생략
}

// Status 는 한 리포의 관측 결과다.
type Status struct {
	Repo        string      `json:"repo"`
	Oid         string      `json:"oid"`      // HEAD 커밋. 초기 커밋 전이면 ""
	Branch      string      `json:"branch"`   // detached 면 ""
	Detached    bool        `json:"detached"` // FR-GIT-33
	Initial     bool        `json:"initial"`  // 커밋이 없는 저장소
	Upstream    string      `json:"upstream"`
	HasUpstream bool        `json:"hasUpstream"` // FR-GIT-33
	Ahead       int         `json:"ahead"`
	Behind      int         `json:"behind"`
	Staged      []FileEntry `json:"staged"`
	Changes     []FileEntry `json:"changes"`
	Untracked   []FileEntry `json:"untracked"`
	Conflicts   []FileEntry `json:"conflicts"`
	Total       int         `json:"total"` // **서로 다른 경로의 개수.** 배지용 (FR-GIT-14)
	// Operation 은 충돌로 멈춘 중간 상태다 (FR-GIT-251). porcelain 은 이것을 주지
	// 않으므로 gitdir 의 표식에서 파생하며, 관측을 만드는 자리(store.observe)가
	// 채운다 — 여기서 채우면 status 마다 rev-parse 가 한 번씩 더 돈다.
	Operation Operation `json:"operation"`
}

// porcelain v2 의 자리표시자와 필드 수. 숫자를 파싱 코드에 흩뿌리면 어느 레코드
// 종류의 규칙인지 알 수 없게 된다.
const (
	statusInitialOid  = "(initial)"
	statusDetached    = "(detached)"
	statusNoChange    = '.'
	statusSubNone     = "N..." // 서브모듈이 아니라는 표시. 실을 정보가 없다
	statusOrdFields   = 8      // 1 레코드: XY sub mH mI mW hH hI path
	statusRenFields   = 9      // 2 레코드: + <X><score>
	statusUnmerFields = 10     // u 레코드: XY sub m1 m2 m3 mW h1 h2 h3 path
	statusUntrackedXY = "??"   // ? 레코드에는 XY 가 없다 — v1 의 관용 표기를 쓴다
)

// ParseStatusV2 는 `git status --porcelain=v2 -z --branch` 의 stdout 을 해석한다.
// 레코드는 NUL 로 끝난다 — 헤더(`# ...`)도 마찬가지다 (git 2.50 확인).
//
// 필드 수가 모자란 레코드는 **오류다.** 조용히 건너뛰면 목록이 조용히 틀리고,
// 사용자는 없는 파일을 없다고 믿는다.
func ParseStatusV2(out string) (Status, error) {
	var st Status
	toks := strings.Split(out, "\x00")
	if n := len(toks); n > 0 && toks[n-1] == "" {
		toks = toks[:n-1]
	}
	for i := 0; i < len(toks); i++ {
		tok := toks[i]
		if tok == "" {
			continue
		}
		switch {
		case strings.HasPrefix(tok, "# "):
			parseStatusHeader(&st, tok)
		case strings.HasPrefix(tok, "1 "):
			e, err := parseOrdinary(tok[2:])
			if err != nil {
				return Status{}, err
			}
			addTracked(&st, e)
		case strings.HasPrefix(tok, "2 "):
			// rename/copy 는 NUL 조각 2개를 소비한다 — origPath 가 뒤따른다.
			if i+1 >= len(toks) {
				return Status{}, fmt.Errorf("porcelain v2: rename 레코드에 origPath 가 없다: %q", tok)
			}
			e, err := parseRenamed(tok[2:], toks[i+1])
			if err != nil {
				return Status{}, err
			}
			i++
			addTracked(&st, e)
		case strings.HasPrefix(tok, "u "):
			e, err := parseUnmerged(tok[2:])
			if err != nil {
				return Status{}, err
			}
			// 충돌은 Conflicts 에만 든다 (FR-GIT-37). Staged·Changes 에 넣으면
			// 충돌 파일이 스테이징 가능한 것처럼 보인다.
			st.Conflicts = append(st.Conflicts, e)
		case strings.HasPrefix(tok, "? "):
			st.Untracked = append(st.Untracked, FileEntry{Path: tok[2:], XY: statusUntrackedXY, Untracked: true})
		case strings.HasPrefix(tok, "! "):
			// --ignored 를 주지 않으므로 나오지 않아야 한다. 나와도 관심 대상이 아니다.
		default:
			return Status{}, fmt.Errorf("porcelain v2: 알 수 없는 레코드: %q", tok)
		}
	}
	finalizeStatus(&st)
	return st, nil
}

func parseStatusHeader(st *Status, tok string) {
	parts := strings.SplitN(tok, " ", 3)
	if len(parts) < 3 {
		return
	}
	switch parts[1] {
	case "branch.oid":
		if parts[2] == statusInitialOid {
			st.Initial = true
		} else {
			st.Oid = parts[2]
		}
	case "branch.head":
		if parts[2] == statusDetached {
			st.Detached = true
		} else {
			st.Branch = parts[2]
		}
	case "branch.upstream":
		st.Upstream = parts[2]
		st.HasUpstream = true
	case "branch.ab":
		st.Ahead, st.Behind = parseAheadBehind(parts[2])
	}
	// 모르는 # 헤더는 조용히 무시한다 — git 이 헤더를 늘려도 깨지지 않아야 한다.
}

// parseAheadBehind 는 "+2 -3" 을 읽는다. 읽지 못한 쪽은 0 이다 — ahead/behind 는
// upstream 이 있을 때만 의미가 있고, 그 판정은 branch.upstream 이 한다.
func parseAheadBehind(s string) (ahead, behind int) {
	for _, f := range strings.Fields(s) {
		n, err := strconv.Atoi(f[1:])
		if err != nil {
			continue
		}
		switch f[0] {
		case '+':
			ahead = n
		case '-':
			behind = n
		}
	}
	return ahead, behind
}

// parseOrdinary 는 `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>` 의 뒷부분을 읽는다.
// 경로에 공백이 있을 수 있으므로 앞 7개 필드만 떼고 나머지 전부를 경로로 삼는다.
func parseOrdinary(rest string) (FileEntry, error) {
	f := strings.SplitN(rest, " ", statusOrdFields)
	if len(f) < statusOrdFields {
		return FileEntry{}, fmt.Errorf("porcelain v2: 1 레코드의 필드가 %d개다 (want %d): %q", len(f), statusOrdFields, rest)
	}
	return newTracked(f[0], f[1], f[statusOrdFields-1]), nil
}

// parseRenamed 는 `2 … <X><score> <path>` 와 다음 조각의 origPath 를 읽는다.
func parseRenamed(rest, origPath string) (FileEntry, error) {
	f := strings.SplitN(rest, " ", statusRenFields)
	if len(f) < statusRenFields {
		return FileEntry{}, fmt.Errorf("porcelain v2: 2 레코드의 필드가 %d개다 (want %d): %q", len(f), statusRenFields, rest)
	}
	e := newTracked(f[0], f[1], f[statusRenFields-1])
	e.OrigPath = origPath
	// <X><score> 는 R100·C75 형태다. 첫 글자는 rename/copy 구분이고 XY 가 이미
	// 같은 정보를 담으므로 버린다.
	if score := f[statusRenFields-2]; len(score) > 1 {
		if n, err := strconv.Atoi(score[1:]); err == nil {
			e.Score = n
		}
	}
	return e, nil
}

// parseUnmerged 는 `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>` 를 읽는다.
func parseUnmerged(rest string) (FileEntry, error) {
	f := strings.SplitN(rest, " ", statusUnmerFields)
	if len(f) < statusUnmerFields {
		return FileEntry{}, fmt.Errorf("porcelain v2: u 레코드의 필드가 %d개다 (want %d): %q", len(f), statusUnmerFields, rest)
	}
	e := newTracked(f[0], f[1], f[statusUnmerFields-1])
	e.Conflict = true
	return e, nil
}

func newTracked(xy, sub, path string) FileEntry {
	e := FileEntry{Path: path, XY: xy}
	if len(xy) == 2 {
		e.Staged = xy[0] != statusNoChange
		e.Unstaged = xy[1] != statusNoChange
	}
	if sub != statusSubNone {
		e.Sub = sub
	}
	return e
}

// addTracked 는 1·2 레코드를 그룹에 넣는다. 한 파일이 양쪽에 드는 것은 사실이며,
// M2 의 indeterminate 표시(FR-GIT-70)가 그 사실 위에 선다.
func addTracked(st *Status, e FileEntry) {
	if e.Staged {
		st.Staged = append(st.Staged, e)
	}
	if e.Unstaged {
		st.Changes = append(st.Changes, e)
	}
}

// finalizeStatus 는 그룹을 경로 오름차순으로 정렬하고 Total 을 센다.
// 정렬하는 이유는 UI 가 git 의 출력 순서에 의존하지 않게 하는 것이다.
func finalizeStatus(st *Status) {
	seen := make(map[string]struct{})
	for _, g := range []*[]FileEntry{&st.Staged, &st.Changes, &st.Untracked, &st.Conflicts} {
		sort.SliceStable(*g, func(i, j int) bool { return (*g)[i].Path < (*g)[j].Path })
		for _, e := range *g {
			seen[e.Path] = struct{}{}
		}
	}
	// Total 은 합이 아니라 서로 다른 경로의 개수다 — 한 파일이 Staged·Changes 에
	// 동시에 들면 배지가 2 가 되어 사용자가 세는 파일 수와 어긋난다.
	st.Total = len(seen)
}

// StatusOf 는 리포 하나의 상태를 관측한다. 캐시·single-flight 는 Store 의 일이다.
//
// --ignored 를 주지 않는다 — 무시된 파일은 관심 대상이 아니고 비용만 든다.
//
// --untracked-files=all 은 반드시 준다 (FR-GIT-215). git 기본값(normal)은 추적되지
// 않는 디렉터리를 `newdir/` **한 줄로 접어** 안의 파일을 하나도 열거하지 않는다.
// 접힌 항목은 파일이 아니므로 이름도 diff 도 개수도 성립하지 않는다 — FR-GIT-34 가
// 분류 대상으로 못박은 것은 "변경 **파일**" 이다.
func StatusOf(s *core.Service, ctx context.Context, repo string) (Status, error) {
	out, err := s.Exec(ctx, repo, "status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all")
	if err != nil {
		return Status{}, err
	}
	st, err := ParseStatusV2(out.Stdout)
	if err != nil {
		return Status{}, err
	}
	st.Repo = repo
	return st, nil
}
