package submodule

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"testing"

	"dongminal/internal/webserver/domain/git/core"
)

// REPO_FIX 01 §5.6 — Runner 는 호출자 ctx 를 받고, 실패는 core 의 분류를 보존한다.

func TestRunner_ReceivesCallerContext(t *testing.T) {
	type k struct{}
	var got any
	m := New(func(ctx context.Context, _ string, _ ...string) (string, error) {
		got = ctx.Value(k{})
		return "", nil
	})
	if err := m.Sync(context.WithValue(context.Background(), k{}, "v"), repoPath, ""); err != nil {
		t.Fatal(err)
	}
	if got != "v" {
		t.Fatalf("Runner 가 호출자 ctx 를 받지 못했다: %v", got)
	}
}

// ErrFailed 로 감싸도 core sentinel(index_locked 등)이 남는다 — 그래야 응답이 lock
// 필드와 409 index_locked 를 싣는다.
func TestSync_FailurePreservesCoreSentinel(t *testing.T) {
	m := New(func(context.Context, string, ...string) (string, error) {
		return "fatal: Unable to create '.git/index.lock': File exists.", fmt.Errorf("git submodule sync: %w", core.ErrIndexLocked)
	})
	err := m.Sync(context.Background(), repoPath, "")
	if !errors.Is(err, ErrFailed) || !errors.Is(err, core.ErrIndexLocked) {
		t.Fatalf("= %v, want ErrFailed 와 core.ErrIndexLocked 둘 다", err)
	}
}

func TestRunGit_PreservesCoreSentinel(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git 이 없다")
	}
	_, err := runGit(context.Background(), nil, t.TempDir(), "status")
	if !errors.Is(err, core.ErrNotRepo) {
		t.Fatalf("= %v, want core.ErrNotRepo 보존", err)
	}
}
