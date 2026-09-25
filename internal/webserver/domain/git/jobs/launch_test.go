package jobs

import (
	"context"
	"strings"
	"testing"

	"dongminal/internal/shared/gittest"
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
