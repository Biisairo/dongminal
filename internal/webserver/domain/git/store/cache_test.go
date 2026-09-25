package store

import (
	"context"
	"fmt"
	"runtime"
	"sync"
	"testing"
	"time"

	"dongminal/internal/shared/testpath"
	"dongminal/internal/webserver/domain/git/core"
)

// OPTIMIZE_REFACTOR_SRS FR-OPT-7-4 (DOM-26).

// 상한에 닿아도 캐시를 통째로 버리지 않는다 — 만료된 것부터, 그래도 넘치면 가장
// 오래된 것부터 거둔다. 종전에는 clear 로 전부 버려 핀이 상한을 넘으면 TTL 이
// 무의미해졌다.
func TestStore_RepoRootPruneIsPartial(t *testing.T) {
	g := newFakeGit(t)
	base := time.Now()
	clk := base
	st := NewStore(core.New(core.WithRunner(g.runner)), WithClock(func() time.Time { return clk }))
	ctx := context.Background()

	cwds := make([]string, DefaultObservedCap+1)
	for i := range cwds {
		cwds[i] = testpath.Abs(fmt.Sprintf("p%d", i))
		clk = base.Add(time.Duration(i) * time.Millisecond)
		if _, err := st.RepoRoot(ctx, cwds[i]); err != nil {
			t.Fatalf("RepoRoot: %v", err)
		}
	}
	// 상한+1 번째가 들어가며 가장 오래된 하나만 밀려났다 — 나머지는 캐시가 답한다.
	before := g.count("rev-parse --show-toplevel")
	for _, c := range cwds[1:] {
		if _, err := st.RepoRoot(ctx, c); err != nil {
			t.Fatalf("RepoRoot: %v", err)
		}
	}
	if got := g.count("rev-parse --show-toplevel") - before; got != 0 {
		t.Fatalf("캐시에 남아야 할 %d 개를 다시 물었다", got)
	}
	if len(st.roots) > DefaultObservedCap {
		t.Fatalf("캐시가 상한 %d 을 넘었다: %d", DefaultObservedCap, len(st.roots))
	}
}

// 만료된 항목이 있으면 그것을 먼저 거둔다 — 살아 있는 항목은 남는다.
func TestPruneCache_ExpiredFirst(t *testing.T) {
	now := time.Now()
	m := map[string]rootEntry{
		"old":   {at: now.Add(-time.Hour)},
		"fresh": {at: now.Add(-2 * time.Millisecond)},
		"new":   {at: now.Add(-time.Millisecond)},
	}
	pruneCache(m, 3, now, time.Second)
	if _, ok := m["old"]; ok {
		t.Fatal("만료 항목이 남았다")
	}
	if len(m) != 2 {
		t.Fatalf("살아 있는 항목까지 거뒀다: %v", m)
	}
	// 만료가 없으면 가장 오래된 것 하나만 거둔다.
	pruneCache(m, 2, now, time.Second)
	if _, ok := m["fresh"]; ok || len(m) != 1 {
		t.Fatalf("가장 오래된 것이 남았다: %v", m)
	}
}

// RepoRoot 에 single-flight 가 있다 — 같은 cwd 의 동시 미스는 rev-parse 를 한 번만
// 돌린다.
func TestStore_RepoRootSingleFlight(t *testing.T) {
	g := newFakeGit(t)
	release := make(chan struct{})
	entered := make(chan struct{}, 16)
	svc := core.New(core.WithRunner(func(ctx context.Context, dir string, args []string) (core.Output, error) {
		if len(args) > 1 && args[1] == "--show-toplevel" {
			entered <- struct{}{}
			<-release
		}
		return g.runner(ctx, dir, args)
	}))
	st := NewStore(svc, fixedClock(time.Now()))
	ctx := context.Background()

	const n = 8
	var wg sync.WaitGroup
	roots := make([]string, n)
	errs := make([]error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			roots[i], errs[i] = st.RepoRoot(ctx, absR)
		}(i)
	}
	<-entered
	// 나머지가 모두 합류할 때까지 기다린다 — 합류하지 못한 호출자는 entered 에
	// 또 들어온다.
	for st.rootJoined(absR) != n-1 {
		select {
		case <-entered:
			t.Fatal("합류하지 않고 rev-parse 를 또 돌렸다")
		default:
			runtime.Gosched()
		}
	}
	close(release)
	wg.Wait()
	for i := 0; i < n; i++ {
		if errs[i] != nil || roots[i] != absR {
			t.Fatalf("[%d] = %q, %v", i, roots[i], errs[i])
		}
	}
	if got := g.count("rev-parse --show-toplevel"); got != 1 {
		t.Fatalf("rev-parse %d 회, want 1", got)
	}
}

func (st *Store) rootJoined(cwd string) int {
	st.mu.Lock()
	defer st.mu.Unlock()
	if f := st.rootFlights[cwd]; f != nil {
		return f.joined
	}
	return -1
}

// ForgetRoot 가 진행 중인 해석을 떼어 내면 그 결과는 캐시에 담기지 않는다 — 그 사이의
// `git init` 이 참으로 바꾼 답을 낡은 실패가 2초 동안 덮지 않는다 (FR-RTU-28).
func TestStore_ForgetRootDetachesFlight(t *testing.T) {
	g := newFakeGit(t)
	release := make(chan struct{})
	entered := make(chan struct{}, 4)
	svc := core.New(core.WithRunner(func(ctx context.Context, dir string, args []string) (core.Output, error) {
		if len(args) > 1 && args[1] == "--show-toplevel" {
			entered <- struct{}{}
			<-release
		}
		return g.runner(ctx, dir, args)
	}))
	st := NewStore(svc, fixedClock(time.Now()))
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _ = st.RepoRoot(context.Background(), absR)
	}()
	<-entered
	st.ForgetRoot(absR)
	close(release)
	<-done
	st.mu.Lock()
	_, cached := st.roots[absR]
	st.mu.Unlock()
	if cached {
		t.Fatal("떼어 낸 flight 의 결과가 캐시에 담겼다")
	}
}
