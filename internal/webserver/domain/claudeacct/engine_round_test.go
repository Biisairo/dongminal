package claudeacct

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// REFACTOR3_GO_STRUCT_SRS FR-RGS-20 — 회차 하나의 디스크·프로세스 비용을 센다 (INV-S4).
//
//	GD-9  usage.json 쓰기: 이전 = 조회한 계정 수(행마다 전 행 직렬화+원자적 쓰기), 새 = 1
//	GD-23 accounts.json 읽기: 이전 = 엔진 2·자동 전환 2, 새 = 1·1
//	GD-10 계정 사이 기다림: 이전 = 종료 신호를 보지 않고 (n-1)×stagger, 새 = 곧바로 돌아온다
//	GD-8  ps fork: 이전 = 켜진 회차마다 1, 새 = cswapProbeTTL 안에서 1

// countUsageWrites 는 usage.json 쓰기 수를 센다.
func countUsageWrites(t *testing.T) *int {
	t.Helper()
	n, orig := 0, writeUsageFile
	writeUsageFile = func(p string, b []byte, m os.FileMode) error {
		n++
		return orig(p, b, m)
	}
	t.Cleanup(func() { writeUsageFile = orig })
	return &n
}

// countAccountReads 는 accounts.json 읽기 수를 센다.
func countAccountReads(t *testing.T) *int {
	t.Helper()
	n, orig := 0, readStoreFile
	readStoreFile = func(p string) ([]byte, error) {
		if filepath.Base(p) == accountsFile {
			n++
		}
		return orig(p)
	}
	t.Cleanup(func() { readStoreFile = orig })
	return &n
}

// dueAll 은 세 계정 모두 조회 기한이 지나게 시계를 민다.
func dueAll(clock *time.Time) { *clock = clock.Add(24 * time.Hour) }

func TestEngineTick_WritesUsageOncePerRound(t *testing.T) {
	_, eng, api, clock := threeAccounts(t)
	dueAll(clock)
	writes := countUsageWrites(t)
	before := len(api.calls)
	eng.Tick(context.Background())
	if fetched := len(api.calls) - before; fetched != 3 {
		t.Fatalf("조회 %d회, want 3", fetched)
	}
	if *writes != 1 {
		t.Fatalf("usage.json 쓰기 %d회 (조회 3), want 1 (GD-9)", *writes)
	}
	// 쓴 것은 회차 끝의 행 전부다 — 다시 읽어도 같다.
	again := &Engine{Svc: eng.Svc, Now: eng.Now}
	if err := again.Load(); err != nil {
		t.Fatal(err)
	}
	for id, r := range eng.Rows() {
		if got := again.Rows()[id]; got.FetchedAt != r.FetchedAt || got.NextPollAt != r.NextPollAt {
			t.Fatalf("%s: 디스크 %+v, 메모리 %+v", id, got, r)
		}
	}
}

func TestEngineTick_ReadsAccountsOnce(t *testing.T) {
	_, eng, _, _ := threeAccounts(t)
	reads := countAccountReads(t)
	eng.Tick(context.Background())
	if *reads != 1 {
		t.Fatalf("엔진 회차의 accounts.json 읽기 %d회, want 1 (GD-23)", *reads)
	}
}

func TestAutoTick_ReadsAccountsOnce(t *testing.T) {
	x := newAutoEnv(t)
	reads := countAccountReads(t)
	x.tick()
	if *reads != 1 {
		t.Fatalf("자동 전환 회차(꺼짐)의 accounts.json 읽기 %d회, want 1 (GD-23)", *reads)
	}
}

func TestEngineTick_StaggerHonorsCancel(t *testing.T) {
	_, eng, api, clock := threeAccounts(t)
	eng.Stagger = 300 * time.Millisecond
	dueAll(clock)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	before := len(api.calls)
	start := time.Now()
	eng.Tick(ctx)
	if d := time.Since(start); d >= eng.Stagger {
		t.Fatalf("끊긴 회차가 %v 뒤에 돌아왔다 (GD-10, 이전 2×stagger)", d)
	}
	if n := len(api.calls) - before; n != 1 {
		t.Fatalf("끊긴 뒤에도 조회했다: %d회, want 1", n)
	}
}

func TestAutoTick_CachesCswapProbe(t *testing.T) {
	x := newAutoEnv(t)
	probes := 0
	x.auto.Procs = func() ([]string, error) { probes++; return nil, nil }
	x.put(t, `{"enabled":true}`)
	for i := 0; i < 5; i++ {
		x.tick()
		*x.clock = x.clock.Add(cswapProbeTTL / 10)
	}
	// 켜기 1 + 첫 회차 1. 나머지 넷은 기억을 쓴다.
	if probes != 2 {
		t.Fatalf("켜기 + 켜진 회차 5번의 ps %d회, want 2 (GD-8, 이전 6)", probes)
	}
	*x.clock = x.clock.Add(cswapProbeTTL)
	x.tick()
	if probes != 3 {
		t.Fatalf("TTL 뒤 ps %d회, want 3", probes)
	}
}

// 켜는 요청은 캐시를 보지 않는다 — 방금 띄운 cswap 을 놓치면 둘이 함께 돈다 (FR-CAC-75).
func TestAutoPut_ProbesFresh(t *testing.T) {
	x := newAutoEnv(t)
	x.put(t, `{"enabled":true}`)
	x.tick()
	x.put(t, `{"enabled":false}`)
	x.procs = []string{"/usr/bin/cswap auto"}
	if _, err := x.auto.Put([]byte(`{"enabled":true}`)); err != ErrCswapRunning {
		t.Fatalf("Put = %v, want ErrCswapRunning", err)
	}
}
