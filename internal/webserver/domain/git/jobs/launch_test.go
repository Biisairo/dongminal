package jobs

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/shared/gittest"
	"dongminal/internal/shared/platform"
	"dongminal/internal/webserver/domain/git/core"
)

// OPTIMIZE_REFACTOR_SRS FR-OPT-7-1 (DOM-18): 잡 경로도 동기 실행과 같은 기동 자리를
// 지나 `-c log.showSignature=false` 를 받는다 (REPO_FIX 01 R-4.1 — 모든 git 실행).
func TestExecStreamGit_UsesSharedLaunch(t *testing.T) {
	repo := gittest.Repo(t)
	c := gittest.Count(t)
	exit, err := execStreamGit(context.Background(), repo, []string{"log", "-n", "1"}, "", func(string, string) {})
	if err != nil || exit != 0 {
		t.Fatalf("exit=%d err=%v", exit, err)
	}
	calls := c.Calls()
	if len(calls) != 1 || !strings.HasPrefix(calls[0], "-c log.showSignature=false log -n 1") {
		t.Fatalf("calls = %q", calls)
	}
}

// FR-OPT-7-1: 잡 경로도 캐시된 git 이 사라지면 부재로 답하고 캐시를 버린다 — 같은
// PATH 의 다음 실행은 PATH 를 다시 훑어 뒤에 있는 git 을 찾는다.
func TestExecStreamGit_VanishedCachedBinForgets(t *testing.T) {
	if platform.Current().OS == platform.Windows {
		t.Skip("자리표시 git 은 셸 스크립트다")
	}
	real := gittest.Path(t)
	repo := gittest.Repo(t)
	a := t.TempDir()
	fake := filepath.Join(a, "git")
	if err := os.WriteFile(fake, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", a+string(os.PathListSeparator)+filepath.Dir(real))
	// 캐시에 자리표시를 담는다.
	if cmd, err := core.Command(context.Background(), repo, []string{"status"}, ""); err != nil || cmd.Path != fake {
		t.Fatalf("Command path=%v err=%v want %s", cmd, err, fake)
	}
	if err := os.Remove(fake); err != nil {
		t.Fatal(err)
	}
	noop := func(string, string) {}
	if _, err := execStreamGit(context.Background(), repo, []string{"status"}, "", noop); !errors.Is(err, core.ErrGitMissing) {
		t.Fatalf("err = %v, want ErrGitMissing", err)
	}
	if exit, err := execStreamGit(context.Background(), repo, []string{"status"}, "", noop); err != nil || exit != 0 {
		t.Fatalf("캐시를 버리지 않았다: exit=%d err=%v", exit, err)
	}
}
