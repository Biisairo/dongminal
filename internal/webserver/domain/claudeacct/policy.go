package claudeacct

import (
	"math"
	"strconv"
	"strings"
)

// 조회 주기 상수 (FR-CAC-53·54, cswap `poll_policy.py`·`usage_store.py`).
const (
	minIntervalS      = 180
	urgentIntervalS   = 60
	activeMaxS        = 300
	candidateDefaultS = 300
	candidateMaxS     = 600
	exhaustedS        = 600
	movementDelta     = 1.0
	jitterFrac        = 0.10
	escalationMargin  = 15.0
	resetSlackS       = 60
	recent429WindowS  = 3600
	post429MinS       = 360
	post429Mult       = 1.5
	post429MaxS       = 1800

	backoffBaseS      = 30
	backoffMaxS       = 600
	backoff429Floor   = 300
	backoffRALongS    = 600
	backoffRAPadS     = 900
	backoffCap429S    = 4500
	backoffCapOtherS  = 3600
	fetchNowMinGapS   = 60
	defaultLinePct    = 90.0
	freshForDecisionS = 300
)

type planInput struct {
	now          int64
	prevInterval int64
	prev, next   *Usage
	active       bool
	line         float64
	last429      int64
}

func moved(prev, next *Usage) bool {
	a, b := prev.windows(nil), next.windows(nil)
	if len(a) != len(b) {
		return true
	}
	for i := range a {
		if math.Abs(a[i].Pct-b[i].Pct) >= movementDelta {
			return true
		}
	}
	return false
}

// planInterval 은 성공한 조회 뒤의 간격(초)이다. jitter 는 [-1, 1] 이다.
func planInterval(in planInput, jitter float64) int64 {
	ceiling := int64(candidateMaxS)
	if in.active {
		ceiling = activeMaxS
	}
	var iv int64
	switch {
	case in.prev == nil || in.next == nil:
		iv = candidateDefaultS
		if in.active {
			iv = minIntervalS
		}
	case moved(in.prev, in.next):
		iv = max(minIntervalS, in.prevInterval/2)
		if in.active {
			for _, w := range in.next.windows(nil) {
				if w.Pct >= in.line-escalationMargin {
					iv = urgentIntervalS
					break
				}
			}
		}
	default:
		iv = min(ceiling, max(minIntervalS, int64(float64(in.prevInterval)*1.5)))
	}
	if in.last429 > 0 && in.now-in.last429 < recent429WindowS {
		iv = min(post429MaxS, max(iv, max(int64(float64(in.prevInterval)*post429Mult), post429MinS)))
	}
	if in.next != nil && in.next.Headroom(nil) <= 0 {
		iv = max(iv, exhaustedS)
	}
	return int64(math.Round(float64(iv) * (1 + jitterFrac*jitter)))
}

// planNext 는 다음 조회 시각이다. 가장 가까운 창 초기화 + 60초를 넘지 않는다.
func planNext(in planInput, jitter float64) int64 {
	next := in.now + planInterval(in, jitter)
	if in.next != nil {
		for _, w := range in.next.windows(nil) {
			if w.ResetsAt > in.now && w.ResetsAt+resetSlackS < next {
				next = w.ResetsAt + resetSlackS
			}
		}
	}
	return next
}

// backoffSeconds 는 연속 실패 fails 번째 뒤 기다릴 시간이다 (FR-CAC-54).
func backoffSeconds(fails, status int, retryAfter string) int64 {
	computed := int64(backoffMaxS)
	if fails <= 5 {
		computed = min(int64(backoffBaseS)<<(fails-1), backoffMaxS)
	}
	if status != 429 {
		return computed
	}
	ra, err := strconv.ParseInt(strings.TrimSpace(retryAfter), 10, 64)
	if err != nil || ra < 0 {
		return computed
	}
	if ra == 0 {
		return min(max(computed, backoff429Floor), backoffMaxS)
	}
	asked := ra
	if ra > backoffRALongS {
		asked = ra + backoffRAPadS
	}
	return max(min(asked, backoffCap429S), computed)
}
