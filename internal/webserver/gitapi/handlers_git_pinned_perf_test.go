package gitapi

import (
	"context"
	"encoding/json"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"dongminal/internal/shared/testpath"
	"dongminal/internal/webserver/domain/git/core"
	"dongminal/internal/webserver/domain/git/store"
)

// PERFORMANCE_HARDENING_SRS FR-PRF-55~57 · TC-PRF-18 (`AUDIT-go-http.md` P-3).
//
// **재는 것은 벽시계가 아니라 겹침이다** (FR-PRF-3). "핀 10개에 250ms → 75ms" 는
// 이 기계의 `rev-parse` 속도이고, 동시에 몇 개가 돌았는가는 어디서 재도 같다.
//
// 바로 위 `gitObservePins` 는 같은 일을 이미 겹쳐서 한다 — 그 수단이 형제 함수에
// 닿지 않았던 것이 이 항목이다.
func TestGitPinnedEntries_RunsInParallel(t *testing.T) {
	t.Setenv(testpath.HomeEnv(), t.TempDir())
	g := newGitFake(t)

	// `RepoRoot` 는 TTL 2초 캐시를 지난다. 시계를 밀 수 있어야 핀을 심는 동안
	// 덥혀진 캐시가 측정을 가리지 않는다.
	var nowNs atomic.Int64
	nowNs.Store(time.Now().UnixNano())
	s, _, ws, _ := gitTestServer(t, g, store.WithClock(func() time.Time {
		return time.Unix(0, nowNs.Load())
	}))

	const pins = 10
	list := make([]string, 0, pins)
	for i := 0; i < pins; i++ {
		list = append(list, absWorkRepo+"-"+strconv.Itoa(i))
	}
	doc, err := json.Marshal(map[string]any{"git": map[string]any{"pinned": list}})
	if err != nil {
		t.Fatal(err)
	}
	ws.raw = doc

	nowNs.Add(int64(time.Minute))

	var cur, peak atomic.Int32
	g.root = func(dir string) (core.Output, error) {
		n := cur.Add(1)
		for {
			m := peak.Load()
			if n <= m || peak.CompareAndSwap(m, n) {
				break
			}
		}
		// 겹칠 **틈**을 준다. 즉시 답하면 순차와 병렬이 구분되지 않는다.
		time.Sleep(20 * time.Millisecond)
		cur.Add(-1)
		return core.Output{Stdout: dir + "\n"}, nil
	}

	out := s.gitPinnedEntries(context.Background())
	if len(out) != pins {
		t.Fatalf("항목 %d개, want %d", len(out), pins)
	}
	// **순서는 사용자가 정한 것이고 계약이다** — 겹치면서도 지켜야 한다.
	for i, e := range out {
		if got := e["path"]; got != list[i] {
			t.Fatalf("%d번째 path=%v, want %v — 순서가 어긋났다", i, got, list[i])
		}
	}
	if p := peak.Load(); p < 2 {
		t.Fatalf("RepoRoot 의 동시 진행 최대 %d — 순차다 (FR-PRF-57)", p)
	}
	if p := peak.Load(); int(p) > gitObserveMax {
		t.Fatalf("동시 진행 최대 %d — 상한 %d 를 넘는다", p, gitObserveMax)
	}
}
