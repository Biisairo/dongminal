package query

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"dongminal/internal/webserver/domain/git/core"
)

// 브랜치 이름 검사 (GIT_SRS §3D.1 FR-GIT-159).
//
// 규칙을 직접 구현하지 않는다 — `git check-ref-format` 이 판정한다. 목록도 여기서
// 만들지 않는다: Refs 가 이미 답한다 (FR-GIT-147).

// branchRefPrefix 는 로컬 브랜치 ref 의 접두다. 이름만으로 묻지 않는 이유는
// for-each-ref 의 패턴이 `refs/heads/feat` 로 `refs/heads/feat/sub` 도 잡기 때문이다.
const branchRefPrefix = "refs/heads/"

// refNameInvalidStderr 는 "그 이름은 브랜치 이름이 아니다" 를 뜻하는 git 의 fatal
// 문구다 (git 2.50.1 실측). classify 가 분류하지 않는 exit 128 이므로 문구로 좁힌다
// — 그 밖의 128 을 "이름이 틀렸다" 로 뭉개면 저장소 실패가 입력 오류로 보인다.
const refNameInvalidStderr = "is not a valid branch name"

// ValidBranchName 은 git 의 이름 규칙을 확인한다 (FR-GIT-159).
//
// **규칙을 직접 구현하지 않는다** — `git check-ref-format --branch <name>` 이
// 판정한다. 규칙이 두 벌이면 한쪽만 고쳐져, git 이 받는 이름을 우리가 막거나 그
// 반대가 된다.
//
// 실측 (git 2.50.1): 유효하면 exit 0 + **펼쳐진 이름**을 출력, 무효하면 exit 128 +
// `fatal: 'x' is not a valid branch name`.
//
// 출력이 입력과 다르면 거부한다. `@{-1}` 은 exit 0 으로 직전 브랜치 이름을
// 출력하며(실측), 통과시키면 사용자가 적은 이름과 git 이 만드는 이름이 달라진다.
func ValidBranchName(s *core.Service, ctx context.Context, repo, name string) error {
	if err := core.CheckRefArg("name", name); err != nil {
		return err
	}
	out, err := s.Exec(ctx, repo, "check-ref-format", core.CheckRefFormatBranch, name)
	if err != nil {
		return refNameError(name, err)
	}
	if got := strings.TrimRight(out.Stdout, "\n"); got != name {
		return fmt.Errorf("%w: %q 는 git 이 %q 로 펼치는 표현이다", core.ErrRefName, name, got)
	}
	return nil
}

// LocalBranchExists 는 그 이름의 로컬 브랜치가 있는지다. 읽기이므로 Exec 으로
// 간다 — rev-parse 는 쓰기 목록에 없다.
//
// `refs/heads/<name>` 으로 정확히 묻는다. for-each-ref 의 패턴은 `refs/heads/feat`
// 가 `refs/heads/feat/sub` 도 잡으므로 쓰지 않는다.
//
// 없는 ref 의 실패는 실패가 아니다. 그 사실 자체가 답이며, 오류로 올리면 충돌이
// 없을 때 생성이 아예 막힌다.
func LocalBranchExists(s *core.Service, ctx context.Context, repo, name string) (bool, error) {
	if err := core.CheckRefArg("name", name); err != nil {
		return false, err
	}
	if _, err := s.Exec(ctx, repo, "rev-parse", "--verify", branchRefPrefix+name); err != nil {
		var xe *core.ExecError
		if errors.As(err, &xe) && xe.Unwrap() == nil {
			return false, nil
		}
		return false, err
	}
	return true, nil
}

// refNameError 는 실패가 "이름 규칙 위반" 이면 그것으로 갈라 준다. 저장소 실패와
// 구분되지 않으면 사용자는 이름을 고치면 되는지 알 수 없다.
func refNameError(name string, err error) error {
	var xe *core.ExecError
	if !errors.As(err, &xe) || xe.Unwrap() != nil {
		return err
	}
	if strings.Contains(strings.ToLower(xe.Stderr), refNameInvalidStderr) {
		return fmt.Errorf("%w: %q 는 git 의 브랜치 이름 규칙을 어긴다", core.ErrRefName, name)
	}
	return err
}

// ── 묶음 B 가 딛는 조회 (GIT_ACTIONS_SRS §3.2 FR-GIT-254·255) ──
//
// **목록은 여전히 Refs 다** (FR-GIT-147). 여기 더하는 것은 목록이 답하지 않는 것
// 뿐이다 — 지우기 전의 oid(hint 가 실을 값)와 머지 한 번의 영향 범위.

const (
	remoteRefPrefix = "refs/remotes/"
	// mergeBaseAncestor 는 "왼쪽이 오른쪽의 조상인가" 다. 답이 아니오면 exit 1 이며
	// 그것은 실패가 아니라 **답**이다 — 오류로 올리면 ff 판정 자체가 막힌다.
	mergeBaseAncestor = "--is-ancestor"
	notAncestorExit   = 1
)

// BranchOid 는 그 로컬 브랜치가 가리키는 커밋이다 (FR-GIT-250.2).
//
// **지우기 전에 읽어야 하는 값이다** — 지운 뒤에는 읽을 수 없고, 그러면 hint 는
// 안내문만 남는다. `refs/heads/<name>` 으로 정확히 묻는 이유는 LocalBranchExists 와
// 같다: `feat` 는 `feat/sub` 도 잡는 패턴이 된다.
func BranchOid(s *core.Service, ctx context.Context, repo, name string) (string, error) {
	return refOid(s, ctx, repo, branchRefPrefix, name)
}

// RemoteBranchOid 는 원격 추적 ref 가 가리키는 커밋이다 (FR-GIT-268). short 는
// `origin/feat` 처럼 원격 이름을 포함한다.
func RemoteBranchOid(s *core.Service, ctx context.Context, repo, short string) (string, error) {
	return refOid(s, ctx, repo, remoteRefPrefix, short)
}

func refOid(s *core.Service, ctx context.Context, repo, prefix, name string) (string, error) {
	if err := core.CheckRefArg("name", name); err != nil {
		return "", err
	}
	out, err := s.Exec(ctx, repo, "rev-parse", "--verify", prefix+name)
	if err != nil {
		return "", err
	}
	return strings.TrimRight(out.Stdout, "\n"), nil
}

// BranchUpstream 은 그 브랜치의 upstream 이다. 없으면 빈 문자열이며 **그것은
// 오류가 아니다** — upstream 이 없다는 사실 자체가 답이다 (FR-GIT-257·258).
func BranchUpstream(s *core.Service, ctx context.Context, repo, name string) (string, error) {
	if err := core.CheckRefArg("branch", name); err != nil {
		return "", err
	}
	out, err := s.Exec(ctx, repo, "for-each-ref", "--format=%(upstream:short)", branchRefPrefix+name)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(out.Stdout), nil
}

// BranchMerged 는 `git branch -d` 가 그 브랜치를 받아들일지다 (FR-GIT-254).
//
// **git 의 기준을 그대로 쓴다**: upstream 이 있으면 그것에, 없으면 HEAD 에 합쳐졌는지
// 본다 (git 의 `branch_merged`). 판정을 미리 하는 이유는 하나뿐이다 — 거부를 실패로
// 끝내지 않고 `-D` 로 올릴 선택지를 **실행 전에** 줘야 하기 때문이다 (FR-GIT-254).
// 실제 삭제는 그래도 `-d` 로 나가므로 마지막 판정은 여전히 git 이 한다.
func BranchMerged(s *core.Service, ctx context.Context, repo, name string) (bool, error) {
	up, err := BranchUpstream(s, ctx, repo, name)
	if err != nil {
		return false, err
	}
	base := up
	if base == "" {
		base = "HEAD"
	}
	return isAncestor(s, ctx, repo, name, base)
}

// MergeImpact 는 머지 한 번이 무엇을 할지다 (FR-GIT-255, G11).
//
// 개수만 보이면 사용자는 무엇이 들어오는지 모르고, ff 여부가 없으면 머지 커밋이
// 생기는지 알 수 없다 — 다이얼로그가 **실행 전에** 둘 다 보여야 한다.
type MergeImpact struct {
	Ref string `json:"ref"`
	// FastForward 는 현재 HEAD 가 대상의 조상이라는 것이다 — 머지 커밋이 생기지 않는다.
	FastForward bool `json:"ff"`
	// Incoming 은 대상에만 있는 커밋 수다 (`rev-list --count HEAD..<ref>`).
	Incoming int `json:"incoming"`
	// Diverged 는 현재 쪽에만 있는 커밋 수다. 0 이 아니면 갈라져 있다.
	Diverged int `json:"diverged"`
	// UpToDate 는 들어올 것이 없다는 것이다. ff 와 구분해야 한다 — 둘 다 머지 커밋을
	// 만들지 않지만 하나는 "할 일이 없다" 이고 하나는 "따라잡는다" 다.
	UpToDate bool `json:"upToDate"`
}

// MergePreview 는 실행 전의 영향 범위다 (FR-GIT-255).
//
// 근거는 `rev-list --count` 와 `merge-base --is-ancestor` 다 — 둘 다 읽기이므로
// Exec 으로 간다. 머지를 흉내 내지 않는다: 충돌이 날지는 여기서 답하지 않으며,
// 그것은 실행이 답할 일이다 (판정을 두 벌로 두지 않는다).
func MergePreview(s *core.Service, ctx context.Context, repo, ref string) (MergeImpact, error) {
	if err := core.CheckRefArg("ref", ref); err != nil {
		return MergeImpact{}, err
	}
	in, err := revCount(s, ctx, repo, "HEAD.."+ref)
	if err != nil {
		return MergeImpact{}, err
	}
	out, err := revCount(s, ctx, repo, ref+"..HEAD")
	if err != nil {
		return MergeImpact{}, err
	}
	ff, err := isAncestor(s, ctx, repo, "HEAD", ref)
	if err != nil {
		return MergeImpact{}, err
	}
	return MergeImpact{Ref: ref, FastForward: ff, Incoming: in, Diverged: out, UpToDate: in == 0}, nil
}

// revCount 는 범위 하나의 커밋 수다. 범위 표현은 **여기서 만든다** — 호출자가
// 만들어 넘기면 CheckRefArg 의 `..` 금지를 우회하는 자리가 된다.
func revCount(s *core.Service, ctx context.Context, repo, rng string) (int, error) {
	out, err := s.Exec(ctx, repo, "rev-list", "--count", rng)
	if err != nil {
		return 0, err
	}
	n, err := strconv.Atoi(strings.TrimSpace(out.Stdout))
	if err != nil {
		return 0, fmt.Errorf("rev-list --count %s 의 출력이 수가 아니다: %q", rng, out.Stdout)
	}
	return n, nil
}

// isAncestor 는 exit 1 을 **답으로** 읽는다. 오류로 올리면 "조상이 아니다" 라는
// 흔한 사실이 실패가 되어 ff 판정과 미머지 판정이 아예 막힌다.
func isAncestor(s *core.Service, ctx context.Context, repo, child, parent string) (bool, error) {
	if _, err := s.Exec(ctx, repo, "merge-base", mergeBaseAncestor, child, parent); err != nil {
		var xe *core.ExecError
		if errors.As(err, &xe) && xe.Unwrap() == nil && xe.ExitCode == notAncestorExit {
			return false, nil
		}
		return false, err
	}
	return true, nil
}
