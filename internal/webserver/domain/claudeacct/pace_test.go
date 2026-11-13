package claudeacct

import (
	"math"
	"testing"
)

// TC-CAC-13: cswap pace.py 와 같은 입력에 같은 출력.

func TestPaceSuppressedFirstDay(t *testing.T) {
	fetched := int64(1_000_000)
	// 초기화까지 6.5일 남음 → 지난 시간 0.5일 → 예측 없음.
	if p := ComputePace(30, fetched+int64(6.5*86400), fetched); p != nil {
		t.Fatalf("%+v", p)
	}
}

func TestPaceNumbers(t *testing.T) {
	fetched := int64(1_000_000)
	reset := fetched + 4*86400 // 3일 지남
	p := ComputePace(60, reset, fetched)
	if p == nil {
		t.Fatal("want pace")
	}
	if p.ExpectedPct != 42.9 {
		t.Fatalf("expected %v", p.ExpectedPct)
	}
	if !p.AheadOfPace {
		t.Fatal("60 - 42.9 >= 15")
	}
	elapsed := 3.0 * 86400
	rate := 60 / elapsed
	wantExhaust := fetched + int64(math.Round(40/rate))
	if p.ProjectedExhaustionAt == nil || math.Abs(float64(*p.ProjectedExhaustionAt-wantExhaust)) > 1 {
		t.Fatalf("exhaust %v want %v", p.ProjectedExhaustionAt, wantExhaust)
	}
	if p.WillLastToReset {
		t.Fatal("60% in 3 days runs out before day 7")
	}
}

func TestPaceSlowAndFull(t *testing.T) {
	fetched := int64(1_000_000)
	p := ComputePace(20, fetched+4*86400, fetched)
	if p.AheadOfPace || !p.WillLastToReset {
		t.Fatalf("%+v", p)
	}
	p = ComputePace(100, fetched+4*86400, fetched)
	if p.ProjectedExhaustionAt == nil || *p.ProjectedExhaustionAt != fetched {
		t.Fatalf("full → now: %+v", p)
	}
	p = ComputePace(0, fetched+4*86400, fetched)
	if p.ProjectedExhaustionAt != nil || !p.WillLastToReset {
		t.Fatalf("zero: %+v", p)
	}
}

func TestPaceRemainingModuloAndZero(t *testing.T) {
	fetched := int64(1_000_000)
	// resets_at 이 한 주기보다 멀면 나머지로 접는다.
	a := ComputePace(50, fetched+weekSeconds+4*86400, fetched)
	b := ComputePace(50, fetched+4*86400, fetched)
	if a == nil || b == nil || a.ExpectedPct != b.ExpectedPct {
		t.Fatalf("%+v %+v", a, b)
	}
	if ComputePace(50, fetched, fetched) != nil {
		t.Fatal("remaining 0 → elapsed 0 → suppressed")
	}
}
