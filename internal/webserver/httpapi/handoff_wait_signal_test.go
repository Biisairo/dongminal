package httpapi

import (
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"dongminal/internal/shared/testpath"
)

// countingRuns 는 HandoffWaiting 물음을 센다.
type countingRuns struct {
	RunStore
	asks atomic.Int64
}

func (c *countingRuns) HandoffWaiting(memberID string) bool {
	c.asks.Add(1)
	return c.RunStore.HandoffWaiting(memberID)
}

// OPTIMIZE_REFACTOR_SRS FR-OPT-8-4 (HTTP-31) — 프리앰블의 인수인계 대기는 Run 저장소가
// 바뀔 때만 다시 묻는다. 종전에는 250 ms 마다 물었다.
func TestPreamble_HandoffWaitAsksOnChangeOnly(t *testing.T) {
	f := newHeadlessFixture(t)
	runID := f.startRun(t)
	code, prev := postRun(t, f.s, "/api/runs/members",
		`{"runId":`+testpath.JSONQuote(runID)+`,"role":"작가","agent":"claude","id":"tab-a"}`)
	if code != http.StatusOK {
		t.Fatalf("멤버 등록 %d %+v", code, prev)
	}
	prevID, _ := prev["id"].(string)
	_, out := postRun(t, f.s, "/api/runs/succeed",
		`{"memberId":`+testpath.JSONQuote(prevID)+`,"headless":true,"timeoutMs":1}`)
	next, _ := out["member"].(map[string]any)
	nextID, _ := next["memberId"].(string)
	if nextID == "" {
		nextID, _ = next["id"].(string)
	}
	if nextID == "" {
		t.Fatalf("후임 uuid 가 없다: %+v", out)
	}

	cr := &countingRuns{RunStore: f.s.Runs}
	f.s.Runs = cr
	go func() {
		time.Sleep(time.Second)
		postRun(t, f.s, "/api/runs/handoff", `{"toolId":"tool-a","summary":"늦은 요약"}`)
	}()
	_, got := getRun(t, f.s, "/api/runs/preamble?member="+nextID)
	if pre, _ := got["preamble"].(string); !strings.Contains(pre, "늦은 요약") {
		t.Fatalf("요약이 실리지 않았다:\n%s", pre)
	}
	// 대기 전 판정 한 번 + 대기의 첫 물음 + 요약이 도착해 깨어난 한 번. 1초를
	// 250 ms 로 폴링했다면 6번이다.
	if n := cr.asks.Load(); n > 3 {
		t.Fatalf("HandoffWaiting 을 %d 번 물었다 — 바뀌지 않았는데 묻는다", n)
	}
}
