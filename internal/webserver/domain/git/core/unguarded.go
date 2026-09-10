package core

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"time"
)

/*
실행 층 — 인가를 지나지 않는 진입점 (GIT_EXEC_UNIFY_SRS FR-GXU-1~5).

이 파일이 여는 것은 **실행 방법**이지 **실행 권한**이 아니다. 둘은 다른 것이며,
지금까지 한 덩어리였던 것이 "실행을 공유하려면 화이트리스트까지 통과해야 한다"는
막다른 길을 만들었다.

	Exec / ExecWrite   인가 층 — readCommands·writeCommands. 이 파일은 손대지 않는다
	ExecUnguarded      실행 층 — Env·마감·상한·취소·분류·기록

**왜 인가를 건너뛰는 자리가 필요한가.** `git worktree` 와 `git submodule` 은 한
하위 명령 안에 읽기(`list`·`status`)와 쓰기(`add`·`update`)를 함께 갖는다. 화이트
리스트는 `argv[0]` 으로 키잉되고 두 목록의 교집합은 비어 있어야 하므로(FR-GIT-95),
**어느 목록에 넣어도 불변식이 뜻을 잃는다.** 그래서 그 둘은 자기 인가(`checkRepo`·
`checkPath`·`validRef`·`--` 규약)를 가진 별도 도메인으로 서 있다 — FR-GIT-246 과
UX_BATCH5_SRS D-9 가 두 번에 걸쳐 확정한 결정이다.

**그 결정은 인가 층을 말한 것이지 실행 층을 말한 것이 아니다.** 그런데 그 셋은
실행까지 각자 들었고, 그래서 `Env()`·출력 상한·오류 분류·**실행 기록**이 전부
빠졌다. Console 이 그 실행들을 못 보는 것이 그 대가였다.

**이 진입점의 안전은 호출처 화이트리스트가 진다** (FR-GXU-12,
`static_test.go`). 누가 부를 수 있는지가 고정되지 않으면 화이트리스트가 뜻을
잃는다 — 이 파일이 아니라 그 게이트가 이 설계의 안전 장치다.
*/

// UnguardedSpec 은 인가를 건너뛰는 실행 한 번의 요청이다.
type UnguardedSpec struct {
	Argv []string
	// Stdin 은 인자로 넘길 수 없는 값을 위한 것이다. 내용은 기록에 남지 않는다 —
	// 바이트 수만 남는다 (I6 과 같은 규약).
	Stdin string
	// Timeout 은 Service 기본 마감을 대신한다. 0 이면 기본이다 (FR-GXU-3).
	//
	// 이 필드가 없으면 이관이 곧 동작 변경이 된다 — 세 도메인의 마감은 기본
	// 30초보다 길다 (worktree·submodule 각 180초).
	Timeout time.Duration
	// Reason 은 **왜 인가를 건너뛰는가** 다. 비어 있을 수 없다.
	//
	// 기록에 남아 Console 이 읽는다. 적지 않고 쓰는 것을 막는 것이 요점이다 —
	// 이 진입점은 "편해서" 쓰는 자리가 아니다.
	Reason string
}

// ExecUnguarded 는 화이트리스트를 지나지 않고 git 을 실행한다 (FR-GXU-1).
//
// `Exec`·`ExecWrite` 와 **같은 몸통**(execGit)을 쓴다. 다른 것은 guardArgs 를
// 부르지 않는다는 것뿐이며, 그 밖의 규약 — 환경·출력 상한·마감·취소·오류 분류 —
// 은 전부 같다 (FR-GXU-2).
//
// `dir` 검사는 **유지한다.** 그것은 인가가 아니라 실행의 전제다: 상대 경로는
// 해석 기준이 없어 어느 저장소에서 도는지 말할 수 없다.
//
// 거부된 호출도 기록에 남는다 (FR-GIT-5) — 조용한 거부는 디버깅할 수 없다.
//
// 수신자가 nil 이어도 안전하다 (FR-GXU-4). 기록만 생략하고 나머지 규약은 그대로
// 적용한다 — `httpapi` 의 `s.Git` 은 nil 일 수 있는 배선이고, 그때 호출자가
// 죽거나 규약 없이 실행되는 것은 둘 다 답이 아니다.
func (s *Service) ExecUnguarded(ctx context.Context, dir string, spec UnguardedSpec) (Output, error) {
	if strings.TrimSpace(spec.Reason) == "" {
		return s.denyUnguarded(dir, spec, fmt.Errorf("%w: Reason 이 비었다 — 인가를 건너뛰는 사유를 적어야 한다", ErrUnsafeArgument))
	}
	if len(spec.Argv) == 0 {
		return s.denyUnguarded(dir, spec, fmt.Errorf("%w: 인자가 없다", ErrUnsafeArgument))
	}
	if strings.TrimSpace(dir) == "" || !filepath.IsAbs(dir) {
		return s.denyUnguarded(dir, spec, fmt.Errorf("%w: cwd 는 절대 경로여야 한다: %q", ErrUnsafeArgument, dir))
	}

	ctx2, cancel := s.unguardedDeadline(ctx, spec.Timeout)
	defer cancel()

	out, err := s.unguardedRunner()(ctx2, dir, spec.Argv, spec.Stdin)
	switch {
	case err == nil && out.ExitCode != 0:
		err = &ExecError{Argv: spec.Argv, Cwd: dir, ExitCode: out.ExitCode, Stderr: out.Stderr, kind: classify(ctx2, out.Stderr)}
	case err != nil && !classified(err):
		if k := classify(ctx2, out.Stderr); k != nil {
			err = fmt.Errorf("%w: %v", k, err)
		}
	}
	s.recordUnguarded(dir, spec, out, err)
	return out, err
}

// unguardedRunner 는 주입된 쓰기 실행기 또는 기본 구현이다. 쓰기 실행기를 함께
// 쓰는 이유는 몸통이 같기 때문이다 — stdin 을 받는 execGit 하나다.
func (s *Service) unguardedRunner() WriteRunner {
	if s != nil && s.writeRun != nil {
		return s.writeRun
	}
	limit := DefaultMaxOutput
	if s != nil && s.maxOutput > 0 {
		limit = s.maxOutput
	}
	return func(ctx context.Context, dir string, args []string, stdin string) (Output, error) {
		return execGit(ctx, dir, args, limit, stdin)
	}
}

// unguardedDeadline 은 spec 의 마감을 우선하되, 호출자의 ctx 가 더 짧으면 그것이
// 이긴다 (FR-GXU-3, FR-GIT-3 과 같은 규칙).
func (s *Service) unguardedDeadline(ctx context.Context, d time.Duration) (context.Context, context.CancelFunc) {
	if d <= 0 {
		d = DefaultTimeout
		if s != nil && s.timeout > 0 {
			d = s.timeout
		}
	}
	if dl, ok := ctx.Deadline(); ok && time.Until(dl) <= d {
		return context.WithCancel(ctx)
	}
	return context.WithTimeout(ctx, d)
}

// denyUnguarded 는 실행 없이 거부한다. exit -1 은 "프로세스가 뜨지도 않았다"는
// 표시다 (deny·denyWrite 와 같은 규약).
func (s *Service) denyUnguarded(dir string, spec UnguardedSpec, err error) (Output, error) {
	out := Output{ExitCode: -1}
	s.recordUnguarded(dir, spec, out, err)
	return out, err
}

// recordUnguarded 는 공통 기록에 이 경로의 두 사실을 더한다 — **인가를 지나지
// 않았다는 것**과 그 사유다 (FR-GXU-5).
//
// 표식이 없으면 Console 에서 화이트리스트를 지난 실행과 섞이고, 그 목록을 근거로
// 삼는 판단이 틀린다.
func (s *Service) recordUnguarded(dir string, spec UnguardedSpec, out Output, err error) {
	if s == nil || s.rec == nil {
		return
	}
	rec := newRecord(dir, spec.Argv, out, err)
	rec.Unguarded = true
	rec.Reason = spec.Reason
	rec.StdinBytes = len(spec.Stdin)
	s.rec.Add(rec)
}
