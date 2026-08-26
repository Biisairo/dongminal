package git

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
)

// stderr tail 의 기본 길이 (FR-GIT-96). 상한은 상수로 못박는다 — 호출 지점마다
// 다른 숫자가 흩어지면 상한이 상한이 아니게 된다.
const DefaultStderrTailLines = 200

// writeCommands 는 저장소를 변경할 수 있는 하위 명령이다. 읽기 목록과 분리해 두는
// 이유는 진입 함수가 다르기 때문이다 — Exec 은 이 목록을 실행하지 못하고,
// ExecWrite 는 readCommands 를 실행하지 못한다 (FR-GIT-95).
//
// 두 목록의 교집합은 비어 있어야 한다. 겹치면 "어느 경로로도 실행 가능한 명령"이
// 생겨 단일 경로가 뜻을 잃는다.
var writeCommands = map[string]bool{
	"add": true, "reset": true, "rm": true, "commit": true,
	"checkout": true, "restore": true, "clean": true,
	"stash": true, "branch": true, "tag": true,
	"fetch": true, "pull": true, "push": true,
	"merge": true, "rebase": true, "cherry-pick": true, "revert": true,
	"update-ref": true, "symbolic-ref": true,
}

// IsWriteCommand 는 argv 의 하위 명령이 쓰기 목록에 있는지 답한다 (FR-GIT-218).
// 목록을 두 벌 두지 않으려고 노출한다 — Console 이 감추는 기준과 ExecWrite 가
// 막는 기준이 어긋나면, 화면이 "쓰기가 아니다" 라고 한 것이 실제로는 쓰기다.
func IsWriteCommand(argv []string) bool {
	return len(argv) > 0 && writeCommands[argv[0]]
}

// WriteSpec 은 쓰기 한 번의 요청이다.
//
// Destructive 는 **호출자가 선언한다** (I5) — 하위 명령만으로는 판정되지 않는다.
// `reset --soft` 는 안전하고 `--hard` 는 아니다. 그 선언이 실행 기록에 남는다.
type WriteSpec struct {
	Argv        []string
	Destructive bool
	// Stdin 은 인자로 넘길 수 없는 값(커밋 메시지)을 위한 것이다 (FR-GIT-77).
	// **내용은 기록에 남지 않는다** — 바이트 수만 남는다 (I6).
	Stdin string
}

// WriteRunner 는 stdin 을 받는 실행 한 번이다. Runner 를 그대로 쓰지 않는 이유는
// 읽기 경로에 전달할 stdin 이 없기 때문이다.
type WriteRunner func(ctx context.Context, dir string, args []string, stdin string) (Output, error)

// WithWriteRunner 는 쓰기 실행기를 주입한다. **WithRunner 는 쓰기를 대신 막아 주지
// 않는다** — 쓰기까지 격리해야 하는 테스트는 이것을 함께 준다.
func WithWriteRunner(r WriteRunner) Option { return func(s *Service) { s.writeRun = r } }

// ExecWrite 는 저장소를 변경하는 유일한 경로다 (FR-GIT-95). 거부된 호출도 기록에
// 남는다 (FR-GIT-5) — 조용한 거부는 디버깅할 수 없다.
//
// **이 단계에는 호출자가 없다.** 실제 stage/unstage/discard/commit 은 10·11단계가
// 이 골격 위에 얹는다.
func (s *Service) ExecWrite(ctx context.Context, dir string, spec WriteSpec) (Output, error) {
	if strings.TrimSpace(dir) == "" || !filepath.IsAbs(dir) {
		return s.denyWrite(dir, spec, fmt.Errorf("%w: cwd 는 절대 경로여야 한다: %q", ErrUnsafeArgument, dir))
	}
	if err := guardWriteArgs(spec.Argv); err != nil {
		return s.denyWrite(dir, spec, err)
	}

	// 호출자가 더 짧은 마감을 주면 그것이 이긴다 (FR-GIT-3).
	ctx2, cancel := s.withTimeout(ctx)
	defer cancel()

	out, err := s.writeRunner()(ctx2, dir, spec.Argv, spec.Stdin)
	switch {
	case err == nil && out.ExitCode != 0:
		err = &ExecError{Argv: spec.Argv, Cwd: dir, ExitCode: out.ExitCode, Stderr: out.Stderr, kind: classify(ctx2, out.Stderr)}
	case err != nil && !classified(err):
		if k := classify(ctx2, out.Stderr); k != nil {
			err = fmt.Errorf("%w: %v", k, err)
		}
	}
	s.recordWrite(dir, spec, out, err)
	return out, err
}

// guardWriteArgs 는 guardArgs 와 같은 안전 검사를 하고 허용 목록만 바꾼다
// (FR-GIT-2). 목록에 없는 명령은 읽기든 미지의 것이든 여기서 멈춘다.
func guardWriteArgs(args []string) error { return guardCommon(args, writeCommands, "쓰기") }

// writeRunner 는 주입된 실행기 또는 기본 구현이다. 기본 구현이 execGit 을 그대로
// 쓰는 이유는 환경·상한·마감 처리가 읽기와 갈라지면 안 되기 때문이다.
func (s *Service) writeRunner() WriteRunner {
	if s.writeRun != nil {
		return s.writeRun
	}
	limit := s.maxOutput
	return func(ctx context.Context, dir string, args []string, stdin string) (Output, error) {
		return execGit(ctx, dir, args, limit, stdin)
	}
}

// denyWrite 는 실행 없이 거부한다. exit -1 은 "프로세스가 뜨지도 않았다"는 표시다.
func (s *Service) denyWrite(dir string, spec WriteSpec, err error) (Output, error) {
	out := Output{ExitCode: -1}
	s.recordWrite(dir, spec, out, err)
	return out, err
}

// recordWrite 는 공통 기록에 쓰기 경로의 두 사실을 더한다 — 호출자의 파괴적 선언과
// stdin 의 **바이트 수**다 (I5·I6).
func (s *Service) recordWrite(dir string, spec WriteSpec, out Output, err error) {
	rec := newRecord(dir, spec.Argv, out, err)
	rec.Destructive = spec.Destructive
	rec.StdinBytes = len(spec.Stdin)
	s.rec.Add(rec)
}

// StderrTail 은 stderr 의 마지막 n 줄이다 (FR-GIT-96). 실패의 이유는 stderr 끝에
// 있으므로 앞을 버린다. n<=0 이면 DefaultStderrTailLines 다.
func (o Output) StderrTail(n int) string {
	if n <= 0 {
		n = DefaultStderrTailLines
	}
	if o.Stderr == "" {
		return ""
	}
	lines := strings.Split(strings.TrimRight(o.Stderr, "\n"), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n")
}
