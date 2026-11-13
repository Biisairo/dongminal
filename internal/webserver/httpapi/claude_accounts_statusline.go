package httpapi

import (
	"sort"
	"sync"
	"time"

	"dongminal/internal/shared/agentrec"
	"dongminal/internal/shared/statusline"
	"dongminal/internal/webserver/domain/claudeacct"
)

// claudeSLStore 는 계정별 statusLine 마지막 값이다 (CLAUDE_ACCOUNTS_SRS FR-CAC-78). 서버 메모리에만 둔다.
type claudeSLStore struct {
	mu sync.Mutex
	m  map[string]claudeSLObs
}

type claudeSLObs struct {
	email string
	u     claudeacct.Usage
	at    int64
}

func claudeSLKey(email, org string) string { return email + "\x00" + org }

// claudeSLUsage 는 statusLine 의 두 창을 사용량 모양으로 옮긴다. 둘 다 없으면 false.
func claudeSLUsage(rl map[string]statusline.RateWindow) (claudeacct.Usage, bool) {
	conv := func(name string) *claudeacct.Window {
		w, ok := rl[name]
		if !ok || w.UsedPct == nil {
			return nil
		}
		out := &claudeacct.Window{Pct: *w.UsedPct}
		if w.ResetsAt != nil {
			out.ResetsAt = int64(*w.ResetsAt)
		}
		return out
	}
	u := claudeacct.Usage{FiveHour: conv("five_hour"), SevenDay: conv("seven_day")}
	return u, u.FiveHour != nil || u.SevenDay != nil
}

func (st *claudeSLStore) put(acc agentrec.ReportAccount, rl map[string]statusline.RateWindow, at time.Time) {
	u, ok := claudeSLUsage(rl)
	if !ok {
		return
	}
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.m == nil {
		st.m = map[string]claudeSLObs{}
	}
	st.m[claudeSLKey(acc.Email, acc.OrgUUID)] = claudeSLObs{email: acc.Email, u: u, at: at.Unix()}
}

// get 은 Engine.StatusLine 이다.
func (st *claudeSLStore) get(a claudeacct.Account) (claudeacct.Usage, int64, bool) {
	st.mu.Lock()
	defer st.mu.Unlock()
	o, ok := st.m[claudeSLKey(a.Email, a.OrgUUID)]
	return o.u, o.at, ok
}

// others 는 등록되지 않은 계정의 값이다. 이름은 가린 이메일이고 순서는 이름 순이다.
func (st *claudeSLStore) others(accts []claudeacct.Account, now int64) []claudeacct.StatusLineView {
	known := map[string]bool{}
	for _, a := range accts {
		known[claudeSLKey(a.Email, a.OrgUUID)] = true
	}
	st.mu.Lock()
	defer st.mu.Unlock()
	out := []claudeacct.StatusLineView{}
	for k, o := range st.m {
		if known[k] {
			continue
		}
		v := claudeacct.StatusLineViewOf(o.u, o.at, now)
		v.Name = claudeacct.MaskedName(o.email)
		out = append(out, *v)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}
