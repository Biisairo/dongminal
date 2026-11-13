package httpapi

import (
	"cmp"
	"maps"
	"slices"
	"sync"
	"time"

	"dongminal/internal/shared/statusline"
	"dongminal/internal/webserver/domain/claudeacct"
)

// ACTIVITY_STATE_SUBAGENT_SRS 묶음 L — 계정 한도 (FR-ASV-20·21).
//
// statusLine 입력의 `rate_limits` 는 도구가 아니라 **계정**의 값이다. 그래서 도구가
// 죽어도 지우지 않고 에이전트마다 마지막 값 하나를 둔다. 메모리에만 둔다.

const (
	// resetsAtMillisFloor 를 넘는 resetsAt 은 밀리초로 본다 (R-4).
	resetsAtMillisFloor = 1e12
)

// limitWindowOrder 는 앞에 세우는 창 이름이다. 나머지는 사전 순으로 뒤에 선다 (FR-ASV-21).
var limitWindowOrder = []string{"five_hour", "seven_day"}

type limitWindow struct {
	Name        string   `json:"name"`
	UsedPct     *float64 `json:"usedPct,omitempty"`
	ResetsAt    *float64 `json:"resetsAt,omitempty"`
	ResetsInSec *float64 `json:"resetsInSec,omitempty"`
	Level       string   `json:"level"`
}

type limitEntry struct {
	Agent      string        `json:"agent"`
	ObservedAt int64         `json:"observedAt"`
	Windows    []limitWindow `json:"windows"`
}

type limitObs struct {
	windows    map[string]statusline.RateWindow
	observedAt time.Time
}

type rateLimitStore struct {
	mu sync.Mutex
	m  map[string]limitObs
}

// put 은 비어 있지 않은 한도로 그 에이전트의 마지막 값을 덮어쓴다 (FR-ASV-20).
func (st *rateLimitStore) put(agent string, windows map[string]statusline.RateWindow, at time.Time) {
	if len(windows) == 0 {
		return
	}
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.m == nil {
		st.m = map[string]limitObs{}
	}
	st.m[agent] = limitObs{windows: maps.Clone(windows), observedAt: at}
}

// view 는 now 기준의 응답이다. 남은 시간은 서버 시계로 셈한다 (D-ASV-10). 비면 빈 배열이다.
func (st *rateLimitStore) view(now time.Time) []limitEntry {
	st.mu.Lock()
	defer st.mu.Unlock()
	out := []limitEntry{}
	for _, agent := range slices.Sorted(maps.Keys(st.m)) {
		obs := st.m[agent]
		e := limitEntry{Agent: agent, ObservedAt: obs.observedAt.UnixMilli(), Windows: []limitWindow{}}
		for _, name := range limitWindowNames(obs.windows) {
			e.Windows = append(e.Windows, limitWindowOf(name, obs.windows[name], now))
		}
		out = append(out, e)
	}
	return out
}

func limitWindowNames(windows map[string]statusline.RateWindow) []string {
	rank := func(n string) int {
		if i := slices.Index(limitWindowOrder, n); i >= 0 {
			return i
		}
		return len(limitWindowOrder)
	}
	return slices.SortedFunc(maps.Keys(windows), func(a, b string) int {
		return cmp.Or(cmp.Compare(rank(a), rank(b)), cmp.Compare(a, b))
	})
}

func limitWindowOf(name string, w statusline.RateWindow, now time.Time) limitWindow {
	out := limitWindow{Name: name, UsedPct: w.UsedPct}
	if w.UsedPct != nil {
		out.Level = limitLevel(*w.UsedPct)
	}
	if w.ResetsAt != nil {
		at := *w.ResetsAt
		if at > resetsAtMillisFloor {
			at /= 1000
		}
		left := max(0, at-float64(now.Unix()))
		out.ResetsAt, out.ResetsInSec = &at, &left
	}
	return out
}

// limitLevel 은 사용률의 경고 등급이다 (FR-ASV-21, D-ASV-9). 경계는 계정 묶음과 한 벌이다 (FR-CAC-93).
func limitLevel(pct float64) string { return claudeacct.UsageLevel(pct) }
