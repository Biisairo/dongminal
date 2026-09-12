package core

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
//
// `apply` 는 부분 스테이징이 여는 유일한 새 하위 명령이다 (FR-GIT-278). 패치는
// **서버가 만들어 stdin 으로만** 넣는다 (D6) — 클라이언트가 만든 패치 문자열이
// 여기 닿는 경로는 없다. 파일 인자를 받지 않으므로 임의 파일을 읽지도 않는다.
var writeCommands = map[string]bool{
	"add": true, "reset": true, "rm": true, "commit": true, "apply": true,
	"checkout": true, "restore": true, "clean": true,
	"stash": true, "branch": true, "tag": true,
	"fetch": true, "pull": true, "push": true,
	"merge": true, "rebase": true, "cherry-pick": true, "revert": true,
	// GIT_DETECT_TIER_SRS FR-GDT-19·20: 진행 중 작업의 **출구**로만 쓰인다.
	// `am` 은 `--continue|--skip|--abort`, `bisect` 는 `reset` 뿐이며 그 한정은
	// `write.operationVerbs` 가 하고 아래 guard 가 다시 못박는다.
	"am": true, "bisect": true,
	"update-ref": true, "symbolic-ref": true,
	// FR-GIT-269: 원격 목록의 add/remove. 목록 **조회**는 여기 오지 않는다 —
	// query/remote.go 가 `config --list` 로 이미 얻으므로 읽기 허용 목록을 늘릴
	// 일이 없고, 그래서 두 목록의 교집합도 그대로 비어 있다 (FR-GIT-95).
	"remote": true,
	// REPO_TAB_UNIFY_SRS FR-RTU-29: 저장소가 아닌 자리를 저장소로 만든다.
	//
	// **이 목록에서 유일하게 저장소 밖에서 도는 명령이다.** 그래서 인자를 하나도
	// 받지 않는 모양으로 한정한다 (아래 guardInitArgs) — `--bare`·`--template`·
	// `--separate-git-dir` 는 이 표면이 제공하지 않는 동작이고, 열어 두면 화면에
	// 없는 저장소 모양이 API 직접 호출로 만들어진다.
	"init": true,
}

// remoteSubArgs 는 `git remote` 가 지날 수 있는 하위 명령과 그 뒤 인자 수다
// (FR-GIT-269). **add·remove 둘뿐이다** — set-url·prune·update 는 이 표면이
// 제공하지 않는 동작이고, 열어 두면 화면에 없는 변경이 API 직접 호출로 들어온다.
var remoteSubArgs = map[string]int{"add": 2, "remove": 1}

// readOnlySubcommands 는 **쓰기 동사 아래의 읽기 하위 명령**이다
// (GIT_REFRESH_LIFECYCLE_SRS FR-GRF-25 · `GP-10`).
//
// `git stash list` 는 `argv[0]=="stash"` 라 쓰기 동사를 쓰지만 저장소를 바꾸지
// 않는다. 그런데 `IsWriteCommand` 가 `argv[0]` 만 보던 탓에 **쓰기로 기록**됐고,
// 관측 회차마다 `_reloadViews` 가 그것을 실행하므로 Console 맨 위는 사용자가 친
// 적 없는 `stash list` 가 됐다 (e2e `git-console` K2 · `git-view-refresh` G3·G5).
//
// **실행 게이트는 이 표를 보지 않는다** (FR-GRF-26). `ExecWrite` 의 허용목록은
// 여전히 `writeCommands` 이고 두 목록의 교집합은 그대로 비어 있다 (FR-GIT-95) —
// 달라지는 것은 기록의 분류뿐이다.
//
// 값이 빈 집합이면 "인자 없는 형태가 읽기" 라는 뜻이다 (`git branch` 는 목록,
// `git remote` 도 목록).
var readOnlySubcommands = map[string]map[string]bool{
	"stash":  {"list": true, "show": true},
	"branch": {"--list": true, "-l": true, "--show-current": true},
	"tag":    {"-l": true, "--list": true},
	"remote": {"-v": true, "--verbose": true, "show": true},
}

// bareIsRead 는 인자 없는 형태가 읽기인 동사다. `git branch`·`git remote`·
// `git tag` 는 인자가 없으면 목록을 낸다.
var bareIsRead = map[string]bool{"branch": true, "remote": true, "tag": true}

// IsWriteCommand 는 argv 가 저장소를 바꾸는 실행인지 답한다 (FR-GIT-218).
//
// 판정은 **(동사, 하위명령) 쌍**이다 (FR-GRF-25). 동사만 보면 같은 동사 아래의
// 읽기가 전부 쓰기로 기록된다.
//
// 목록을 두 벌 두지 않으려고 노출한다 — Console 이 감추는 기준과 ExecWrite 가
// 막는 기준이 어긋나면, 화면이 "쓰기가 아니다" 라고 한 것이 실제로는 쓰기다.
func IsWriteCommand(argv []string) bool {
	if len(argv) == 0 || !writeCommands[argv[0]] {
		return false
	}
	if len(argv) == 1 {
		return !bareIsRead[argv[0]]
	}
	subs := readOnlySubcommands[argv[0]]
	if subs == nil {
		return true
	}
	// 첫 인자 하나로 가른다. `stash show --name-status -z <ref>` 처럼 뒤에 무엇이
	// 붙어도 그 실행이 읽기라는 사실은 바뀌지 않는다 — 반대로 `stash push -u` 는
	// 첫 인자가 목록에 없으므로 쓰기로 남는다.
	return !subs[argv[1]]
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
// stage/unstage/discard/commit 부터 branch/tag/remote·fetch/pull/push 까지, 쓰기
// 표면 전부가 이 함수를 지난다.
func (s *Service) ExecWrite(ctx context.Context, dir string, spec WriteSpec) (Output, error) {
	if strings.TrimSpace(dir) == "" || !filepath.IsAbs(dir) {
		return s.denyWrite(dir, spec, fmt.Errorf("%w: cwd 는 절대 경로여야 한다: %q", ErrUnsafeArgument, dir))
	}
	if err := GuardWriteArgs(spec.Argv); err != nil {
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
	s.RecordWrite(dir, spec, out, err)
	return out, err
}

// GuardWriteArgs 는 guardArgs 와 같은 안전 검사를 하고 허용 목록만 바꾼다
// (FR-GIT-2). 목록에 없는 명령은 읽기든 미지의 것이든 여기서 멈춘다.
func GuardWriteArgs(args []string) error {
	if err := guardCommon(args, writeCommands, "쓰기"); err != nil {
		return err
	}
	if args[0] == "remote" {
		return guardRemoteArgs(args[1:])
	}
	if args[0] == "init" {
		return guardInitArgs(args[1:])
	}
	if sub, ok := opOnlySubcommands[args[0]]; ok {
		return guardOpOnlyArgs(args[0], args[1:], sub)
	}
	return nil
}

// opOnlySubcommands 는 **진행 중 작업의 출구로만** 쓰이는 동사와 그 허용 모양이다
// (GIT_DETECT_TIER_SRS FR-GDT-20).
//
// `am`·`bisect` 는 이 표면이 **시작하지 않는** 명령이다 — 사용자가 터미널에서
// 시작한 것을 GUI 가 끝내거나 중단할 수 있게 할 뿐이다. 그래서 시작 갈래
// (`am <mbox>`·`bisect start`)를 열지 않는다. `guardInitArgs` 와 같은 근거다:
// 화면에 없는 동작이 API 직접 호출로 들어오지 않게 한다.
var opOnlySubcommands = map[string]map[string]bool{
	"am":     {"--continue": true, "--skip": true, "--abort": true},
	"bisect": {"reset": true},
}

func guardOpOnlyArgs(verb string, rest []string, allow map[string]bool) error {
	if len(rest) != 1 {
		return fmt.Errorf("%w: git %s 는 하위 명령 하나만 받는다: %q", ErrUnsafeArgument, verb, rest)
	}
	if !allow[rest[0]] {
		return fmt.Errorf("%w: git %s 의 %q 는 이 표면이 제공하지 않는다", ErrUnsafeArgument, verb, rest[0])
	}
	return nil
}

// guardInitArgs 는 `git init` 을 **인자 없는 한 모양**으로 한정한다 (FR-RTU-29).
//
// 대상은 언제나 `dir`(실행 디렉터리)이다. 경로 인자를 받으면 그것이 곧 "이 종단이
// 검사한 자리와 다른 자리에 저장소를 만드는" 길이 된다 — 핸들러의 존재·디렉터리
// 검사가 그 순간 무의미해진다.
//
// 초기 브랜치 이름도 주지 않는다. 사용자의 `init.defaultBranch` 가 있고, 우리가
// 정하면 그 설정과 어긋난 저장소가 만들어진다.
func guardInitArgs(rest []string) error {
	if len(rest) != 0 {
		return fmt.Errorf("%w: git init 은 인자를 받지 않는다: %q", ErrUnsafeArgument, rest)
	}
	return nil
}

// guardRemoteArgs 는 `git remote` 를 add/remove 두 모양으로 한정한다
// (FR-GIT-269). 인자 수까지 못박는 이유는 남는 인자가 곧 다른 동작이기 때문이다 —
// `remote add -f <name> <url>` 은 fetch 까지 하는 다른 명령이다.
func guardRemoteArgs(rest []string) error {
	if len(rest) == 0 {
		return fmt.Errorf("%w: git remote 는 하위 명령을 요구한다", ErrUnsafeArgument)
	}
	want, ok := remoteSubArgs[rest[0]]
	if !ok {
		return fmt.Errorf("%w: git remote 의 %q 는 이 표면이 제공하지 않는다", ErrUnsafeArgument, rest[0])
	}
	if len(rest)-1 != want {
		return fmt.Errorf("%w: git remote %s 는 인자 %d 개를 받는다: %q", ErrUnsafeArgument, rest[0], want, rest[1:])
	}
	// 위치 인자에 옵션처럼 생긴 값이 오면 git 이 그것을 옵션으로 읽는다.
	for _, a := range rest[1:] {
		if strings.HasPrefix(a, "-") {
			return fmt.Errorf("%w: git remote 의 인자는 - 로 시작할 수 없다: %q", ErrUnsafeArgument, a)
		}
	}
	return nil
}

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
	s.RecordWrite(dir, spec, out, err)
	return out, err
}

// RecordWrite 는 공통 기록에 쓰기 경로의 두 사실을 더한다 — 호출자의 파괴적 선언과
// stdin 의 **바이트 수**다 (I5·I6).
func (s *Service) RecordWrite(dir string, spec WriteSpec, out Output, err error) {
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
