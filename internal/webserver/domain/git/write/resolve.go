package write

import (
	"context"
	"fmt"

	"dongminal/internal/webserver/domain/git/core"
)

// 충돌 파일을 한쪽으로 해결한다 (FR-GIT-224).
//
// **`ours`/`theirs` 의 뜻은 진행 중인 조작에 따라 뒤집힌다.** merge 중에는 ours 가
// 현재 브랜치이지만 rebase 중에는 ours 가 올려놓는 대상이고 내 커밋이 theirs 다.
// 여기서는 git 의 낱말을 그대로 전달하고, 어느 쪽인지 밝히는 것은 화면의 일이다.
const (
	ResolveOurs   = "ours"
	ResolveTheirs = "theirs"
)

// Resolve 는 충돌 파일들을 한쪽 내용으로 받고 해결됨으로 표시한다.
//
// **두 명령이다.** 실측(git 2.50.1): `git checkout --ours -- <path>` 는 워킹
// 트리만 바꾸고 index 의 unmerged stage 를 그대로 둔다 — `git status` 가 여전히
// `u UU` 라 파일이 충돌 목록에서 빠지지 않는다. `add` 가 뒤따라야 해결이 된다.
//
// 원자적이지 않다 (해석 I2). git 이 주지 않는 원자성을 흉내 내지 않고, 호출자가
// 실행 전후 status 를 비교해 무엇이 바뀌었는지 보인다.
func Resolve(s *core.Service, ctx context.Context, repo, side string, paths Paths) (core.Output, error) {
	if side != ResolveOurs && side != ResolveTheirs {
		return denied(), fmt.Errorf("%w: 알 수 없는 side: %q", core.ErrUnsafeArgument, side)
	}
	cp, err := checkPaths(paths)
	if err != nil {
		return denied(), err
	}
	// 실행 **전에** 남긴다 (FR-GIT-92). 실행 후에 남기면 실패한 경로에서 hint 가
	// 없고, 사용자는 무엇을 잃었는지조차 알 수 없다.
	s.AddHint(resolveHint(repo, side, cp))

	// checkout 은 파괴적이다 — 워킹 트리의 충돌 표식과 손댄 내용이 사라지고
	// git 에 저장된 적이 없어 되살릴 값이 없다 (FR-GIT-95, 해석 I5).
	out, applied, err := execPaths(s, ctx, repo, cp, true, len(cp), 0, "checkout", "--"+side)
	if err != nil {
		return out, err
	}
	// 받아 오지 못한 것을 해결됨으로 표시하면 충돌이 조용히 사라진다 — 위에서
	// 실패하면 여기 오지 않는다.
	out, _, err = execPaths(s, ctx, repo, cp, false, len(cp), applied-len(cp), "add")
	return out, err
}

// resolveHint 는 무엇을 잃는지 적는다 (FR-GIT-92).
//
// **Values 는 비어 있다.** 충돌 표식이 든 워킹 트리 파일은 git 에 저장된 적이
// 없어 되살릴 값이 없다 — discard 와 같은 성질이다. 대신 되돌리는 방법을 적는다:
// `git checkout -m -- <path>` 가 충돌 상태를 다시 만든다.
func resolveHint(repo, side string, paths Paths) core.Hint {
	return core.Hint{
		Repo:    repo,
		Action:  core.ActionResolveSide,
		Targets: append([]string(nil), paths...),
		Note: fmt.Sprintf(
			"%s 쪽 내용으로 덮고 해결됨으로 표시한다. 충돌 표식과 손대던 내용은 git 에 저장된 적이 없어 되살릴 값이 없다. "+
				"충돌 상태로 되돌리려면 `git checkout -m -- <경로>` 다.", side),
	}
}
