package fswatch

import (
	"errors"
	"sort"
	"sync"
	"syscall"
	"testing"
	"time"
)

type fakeBackend struct {
	mu      sync.Mutex
	watched map[string]int
	adds    int
	failAdd map[string]error
	events  chan RawEvent
	errs    chan error
	closed  bool
}

func newFakeBackend() *fakeBackend {
	return &fakeBackend{watched: map[string]int{}, failAdd: map[string]error{},
		events: make(chan RawEvent, 16), errs: make(chan error, 4)}
}

func (b *fakeBackend) Add(p string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if err := b.failAdd[p]; err != nil {
		return err
	}
	b.watched[p]++
	b.adds++
	return nil
}

func (b *fakeBackend) Remove(p string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.watched, p)
	return nil
}

func (b *fakeBackend) Events() <-chan RawEvent { return b.events }
func (b *fakeBackend) Errors() <-chan error    { return b.errs }
func (b *fakeBackend) Close() error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if !b.closed {
		b.closed = true
		close(b.events)
		close(b.errs)
	}
	return nil
}

func (b *fakeBackend) list() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make([]string, 0, len(b.watched))
	for p := range b.watched {
		out = append(out, p)
	}
	sort.Strings(out)
	return out
}

type mgrFx struct {
	clk      *fakeClock
	mu       sync.Mutex
	backends []*fakeBackend
	emitted  []Change
	overflow int
	m        *Manager
}

func newMgrFx(t *testing.T) *mgrFx {
	fx := &mgrFx{clk: &fakeClock{}}
	fx.m = NewManager(ManagerOptions{
		NewBackend: func() (Backend, error) {
			b := newFakeBackend()
			fx.mu.Lock()
			fx.backends = append(fx.backends, b)
			fx.mu.Unlock()
			return b, nil
		},
		Clock:         fx.clk,
		CaseSensitive: true,
		Watchable:     func(string) bool { return true },
		Exists:        func(string) bool { return true },
		Emit: func(c []Change, overflow bool) {
			fx.mu.Lock()
			defer fx.mu.Unlock()
			fx.emitted = append(fx.emitted, c...)
			if overflow {
				fx.overflow++
			}
		},
	})
	t.Cleanup(fx.m.Close)
	return fx
}

func (fx *mgrFx) backend() *fakeBackend {
	fx.mu.Lock()
	defer fx.mu.Unlock()
	return fx.backends[len(fx.backends)-1]
}

func (fx *mgrFx) backendCount() int {
	fx.mu.Lock()
	defer fx.mu.Unlock()
	return len(fx.backends)
}

func dirs(pairs ...string) []Dir {
	out := make([]Dir, 0, len(pairs)/2)
	for i := 0; i+1 < len(pairs); i += 2 {
		out = append(out, Dir{Path: pairs[i], Real: pairs[i+1]})
	}
	return out
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("조건이 서지 않았다")
}

// V-ELR-24 일부 (FR-ELR-51): SSE 구독이 없는 신원은 등록할 수 없다.
func TestManager_SetRequiresAttach(t *testing.T) {
	fx := newMgrFx(t)
	if _, err := fx.m.Set("c1", dirs("/a", "/a")); !errors.Is(err, ErrNotAttached) {
		t.Fatalf("err=%v, want ErrNotAttached", err)
	}
	if _, err := fx.m.Set("", dirs("/a", "/a")); !errors.Is(err, ErrNotAttached) {
		t.Fatalf("빈 신원 err=%v", err)
	}
}

// V-ELR-23 (FR-ELR-52·53): 참조 수와 SSE 수명.
func TestManager_SharedDirWatchedOnceAndLeaseScoped(t *testing.T) {
	fx := newMgrFx(t)
	e1 := fx.m.Attach("c1")
	e2 := fx.m.Attach("c2")
	if _, err := fx.m.Set("c1", dirs("/a", "/a", "/b", "/b")); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.m.Set("c2", dirs("/a", "/a")); err != nil {
		t.Fatal(err)
	}
	b := fx.backend()
	if got := b.list(); len(got) != 2 || b.adds != 2 {
		t.Fatalf("watched=%v adds=%d, want /a·/b once", got, b.adds)
	}
	fx.m.Detach("c1", e1)
	if got := b.list(); len(got) != 1 || got[0] != "/a" {
		t.Fatalf("c1 이 떠난 뒤 %v, want [/a]", got)
	}
	fx.m.Detach("c2", e2)
	if got := b.list(); len(got) != 0 {
		t.Fatalf("둘 다 떠난 뒤 %v, want none", got)
	}
}

func TestManager_SetReplacesWholeSet(t *testing.T) {
	fx := newMgrFx(t)
	fx.m.Attach("c1")
	_, _ = fx.m.Set("c1", dirs("/a", "/a", "/b", "/b"))
	got, err := fx.m.Set("c1", dirs("/b", "/b", "/c", "/c"))
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(got)
	if len(got) != 2 || got[0] != "/b" || got[1] != "/c" {
		t.Fatalf("watching=%v", got)
	}
	if w := fx.backend().list(); len(w) != 2 || w[0] != "/b" || w[1] != "/c" {
		t.Fatalf("backend=%v", w)
	}
}

func TestManager_StaleDetachIgnored(t *testing.T) {
	fx := newMgrFx(t)
	old := fx.m.Attach("c1")
	fx.m.Attach("c1") // 재연결
	_, _ = fx.m.Set("c1", dirs("/a", "/a"))
	fx.m.Detach("c1", old)
	if w := fx.backend().list(); len(w) != 1 {
		t.Fatalf("옛 구독의 해제가 새 등록을 지웠다: %v", w)
	}
}

// FR-ELR-55: 감시를 걸지 못한 디렉터리는 응답에서 빠진다.
func TestManager_FailedAddExcluded(t *testing.T) {
	fx := newMgrFx(t)
	fx.m.Attach("c1")
	_, _ = fx.m.Set("c1", nil) // 백엔드를 세운다
	fx.backend().failAdd["/bad"] = errors.New("nope")
	got, err := fx.m.Set("c1", dirs("/ok", "/ok", "/bad", "/bad"))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0] != "/ok" {
		t.Fatalf("watching=%v, want [/ok]", got)
	}
}

func TestManager_UnwatchableExcluded(t *testing.T) {
	fx := &mgrFx{clk: &fakeClock{}}
	m := NewManager(ManagerOptions{
		NewBackend: func() (Backend, error) { return newFakeBackend(), nil },
		Clock:      fx.clk, CaseSensitive: true,
		Watchable: func(p string) bool { return p != "/Volumes/x" },
		Exists:    func(string) bool { return true },
		Emit:      func([]Change, bool) {},
	})
	defer m.Close()
	m.Attach("c1")
	got, _ := m.Set("c1", dirs("/Volumes/x", "/Volumes/x", "/ok", "/ok"))
	if len(got) != 1 || got[0] != "/ok" {
		t.Fatalf("watching=%v", got)
	}
}

// V-ELR-25 (FR-ELR-54): 등록한 철자로 되돌린다.
func TestManager_EventsUseRegisteredSpellings(t *testing.T) {
	fx := newMgrFx(t)
	fx.m.Attach("c1")
	fx.m.Attach("c2")
	_, _ = fx.m.Set("c1", dirs("/link/d", "/real/d"))
	_, _ = fx.m.Set("c2", dirs("/real/d", "/real/d"))
	fx.m.handleRaw(RawEvent{"/real/d/x.txt", OpWrite})
	fx.clk.Advance(time.Second)
	fx.mu.Lock()
	defer fx.mu.Unlock()
	got := map[string]Kind{}
	for _, c := range fx.emitted {
		got[c.Path] = c.Kind
	}
	if got["/link/d/x.txt"] != Updated || got["/real/d/x.txt"] != Updated || len(got) != 2 {
		t.Fatalf("emitted=%v", fx.emitted)
	}
}

func TestManager_EventsOutsideWatchedDirsDropped(t *testing.T) {
	fx := newMgrFx(t)
	fx.m.Attach("c1")
	_, _ = fx.m.Set("c1", dirs("/a", "/a"))
	fx.m.handleRaw(RawEvent{"/zzz/x", OpWrite})
	fx.clk.Advance(time.Second)
	fx.mu.Lock()
	defer fx.mu.Unlock()
	if len(fx.emitted) != 0 {
		t.Fatalf("emitted=%v", fx.emitted)
	}
}

func TestManager_WatchedDirItselfDeleted(t *testing.T) {
	fx := &mgrFx{clk: &fakeClock{}}
	var mu sync.Mutex
	var emitted []Change
	m := NewManager(ManagerOptions{
		NewBackend: func() (Backend, error) { return newFakeBackend(), nil },
		Clock:      fx.clk, CaseSensitive: true,
		Watchable: func(string) bool { return true },
		Exists:    func(string) bool { return false },
		Emit:      func(c []Change, _ bool) { mu.Lock(); emitted = append(emitted, c...); mu.Unlock() },
	})
	defer m.Close()
	m.Attach("c1")
	_, _ = m.Set("c1", dirs("/a/sub", "/a/sub"))
	m.handleRaw(RawEvent{"/a/sub", OpRemove})
	fx.clk.Advance(time.Second)
	mu.Lock()
	defer mu.Unlock()
	if len(emitted) != 1 || emitted[0] != (Change{"/a/sub", Deleted}) {
		t.Fatalf("emitted=%v", emitted)
	}
}

// V-ELR-26 (FR-ELR-60): 재시작 규칙.
func TestManager_RestartsOnErrorUpToFive(t *testing.T) {
	fx := newMgrFx(t)
	fx.m.Attach("c1")
	_, _ = fx.m.Set("c1", dirs("/a", "/a"))
	for i := 1; i <= MaxRestarts; i++ {
		fx.backend().errs <- errors.New("boom")
		want := i + 1
		waitFor(t, func() bool { return fx.backendCount() == want })
		if w := fx.backend().list(); len(w) != 1 || w[0] != "/a" {
			t.Fatalf("재시작 뒤 감시 %v, want [/a]", w)
		}
	}
	// 여섯 번째 오류는 다시 세우지 않는다.
	fx.backend().errs <- errors.New("boom")
	time.Sleep(50 * time.Millisecond)
	if n := fx.backendCount(); n != MaxRestarts+1 {
		t.Fatalf("백엔드 %d개, want %d", n, MaxRestarts+1)
	}
}

func TestManager_NoRestartOnEMFILE(t *testing.T) {
	fx := newMgrFx(t)
	fx.m.Attach("c1")
	_, _ = fx.m.Set("c1", dirs("/a", "/a"))
	fx.backend().errs <- syscall.EMFILE
	time.Sleep(80 * time.Millisecond)
	if n := fx.backendCount(); n != 1 {
		t.Fatalf("EMFILE 뒤 백엔드 %d개, want 1", n)
	}
}

func TestManager_EventOverflowErrorSignalsOverflow(t *testing.T) {
	fx := newMgrFx(t)
	fx.m.Attach("c1")
	_, _ = fx.m.Set("c1", dirs("/a", "/a"))
	fx.backend().errs <- ErrBackendOverflow
	waitFor(t, func() bool { fx.mu.Lock(); defer fx.mu.Unlock(); return fx.overflow == 1 })
	if n := fx.backendCount(); n != 1 {
		t.Fatalf("overflow 가 재시작을 불렀다: %d", n)
	}
}
