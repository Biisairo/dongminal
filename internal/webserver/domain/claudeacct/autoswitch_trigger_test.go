package claudeacct

import "testing"

// REFACTOR3_GO_STRUCT_SRS FR-RGS-22 (GD-18): decide 의 트리거 결정은 순수 함수다.
// 표가 FR-CAC-72 의 계기 규칙 그대로다.
func TestAutoTrigger(t *testing.T) {
	over := acctView{known: true, h: 5, hasB: true, b: binding{Over: true}}
	atLimit := acctView{known: true, h: 0, hasB: true, b: binding{Over: true}}
	under := acctView{known: true, h: 40, hasB: true}
	unknown := acctView{}
	best := AutoSettings{Strategy: AutoStrategyBest, UnhealthyTicks: 3}
	consume := AutoSettings{Strategy: AutoStrategyConsumeFirst, UnhealthyTicks: 3}
	prio := AutoSettings{Strategy: AutoStrategyPriorityConsumeFirst, UnhealthyTicks: 3}
	for _, c := range []struct {
		name      string
		active    acctView
		s         AutoSettings
		unhealthy int
		want      string
	}{
		{"소진", atLimit, best, 0, TriggerAtLimit},
		{"라인 넘음", over, best, 0, TriggerProactive},
		{"라인 넘음이 전략보다 앞선다", over, consume, 0, TriggerProactive},
		{"best 는 라인 아래면 그대로", under, best, 0, ""},
		{"consume-first", under, consume, 0, TriggerConsumeFirst},
		{"priority-consume-first", under, prio, 0, TriggerPriority},
		{"모름 — 문턱 전", unknown, best, 2, ""},
		{"모름 — 문턱", unknown, best, 3, TriggerFailover},
	} {
		if got := autoTrigger(c.active, c.s, c.unhealthy); got != c.want {
			t.Errorf("%s: %q, want %q", c.name, got, c.want)
		}
	}
}

// 쿨다운은 at-limit·failover 를 막지 않는다. 마지막 전환이 없으면 막지 않는다.
func TestAutoInCooldown(t *testing.T) {
	last := &LastSwitch{At: 1000}
	for _, c := range []struct {
		name    string
		trigger string
		last    *LastSwitch
		now     int64
		want    bool
	}{
		{"쿨다운 안", TriggerProactive, last, 1100, true},
		{"쿨다운 끝", TriggerProactive, last, 1300, false},
		{"at-limit 는 쿨다운을 보지 않는다", TriggerAtLimit, last, 1100, false},
		{"failover 는 쿨다운을 보지 않는다", TriggerFailover, last, 1100, false},
		{"전환 기록 없음", TriggerConsumeFirst, nil, 1100, false},
	} {
		if got := inCooldown(c.trigger, c.last, c.now, 300); got != c.want {
			t.Errorf("%s: %v, want %v", c.name, got, c.want)
		}
	}
}
