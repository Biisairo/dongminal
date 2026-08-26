package core

import (
	"context"
	"errors"
	"fmt"
	"strings"
)

// 한 번의 실행에 담을 경로 수 상한 (FR-GIT-73). argv 길이 한계가 있으므로 넘으면
// 나눠 실행한다. 상한은 상수로 못박는다 — 호출 지점마다 다른 숫자가 흩어지면
// 상한이 상한이 아니게 된다.
const MaxPathsPerCall = 1000

// pathsSep 은 경로 묶음 앞의 구분자다. **경로는 항상 이 뒤에 온다** — 경로가
// 옵션으로 해석되는 것을 막는 유일한 방법이다 (`-x.txt` 같은 파일명).
const pathsSep = "--"

// Paths 는 경로 묶음이다. 전부 리포 상대경로다.
type Paths []string

// BatchError 는 나눠 실행 중의 실패다. **실패 전에 몇 개가 적용됐는지**를 함께
// 들고 있다.
//
// git 의 add/reset/checkout 은 경로별로 처리하므로 진짜 롤백이 없다. 그래서
// FR-GIT-73("부분 적용 상태로 조용히 남기지 않는다")은 무엇이 적용됐는지를 그대로
// 보고하는 것으로 만족시킨다 (§7.1 I2). git 이 주지 않는 원자성을 흉내 내지 않는다.
type BatchError struct {
	Argv    []string // 실패한 묶음의 argv
	Applied int      // 실패 전에 실행이 끝난 경로 수
	Total   int      // 요청된 경로 수
	Err     error
}

func (e *BatchError) Error() string {
	return fmt.Sprintf("git %s: 경로 %d/%d 까지 적용된 뒤 실패했다: %v",
		strings.Join(e.Argv, " "), e.Applied, e.Total, e.Err)
}

func (e *BatchError) Unwrap() error { return e.Err }

// Partial 은 실패 시점에 이미 적용된 묶음이 있었는지다. 참이면 사용자에게 무엇이
// 바뀌었는지를 보여야 한다.
func (e *BatchError) Partial() bool { return e.Applied > 0 }

// Stage 는 경로들을 index 에 올린다 (FR-GIT-64·66·68·69).
func (s *Service) Stage(ctx context.Context, repo string, paths Paths) (Output, error) {
	clean, err := checkPaths(paths)
	if err != nil {
		return denied(), err
	}
	out, _, err := s.execPaths(ctx, repo, clean, false, len(clean), 0, "add")
	return out, err
}

// Unstage 는 경로들을 index 에서 내린다 (FR-GIT-65·67).
//
// **HEAD 가 없는 저장소(초기 커밋 전)에서는 `reset HEAD` 가 실패한다** — 되돌릴
// 트리가 없다. 그 경우 `rm --cached` 로 간다 (FR-GIT-65, 검증 V31).
func (s *Service) Unstage(ctx context.Context, repo string, paths Paths) (Output, error) {
	clean, err := checkPaths(paths)
	if err != nil {
		return denied(), err
	}
	head, err := s.hasHead(ctx, repo)
	if err != nil {
		return denied(), err
	}
	lead := []string{"reset", "-q", "HEAD"}
	if !head {
		lead = []string{"rm", "--cached", "-q"}
	}
	out, _, err := s.execPaths(ctx, repo, clean, false, len(clean), 0, lead...)
	return out, err
}

// Discard 는 워킹 트리의 변경을 버린다. **파괴적이다** (FR-GIT-89).
//
// tracked 는 `checkout`, untracked 는 `clean` 으로 갈리므로 호출자가 어느 쪽인지
// 알려 준다 — 여기서 추측하면 untracked 파일에 checkout 을 걸어 조용히 실패한다.
//
// 실행 **전에** recovery hint 를 남긴다 (FR-GIT-92). 실행 후에 남기면 실패한
// 경로에서 hint 가 없고, 사용자는 무엇을 잃었는지조차 알 수 없다.
func (s *Service) Discard(ctx context.Context, repo string, tracked, untracked Paths) (Output, error) {
	if len(tracked) == 0 && len(untracked) == 0 {
		return denied(), fmt.Errorf("%w: 경로가 없다", ErrUnsafeArgument)
	}
	// 양쪽을 먼저 검증한다 — 한쪽을 버린 뒤 다른 쪽이 거부되면 되돌릴 수 없다.
	ct, err := checkEach(tracked)
	if err != nil {
		return denied(), err
	}
	cu, err := checkEach(untracked)
	if err != nil {
		return denied(), err
	}
	total := len(ct) + len(cu)
	s.AddHint(discardHint(repo, ct, cu))

	var out Output
	applied := 0
	if len(ct) > 0 {
		out, applied, err = s.execPaths(ctx, repo, ct, true, total, 0, "checkout", "-q")
		if err != nil {
			return out, err
		}
	}
	if len(cu) > 0 {
		out, _, err = s.execPaths(ctx, repo, cu, true, total, applied, "clean", "-q", "-f")
		if err != nil {
			return out, err
		}
	}
	return out, nil
}

// discardHint 는 버려지는 것과 남는 것을 적는다 (FR-GIT-92).
//
// **Values 는 비어 있다.** 워킹 트리의 변경은 git 에 저장된 적이 없어 되살릴 값이
// 없다 — 안내문만 남기는 이유를 Note 에 적는다. 조용히 빈 hint 를 만들지 않는다.
func discardHint(repo string, tracked, untracked Paths) Hint {
	targets := make([]string, 0, len(tracked)+len(untracked))
	targets = append(targets, tracked...)
	targets = append(targets, untracked...)
	note := "워킹 트리의 변경은 git 에 저장된 적이 없어 되살릴 값이 없다."
	if len(tracked) > 0 {
		note += fmt.Sprintf(" tracked %d 개는 index 의 내용으로 덮인다 — staged 분은 남는다.", len(tracked))
	}
	if len(untracked) > 0 {
		note += fmt.Sprintf(" untracked %d 개는 삭제된다.", len(untracked))
	}
	return Hint{Repo: repo, Action: ActionDiscard, Targets: targets, Note: note}
}

// execPaths 는 경로 묶음을 상한 단위로 나눠 실행한다. offset 은 이 호출 앞에서 이미
// 적용된 경로 수다 — Discard 처럼 두 명령으로 갈리는 동작이 부분 적용을 정확히
// 보고하기 위한 것이다.
//
// 실패하면 **남은 묶음을 실행하지 않는다.** 실패한 뒤에도 계속 밀어 넣으면 무엇이
// 적용됐는지 말할 수 없게 된다.
func (s *Service) execPaths(ctx context.Context, repo string, paths Paths, destructive bool, total, offset int, lead ...string) (Output, int, error) {
	var last Output
	applied := offset
	for len(paths) > 0 {
		n := min(len(paths), MaxPathsPerCall)
		argv := make([]string, 0, len(lead)+1+n)
		argv = append(argv, lead...)
		argv = append(argv, pathsSep)
		argv = append(argv, paths[:n]...)

		out, err := s.ExecWrite(ctx, repo, WriteSpec{Argv: argv, Destructive: destructive})
		if err != nil {
			return out, applied, &BatchError{Argv: argv, Applied: applied, Total: total, Err: err}
		}
		applied += n
		last = out
		paths = paths[n:]
	}
	return last, applied, nil
}

// checkPaths 는 경로 묶음을 검증한다. **경로 0개는 오류다** — 빈 `add --` 는
// 의도치 않은 전체 add 가 될 수 있다.
func checkPaths(paths Paths) (Paths, error) {
	if len(paths) == 0 {
		return nil, fmt.Errorf("%w: 경로가 없다", ErrUnsafeArgument)
	}
	return checkEach(paths)
}

// checkEach 는 경로 하나하나를 검증한다. 규칙은 diff 와 같은 것을 쓴다 — 검사가
// 두 벌이면 한쪽만 고쳐져 구멍이 된다.
func checkEach(paths Paths) (Paths, error) {
	out := make(Paths, 0, len(paths))
	for _, p := range paths {
		rel, err := relPath(p, ErrUnsafeArgument)
		if err != nil {
			return nil, err
		}
		out = append(out, rel)
	}
	return out, nil
}

// hasHead 는 HEAD 가 커밋을 가리키는지다. 읽기이므로 Exec 으로 간다 — rev-parse 는
// 쓰기 목록에 없다.
//
// 커밋이 없는 저장소의 실패는 실패가 아니다. 그 사실 자체가 답이며, 오류로 올리면
// 초기 커밋 전 저장소에서 unstage 가 아예 막힌다.
func (s *Service) hasHead(ctx context.Context, repo string) (bool, error) {
	if _, err := s.Exec(ctx, repo, "rev-parse", "--verify", "HEAD"); err != nil {
		var xe *ExecError
		if errors.As(err, &xe) && xe.kind == nil {
			return false, nil
		}
		return false, err
	}
	return true, nil
}

// denied 는 실행 없이 거부된 결과다. exit -1 은 "프로세스가 뜨지도 않았다"는
// 표시이며 ExecWrite 의 거부와 같은 값이다.
func denied() Output { return Output{ExitCode: -1} }
