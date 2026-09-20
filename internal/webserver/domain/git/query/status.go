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
	// Dir 은 이 항목이 파일이 아니라 **디렉터리 하나**를 가리키는가다
	// (GIT_DIR_ENTRY_SRS FR-DIR-1). 근거가 둘이라 서버가 확정한다 (D-DIR-1) —
	// 클라이언트가 경로의 마지막 문자로 판정하면 판정 자리가 둘이 된다.
	//
	//   ? 레코드의 경로가 "/" 로 끝난다      → 중첩 저장소 (Sub 는 빈 값)
	//   1·2 레코드의 sub 가 "S" 로 시작한다  → 서브모듈 (gitlink, 모드 160000)
	//
	// 두 경우 모두 그 디렉터리 **안**은 이 저장소의 관측 대상이 아니다 — git 이
	// 다른 저장소 안을 들여다보지 않기 때문이며, --untracked-files=all 도
	// 그것만은 펴지 못한다 (§2.1 실측).
	Dir bool `json:"dir,omitempty"`
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
	// Truncated 는 상한에서 잘린 그룹의 **원래 개수**다
	// (GIT_DETECT_TIER_SRS FR-GDT-22·23 · `11 GP-15`).
	//
	//   이전 동작: 상한이 없었다. 변경·미추적 파일이 수만 개인 저장소(빌드
	//             산출물, `node_modules` 미무시)에서 서버는 그 목록 전체를 매
	//             회차 만들어 해시하고, 브라우저는 관측마다 통째로 문자열화했다.
	//             History 는 300/100 페이징이 있는데 status 만 상한이 없었다
	//   새  동작: 그룹마다 `StatusGroupCap` 에서 자르고 **잘렸다는 사실을 싣는다**
	//   이유:     조용히 자르면 사용자는 파일이 없어진 것으로 읽는다 (FR-GDT-23).
	//             `Total` 은 자르기 **전**의 수라 배지는 여전히 참이다
	Truncated map[string]int `json:"truncated,omitempty"`
	// OutputTruncated 는 **git 의 출력 자체가** 상한(`core.DefaultMaxOutput`,
	// 1MiB)에서 잘렸다는 뜻이다 (SAFETY_CORRECTNESS_SRS FR-SAF-19·20·21).
	//
	// `Truncated` 와 **다른 종류의 사실**이라 섞지 않는다. 그쪽은 "이 그룹이 몇
	// 개였는가" 이고 프론트가 키별로 **합을 낸다**(`gitGroupTruncated`) — 거기에
	// 개수가 아닌 값을 넣으면 그 합이 깨진다.
	//
	//   이전 동작: 잘림을 보지 않고 곧장 파싱했다. 조회 아홉 중 여덟은 보는데
	//             `StatusOf` 만 안 봤다. 잘림은 NUL 경계를 가리지 않으므로
	//             마지막 레코드가 중간에서 끊기면 파싱이 실패해 **status 가
	//             영구히 실패**하고, 우연히 경계에 맞으면 **조용히 짧은 목록**이
	//             됐다
	//   새  동작: 온전한 레코드까지만 파싱하고 이 표식을 세운다
	//   이유:     status 는 실패로 끝낼 수 없는 표면이다 (D-SAF-2). 배지·관측이
	//             여기 딛고 `StashPush`·`CleanUntracked`·`Rebase`·`PushSpec` 이
	//             전부 이 함수를 지나므로, 오류로 끝내면 그 저장소에서 여섯이
	//             함께 막힌다
	//
	// **이것이 서면 `Total` 은 하한이지 정확한 수가 아니다** (FR-SAF-21).
	OutputTruncated bool `json:"outputTruncated,omitempty"`
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
	statusSubIsSub    = "S"    // sub 필드의 첫 글자. gitlink 임을 뜻한다 (FR-DIR-1)
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
			st.Untracked = append(st.Untracked, newUntracked(tok[2:]))
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
		// FR-DIR-1: sub 필드의 첫 글자가 "S" 면 gitlink 다 — 이 항목은 파일이
		// 아니라 서브모듈 디렉터리 하나를 가리킨다.
		e.Dir = strings.HasPrefix(sub, statusSubIsSub)
	}
	return e
}

// newUntracked 는 ? 레코드 하나를 만든다.
//
// FR-DIR-2: 미추적 **디렉터리**는 경로가 "/" 로 끝나 온다. 그 슬래시를 벗기고
// 사실은 Dir 로 옮긴다 — 경로 문법이 항목마다 달라지면 그 경로를 받는 모든
// 곳(탐색기 매칭·스테이지·discard·diff)이 각자 슬래시를 처리해야 한다 (D-DIR-2).
//
// 벗기는 것은 **끝의 한 겹뿐**이다. 경로 안의 슬래시는 계층 구분이라 그대로 둔다.
func newUntracked(path string) FileEntry {
	e := FileEntry{Path: path, XY: statusUntrackedXY, Untracked: true}
	if strings.HasSuffix(path, "/") {
		e.Path = strings.TrimSuffix(path, "/")
		e.Dir = true
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
// StatusGroupCap 은 그룹 하나가 실어 나르는 항목 수의 상한이다 (FR-GDT-22).
//
// 2000 은 사람이 화면에서 다룰 수 있는 수를 한참 넘는다 — 그보다 많으면 목록이
// 아니라 잡음이고, 사용자가 할 일은 `.gitignore` 를 고치는 것이다.
const StatusGroupCap = 2000

func finalizeStatus(st *Status) {
	seen := make(map[string]struct{})
	names := []string{"staged", "changes", "untracked", "conflicts"}
	for i, g := range []*[]FileEntry{&st.Staged, &st.Changes, &st.Untracked, &st.Conflicts} {
		sort.SliceStable(*g, func(a, b int) bool { return (*g)[a].Path < (*g)[b].Path })
		for _, e := range *g {
			seen[e.Path] = struct{}{}
		}
		// **자르기는 세기 뒤다** (FR-GDT-23): `Total` 은 배지의 근거이고 그것이
		// 잘린 수를 말하면 사용자가 세는 파일 수와 어긋난다.
		if n := len(*g); n > StatusGroupCap {
			if st.Truncated == nil {
				st.Truncated = map[string]int{}
			}
			st.Truncated[names[i]] = n
			*g = (*g)[:StatusGroupCap]
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
	// FR-SAF-19·20: 잘렸으면 **온전한 레코드까지만** 넘긴다. 상한은 NUL 경계를
	// 가리지 않으므로 마지막 토막은 레코드가 아니다 — 그대로 파서에 주면
	// "필드가 N개다" 로 실패하고, 이 표면은 실패로 끝낼 수 없다 (D-SAF-2).
	raw := out.Stdout
	if out.StdoutTruncated {
		raw = dropPartialRecord(raw)
	}
	st, err := ParseStatusV2(raw)
	if err != nil {
		return Status{}, err
	}
	st.Repo = repo
	st.OutputTruncated = out.StdoutTruncated
	return st, nil
}

// dropPartialRecord 는 마지막 NUL 뒤에 남은 토막을 버린다.
//
// NUL 이 하나도 없으면 온전한 레코드가 하나도 없다는 뜻이므로 전부 버린다 —
// 머리글(`# branch.head …`)조차 끝나지 않았다.
func dropPartialRecord(s string) string {
	i := strings.LastIndexByte(s, 0)
	if i < 0 {
		return ""
	}
	return s[:i+1]
}
