package query

import (
	"context"
	"errors"
	"fmt"
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
