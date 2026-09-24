package worktree

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"dongminal/internal/webserver/domain/git/core"
)

// REPO_FIX 01 §5.6 — repoLock 은 ctx·시한을 존중하고 common-dir 키로 잡는다.

func lockKey(t *testing.T) string {
	t.Helper()
	return filepath.Join(t.TempDir(), "common")
}

// 대기 상한을 넘으면 ErrRepoBusy, 요청 취소면 ErrCanceled, 마감이면 ErrTimeout —
// 어느 쪽도 잠금을 쥐지 않는다.
func TestLockRepo_WaitBoundCancelDeadline(t *testing.T) {
	key := lockKey(t)
	release, err := LockRepo(context.Background(), key, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := LockRepo(context.Background(), key, 30*time.Millisecond); !errors.Is(err, ErrRepoBusy) {
		t.Fatalf("대기 상한 = %v, want ErrRepoBusy", err)
	}
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := LockRepo(canceled, key, time.Second); !errors.Is(err, core.ErrCanceled) {
		t.Fatalf("취소 = %v, want ErrCanceled", err)
	}
	short, cancel2 := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel2()
	if _, err := LockRepo(short, key, time.Second); !errors.Is(err, core.ErrTimeout) {
		t.Fatalf("마감 = %v, want ErrTimeout", err)
	}
	release()
	release() // 두 번 불러도 한 번만 반납한다
	again, err := LockRepo(context.Background(), key, 30*time.Millisecond)
	if err != nil {
		t.Fatalf("반납 뒤 다시 쥐지 못했다: %v", err)
	}
	again()
}

// 키는 정규화한다 — 같은 경로의 다른 표기(트레일링 슬래시·심링크)는 같은 잠금이다.
func TestLockRepo_KeyIsNormalized(t *testing.T) {
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(dir, link); err != nil {
		t.Skip("심링크를 만들 수 없다:", err)
	}
	release, err := LockRepo(context.Background(), dir, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	for _, k := range []string{dir + string(filepath.Separator), link} {
		if _, err := LockRepo(context.Background(), k, 30*time.Millisecond); !errors.Is(err, ErrRepoBusy) {
			t.Fatalf("%q 가 다른 잠금을 잡았다: %v", k, err)
		}
	}
}

// 잠금 키는 LockKey(common-dir)다 — 서로 다른 worktree 경로(Repo)라도 같은 저장소면
// 한 잠금을 문다.
func TestCreate_LockKeyIsCommonDir(t *testing.T) {
	key := lockKey(t)
	release, err := LockRepo(context.Background(), key, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	var adds int32
	m := New(filepath.Join(t.TempDir(), "worktrees"), WithLockWait(30*time.Millisecond),
		WithRunner(func(_ context.Context, _ string, args ...string) (string, error) {
			if len(args) > 1 && args[0] == "worktree" && args[1] == "add" {
				atomic.AddInt32(&adds, 1)
			}
			return "", nil
		}))
	err = m.Create(context.Background(), Spec{Repo: absRepo, LockKey: key, Path: m.Path("r", "a"), Branch: "dmn/r/a", Base: "main"})
	if !errors.Is(err, ErrRepoBusy) {
		t.Fatalf("잠금을 쥔 동안 Create = %v, want ErrRepoBusy", err)
	}
	if adds != 0 {
		t.Fatal("잠금을 얻지 못했는데 worktree add 가 돌았다")
	}
}

// Remove 의 잠금 대기가 ctx 마감에 걸리면 지우지 않고 Err 에 ErrTimeout 을 싣는다.
func TestRemove_LockWaitDeadlineCarriesErr(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "worktrees", "r", "a")
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatal(err)
	}
	key := lockKey(t)
	release, err := LockRepo(context.Background(), key, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	var calls int32
	m := New(filepath.Join(root, "worktrees"), WithRunner(func(context.Context, string, ...string) (string, error) {
		atomic.AddInt32(&calls, 1)
		return "", nil
	}))
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	res := m.Remove(ctx, RemoveSpec{Repo: absRepo, LockKey: key, Path: path})
	if res.Removed || !errors.Is(res.Err, core.ErrTimeout) {
		t.Fatalf("= %+v, want 미제거 + ErrTimeout", res)
	}
	if res.Residue != ResidueRemoveFailed {
		t.Fatalf("잔여물 사유 = %q, want %q", res.Residue, ResidueRemoveFailed)
	}
	if calls != 0 {
		t.Fatalf("잠금 없이 git 이 %d번 돌았다", calls)
	}
}

// BranchExists 는 잠그지 않는다 — worktree add 사전 단계가 repoLock 을 쥔 채 부른다.
func TestBranchExists_DoesNotTakeRepoLock(t *testing.T) {
	release, err := LockRepo(context.Background(), absRepo, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	m := New(filepath.Join(t.TempDir(), "worktrees"), WithLockWait(30*time.Millisecond),
		WithRunner(func(context.Context, string, ...string) (string, error) { return "", nil }))
	if !m.BranchExists(context.Background(), absRepo, "main") {
		t.Fatal("rev-parse 성공인데 없다고 답했다")
	}
}

// 호출자 ctx 가 git 실행까지 간다.
func TestRunner_ReceivesCallerContext(t *testing.T) {
	type k struct{}
	var got any
	m := New(filepath.Join(t.TempDir(), "worktrees"), WithRunner(func(ctx context.Context, _ string, _ ...string) (string, error) {
		got = ctx.Value(k{})
		return "", nil
	}))
	if _, err := m.List(context.WithValue(context.Background(), k{}, "v"), absRepo); err != nil {
		t.Fatal(err)
	}
	if got != "v" {
		t.Fatalf("Runner 가 호출자 ctx 를 받지 못했다: %v", got)
	}
}

// runGit 은 core 의 분류를 %w 로 보존한다 — apierr·lock 판정이 sentinel 을 본다.
func TestRunGit_PreservesCoreSentinel(t *testing.T) {
	gitPath(t)
	_, err := runGit(context.Background(), nil, t.TempDir(), "status")
	if !errors.Is(err, core.ErrNotRepo) {
		t.Fatalf("= %v, want core.ErrNotRepo 보존", err)
	}
}

// AddSpec 은 검증·argv·사유만 낸다 — 실행하지 않는다.
func TestAddSpec_ArgvAndGuards(t *testing.T) {
	m := New(filepath.Join(t.TempDir(), "worktrees"), WithRunner(func(context.Context, string, ...string) (string, error) {
		t.Fatal("AddSpec 이 git 을 불렀다")
		return "", nil
	}))
	p := m.Path("repo-x", "feat")
	spec, err := m.AddSpec(Spec{Repo: absRepo, Path: p, Branch: "feat", Base: "main"})
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(spec.Argv, " "); got != "worktree add --no-track -b feat "+p+" main" {
		t.Fatalf("argv = %q", got)
	}
	if spec.Reason == "" {
		t.Fatal("사유가 비었다")
	}
	spec, err = m.AddSpec(Spec{Repo: absRepo, Path: p, Base: "main"})
	if err != nil || strings.Join(spec.Argv, " ") != "worktree add "+p+" main" {
		t.Fatalf("브랜치 없는 argv = %q, %v", spec.Argv, err)
	}
	if _, err := m.AddSpec(Spec{Repo: absRepo, Path: "/elsewhere/x", Base: "main"}); !errors.Is(err, ErrUnsafePath) {
		t.Fatalf("영역 밖 경로 = %v, want ErrUnsafePath", err)
	}
	if _, err := m.AddSpec(Spec{Repo: absRepo, Path: p, Base: "-x"}); !errors.Is(err, ErrUnsafeArgument) {
		t.Fatalf("플래그 모양 base = %v, want ErrUnsafeArgument", err)
	}
}
