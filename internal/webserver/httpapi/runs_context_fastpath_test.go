package httpapi

import (
	"sync/atomic"
	"testing"

	"dongminal/internal/webserver/domain/run"
)

// countingWhoAmI 는 PID 사슬 해석 횟수를 센다. darwin 에서 그것은 lsof·ps fork 다.
type countingWhoAmI struct {
	toolID string
	n      atomic.Int64
}

func (c *countingWhoAmI) ResolveClientPane(string) (string, int, error) {
	c.n.Add(1)
	return c.toolID, 0, nil
}

// OPTIMIZE_REFACTOR_SRS FR-OPT-8-3 (HTTP-3) — 열린 Run 이 없으면 컨텍스트 훅은 PID 해석
// 없이 observed:false 다. 이 훅은 Run 과 무관한 claude 전부에서 돈다.
func TestRunContext_NoOpenRunSkipsCallerResolution(t *testing.T) {
	s, _, store, _ := runsServer(t, "tool-a")
	who := &countingWhoAmI{toolID: "tool-a"}
	s.WhoAmI = who

	code, out := postRun(t, s, "/api/runs/context", `{"toolId":"tool-a","bytes":100}`)
	if code != 200 || out["observed"] != false {
		t.Fatalf("code=%d out=%v", code, out)
	}
	if got := who.n.Load(); got != 0 {
		t.Fatalf("열린 Run 이 없는데 PID 해석 %d 회", got)
	}

	// 열린 Run 이 생기면 스푸핑 방지 규약(PID 해석 우선)이 그대로 선다.
	rec, err := store.Start(run.StartOptions{Objective: "x", Projection: run.DedicatedWindow,
		Isolation: run.IsolationPerMember, CoordinatorToolID: "tool-a"})
	if err != nil {
		t.Fatal(err)
	}
	code, out = postRun(t, s, "/api/runs/context", `{"toolId":"tool-b","bytes":100}`)
	if code != 200 || out["observed"] != true || out["coordinator"] != true {
		t.Fatalf("조정자 관측이 서지 않았다: code=%d out=%v", code, out)
	}
	if got := who.n.Load(); got != 1 {
		t.Fatalf("열린 Run 이 있으면 PID 해석 1회여야 한다: %d", got)
	}

	// 닫으면 다시 빠른 경로다.
	if _, _, err := store.Close(rec.ID, true); err != nil {
		t.Fatal(err)
	}
	postRun(t, s, "/api/runs/context", `{"toolId":"tool-a","bytes":100}`)
	if got := who.n.Load(); got != 1 {
		t.Fatalf("닫힌 Run 만 남았는데 PID 해석을 했다: %d", got)
	}
}
