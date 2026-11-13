package claudeacct

import "math"

const (
	weekSeconds     = 7 * 86400
	paceMinElapsed  = 86400
	paceAheadMargin = 15.0
)

// Pace 는 주간 창의 사용 속도 예측이다 (FR-CAC-57, cswap `pace.py`).
type Pace struct {
	ExpectedPct           float64 `json:"expectedPct"`
	AheadOfPace           bool    `json:"aheadOfPace"`
	ProjectedExhaustionAt *int64  `json:"projectedExhaustionAt,omitempty"`
	WillLastToReset       bool    `json:"willLastToReset"`
}

// ComputePace 는 주간 창 하나의 예측이다. 지난 시간이 하루 미만이면 nil 이다.
func ComputePace(pct float64, resetsAt, fetchedAt int64) *Pace {
	if resetsAt == 0 {
		return nil
	}
	remaining := ((resetsAt-fetchedAt)%weekSeconds + weekSeconds) % weekSeconds
	elapsed := int64(0)
	if remaining != 0 {
		elapsed = weekSeconds - remaining
	}
	if elapsed < paceMinElapsed {
		return nil
	}
	expected := math.Min(100, float64(elapsed)/weekSeconds*100)
	p := &Pace{ExpectedPct: math.Round(expected*10) / 10, AheadOfPace: pct-expected >= paceAheadMargin}
	if pct <= 0 {
		p.WillLastToReset = true
		return p
	}
	rate := pct / float64(elapsed)
	ex := fetchedAt
	if pct < 100 {
		ex = fetchedAt + int64(math.Round((100-pct)/rate))
	}
	p.ProjectedExhaustionAt = &ex
	p.WillLastToReset = pct+rate*float64(weekSeconds-elapsed) <= 100
	return p
}
