package gitapi

import (
	"context"
	"net/http"
	"sync"
	"time"

	"dongminal/internal/webserver/domain/git/core"
	"dongminal/internal/webserver/domain/git/jobs"
)

// REPO_FIX 01 §5.2·5.4 — 쓰기 배타.
//
// 잠금의 **분류는 종단 표 하나**가 소유한다 (writeLocks). 핸들러마다 잠금을 부르게
// 두면 한 곳이 빠졌을 때 배타가 조용히 사라지고, 반납을 핸들러의 모든 반환 경로가
// 지켜야 한다. 그래서 Handle 이 요청마다 lease 를 붙이고 핸들러가 끝나면 반납한다 —
// 핸들러는 resolve 에서 키가 정해질 때 lease 를 채울 뿐이다.

type lockMode int

const (
	// lockNone — 잠금 없음. 비-index 잡 시작·제어·핀·init.
	lockNone lockMode = iota
	// lockTop — 같은 toplevel 의 index 칸 확인 → toplevel 뮤텍스 → 재확인.
	// 동기 쓰기와 index 잡 시작(사전 단계~등록)이 쓴다.
	lockTop
	// lockStash — common-dir 잠금을 먼저 쥐고 lockTop. `refs/stash` 는 worktree
	// 들이 공유한다 (§5.3).
	lockStash
)

// writeLocks 는 §5.2 분류표의 잠금 열이다. **POST 종단 전부가 여기 있어야 한다**
// (TestWriteLocks_CoverAllPostRoutes). lockNone 이지만 핸들러가 직접 잠그는 종단이
// 셋이다 (§5.6·7.2): worktrees/create 는 common 칸 확인 + repoLock, worktrees/remove
// 는 **대상** worktree 의 index 칸·toplevel 뮤텍스(요청 worktree 가 아니다),
// lock/remove 는 기다리지 않는 TryLock.
var writeLocks = map[string]lockMode{
	"/api/git/init":                 lockNone,
	"/api/git/repos/pin":            lockNone,
	"/api/git/repos/unpin":          lockNone,
	"/api/git/repos/reorder":        lockNone,
	"/api/git/stage":                lockTop,
	"/api/git/unstage":              lockTop,
	"/api/git/discard":              lockTop,
	"/api/git/resolve":              lockTop,
	"/api/git/commit":               lockTop,
	"/api/git/undo-last":            lockTop,
	"/api/git/records/replay":       lockTop, // 읽기 기록은 핸들러가 잠그지 않는다
	"/api/git/fetch":                lockNone,
	"/api/git/pull":                 lockTop,
	"/api/git/push":                 lockNone,
	"/api/git/job/cancel":           lockNone,
	"/api/git/remote/add":           lockTop,
	"/api/git/remote/remove":        lockTop,
	"/api/git/checkout":             lockTop,
	"/api/git/operation":            lockTop,
	"/api/git/branch":               lockTop,
	"/api/git/branch/rename":        lockTop,
	"/api/git/branch/delete":        lockTop,
	"/api/git/branch/merge":         lockTop,
	"/api/git/branch/rebase":        lockTop,
	"/api/git/branch/upstream":      lockTop,
	"/api/git/branch/push":          lockNone,
	"/api/git/branch/fetch":         lockNone,
	"/api/git/branch/delete-remote": lockNone,
	"/api/git/stash/push":           lockStash,
	"/api/git/stash/apply":          lockStash,
	"/api/git/stash/pop":            lockStash,
	"/api/git/stash/drop":           lockStash,
	"/api/git/stash/branch":         lockStash,
	"/api/git/tag":                  lockTop,
	"/api/git/tag/delete":           lockTop,
	"/api/git/tag/push":             lockNone,
	"/api/git/tag/delete-remote":    lockNone,
	"/api/git/ignore":               lockTop,
	"/api/git/uncommitted/reset":    lockTop,
	"/api/git/uncommitted/clean":    lockTop,
	"/api/git/patch":                lockTop,
	"/api/git/cherry-pick":          lockTop,
	"/api/git/revert":               lockTop,
	"/api/git/reset":                lockTop,
	"/api/git/drop":                 lockTop,
	"/api/git/submodules/update":    lockNone,
	"/api/git/submodules/sync":      lockTop,
	"/api/git/worktrees/create":     lockNone,
	"/api/git/worktrees/remove":     lockNone,
	"/api/git/lock/remove":          lockNone,
}

// writeLease 는 요청 하나가 쥔 잠금과 사전 단계 ctx 다. Handle 이 핸들러가 끝난 뒤
// release 한다 — 핸들러의 어느 반환 경로도 반납을 빠뜨릴 수 없다.
type writeLease struct {
	mode lockMode

	mu       sync.Mutex
	releases []func()
}

func (l *writeLease) hold(release func()) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.releases = append(l.releases, release)
}

// release 는 쥔 역순으로 반납한다 — 잠금 순서(common-dir → toplevel)의 거울이다.
func (l *writeLease) release() {
	l.mu.Lock()
	rs := l.releases
	l.releases = nil
	l.mu.Unlock()
	for i := len(rs) - 1; i >= 0; i-- {
		rs[i]()
	}
}

type leaseKey struct{}

func leaseOf(ctx context.Context) *writeLease {
	l, _ := ctx.Value(leaseKey{}).(*writeLease)
	return l
}

// withLease 는 분류표에 있는 POST 에 lease 를 붙인다. 없는 종단은 그대로 둔다.
func withLease(r *http.Request) (*http.Request, *writeLease) {
	if r.Method != http.MethodPost {
		return r, nil
	}
	mode, ok := writeLocks[r.URL.Path]
	if !ok {
		return r, nil
	}
	l := &writeLease{mode: mode}
	return r.WithContext(context.WithValue(r.Context(), leaseKey{}, l)), l
}

// exclusion 은 서버의 배타 상태다. 합성 루트가 주입하지 않은 배선(테스트)에서는
// 처음 쓸 때 하나를 만든다 — 그래도 이 서버 안에서는 하나다.
func (s *GitServer) exclusion() *jobs.Exclusion {
	s.gitJobs.mu.Lock()
	defer s.gitJobs.mu.Unlock()
	if s.Exclusion == nil {
		s.Exclusion = jobs.NewExclusion()
	}
	return s.Exclusion
}

// gitKeys 는 root 의 배타 키다 (§5.1). toplevel 은 root 자신, common-dir 은 store 의
// gitDirs 캐시에서 온다. 둘 다 배타 키로만 정규화한다.
func (s *GitServer) gitKeys(ctx context.Context, root string) (jobs.Keys, error) {
	common, err := s.Git.CommonDir(ctx, root)
	if err != nil {
		return jobs.Keys{}, err
	}
	return jobs.Keys{Top: core.ExclusionKey(root), Common: core.ExclusionKey(common)}, nil
}

// gitRoot 는 쓰기·사후 단계의 부모 ctx 다 — 서버 수명.
func (s *GitServer) gitRoot() context.Context {
	if s.Git == nil {
		return context.Background()
	}
	return s.Git.Root()
}

func (s *GitServer) gitManagerWrite() time.Duration {
	if s.managerWrite > 0 {
		return s.managerWrite
	}
	return core.ManagerWriteTimeout
}

func (s *GitServer) gitLockWait() time.Duration {
	if s.lockWait > 0 {
		return s.lockWait
	}
	return core.LockWait
}
