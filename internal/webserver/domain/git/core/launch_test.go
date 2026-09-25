package core

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"dongminal/internal/shared/gittest"
)

// OPTIMIZE_REFACTOR_SRS FR-OPT-7-1 — git 기동 자리는 한 벌이고 bin 탐색은 캐시된다.

// 동기 실행과 잡이 함께 쓰는 기동 자리가 중립화 인자·환경을 붙인다.
func TestCommand_AddsLaunchArgsAndEnv(t *testing.T) {
	gittest.Path(t)
	cmd, err := Command(context.Background(), absTmpRepo, []string{"log", "-n", "1"}, "")
	if err != nil {
		t.Fatalf("Command: %v", err)
	}
	if got := strings.Join(cmd.Args[1:], " "); got != "-c log.showSignature=false log -n 1" {
		t.Fatalf("args = %q", got)
	}
	if cmd.Dir != absTmpRepo {
		t.Fatalf("dir = %q", cmd.Dir)
	}
	if cmd.Stdin != nil {
		t.Fatal("빈 stdin 에 파이프를 만들었다")
	}
	env := strings.Join(cmd.Env, "\n")
	for _, want := range []string{"GIT_TERMINAL_PROMPT=0", "GIT_OPTIONAL_LOCKS=0", "LC_ALL=C"} {
		if !strings.Contains(env, want) {
			t.Fatalf("Env 에 %s 가 없다", want)
		}
	}
}

// fakeGit 은 dir 아래 실행 가능한 git 자리표시다. 실행되지는 않는다.
func fakeGit(t *testing.T, dir string) string {
	t.Helper()
	p := filepath.Join(dir, "git")
	if err := os.WriteFile(p, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

// 같은 PATH 면 캐시를 쓰고, PATH 가 바뀌면 다시 찾는다.
func TestLookGit_CachedPerPath(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("자리표시 git 은 셸 스크립트다")
	}
	t.Cleanup(forgetGit)
	a, b := t.TempDir(), t.TempDir()
	binA, binB := fakeGit(t, a), fakeGit(t, b)

	t.Setenv("PATH", a)
	if got, err := lookGit(); err != nil || got != binA {
		t.Fatalf("lookGit = %q, %v; want %q", got, err, binA)
	}
	// 캐시가 답한다 — 파일을 지워도 같은 PATH 에서는 다시 훑지 않는다.
	if err := os.Remove(binA); err != nil {
		t.Fatal(err)
	}
	if got, _ := lookGit(); got != binA {
		t.Fatalf("같은 PATH 에서 캐시를 쓰지 않았다: %q", got)
	}
	t.Setenv("PATH", b)
	if got, err := lookGit(); err != nil || got != binB {
		t.Fatalf("PATH 가 바뀐 뒤 lookGit = %q, %v; want %q", got, err, binB)
	}
}

// 캐시된 bin 이 사라지면 부재로 답하고, 다음 실행은 PATH 를 다시 훑는다.
func TestExecGit_VanishedCachedBinIsGitMissing(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("자리표시 git 은 셸 스크립트다")
	}
	real := gittest.Path(t)
	repo := gittest.Repo(t)
	t.Cleanup(forgetGit)
	a := t.TempDir()
	bin := fakeGit(t, a)
	t.Setenv("PATH", a)
	if _, err := lookGit(); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(bin); err != nil {
		t.Fatal(err)
	}
	_, err := execGit(context.Background(), repo, []string{"status"}, DefaultMaxOutput, "")
	if !errors.Is(err, ErrGitMissing) {
		t.Fatalf("err = %v, want ErrGitMissing", err)
	}
	// 진짜 git 이 PATH 에 들어오면 곧 찾는다.
	t.Setenv("PATH", filepath.Dir(real)+string(os.PathListSeparator)+a)
	if _, err := execGit(context.Background(), repo, []string{"status"}, DefaultMaxOutput, ""); err != nil {
		t.Fatalf("다시 찾지 않았다: %v", err)
	}
}

// PlainExit 는 분류되지 않은 종료만 참이다.
func TestPlainExit(t *testing.T) {
	plain := &ExecError{ExitCode: 1}
	if xe, ok := PlainExit(plain); !ok || xe != plain {
		t.Fatal("분류되지 않은 종료를 놓쳤다")
	}
	wrapped := errors.Join(errors.New("ctx"), plain)
	if _, ok := PlainExit(wrapped); !ok {
		t.Fatal("감싼 종료를 놓쳤다")
	}
	if _, ok := PlainExit(&ExecError{ExitCode: 128, kind: ErrNotRepo}); ok {
		t.Fatal("분류된 실패를 답으로 읽었다")
	}
	if _, ok := PlainExit(ErrTimeout); ok {
		t.Fatal("ExecError 가 아닌 것을 답으로 읽었다")
	}
}

// UnguardedText: 성공은 stdout 만, 실패는 stdout 다음 stderr 다 (FR-GXU-8 개정).
func TestUnguardedText(t *testing.T) {
	out := Output{Stdout: " a \n", Stderr: "warning: x\n"}
	got, err := UnguardedText([]string{"status"}, out, nil, strings.TrimSpace)
	if err != nil || got != "a" {
		t.Fatalf("성공 = %q, %v", got, err)
	}
	cause := &ExecError{ExitCode: 1}
	got, err = UnguardedText([]string{"status", "-s"}, out, cause, strings.TrimSpace)
	if got != "a \nwarning: x" {
		t.Fatalf("실패 텍스트 = %q", got)
	}
	if !errors.Is(err, cause) || !strings.HasPrefix(err.Error(), "git status -s: ") {
		t.Fatalf("실패 오류 = %v", err)
	}
}
