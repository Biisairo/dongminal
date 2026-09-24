package write

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"dongminal/internal/webserver/domain/git/core"
	"dongminal/internal/webserver/domain/git/query"
)

// stash 조작 (GIT_SRS §3D.2 FR-GIT-161~170).
//
// **`stash` 는 writeCommands 에 있다** (FR-GIT-95). 두 허용 목록의 교집합을 비우기
// 위한 대가로, `stash list`·`stash show` 처럼 읽기뿐인 하위 동작도 ExecWrite 로
// 간다 — Destructive 는 false 이며 그 선언이 실행 기록에 남는다 (I5).

// stash list 의 필드 배치.
//
// 레코드 끝의 `%x00` 이 구분자를 만든다 — 그래서 `\x00\n` 으로 레코드를 나눈다.
// git 은 reflog 메시지의 개행을 공백으로 바꾸므로(2.50.1 실측) 줄로 나눠도 되지만,
// 이렇게 하면 그 가정에 기대지 않는다.
const (
	stashFields = 4
	stashFormat = "--format=%gd%x00%H%x00%gs%x00%ct%x00"
	stashRecSep = "\x00\n"
)

// `%gs` 의 두 형태 (git 2.50.1 실측).
//
//	WIP on main: abc123 subject      ← 메시지 없이 만든 것
//	On feat/a: has: colon in msg     ← --message 로 만든 것
//
// detached 에서는 기준이 `(no branch)` 다.
const (
	stashWIPPrefix = "WIP on "
	stashOnPrefix  = "On "
	stashBaseSep   = ": "
)

// stashRefFormat 은 `stash@{n}` 이다. 인덱스에서 ref 를 만드는 자리가 여럿이므로
// 형식을 한 자리에 둔다.
const stashRefFormat = "stash@{%d}"

const (
	stashIndexFlag       = "--index"
	stashUntrackedFlag   = "--include-untracked"
	stashKeepIndexFlag   = "--keep-index"
	stashMessageFlag     = "--message="
	stashNameStatusFlags = "--name-status"
)

var stashRefRe = regexp.MustCompile(`^stash@\{(\d+)\}$`)

var (
	// ErrStashEmpty 는 저장할 변경이 없다는 것이다 (FR-GIT-167).
	ErrStashEmpty = errors.New("nothing_to_stash")
	// ErrStashMoved 는 고른 stash(oid)가 목록에 없다는 것이다 (REPO_FIX 01 §5.3).
	// 위치가 밀린 것은 여기 해당하지 않는다 — oid 로 현재 위치를 찾는다.
	ErrStashMoved = errors.New("stash_moved")
)

// Stash 는 Stash 탭 한 줄이다 (FR-GIT-161).
type Stash struct {
	Index    int    `json:"index"` // stash@{n} 의 n
	Oid      string `json:"oid"`
	Message  string `json:"message"`
	Base     string `json:"base"` // 기준 브랜치. detached 면 `(no branch)`
	AtUnixMs int64  `json:"atUnixMs"`
}

// StashPushOpts 는 stash 생성 다이얼로그의 선택이다 (FR-GIT-166).
type StashPushOpts struct {
	Message          string `json:"message"`
	IncludeUntracked bool   `json:"includeUntracked"`
	KeepIndex        bool   `json:"keepIndex"`
}

// StashPopKept 는 pop 한 번의 뒷정리 사실이다 (FR-GIT-165, 검증 V57).
//
// Kept 는 **목록을 다시 찍어 확인한 것**이다 — 종료 코드나 출력 문구로 짐작하지
// 않는다. git 의 문구가 바뀌는 순간 짐작은 거짓이 된다.
type StashPopKept struct {
	Kept   bool   `json:"stashKept"`
	Reason string `json:"stashKeptReason,omitempty"`
	Oid    string `json:"stashKeptOid,omitempty"`
}

// StashRef 는 인덱스를 `stash@{n}` 으로 옮긴다. 음수는 오류다 — `stash@{-1}` 은
// git 에서 다른 뜻이 되므로 인자로 넘기기 전에 막는다.
func StashRef(index int) (string, error) {
	if index < 0 {
		return "", fmt.Errorf("%w: stash 인덱스는 0 이상이어야 한다: %d", core.ErrUnsafeArgument, index)
	}
	return fmt.Sprintf(stashRefFormat, index), nil
}

// StashList 는 stash 전부를 준다 (FR-GIT-161).
func StashList(s *core.Service, ctx context.Context, repo string) ([]Stash, error) {
	out, err := s.ExecWrite(ctx, repo, core.WriteSpec{Argv: []string{"stash", "list", stashFormat}})
	if err != nil {
		return nil, err
	}
	if out.StdoutTruncated {
		return nil, fmt.Errorf("git stash list 의 출력이 상한(%dB)에서 잘렸다: stash 목록을 온전히 줄 수 없다", s.MaxOutput())
	}
	return ParseStashList(out.Stdout)
}

// ParseStashList 는 stash list 의 stdout 을 해석한다.
//
// 필드 수가 모자란 레코드는 **오류다.** 조용히 건너뛰면 목록에서 stash 가 사라지고,
// 사용자는 자기 작업이 없어진 것으로 읽는다.
func ParseStashList(out string) ([]Stash, error) {
	list := []Stash{}
	for _, rec := range strings.Split(out, stashRecSep) {
		if rec == "" {
			continue
		}
		f := strings.Split(rec, "\x00")
		if len(f) != stashFields {
			return nil, fmt.Errorf("stash list: 필드가 %d개다 (want %d): %q", len(f), stashFields, rec)
		}
		idx, err := stashIndexOf(f[0])
		if err != nil {
			return nil, err
		}
		st := Stash{Index: idx, Oid: f[1], AtUnixMs: core.UnixSecToMilli(f[3])}
		st.Base, st.Message = stashSubject(f[2])
		list = append(list, st)
	}
	return list, nil
}

// StashPush 는 워킹 트리의 변경을 stash 로 옮긴다 (FR-GIT-166).
//
// **담을 것이 없으면 실행하지 않는다** (FR-GIT-167). git 은 그 경우 exit 0 +
// "No local changes to save" 로 끝나므로(2.50.1 실측), 성공으로 답하면 사용자는
// 만들어지지 않은 stash 를 찾는다. 사유를 오류에 담는다.
func StashPush(s *core.Service, ctx context.Context, repo string, o StashPushOpts) (core.Output, error) {
	st, err := query.StatusOf(s, ctx, repo)
	if err != nil {
		return denied(), err
	}
	if StashableCount(st, o.IncludeUntracked) == 0 {
		return denied(), fmt.Errorf("%w: %s", ErrStashEmpty, StashEmptyReason(st, o.IncludeUntracked))
	}
	argv := []string{"stash", "push"}
	if o.IncludeUntracked {
		argv = append(argv, stashUntrackedFlag)
	}
	if o.KeepIndex {
		argv = append(argv, stashKeepIndexFlag)
	}
	// 값은 `=` 형태로만 붙인다 — 별도 인자로 넘기면 메시지가 옵션처럼 생겼을 때
	// git 이 그것을 옵션으로 읽는다.
	if o.Message != "" {
		argv = append(argv, stashMessageFlag+o.Message)
	}
	return s.ExecWrite(ctx, repo, core.WriteSpec{Argv: argv})
}

// StashableCount 는 이 옵션으로 실행했을 때 담길 항목 수다 (FR-GIT-167).
//
// **untracked 는 `--include-untracked` 가 있을 때만 센다.** untracked 만 있는
// 저장소에서 그 옵션 없이 실행하면 git 은 아무것도 담지 않고 성공한다.
//
// 서로 다른 경로의 수(Status.Total)를 쓰지 않는 이유는 그것이 untracked 를 늘
// 포함하기 때문이다 — 0 인지만 보므로 중복은 문제가 되지 않는다.
func StashableCount(st query.Status, includeUntracked bool) int {
	n := len(st.Staged) + len(st.Changes) + len(st.Conflicts)
	if includeUntracked {
		n += len(st.Untracked)
	}
	return n
}

// StashEmptyReason 은 담을 것이 없는 이유다. 클라이언트가 생성 버튼을 끄면서 그대로
// 보인다 (FR-GIT-167) — 이유 없이 꺼진 버튼은 사용자가 해소할 수 없다.
func StashEmptyReason(st query.Status, includeUntracked bool) string {
	if !includeUntracked && len(st.Untracked) > 0 {
		return fmt.Sprintf("추적되지 않는 파일 %d개뿐이다: --include-untracked 를 켜야 담긴다", len(st.Untracked))
	}
	return "저장할 변경이 없다"
}

// REPO_FIX 01 §5.3 — stash 는 **oid 로** 지목한다.
//
//	이전 동작: 위치(index)로 지목했다 — 사용자가 목록을 본 뒤 다른 곳에서 stash
//	          push/drop 이 일어나면 다른 stash 가 적용·삭제됐다
//	새  동작: 클라이언트가 본 oid 를 받아 **실행 직전에** 목록에서 현재 위치를 찾는다.
//	          apply·show 는 oid 를 그대로 넘기고, pop·drop·branch 는 찾은 stash@{n}
//	          을 넘긴다(git 이 그 셋에는 ref 만 받거나, ref 로 열어야 스스로 지운다)
//	이유:     위치는 목록이 바뀌면 다른 stash 를 가리킨다
//
// 목록에 없으면 ErrStashMoved 다. dongminal 밖(터미널)이 목록 조회와 실행 사이에
// 끼는 창은 남는다 — dongminal 안의 경쟁은 호출자가 잠금으로 막는다.

// CheckStashOid 는 oid 형식(sha1 40자·sha256 64자 16진수)인지 본다. 위치 참조
// (`stash@{n}`)·ref 이름은 받지 않는다 — 그것이 곧 위치 지목이다.
func CheckStashOid(oid string) error {
	if len(oid) != 40 && len(oid) != 64 {
		return fmt.Errorf("%w: stash oid 형식이 아니다: %q", core.ErrUnsafeArgument, oid)
	}
	for _, c := range oid {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return fmt.Errorf("%w: stash oid 형식이 아니다: %q", core.ErrUnsafeArgument, oid)
		}
	}
	return nil
}

// StashLocate 는 목록에서 oid 의 현재 항목을 찾는다.
func StashLocate(s *core.Service, ctx context.Context, repo, oid string) (Stash, []Stash, error) {
	if err := CheckStashOid(oid); err != nil {
		return Stash{}, nil, err
	}
	list, err := StashList(s, ctx, repo)
	if err != nil {
		return Stash{}, nil, err
	}
	for _, st := range list {
		if st.Oid == oid {
			return st, list, nil
		}
	}
	return Stash{}, list, fmt.Errorf("%w: stash %s 가 목록에 없다 (stash %d개)", ErrStashMoved, oid, len(list))
}

// StashApply 는 stash 를 워킹 트리에 얹고 **stash 를 남긴다** (FR-GIT-163).
// withIndex 는 index 까지 복원한다 (`--index`).
func StashApply(s *core.Service, ctx context.Context, repo, oid string, withIndex bool) (core.Output, error) {
	if _, _, err := StashLocate(s, ctx, repo, oid); err != nil {
		return denied(), err
	}
	return s.ExecWrite(ctx, repo, core.WriteSpec{Argv: stashRestoreArgs("apply", oid, withIndex)})
}

// StashPop 은 stash 를 얹고 그것을 지운다 (FR-GIT-164).
//
// **충돌로 끝나면 git 이 stash 를 남긴다.** 그것을 확인해 알리는 것은
// StashPopChecked 의 일이다 (FR-GIT-165) — 여기서는 실행만 한다.
func StashPop(s *core.Service, ctx context.Context, repo, oid string, withIndex bool) (core.Output, error) {
	target, _, err := StashLocate(s, ctx, repo, oid)
	if err != nil {
		return denied(), err
	}
	return s.ExecWrite(ctx, repo, core.WriteSpec{Argv: stashRestoreArgs("pop", fmt.Sprintf(stashRefFormat, target.Index), withIndex)})
}

// StashPopChecked 는 pop 을 실행하고 stash 가 남았는지 **확인한다** (FR-GIT-165,
// 검증 V57).
//
// 충돌로 끝나면 git 은 stash 를 지우지 않는다. 조용히 넘기면 사용자는 작업을 잃었다고
// 오해한다 — 그래서 목록을 다시 찍어 **그 oid 가 남았는지** 본다(위치는 보지 않는다).
//
// pop 이 실패해도 확인한다 — 확인이 필요한 경우가 바로 실패한 경우다.
func StashPopChecked(s *core.Service, ctx context.Context, repo, oid string, withIndex bool) (core.Output, StashPopKept, error) {
	if _, _, err := StashLocate(s, ctx, repo, oid); err != nil {
		return denied(), StashPopKept{}, err
	}
	out, popErr := StashPop(s, ctx, repo, oid, withIndex)
	kept, listErr := stashKeptAfter(s, ctx, repo, oid,
		"pop 이 끝나지 않아 git 이 stash(%s) 를 남겼다 — 저장한 작업은 사라지지 않았다. 충돌을 해소한 뒤 drop 하면 된다.")
	if listErr != nil {
		// 확인하지 못한 것을 "남지 않았다" 로 답하지 않는다.
		return out, StashPopKept{}, errors.Join(popErr, listErr)
	}
	return out, kept, popErr
}

// stashKeptAfter 는 실행 뒤 목록에 oid 가 남았는지다.
func stashKeptAfter(s *core.Service, ctx context.Context, repo, oid, reasonFmt string) (StashPopKept, error) {
	after, err := StashList(s, ctx, repo)
	if err != nil {
		return StashPopKept{}, err
	}
	for _, st := range after {
		if st.Oid == oid {
			return StashPopKept{Kept: true, Oid: oid, Reason: fmt.Sprintf(reasonFmt, oid)}, nil
		}
	}
	return StashPopKept{}, nil
}

// StashDrop 은 stash 를 지운다. **파괴적이다** (FR-GIT-89·168).
//
// 실행 **전에** recovery hint 를 남긴다 (FR-GIT-92). 실행 후에 남기면 이미 지워진
// stash 의 sha·메시지·시각을 읽을 수 없고, 실패한 경로에서는 hint 가 아예 없다.
func StashDrop(s *core.Service, ctx context.Context, repo, oid string) (core.Output, error) {
	target, _, err := StashLocate(s, ctx, repo, oid)
	if err != nil {
		// 지우지 않은 것의 복구 안내는 거짓이므로 hint 도 남기지 않는다.
		return denied(), err
	}
	s.AddHint(stashDropHint(repo, target))
	return s.ExecWrite(ctx, repo, core.WriteSpec{Argv: []string{"stash", "drop", fmt.Sprintf(stashRefFormat, target.Index)}, Destructive: true})
}

// StashBranchArgs 는 `stash branch <name> <stash>` 의 argv 다 (FR-GIT-272).
//
// **실행하지 않는다** — 서버가 잘못된 이름·인덱스를 실행 전에 400 으로 답할 수
// 있어야 하고, 테스트가 무엇을 실행하지 않았는가를 볼 수 있어야 한다
// (FR-GIT-250 ①, `CheckoutArgs` 의 선례).
//
// 이름 규칙 전체는 여기서 판정하지 않는다 — 그것은 `query.ValidBranchName` 이
// git 에 물어 답한다. 여기서 막는 것은 git 에 넘기는 순간 뜻이 달라지는 값뿐이다.
func StashBranchArgs(name string, index int) ([]string, error) {
	if err := core.CheckRefArg("name", name); err != nil {
		return nil, err
	}
	ref, err := StashRef(index)
	if err != nil {
		return nil, err
	}
	return []string{"stash", "branch", name, ref}, nil
}

// StashBranch 는 stash 를 새 브랜치에 적용하며 옮겨 간다 (FR-GIT-272, 검증 V199).
//
// **파괴적이 아니다.** git 은 적용이 끝난 뒤에만 그 stash 를 지우므로 잃는 것이
// 없다 — 실패하면 stash 는 그대로 남는다. 그 사실을 pop 과 같은 확인으로 알린다
// (REPO_FIX 01 §5.3): 적용이 충돌하면 브랜치는 만들어지고 stash 는 남는다.
//
// 없는 stash 는 **실행하지 않는다.** git 에 그대로 넘기면 브랜치를 만들다 만
// 상태가 남을 수 있고, 사용자는 왜 그 브랜치가 생겼는지 알 수 없다.
func StashBranch(s *core.Service, ctx context.Context, repo, name, oid string) (core.Output, StashPopKept, error) {
	target, _, err := StashLocate(s, ctx, repo, oid)
	if err != nil {
		return denied(), StashPopKept{}, err
	}
	argv, err := StashBranchArgs(name, target.Index)
	if err != nil {
		return denied(), StashPopKept{}, err
	}
	out, runErr := s.ExecWrite(ctx, repo, core.WriteSpec{Argv: argv})
	kept, listErr := stashKeptAfter(s, ctx, repo, oid,
		"stash branch 가 끝나지 않아 git 이 stash(%s) 를 남겼다 — 저장한 작업은 사라지지 않았다.")
	if listErr != nil {
		return out, StashPopKept{}, errors.Join(runErr, listErr)
	}
	return out, kept, runErr
}

// StashPreview 는 stash 가 바꾼 파일 목록이다 (FR-GIT-169).
//
// **oid 로 직접 연다** (REPO_FIX 01 §5.3) — 위치를 거치지 않으므로 목록 조회와
// 실행 사이에 위치가 밀려도 다른 stash 를 보이지 않는다. 목록은 그 oid 가 아직
// stash 인지 확인하는 데만 쓴다.
//
// `-z` 이므로 rename 은 세 조각이다 — 커밋 상세와 **같은 파서**를 쓴다.
//
// **untracked 는 여기 없다.** `stash show` 는 `--include-untracked` 로 담은 파일을
// 보이지 않는다 (git 2.50.1 실측).
func StashPreview(s *core.Service, ctx context.Context, repo, oid string) ([]query.CommitFile, error) {
	if _, _, err := StashLocate(s, ctx, repo, oid); err != nil {
		return nil, err
	}
	out, err := s.ExecWrite(ctx, repo, core.WriteSpec{Argv: []string{"stash", "show", stashNameStatusFlags, "-z", oid}})
	if err != nil {
		return nil, err
	}
	if out.StdoutTruncated {
		return nil, fmt.Errorf("git stash show 의 출력이 상한(%dB)에서 잘렸다: 변경 파일 목록을 온전히 줄 수 없다", s.MaxOutput())
	}
	return query.ParseNameStatusZ(out.Stdout)
}

// stashRestoreArgs 는 apply/pop 의 공통 argv 다. 둘은 stash 를 지우는지만 다르다.
func stashRestoreArgs(sub, target string, withIndex bool) []string {
	argv := []string{"stash", sub}
	if withIndex {
		argv = append(argv, stashIndexFlag)
	}
	return append(argv, target)
}

// stashDropHint 는 지워지는 stash 의 sha·메시지·시각을 적는다 (FR-GIT-168).
//
// **Values 에 sha 가 있다** — stash 커밋은 drop 후에도 gc 전까지 남아 있고 그 sha 로
// 되살릴 수 있다. 안내문만 남기면 되살릴 수 없다 (FR-GIT-92).
func stashDropHint(repo string, st Stash) core.Hint {
	return core.Hint{
		Repo:    repo,
		Action:  core.ActionStashDrop,
		Targets: []string{fmt.Sprintf(stashRefFormat, st.Index)},
		Values:  []string{st.Oid},
		Command: fmt.Sprintf("git stash store -m %q %s", st.Message, st.Oid),
		Note: fmt.Sprintf("%s 에 %s 기준으로 만든 stash 다. gc 전이면 위 명령으로 되살릴 수 있다.",
			time.UnixMilli(st.AtUnixMs).Format(time.RFC3339), st.Base),
	}
}

// stashIndexOf 는 `%gd`(`stash@{n}`) 에서 n 을 뽑는다. 형태가 다르면 오류다 —
// 인덱스를 0 으로 낮추면 다른 stash 를 가리키게 된다.
func stashIndexOf(gd string) (int, error) {
	m := stashRefRe.FindStringSubmatch(gd)
	if m == nil {
		return 0, fmt.Errorf("stash list: %q 는 stash@{n} 이 아니다", gd)
	}
	n, err := strconv.Atoi(m[1])
	if err != nil {
		return 0, fmt.Errorf("stash list: %q 의 인덱스를 읽지 못했다", gd)
	}
	return n, nil
}

// stashSubject 는 `%gs` 에서 기준과 메시지를 뽑는다. 메시지에 `: ` 가 들 수 있으므로
// 첫 것에서만 나눈다.
//
// 형태를 모르면 **항목을 버리지 않는다** — 다른 도구가 만든 stash 가 목록에서
// 사라지는 것이 더 나쁘다. 기준만 비우고 `%gs` 전체를 메시지로 둔다.
func stashSubject(gs string) (base, msg string) {
	rest, found := strings.CutPrefix(gs, stashWIPPrefix)
	if !found {
		rest, found = strings.CutPrefix(gs, stashOnPrefix)
	}
	if !found {
		return "", gs
	}
	base, msg, found = strings.Cut(rest, stashBaseSep)
	if !found {
		return "", gs
	}
	return base, msg
}
