package write

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"dongminal/internal/webserver/domain/git/core"
	"dongminal/internal/webserver/domain/git/query"
)

// 미커밋 행의 동작 (GIT_ACTIONS_SRS §3.6 FR-GIT-277, 검증 V203).
//
// History 탭의 "미커밋 변경" 행이 여는 메뉴 세 항목 중 둘이다 — 나머지 하나인
// Stash 는 생성 다이얼로그를 그대로 다시 쓴다 (FR-GIT-166).
//
//   - **Reset 은 mixed 다.** index 만 HEAD 로 되돌리고 워킹 트리는 그대로 둔다 —
//     그래서 파괴적이 아니다 (`WriteSpec.Destructive` 는 호출자가 선언한다, I5).
//   - **Clean 은 파괴적이다.** 추적되지 않는 파일은 git 에 저장된 적이 없어
//     되살릴 값이 없다 — hint 는 되살릴 명령이 아니라 **먼저 담아 두는** 명령이다
//     (discard 의 선례, FR-GIT-92).

var (
	// ErrUncommittedNoHead 는 커밋이 없어 HEAD 로 되돌릴 수 없다는 것이다.
	ErrUncommittedNoHead = errors.New("no_head")
	// ErrNothingToClean 은 지울 untracked 파일이 없다는 것이다. git 은 그 실행을
	// exit 0 으로 끝내므로 성공으로 답하면 사용자는 무엇이 지워졌는지 오해한다.
	ErrNothingToClean = errors.New("nothing_to_clean")
	// ErrCleanChanged 는 확인한 목록과 지금의 untracked 가 다르다는 것이다 —
	// 확인 뒤 생긴 파일을 보인 적 없이 지우지 않는다.
	ErrCleanChanged = errors.New("clean_changed")
)

// literalPathspec 은 경로를 glob 이 아닌 그대로의 이름으로 읽게 하는 pathspec
// 머리다. `a*` 라는 파일명이 확인하지 않은 `ab` 를 잡으면 안 된다 (실측).
const literalPathspec = ":(literal)"

// UncommittedResetArgs 는 `reset --mixed HEAD` 의 argv 다 (FR-GIT-277).
//
// **실행하지 않는다** (FR-GIT-250 ①). 인자를 받지 않는 이유는 대상이 HEAD 하나로
// 고정이기 때문이다 — 커밋을 골라 되돌리는 것은 FR-GIT-265 의 일이며 여기가
// 아니다.
func UncommittedResetArgs() []string {
	return []string{"reset", "-q", "--mixed", "HEAD"}
}

// CleanUntrackedArgs 는 `clean -f -d` 의 argv 다 (FR-GIT-277).
//
// `-d` 를 함께 두는 이유는 그것이 없으면 추적되지 않는 **디렉터리**가 그대로
// 남아, 사용자가 보기에 지워지지 않은 것이 되기 때문이다. `-x` 는 붙이지
// 않는다 — `.gitignore` 가 무시하는 것까지 지우는 것은 다른 뜻이다.
func CleanUntrackedArgs() []string {
	return []string{"clean", "-q", "-f", "-d"}
}

// UncommittedReset 은 index 를 HEAD 로 되돌린다 (FR-GIT-277).
//
// **파괴적이 아니다** — 워킹 트리의 내용은 그대로 남고, 되돌아가는 것은 무엇을
// 커밋할지의 선택뿐이다.
//
// 커밋이 없으면 실행하지 않는다. `reset HEAD` 는 그 저장소에서 실패하며, 사유를
// git 의 stderr 로 흘리면 사용자는 왜 막혔는지 알 수 없다.
func UncommittedReset(s *core.Service, ctx context.Context, repo string) (core.Output, error) {
	head, err := query.HasHead(s, ctx, repo)
	if err != nil {
		return denied(), err
	}
	if !head {
		return denied(), fmt.Errorf("%w: 커밋이 없어 HEAD 로 되돌릴 수 없다", ErrUncommittedNoHead)
	}
	return s.ExecWrite(ctx, repo, core.WriteSpec{Argv: UncommittedResetArgs()})
}

// CleanUntracked 는 확인한 untracked 경로 `want` 만 지운다. **파괴적이다**
// (FR-GIT-277).
//
//	이전 동작: 목록을 받지 않고 실행 순간의 untracked 전부를 지웠다
//	새 동작: 지금의 untracked 와 `want` 가 집합으로 같을 때만 그 경로를 literal
//	         pathspec 으로 지운다. 다르면 ErrCleanChanged
//	이유: 확인 뒤~실행 사이에 생긴 파일이 보인 적 없이 지워질 수 있었다
//	      (REPO_FIX 05 §3A-8, 사용자 결정)
//
// 실행 **전에** recovery hint 를 남긴다 (FR-GIT-92). 실행 후에 남기면 지워진
// 경로를 읽을 수 없고, 실패한 경로에서는 hint 가 아예 없다.
//
// 지울 것이 없으면 실행하지 않는다 — git 은 그 실행을 exit 0 으로 끝내므로
// 성공으로 답하면 사용자는 지워진 것이 있다고 읽는다 (StashPush 와 같은 규약).
func CleanUntracked(s *core.Service, ctx context.Context, repo string, want Paths) (core.Output, error) {
	want, err := checkPaths(want)
	if err != nil {
		return denied(), err
	}
	st, err := query.StatusOf(s, ctx, repo)
	if err != nil {
		return denied(), err
	}
	if len(st.Untracked) == 0 {
		return denied(), fmt.Errorf("%w: 추적되지 않는 파일이 없다", ErrNothingToClean)
	}
	paths := make(Paths, 0, len(st.Untracked))
	now := make(map[string]bool, len(st.Untracked))
	for _, e := range st.Untracked {
		paths = append(paths, e.Path)
		now[e.Path] = true
	}
	asked := make(map[string]bool, len(want))
	for _, p := range want {
		if !now[p] {
			return denied(), fmt.Errorf("%w: %s 는 지금 추적되지 않는 파일이 아니다", ErrCleanChanged, p)
		}
		asked[p] = true
	}
	if len(asked) != len(now) {
		return denied(), fmt.Errorf("%w: 확인한 뒤 추적되지 않는 파일이 %d개에서 %d개가 됐다",
			ErrCleanChanged, len(asked), len(now))
	}
	s.AddHint(cleanHint(repo, paths))
	specs := make(Paths, 0, len(paths))
	for _, p := range paths {
		specs = append(specs, literalPathspec+p)
	}
	out, _, err := execPaths(s, ctx, repo, specs, true, len(specs), 0, CleanUntrackedArgs()...)
	removeEmptyParents(repo, paths)
	return out, err
}

// removeEmptyParents 는 지운 경로의 조상 디렉터리 중 **빈 것만** 저장소 최상위
// 아래까지 지운다. 경로 단위 `clean -d` 는 부모 디렉터리를 남긴다(실측) — 남기면
// 사용자에게는 지워지지 않은 것으로 보인다. 비지 않은 디렉터리는 `os.Remove` 가
// 거절하므로 확인 뒤 생긴 파일이 든 디렉터리는 그대로 남는다.
func removeEmptyParents(repo string, paths Paths) {
	top := filepath.Clean(repo)
	for _, p := range paths {
		for dir := filepath.Dir(filepath.Join(top, filepath.FromSlash(p))); dir != top; dir = filepath.Dir(dir) {
			if os.Remove(dir) != nil {
				break
			}
		}
	}
}

// cleanHint 는 지워지는 경로와 **먼저 담아 두는 명령**을 적는다 (FR-GIT-277).
//
// **Values 는 비어 있다.** 추적되지 않는 파일은 git 에 저장된 적이 없어 되살릴
// 값이 없다 — discard 와 같은 이유이며, 그 사실을 Note 에 적는다. 그래서 Command
// 는 되돌리는 명령이 아니라 실행 **전에** 쓰는 명령이다.
func cleanHint(repo string, paths []string) core.Hint {
	return core.Hint{
		Repo:    repo,
		Action:  core.ActionCleanUntracked,
		Targets: paths,
		Command: "git stash push -u",
		Note: fmt.Sprintf(
			"추적되지 않는 파일 %d개는 git 에 저장된 적이 없어 지운 뒤에는 되살릴 값이 없다. 지우기 전에 위 명령으로 담아 둘 수 있다.",
			len(paths)),
	}
}
