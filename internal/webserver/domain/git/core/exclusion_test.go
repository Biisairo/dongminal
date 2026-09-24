package core

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"dongminal/internal/shared/gittest"
)

// REPO_FIX 01 §7.2: index.lock 을 만들지 못한 실패만 ErrIndexLocked 다. 두 조각이
// **함께** 있어야 하고, 다른 `.lock` 은 범위 밖이다.
func TestClassify_IndexLocked(t *testing.T) {
	cases := []struct {
		name   string
		stderr string
		want   bool
	}{
		{"index.lock", "fatal: Unable to create '/r/.git/index.lock': File exists.\n\nAnother git process seems to be running", true},
		{"링크드 worktree", "fatal: Unable to create '/r/.git/worktrees/w/index.lock': File exists.", true},
		{"다른 lock", "error: Unable to create '/r/.git/refs/heads/main.lock': File exists.", false},
		{"한 조각만", "fatal: Unable to create '/r/.git/index.lock': Permission denied", false},
		{"무관", "error: pathspec 'x' did not match", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := New(WithRunner(func(_ context.Context, _ string, _ []string) (Output, error) {
				return Output{Stderr: tc.stderr, ExitCode: 128}, nil
			}))
			_, err := s.Exec(context.Background(), absTmpRepo, "status")
			if got := errors.Is(err, ErrIndexLocked); got != tc.want {
				t.Fatalf("errors.Is(ErrIndexLocked) = %v, want %v (err=%v)", got, tc.want, err)
			}
		})
	}
}

// S-4: index.lock 은 일시적이다 — 감시 제외 같은 결정의 근거가 되지 않는다.
func TestIsTerminal_IndexLockedIsTransient(t *testing.T) {
	if IsTerminal(ErrIndexLocked) {
		t.Fatal("ErrIndexLocked 가 결정적으로 분류됐다")
	}
}

// §5.1: 배타 키는 존재하는 가장 가까운 조상까지 심링크를 풀고 나머지를 붙인다.
// 밖에서 지운 경로도 같은 키가 나와야 한다.
func TestExclusionKey_ResolvesSymlinkPrefix(t *testing.T) {
	real := t.TempDir()
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(real, link); err != nil {
		t.Skipf("심링크를 만들 수 없다: %v", err)
	}
	realKey := ExclusionKey(real)
	if got := ExclusionKey(link); got != realKey {
		t.Fatalf("존재 경로: ExclusionKey(link) = %q, want %q", got, realKey)
	}
	gone := filepath.Join(link, "gone", "deeper")
	want := filepath.Join(realKey, "gone", "deeper")
	if got := ExclusionKey(gone); got != want {
		t.Fatalf("부재 경로: ExclusionKey = %q, want %q", got, want)
	}
	if got := ExclusionKey(real + string(filepath.Separator)); got != realKey {
		t.Fatalf("끝 구분자: %q, want %q", got, realKey)
	}
}

// §7.2: lock 경로는 `rev-parse --git-path index.lock` 이고, 상대면 루트 기준으로
// 절대화한다 — 링크드 worktree 는 자기 gitdir 아래를 가리켜야 한다.
func TestIndexLockPath(t *testing.T) {
	repo := gittest.Repo(t)
	s := New()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	got, err := s.IndexLockPath(ctx, repo)
	if err != nil {
		t.Fatal(err)
	}
	if !filepath.IsAbs(got) || filepath.Base(got) != "index.lock" {
		t.Fatalf("주 저장소 lock 경로 = %q", got)
	}
	if ExclusionKey(filepath.Dir(got)) != ExclusionKey(filepath.Join(repo, ".git")) {
		t.Fatalf("주 저장소 lock 이 .git 아래가 아니다: %q", got)
	}

	wt := filepath.Join(t.TempDir(), "wt")
	gittest.Run(t, repo, "worktree", "add", "-q", "-b", "side", wt)
	got, err = s.IndexLockPath(ctx, wt)
	if err != nil {
		t.Fatal(err)
	}
	if !filepath.IsAbs(got) || !strings.Contains(filepath.ToSlash(got), "/worktrees/") {
		t.Fatalf("링크드 worktree lock 경로 = %q — 자기 gitdir 아래여야 한다", got)
	}
}
