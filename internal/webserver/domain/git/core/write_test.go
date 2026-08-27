package core

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// 묶음 J — 쓰기 경로의 단일 지점 (GIT_SRS §3A.3 FR-GIT-95~96, 검증 V39).

// writeFake 은 argv 와 stdin 을 기록하는 WriteRunner 다. **stdin 을 받는지**가
// 검사 대상이므로 읽기 Runner 로는 대신할 수 없다.
type writeFake struct {
	argvs  [][]string
	stdins []string
	out    Output
	err    error
}

func (f *writeFake) runner(_ context.Context, _ string, args []string, stdin string) (Output, error) {
	f.argvs = append(f.argvs, append([]string(nil), args...))
	f.stdins = append(f.stdins, stdin)
	return f.out, f.err
}

// W3 의 검사 패턴과 허용 경로. 자기 검사와 실제 스캔이 같은 것을 봐야 하므로 한
// 자리에 둔다 — 둘이 갈라지면 자기 검사가 아무것도 보증하지 않는다.
var (
	execWriteCall    = regexp.MustCompile(`\.ExecWrite\(`)
	execWriteAllowed = regexp.MustCompile(`^internal/webserver/gitapi/[^/]*\.go$`)
)

// W1 (V39, FR-GIT-95): 두 진입점은 서로의 목록을 실행하지 못한다. 어느 경로로도
// 실행 가능한 명령이 생기면 "지정된 단일 경로" 가 뜻을 잃는다.
func TestExecAndExecWrite_RejectEachOthersCommands(t *testing.T) {
	ctx := context.Background()

	for cmd := range writeCommands {
		s := New(WithRunner(func(_ context.Context, _ string, _ []string) (Output, error) {
			t.Fatalf("Exec 이 쓰기 명령 %s 를 실행했다", cmd)
			return Output{}, nil
		}))
		if _, err := s.Exec(ctx, "/tmp/repo", cmd); !errors.Is(err, ErrWriteCommand) {
			t.Fatalf("Exec(%s) = %v, want ErrWriteCommand", cmd, err)
		}
	}

	for cmd := range readCommands {
		s := New(WithWriteRunner(func(_ context.Context, _ string, _ []string, _ string) (Output, error) {
			t.Fatalf("ExecWrite 가 읽기 명령 %s 를 실행했다", cmd)
			return Output{}, nil
		}))
		_, err := s.ExecWrite(ctx, "/tmp/repo", WriteSpec{Argv: []string{cmd}})
		if !errors.Is(err, ErrWriteCommand) {
			t.Fatalf("ExecWrite(%s) = %v, want ErrWriteCommand", cmd, err)
		}
	}
}

// W1: 쓰기 경로도 읽기와 같은 안전 검사를 거친다 (전역 옵션·NUL·임의 실행 인자).
func TestExecWrite_SharesGuardChecks(t *testing.T) {
	cases := []struct {
		name string
		dir  string
		argv []string
		want error
	}{
		{"빈 argv", "/tmp/repo", nil, ErrUnsafeArgument},
		{"상대 경로 cwd", "repo", []string{"add", "."}, ErrUnsafeArgument},
		{"전역 옵션", "/tmp/repo", []string{"-c", "core.pager=x", "commit"}, ErrUnsafeArgument},
		{"NUL 포함", "/tmp/repo", []string{"add", "a\x00b"}, ErrUnsafeArgument},
		{"임의 실행 인자", "/tmp/repo", []string{"push", "--receive-pack=/bin/sh"}, ErrUnsafeArgument},
		{"파일 쓰기 인자", "/tmp/repo", []string{"commit", "--output=/etc/passwd"}, ErrUnsafeArgument},
		{"목록 밖 명령", "/tmp/repo", []string{"frobnicate"}, ErrWriteCommand},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := New(WithWriteRunner(func(_ context.Context, _ string, args []string, _ string) (Output, error) {
				t.Fatalf("%q 가 실행됐다", args)
				return Output{}, nil
			}))
			if _, err := s.ExecWrite(context.Background(), tc.dir, WriteSpec{Argv: tc.argv}); !errors.Is(err, tc.want) {
				t.Fatalf("ExecWrite(%q) = %v, want %v", tc.argv, err, tc.want)
			}
		})
	}
}

// W2 (V39): 읽기·쓰기 목록의 교집합은 비어 있다.
func TestReadAndWriteCommands_Disjoint(t *testing.T) {
	for cmd := range writeCommands {
		if readCommands[cmd] {
			t.Fatalf("%q 가 두 목록에 모두 있다 — 어느 경로로도 실행 가능한 명령이 생겼다", cmd)
		}
	}
	// 쓰기 목록이 비면 위 검사가 무의미하다.
	if len(writeCommands) < 10 {
		t.Fatalf("writeCommands 가 %d 개뿐이다", len(writeCommands))
	}
}

// V158 (FR-GIT-246): `git worktree` 는 한 하위 명령 안에 읽기(list)와 쓰기
// (add·remove)가 함께 있어 readCommands·writeCommands 어느 쪽에 넣어도
// FR-GIT-95 의 교집합-금지 불변식이 뜻을 잃는다. 그래서 **어느 목록에도 없어야
// 한다** — worktree 의 git 실행은 전부 internal/webserver/domain/worktree 안에서
// 한다 (도메인 밖 실행은 core/static_test.go 의 execAllowed 예외가 이미 막는다).
// 이 테스트는 그 결정을 회귀로부터 지킨다: 나중에 누가 I7 을 구현하며 별 생각 없이
// "worktree" 를 두 맵 중 하나에 추가하면 여기서 즉시 걸린다.
func TestWorktreeCommand_NotInEitherList(t *testing.T) {
	if readCommands["worktree"] {
		t.Fatal("worktree 가 readCommands 에 있다 — FR-GIT-246 위반: worktree add/remove 가 읽기 경로로 나갈 수 있다")
	}
	if writeCommands["worktree"] {
		t.Fatal("worktree 가 writeCommands 에 있다 — FR-GIT-246 위반: worktree list 가 쓰기 경로에서 막힌다")
	}
	// 교집합 자체가 비어 있다는 불변식도 이 테스트가 다시 확인한다 — W2 와 같은
	// 사실이지만 V158 로 스펙에서 직접 추적할 수 있어야 한다.
	for cmd := range readCommands {
		if writeCommands[cmd] {
			t.Fatalf("%q 가 두 목록에 모두 있다 (FR-GIT-95)", cmd)
		}
	}
}

// W3 (V39, FR-GIT-95): webserver/domain/git 밖에서 ExecWrite 를 부르는 곳은
// internal/webserver/gitapi 뿐이다.
func TestExecWriteCallers_RestrictedToServerGitHandlers(t *testing.T) {
	root := repoRootForTest(t)
	scanned := 0
	var offenders []string

	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			switch d.Name() {
			// `.claude` 는 도구가 저장소 안에 만드는 자리다 — 그 아래의 worktree 는
			// **이 저장소의 사본**이지 소스가 아니다. 세면 같은 호출이 사본 수만큼
			// 중복으로 잡혀 가드가 항상 실패한다.
			case "node_modules", ".git", ".claude", "e2e":
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(d.Name(), ".go") {
			return nil
		}
		rel, rerr := filepath.Rel(root, path)
		if rerr != nil {
			return rerr
		}
		rel = filepath.ToSlash(rel)
		if strings.HasPrefix(rel, "internal/webserver/domain/git/") || execWriteAllowed.MatchString(rel) {
			return nil
		}
		scanned++
		body, rerr := os.ReadFile(path)
		if rerr != nil {
			return rerr
		}
		for i, line := range strings.Split(string(body), "\n") {
			if execWriteCall.MatchString(line) {
				offenders = append(offenders, rel+":"+strconv.Itoa(i+1)+": "+strings.TrimSpace(line))
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk: %v", err)
	}
	if scanned < 20 {
		t.Fatalf("검사한 .go 파일이 %d 개뿐이다 — 탐색이 깨졌다", scanned)
	}
	if len(offenders) > 0 {
		t.Fatalf("지정 경로 밖에서 ExecWrite 를 부른다 (FR-GIT-95):\n%s", strings.Join(offenders, "\n"))
	}
}

// W3: 위 검사의 패턴과 예외 목록이 실제로 구별하는지 본다 — 지금 호출자가 없으므로
// 자기 검사가 없으면 통과가 무의미하다.
func TestExecWriteCallerScan_PatternAndAllowList(t *testing.T) {
	for _, line := range []string{
		`out, err := s.Git.Service().ExecWrite(ctx, root, spec)`,
		`svc.ExecWrite(r.Context(), repo, git.WriteSpec{})`,
	} {
		if !execWriteCall.MatchString(line) {
			t.Fatalf("놓쳤다: %s", line)
		}
	}
	if execWriteCall.MatchString(`ExecWriteSomethingElse(ctx)`) {
		t.Fatal("오탐: 다른 이름을 잡는다")
	}
	for _, rel := range []string{"internal/webserver/gitapi/handlers_git.go", "internal/webserver/gitapi/handlers_git_policy.go"} {
		if !execWriteAllowed.MatchString(rel) {
			t.Fatalf("%s 는 허용돼야 한다", rel)
		}
	}
	for _, rel := range []string{"internal/webserver/httpapi/handlers_runs.go", "cmd/dongminal/main.go", "internal/webserver/httpapi/deps.go"} {
		if execWriteAllowed.MatchString(rel) {
			t.Fatalf("%s 를 허용했다", rel)
		}
	}
}

// W4 (FR-GIT-95, I5): 파괴적이라는 선언은 호출자가 하고 그 선언이 기록에 남는다.
// 거부된 호출도 마찬가지다 — 무엇이 왜 막혔는지 Console 이 봐야 한다.
func TestExecWrite_RecordsDestructiveDeclaration(t *testing.T) {
	f := &writeFake{}
	s := New(WithWriteRunner(f.runner))
	ctx := context.Background()

	if _, err := s.ExecWrite(ctx, "/tmp/repo", WriteSpec{Argv: []string{"clean", "-fd"}, Destructive: true}); err != nil {
		t.Fatalf("ExecWrite: %v", err)
	}
	if _, err := s.ExecWrite(ctx, "/tmp/repo", WriteSpec{Argv: []string{"add", "."}}); err != nil {
		t.Fatalf("ExecWrite: %v", err)
	}
	// 거부돼 프로세스가 뜨지 않아도 선언은 남는다.
	if _, err := s.ExecWrite(ctx, "/tmp/repo", WriteSpec{Argv: []string{"status"}, Destructive: true}); err == nil {
		t.Fatal("읽기 명령이 통과했다")
	}

	recs := s.Records(0)
	if len(recs) != 3 {
		t.Fatalf("기록 %d 개, want 3", len(recs))
	}
	if !recs[0].Destructive || recs[0].ExitCode != 0 {
		t.Fatalf("clean 기록 = %+v", recs[0])
	}
	if recs[1].Destructive {
		t.Fatalf("add 가 파괴적으로 기록됐다: %+v", recs[1])
	}
	if !recs[2].Destructive || recs[2].ExitCode != -1 || recs[2].Err == "" {
		t.Fatalf("거부 기록 = %+v", recs[2])
	}
}

// W5 (FR-GIT-77, I6): Stdin 은 실행기에 전달되고 **기록에는 바이트 수만 남는다.**
func TestExecWrite_StdinNotRecorded(t *testing.T) {
	msg := "제목\n\n본문 secret-token\n"
	f := &writeFake{}
	s := New(WithWriteRunner(f.runner))

	if _, err := s.ExecWrite(context.Background(), "/tmp/repo",
		WriteSpec{Argv: []string{"commit", "--file=-", "--cleanup=strip"}, Stdin: msg}); err != nil {
		t.Fatalf("ExecWrite: %v", err)
	}
	if len(f.stdins) != 1 || f.stdins[0] != msg {
		t.Fatalf("실행기가 받은 stdin = %q", f.stdins)
	}

	rec := s.Records(0)[0]
	if rec.StdinBytes != len(msg) {
		t.Fatalf("StdinBytes = %d, want %d", rec.StdinBytes, len(msg))
	}
	blob := strings.Join(append(append([]string{}, rec.Argv...), rec.Stderr, rec.Err), "\x00")
	if strings.Contains(blob, "secret-token") {
		t.Fatalf("stdin 의 내용이 기록에 남았다: %+v", rec)
	}
}

// W5 (FR-GIT-77): 실제 git 프로세스가 stdin 을 읽는다. 실행기까지의 배선만 봐서는
// 메시지가 프로세스에 닿는지 알 수 없다.
func TestExecWrite_StdinReachesGitProcess(t *testing.T) {
	// 사용자의 전역 설정(서명 강제 등)에 흔들리지 않게 한다 — gitEnv 는
	// os.Environ 을 물려받는다.
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	t.Setenv("GIT_CONFIG_SYSTEM", os.DevNull)
	repo := tempRepo(t)
	s := New()
	ctx := context.Background()
	msg := "stdin 으로 온 제목\n\n본문\n"

	if _, err := s.ExecWrite(ctx, repo, WriteSpec{
		Argv:  []string{"commit", "--allow-empty", "--file=-", "--cleanup=strip"},
		Stdin: msg,
	}); err != nil {
		t.Fatalf("ExecWrite: %v", err)
	}
	out, err := s.Exec(ctx, repo, "log", "-1", "--format=%B")
	if err != nil {
		t.Fatalf("log: %v", err)
	}
	if strings.TrimSpace(out.Stdout) != strings.TrimSpace(msg) {
		t.Fatalf("커밋 메시지 = %q, want %q", out.Stdout, msg)
	}
	rec := s.Records(0)[0]
	if rec.StdinBytes != len(msg) {
		t.Fatalf("StdinBytes = %d, want %d", rec.StdinBytes, len(msg))
	}
}

// W6 (FR-GIT-96): 실패의 이유는 stderr 끝에 있다 — 마지막 n 줄을 준다.
func TestOutput_StderrTail(t *testing.T) {
	lines := make([]string, 300)
	for i := range lines {
		lines[i] = "line " + strconv.Itoa(i)
	}
	out := Output{Stderr: strings.Join(lines, "\n") + "\n"}

	got := strings.Split(out.StderrTail(DefaultStderrTailLines), "\n")
	if len(got) != DefaultStderrTailLines {
		t.Fatalf("줄 수 = %d, want %d", len(got), DefaultStderrTailLines)
	}
	if got[0] != "line 100" || got[len(got)-1] != "line 299" {
		t.Fatalf("tail = %q … %q", got[0], got[len(got)-1])
	}
	// n<=0 은 기본값이다. 보유분이 n 보다 적으면 전부다.
	if out.StderrTail(0) != out.StderrTail(DefaultStderrTailLines) {
		t.Fatal("n<=0 이 기본값을 쓰지 않는다")
	}
	short := Output{Stderr: "fatal: 하나\n"}
	if short.StderrTail(DefaultStderrTailLines) != "fatal: 하나" {
		t.Fatalf("짧은 stderr = %q", short.StderrTail(DefaultStderrTailLines))
	}
	if (Output{}).StderrTail(DefaultStderrTailLines) != "" {
		t.Fatal("빈 stderr 가 빈 문자열이 아니다")
	}
}
