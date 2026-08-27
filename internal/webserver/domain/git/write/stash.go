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
	// ErrStashNotFound 는 그 인덱스의 stash 가 없다는 것이다.
	ErrStashNotFound = errors.New("stash_not_found")
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

// StashApply 는 stash 를 워킹 트리에 얹고 **stash 를 남긴다** (FR-GIT-163).
// withIndex 는 index 까지 복원한다 (`--index`).
func StashApply(s *core.Service, ctx context.Context, repo string, index int, withIndex bool) (core.Output, error) {
	return stashRestore(s, ctx, repo, "apply", index, withIndex)
}

// StashPop 은 stash 를 얹고 그것을 지운다 (FR-GIT-164).
//
// **충돌로 끝나면 git 이 stash 를 남긴다.** 그것을 확인해 알리는 것은
// StashPopChecked 의 일이다 (FR-GIT-165) — 여기서는 실행만 한다.
func StashPop(s *core.Service, ctx context.Context, repo string, index int, withIndex bool) (core.Output, error) {
	return stashRestore(s, ctx, repo, "pop", index, withIndex)
}

// StashPopChecked 는 pop 을 실행하고 stash 가 남았는지 **확인한다** (FR-GIT-165,
// 검증 V57).
//
// 충돌로 끝나면 git 은 stash 를 지우지 않는다. 조용히 넘기면 사용자는 작업을 잃었다고
// 오해한다 — 그래서 목록을 다시 찍어 그 인덱스에 같은 oid 가 있는지 본다. 성공했다면
// 그 자리에는 다음 stash(다른 oid)가 오거나 자리 자체가 없다.
//
// pop 이 실패해도 확인한다 — 확인이 필요한 경우가 바로 실패한 경우다.
func StashPopChecked(s *core.Service, ctx context.Context, repo string, index int, withIndex bool) (core.Output, StashPopKept, error) {
	before, err := StashList(s, ctx, repo)
	if err != nil {
		return denied(), StashPopKept{}, err
	}
	target, ok := stashAt(before, index)
	if !ok {
		return denied(), StashPopKept{}, stashMissing(index, len(before))
	}

	out, popErr := StashPop(s, ctx, repo, index, withIndex)
	after, listErr := StashList(s, ctx, repo)
	if listErr != nil {
		// 확인하지 못한 것을 "남지 않았다" 로 답하지 않는다.
		return out, StashPopKept{}, errors.Join(popErr, listErr)
	}
	kept := StashPopKept{}
	if cur, ok := stashAt(after, index); ok && cur.Oid == target.Oid {
		kept.Kept, kept.Oid = true, target.Oid
		kept.Reason = fmt.Sprintf(
			"pop 이 끝나지 않아 git 이 stash@{%d}(%s) 를 남겼다 — 저장한 작업은 사라지지 않았다. 충돌을 해소한 뒤 drop 하면 된다.",
			index, target.Oid)
	}
	return out, kept, popErr
}

// StashDrop 은 stash 를 지운다. **파괴적이다** (FR-GIT-89·168).
//
// 실행 **전에** recovery hint 를 남긴다 (FR-GIT-92). 실행 후에 남기면 이미 지워진
// stash 의 sha·메시지·시각을 읽을 수 없고, 실패한 경로에서는 hint 가 아예 없다.
func StashDrop(s *core.Service, ctx context.Context, repo string, index int) (core.Output, error) {
	ref, err := StashRef(index)
	if err != nil {
		return denied(), err
	}
	list, err := StashList(s, ctx, repo)
	if err != nil {
		return denied(), err
	}
	target, ok := stashAt(list, index)
	if !ok {
		// 지우지 않은 것의 복구 안내는 거짓이므로 hint 도 남기지 않는다.
		return denied(), stashMissing(index, len(list))
	}
	s.AddHint(stashDropHint(repo, target))
	return s.ExecWrite(ctx, repo, core.WriteSpec{Argv: []string{"stash", "drop", ref}, Destructive: true})
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
// 없다 — 실패하면 stash 는 그대로 남는다.
//
// 없는 인덱스는 **실행하지 않는다.** git 에 그대로 넘기면 브랜치를 만들다 만
// 상태가 남을 수 있고, 사용자는 왜 그 브랜치가 생겼는지 알 수 없다.
func StashBranch(s *core.Service, ctx context.Context, repo, name string, index int) (core.Output, error) {
	argv, err := StashBranchArgs(name, index)
	if err != nil {
		return denied(), err
	}
	list, err := StashList(s, ctx, repo)
	if err != nil {
		return denied(), err
	}
	if _, ok := stashAt(list, index); !ok {
		return denied(), stashMissing(index, len(list))
	}
	return s.ExecWrite(ctx, repo, core.WriteSpec{Argv: argv})
}

// StashPreview 는 stash 가 바꾼 파일 목록이다 (FR-GIT-169).
//
// `-z` 이므로 rename 은 세 조각이다 — 커밋 상세와 **같은 파서**를 쓴다. 파서가 두
// 벌이면 한쪽만 고쳐진다.
//
// **untracked 는 여기 없다.** `stash show` 는 `--include-untracked` 로 담은 파일을
// 보이지 않는다 (git 2.50.1 실측) — 그것까지 필요하면 `stash@{n}^3` 을 따로 봐야
// 하며, 이 단계의 요구사항은 아니다.
func StashPreview(s *core.Service, ctx context.Context, repo string, index int) ([]query.CommitFile, error) {
	ref, err := StashRef(index)
	if err != nil {
		return nil, err
	}
	out, err := s.ExecWrite(ctx, repo, core.WriteSpec{Argv: []string{"stash", "show", stashNameStatusFlags, "-z", ref}})
	if err != nil {
		return nil, err
	}
	if out.StdoutTruncated {
		return nil, fmt.Errorf("git stash show 의 출력이 상한(%dB)에서 잘렸다: 변경 파일 목록을 온전히 줄 수 없다", s.MaxOutput())
	}
	return query.ParseNameStatusZ(out.Stdout)
}

// stashRestore 는 apply/pop 의 공통 argv 다. 둘은 stash 를 지우는지만 다르다.
func stashRestore(s *core.Service, ctx context.Context, repo, sub string, index int, withIndex bool) (core.Output, error) {
	ref, err := StashRef(index)
	if err != nil {
		return denied(), err
	}
	argv := []string{"stash", sub}
	if withIndex {
		argv = append(argv, stashIndexFlag)
	}
	return s.ExecWrite(ctx, repo, core.WriteSpec{Argv: append(argv, ref)})
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

// stashAt 은 그 인덱스의 항목이다. 목록의 자리로 세지 않는 이유는 인덱스가 목록의
// 순서와 같다는 것이 git 의 규약일 뿐 우리가 보장하는 것이 아니기 때문이다.
func stashAt(list []Stash, index int) (Stash, bool) {
	for _, st := range list {
		if st.Index == index {
			return st, true
		}
	}
	return Stash{}, false
}

func stashMissing(index, have int) error {
	return fmt.Errorf("%w: stash@{%d} 가 없다 (stash %d개)", ErrStashNotFound, index, have)
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
