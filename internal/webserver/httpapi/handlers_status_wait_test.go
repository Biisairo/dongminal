package httpapi

import (
	"dongminal/internal/shared/toolhub"

	"net/http"
	"sync/atomic"
	"testing"
	"time"
)

// OPTIMIZE_REFACTOR_SRS FR-OPT-16-3 (HTTP-31) — 활동 대기는 상태 변화 알림과 마감
// 시각에만 재평가한다. 재평가 수는 도구 조회(Get) 수로 센다 — 재평가 하나가 활동과
// 마지막 출력을 한 번씩 읽는다 (직접 모드).

// countingHub 는 Get 을 센다.
type countingHub struct {
	toolhub.ToolHub
	gets atomic.Int64
}

func (h *countingHub) Get(id string) *toolhub.Tool {
	h.gets.Add(1)
	return h.ToolHub.Get(id)
}

func (h *countingHub) evaluations() int64 { return h.gets.Load() / 2 }

func countingStatusServer(t *testing.T) (*Server, *countingHub, *toolhub.Tool) {
	t.Helper()
	s, m, p := statusServer(t)
	h := &countingHub{ToolHub: m}
	s.Tools = h
	return s, h, p
}

// 알림이 없는 1.5 s 대기는 첫 평가 · 1 s 의 liveness 재확인 · 마감의 마지막 평가만 한다
// (종전 100 ms 틱은 ≈ 16 번).
func TestApiToolStatusWait_EvaluatesOnlyAtDeadlines(t *testing.T) {
	s, h, p := countingStatusServer(t)
	p.SetActivity("working", "", "")
	h.gets.Store(0)

	code, out := getWait(t, s, "id=p1&for=ready&timeoutMs=1500")
	if code != http.StatusOK || out["status"] != "timeout" {
		t.Fatalf("want timeout, got code=%d out=%+v", code, out)
	}
	if got := h.evaluations(); got > 4 {
		t.Fatalf("알림 없는 1.5 s 대기가 %d 번 재평가했다 (≤ 4)", got)
	}
}

// 활동 보고(reportActivity) 는 대기를 곧바로 깨운다 — liveness 주기(1 s)를 기다리지 않는다.
func TestApiToolStatusWait_ActivityReportWakesWait(t *testing.T) {
	s, h, p := countingStatusServer(t)
	p.SetActivity("working", "", "")
	h.gets.Store(0)

	go func() {
		time.Sleep(150 * time.Millisecond)
		s.reportActivity("p1", "idle", "", "", false, false)
	}()
	start := time.Now()
	code, out := getWait(t, s, "id=p1&for=ready&timeoutMs=5000")
	if code != http.StatusOK || out["status"] != "ready" || out["reason"] != "hook" {
		t.Fatalf("want ready by hook, got code=%d out=%+v", code, out)
	}
	if el := time.Since(start); el > 700*time.Millisecond {
		t.Fatalf("활동 보고 뒤에도 %v 기다렸다", el)
	}
	// 첫 평가 + 알림 한 번(보고의 Get 은 따로 센다 — reportActivity 가 도구를 한 번 찾는다).
	if got := h.gets.Load(); got > 5 {
		t.Fatalf("Get = %d (첫 평가 2 + 보고 1 + 알림 평가 2 ≤ 5)", got)
	}
}

// 정적 폴백은 "마지막 출력 + 3 s" 시각에 한 번 깨어 판정한다.
func TestApiToolStatusWait_QuiescenceWakesAtQuietDeadline(t *testing.T) {
	s, h, p := countingStatusServer(t)
	p.LastOutputAt.Store(time.Now().Add(-2600 * time.Millisecond).UnixNano())
	h.gets.Store(0)

	start := time.Now()
	code, out := getWait(t, s, "id=p1&for=ready&timeoutMs=5000")
	if code != http.StatusOK || out["status"] != "ready" || out["reason"] != "quiescence" {
		t.Fatalf("want ready by quiescence, got code=%d out=%+v", code, out)
	}
	if el := time.Since(start); el < 300*time.Millisecond || el > 900*time.Millisecond {
		t.Fatalf("정적 마감(≈ 400 ms)이 아닌 %v 에 풀렸다", el)
	}
	if q, _ := out["quietMs"].(float64); q < readyQuietMS {
		t.Fatalf("quietMs = %v < %d", q, readyQuietMS)
	}
	if got := h.evaluations(); got > 2 {
		t.Fatalf("정적 마감까지 %d 번 재평가했다 (≤ 2)", got)
	}
}
