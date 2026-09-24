package store

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"dongminal/internal/webserver/domain/git/core"
)

// REPO_FIX 01 §4 — single-flight 의 수명과 세대.

// seqGit 은 status 호출마다 게이트를 하나씩 준다. i 번째 호출은 gates[i] 가 닫힐
// 때까지 멈췄다가 outs[i] 를 돌려준다. 옛 flight 와 새 flight 의 결과를 구분해야
// 세대 규칙을 볼 수 있다.
type seqGit struct {
	*fakeGit
	mu      sync.Mutex
	n       int
	gates   []chan struct{}
	outs    []string
	entered chan int
}

func newSeqGit(t *testing.T, outs ...string) *seqGit {
	g := &seqGit{fakeGit: newFakeGit(t), outs: outs, entered: make(chan int, len(outs))}
	for range outs {
		g.gates = append(g.gates, make(chan struct{}))
	}
	return g
}

func (g *seqGit) runner(ctx context.Context, dir string, args []string) (core.Output, error) {
	if args[0] != "status" {
		return g.fakeGit.runner(ctx, dir, args)
	}
	g.mu.Lock()
	i := g.n
	g.n++
	g.mu.Unlock()
	g.entered <- i
	<-g.gates[i]
	return core.Output{Stdout: g.outs[i]}, nil
}

func (g *seqGit) waitEntered(t *testing.T, want int) {
	t.Helper()
	select {
	case got := <-g.entered:
		if got != want {
			t.Fatalf("status 호출 순번 %d, want %d", got, want)
		}
	case <-time.After(3 * time.Second):
		t.Fatalf("status 호출 %d 이 시작되지 않았다", want)
	}
}

func statusWith(file string) string { return nulRecords(hdrOid, hdrHead, "? "+file) }

func untracked(obs Observation) string {
	var names []string
	for _, e := range obs.Status.Untracked {
		names = append(names, e.Path)
	}
	return strings.Join(names, ",")
}

// S-1: 첫 호출자가 떠나도(요청 취소) 합류자는 그 취소를 물려받지 않는다. 종전에는
// flight 가 첫 호출자 ctx 로 돌아 합류자 전원이 context canceled 를 받았다.
func TestStore_FirstCallerCancelDoesNotFailJoiner(t *testing.T) {
	g := newSeqGit(t, statusWith("a.txt"))
	st := NewStore(core.New(core.WithRunner(g.runner)), fixedClock(time.Now()))

	ctxA, cancelA := context.WithCancel(context.Background())
	errA := make(chan error, 1)
	go func() { _, _, err := st.Status(ctxA, absR); errA <- err }()
	g.waitEntered(t, 0)

	type res struct {
		obs Observation
		err error
	}
	resB := make(chan res, 1)
	go func() { obs, _, err := st.Status(context.Background(), absR); resB <- res{obs, err} }()
	time.Sleep(20 * time.Millisecond) // B 가 합류할 틈

	cancelA()
	select {
	case err := <-errA:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("A 는 자기 ctx 로 빠져나가야 한다: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("A 가 자기 ctx 취소로 빠져나가지 않았다")
	}

	close(g.gates[0])
	r := <-resB
	if r.err != nil {
		t.Fatalf("합류자 B 가 첫 호출자의 취소를 물려받았다: %v", r.err)
	}
	if untracked(r.obs) != "a.txt" {
		t.Fatalf("B 관측 %q", untracked(r.obs))
	}
	if g.n != 1 {
		t.Fatalf("status 실행 %d 회, want 1 (합류해야 한다)", g.n)
	}
}

// S-2·S-3: Invalidate 뒤의 조회는 쓰기 전에 출발한 flight 에 합류하지 않고, 그 옛
// flight 의 결과는 fresh 로 저장되지 않는다. 종전에는 쓰기 직후 재조회가 쓰기 전
// 관측을 받고 그것이 200ms 동안 캐시로 이어졌다.
func TestStore_InvalidateDoesNotJoinOrStoreOldFlight(t *testing.T) {
	g := newSeqGit(t, statusWith("old.txt"), statusWith("new.txt"))
	st := NewStore(core.New(core.WithRunner(g.runner)), fixedClock(time.Now()))

	oldDone := make(chan Observation, 1)
	go func() { obs, _, _ := st.Status(context.Background(), absR); oldDone <- obs }()
	g.waitEntered(t, 0)

	st.Invalidate(absR)

	newDone := make(chan Observation, 1)
	go func() { obs, _, _ := st.Status(context.Background(), absR); newDone <- obs }()
	g.waitEntered(t, 1) // 합류하지 않고 새로 실행했다

	close(g.gates[1])
	if got := untracked(<-newDone); got != "new.txt" {
		t.Fatalf("무효화 뒤 조회가 %q 를 받았다", got)
	}
	close(g.gates[0])
	if got := untracked(<-oldDone); got != "old.txt" {
		t.Fatalf("옛 flight 의 합류자는 옛 결과를 받는다: %q", got)
	}

	obs, cached, err := st.Status(context.Background(), absR)
	if err != nil || !cached {
		t.Fatalf("캐시가 있어야 한다: cached=%v err=%v", cached, err)
	}
	if got := untracked(obs); got != "new.txt" {
		t.Fatalf("늦게 끝난 옛 flight 가 캐시를 덮었다: %q", got)
	}
}

// S-2 ABA: 옛 flight 가 도는 동안 그 상태가 축출되고 다시 만들어져도, 새 상태의
// 세대는 전역 카운터에서 새로 받으므로 옛 결과가 fresh 로 저장되지 않는다.
func TestStore_EvictRecreateDoesNotAcceptOldFlight(t *testing.T) {
	g := newSeqGit(t, statusWith("old.txt"), statusWith("mid.txt"), statusWith("other.txt"))
	st := NewStore(core.New(core.WithRunner(g.runner)), fixedClock(time.Now()))
	st.observedCap = 1

	oldDone := make(chan struct{})
	go func() { _, _, _ = st.Status(context.Background(), absR); close(oldDone) }()
	g.waitEntered(t, 0)
	st.Invalidate(absR)

	midDone := make(chan struct{})
	go func() { _, _, _ = st.Status(context.Background(), absR); close(midDone) }()
	g.waitEntered(t, 1)
	close(g.gates[1])
	<-midDone

	// 다른 리포가 들어와 absR 의 상태를 축출한다(진행 중 flight 는 슬롯에 없다).
	other := absR + "-other"
	otherDone := make(chan struct{})
	go func() { _, _, _ = st.Status(context.Background(), other); close(otherDone) }()
	g.waitEntered(t, 2)
	close(g.gates[2])
	<-otherDone

	close(g.gates[0])
	<-oldDone
	if obs, ok := st.Observed(absR); ok && untracked(obs) == "old.txt" {
		t.Fatal("축출 뒤 재생성된 상태에 옛 flight 결과가 저장됐다")
	}
}

// S-4: 결정적 오류만 IsTerminal 이다. 02 의 gitwatch 가 이것으로 감시 제외를 가른다.
func TestIsTerminal(t *testing.T) {
	for _, c := range []struct {
		err  error
		want bool
	}{
		{core.ErrNotRepo, true},
		{core.ErrRepoMissing, true},
		{core.ErrGitMissing, true},
		{core.ErrTimeout, false},
		{core.ErrCanceled, false},
		{errors.New("exit 128"), false},
		{nil, false},
	} {
		if got := core.IsTerminal(c.err); got != c.want {
			t.Errorf("IsTerminal(%v) = %v, want %v", c.err, got, c.want)
		}
	}
}
