package git

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// 묶음 C — Store (GIT_SRS §3.3 FR-GIT-21·24·63, 검증 V5·V7·V13·V18).

// fakeGit 은 하위 명령별 호출 수를 세는 Runner 다. rev-parse 는 첫 옵션까지 키에
// 넣는다 — toplevel 조회와 gitdir 조회를 구분해야 한다.
type fakeGit struct {
	mu        sync.Mutex
	counts    map[string]int
	gitDir    string
	statusOut string
	// hold 는 status 진입 시 호출된다. single-flight 를 관찰하려면 실행을 붙잡을
	// 지점이 필요하다.
	hold func(repo string)
}

// newFakeGit 은 HEAD 만 있는 gitdir 을 만든다. Store 의 관측이 signature 도 함께
// 채우므로 읽을 HEAD 가 실제로 있어야 한다.
func newFakeGit(t *testing.T) *fakeGit {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "HEAD"), []byte("ref: refs/heads/main\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return &fakeGit{
		counts:    map[string]int{},
		gitDir:    dir,
		statusOut: nulRecords(hdrOid, hdrHead, "? a.txt"),
	}
}

func (g *fakeGit) runner(_ context.Context, dir string, args []string) (Output, error) {
	key := args[0]
	if len(args) > 1 && args[0] == "rev-parse" {
		key += " " + args[1]
	}
	g.mu.Lock()
	g.counts[key]++
	g.mu.Unlock()
	switch key {
	case "rev-parse --show-toplevel":
		return Output{Stdout: dir + "\n"}, nil
	case "rev-parse --absolute-git-dir":
		return Output{Stdout: g.gitDir + "\n" + g.gitDir + "\n"}, nil
	case "status":
		if g.hold != nil {
			g.hold(dir)
		}
		return Output{Stdout: g.statusOut}, nil
	}
	return Output{}, nil
}

func (g *fakeGit) count(key string) int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.counts[key]
}

func fixedClock(at time.Time) StoreOption {
	return WithClock(func() time.Time { return at })
}

// P10 (V5·V13, FR-GIT-21): 같은 리포의 동시 조회는 한 번만 실행한다.
//
// 시계를 고정했으므로 TTL 이 만료되지 않는다 — 늦게 도착한 goroutine 은
// single-flight 에 붙거나 신선한 캐시를 받으므로 실행 횟수가 결정적으로 1 이다.
func TestStore_StatusSingleFlight(t *testing.T) {
	g := newFakeGit(t)
	entered := make(chan struct{}, 1)
	release := make(chan struct{})
	g.hold = func(string) {
		select {
		case entered <- struct{}{}:
		default:
		}
		<-release
	}
	st := NewStore(New(WithRunner(g.runner)), fixedClock(time.Now()))

	const n = 10
	obs := make([]Observation, n)
	errs := make([]error, n)
	ready := make(chan struct{}, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			ready <- struct{}{}
			obs[i], _, errs[i] = st.Status(context.Background(), "/r")
		}(i)
	}
	for i := 0; i < n; i++ {
		<-ready
	}
	<-entered
	close(release)
	wg.Wait()

	for i := range errs {
		if errs[i] != nil {
			t.Fatalf("Status[%d]: %v", i, errs[i])
		}
		if obs[i].Status.Total != 1 || obs[i].ObservedAtUnixMs == 0 {
			t.Fatalf("obs[%d] = %+v", i, obs[i])
		}
	}
	if got := g.count("status"); got != 1 {
		t.Fatalf("status 실행 %d회, want 1", got)
	}
}

// P11 (V5·V13, FR-GIT-63): TTL 안의 두 번째 요청은 cached=true 이고 git 을 부르지
// 않는다. 브라우저 창 수에 실행 횟수가 비례하면 안 된다.
func TestStore_StatusTTLCache(t *testing.T) {
	g := newFakeGit(t)
	st := NewStore(New(WithRunner(g.runner)), fixedClock(time.Now()))
	ctx := context.Background()

	if _, cached, err := st.Status(ctx, "/r"); err != nil || cached {
		t.Fatalf("첫 조회 cached=%v err=%v", cached, err)
	}
	if _, cached, err := st.Status(ctx, "/r"); err != nil || !cached {
		t.Fatalf("두 번째 조회 cached=%v err=%v", cached, err)
	}
	if got := g.count("status"); got != 1 {
		t.Fatalf("status 실행 %d회, want 1", got)
	}
}

// P12 (V18, FR-GIT-23): TTL 0 이면 캐시가 없다. 매번 실행한다.
func TestStore_StatusTTLZero(t *testing.T) {
	g := newFakeGit(t)
	st := NewStore(New(WithRunner(g.runner)), WithStatusTTL(0), fixedClock(time.Now()))
	ctx := context.Background()
	for i := 0; i < 3; i++ {
		if _, cached, err := st.Status(ctx, "/r"); err != nil || cached {
			t.Fatalf("%d번째 cached=%v err=%v", i, cached, err)
		}
	}
	if got := g.count("status"); got != 3 {
		t.Fatalf("status 실행 %d회, want 3", got)
	}
}

// P13 (V7·V24, FR-GIT-24): Observed 는 만료 여부와 무관하게 준다. 활성이 아닌
// 리포의 배지가 이 값을 딛는다.
func TestStore_ObservedIgnoresTTL(t *testing.T) {
	g := newFakeGit(t)
	base := time.Now()
	clk := base
	st := NewStore(New(WithRunner(g.runner)), WithClock(func() time.Time { return clk }))
	if _, _, err := st.Status(context.Background(), "/r"); err != nil {
		t.Fatalf("Status: %v", err)
	}
	clk = base.Add(time.Hour)

	obs, ok := st.Observed("/r")
	if !ok {
		t.Fatal("만료된 관측값을 주지 않았다")
	}
	if obs.Status.Total != 1 || obs.ObservedAtUnixMs != base.UnixMilli() {
		t.Fatalf("obs = %+v", obs)
	}
	if _, ok := st.Observed("/none"); ok {
		t.Fatal("관측 이력이 없는 리포가 true 다")
	}
	if got := g.count("status"); got != 1 {
		t.Fatalf("Observed 가 git 을 실행했다: %d회", got)
	}
}

// P14 (V7): single-flight 는 리포별이다. 서로 다른 리포의 조회는 서로를 막지
// 않는다.
func TestStore_SingleFlightIsPerRepo(t *testing.T) {
	g := newFakeGit(t)
	release := make(chan struct{})
	entered := make(chan struct{}, 1)
	g.hold = func(repo string) {
		if repo != "/slow" {
			return
		}
		select {
		case entered <- struct{}{}:
		default:
		}
		<-release
	}
	st := NewStore(New(WithRunner(g.runner)), fixedClock(time.Now()))

	done := make(chan error, 1)
	go func() {
		_, _, err := st.Status(context.Background(), "/slow")
		done <- err
	}()
	<-entered

	// /slow 가 실행 중인 동안 /fast 가 완료돼야 한다.
	if _, _, err := st.Status(context.Background(), "/fast"); err != nil {
		t.Fatalf("/fast Status: %v", err)
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatalf("/slow Status: %v", err)
	}
	if got := g.count("status"); got != 2 {
		t.Fatalf("status 실행 %d회, want 2", got)
	}
}

// P15: Observed 는 상한까지만 들고 있는다. 무한히 자라지 않는다.
func TestStore_ObservedLRUCap(t *testing.T) {
	g := newFakeGit(t)
	st := NewStore(New(WithRunner(g.runner)), WithStatusTTL(0), fixedClock(time.Now()))
	ctx := context.Background()

	repos := make([]string, DefaultObservedCap+1)
	for i := range repos {
		repos[i] = fmt.Sprintf("/r%d", i)
		if _, _, err := st.Status(ctx, repos[i]); err != nil {
			t.Fatalf("Status(%s): %v", repos[i], err)
		}
	}
	if _, ok := st.Observed(repos[0]); ok {
		t.Fatalf("가장 오래된 %s 가 밀려나지 않았다", repos[0])
	}
	for _, r := range repos[1:] {
		if _, ok := st.Observed(r); !ok {
			t.Fatalf("%s 가 없다", r)
		}
	}
}

// P16 (V3): RepoRoot 는 TTL 캐시를 거친다. 핀 목록이 길어도 rev-parse 가 항목
// 수만큼 반복되지 않아야 한다.
func TestStore_RepoRootTTLCache(t *testing.T) {
	g := newFakeGit(t)
	base := time.Now()
	clk := base
	st := NewStore(New(WithRunner(g.runner)), WithClock(func() time.Time { return clk }))
	ctx := context.Background()

	root, err := st.RepoRoot(ctx, "/r")
	if err != nil || root != "/r" {
		t.Fatalf("RepoRoot = %q, %v", root, err)
	}
	if _, err := st.RepoRoot(ctx, "/r"); err != nil {
		t.Fatalf("RepoRoot: %v", err)
	}
	if got := g.count("rev-parse --show-toplevel"); got != 1 {
		t.Fatalf("rev-parse 실행 %d회, want 1", got)
	}

	clk = base.Add(DefaultRepoRootTTL + time.Second)
	if _, err := st.RepoRoot(ctx, "/r"); err != nil {
		t.Fatalf("RepoRoot: %v", err)
	}
	if got := g.count("rev-parse --show-toplevel"); got != 2 {
		t.Fatalf("TTL 만료 후 실행 %d회, want 2", got)
	}
}

// Store.Signature 는 gitdir 해석을 캐시해 두 번째 호출에서 git 을 부르지 않는다 —
// signature 는 read 1회 + stat 2회여야 한다 (§2.6).
func TestStore_SignatureCachesGitDirs(t *testing.T) {
	g := newFakeGit(t)
	st := NewStore(New(WithRunner(g.runner)), fixedClock(time.Now()))
	ctx := context.Background()
	for i := 0; i < 3; i++ {
		sig, err := st.Signature(ctx, "/r")
		if err != nil {
			t.Fatalf("Signature: %v", err)
		}
		if sig.RefName != "refs/heads/main" {
			t.Fatalf("sig = %+v", sig)
		}
	}
	if got := g.count("rev-parse --absolute-git-dir"); got != 1 {
		t.Fatalf("gitdir 해석 %d회, want 1", got)
	}
}

func TestStore_Service(t *testing.T) {
	svc := New()
	if NewStore(svc).Service() != svc {
		t.Fatal("Service 가 주입한 것을 주지 않는다")
	}
}
