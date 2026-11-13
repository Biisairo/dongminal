package claudeacct

import (
	"context"
	"fmt"
	"strings"
	"time"

	"dongminal/internal/shared/dmlog"
)

// 스마트 전환 전략 (FR-CAC-31).
const (
	StrategyNext          = "next"
	StrategyNextAvailable = "next-available"
	StrategyBest          = "best"
)

// ModelsAll 은 모든 scoped 창을 고려하라는 models 값이다 (FR-CAC-70).
const ModelsAll = "all"

// `best` 가 전환하지 않은 이유 (FR-CAC-31a).
const (
	ReasonNone               = "none"
	ReasonCurrentUnavailable = "current-unavailable"
	ReasonNoComparison       = "no-comparison"
	ReasonExhausted          = "exhausted"
	ReasonStay               = "stay"
)

// SwitchRequest 는 API 로 온 전환 요청이다. ID 나 Strategy 중 하나를 쓴다.
type SwitchRequest struct {
	ID       string
	Strategy string
	By       string
}

// modelSet 은 models 설정을 Usage.windows 의 인자로 바꾼다.
// 없으면 scoped 창을 빼고(빈 집합), `all` 이면 nil(모두)이다.
func modelSet(models []string) map[string]bool {
	set := map[string]bool{}
	for _, m := range models {
		if strings.EqualFold(m, ModelsAll) {
			return nil
		}
		set[m] = true
	}
	return set
}

func (e *Engine) models() map[string]bool {
	if e.Models == nil {
		return map[string]bool{}
	}
	return modelSet(e.Models())
}

// statusLineGraceS 는 dongminal 이 전환한 뒤 statusLine 값을 믿지 않는 시간이다 — 실행 중인 세션이
// 옛 토큰을 쓰는 동안이다 (FR-CAC-78).
const statusLineGraceS = 60

// mergeWindow 는 창 하나의 OAuth 값과 statusLine 값을 합친다 (FR-CAC-78). 초기화가 지난 값은 버리고,
// 두 초기화 시각이 300초 넘게 다르면 늦은 쪽(새 창)을, 그 밖에는 사용률이 큰 쪽을 쓴다.
func mergeWindow(oauth, sl *Window, now int64) *Window {
	live := func(w *Window) *Window {
		if w == nil || (w.ResetsAt > 0 && w.ResetsAt <= now) {
			return nil
		}
		c := *w
		return &c
	}
	o, s := live(oauth), live(sl)
	switch {
	case o == nil:
		return s
	case s == nil:
		return o
	case o.ResetsAt > 0 && s.ResetsAt > 0 && max(o.ResetsAt-s.ResetsAt, s.ResetsAt-o.ResetsAt) > freshForDecisionS:
		if s.ResetsAt > o.ResetsAt {
			return s
		}
		return o
	case s.Pct > o.Pct:
		return s
	}
	return o
}

func (e *Engine) lastSwitch() int64 {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.lastSwitchAt
}

// decisionUsage 는 결정에 쓰는 값이다 (FR-CAC-55·78): 신선한 OAuth 값과 쓸 수 있는 statusLine 값을 창마다 합친다.
// 둘 다 없으면 false 다.
func (e *Engine) decisionUsage(a Account) (*Usage, bool) {
	now := e.Now().Unix()
	var oauth, sl *Usage
	if r := e.row(a.ID); r.LastGood != nil && now-r.FetchedAt <= freshForDecisionS {
		oauth = r.LastGood
	}
	if e.StatusLine != nil {
		if u, at, ok := e.StatusLine(a); ok && now-at <= freshForDecisionS && at >= e.lastSwitch()+statusLineGraceS {
			sl = &u
		}
	}
	if oauth == nil && sl == nil {
		return nil, false
	}
	var out Usage
	if oauth != nil {
		out = *oauth
	}
	if sl == nil {
		sl = &Usage{}
	}
	out.FiveHour = mergeWindow(out.FiveHour, sl.FiveHour, now)
	out.SevenDay = mergeWindow(out.SevenDay, sl.SevenDay, now)
	if out.FiveHour == nil && out.SevenDay == nil && len(out.Scoped) == 0 {
		return nil, false
	}
	return &out, true
}

// freshHeadroom 은 결정에 쓸 수 있는 헤드룸이다 (FR-CAC-55·78). 값을 모르면 false.
func (e *Engine) freshHeadroom(a Account, models map[string]bool) (float64, bool) {
	u, ok := e.decisionUsage(a)
	if !ok {
		return 0, false
	}
	return u.Headroom(models), true
}

// accountByID 는 st 의 계정이다. 없으면 ID 만 든 빈 계정이다(값을 모른다).
func accountByID(st State, id string) Account {
	if i := st.Find(id); i >= 0 {
		return st.Accounts[i]
	}
	return Account{ID: id}
}

func headroomPtr(h float64, ok bool) *float64 {
	if !ok {
		return nil
	}
	return &h
}

// refreshStale 는 제외되지 않은 계정 중 값이 낡았고 조회할 수 있는 계정을 조회한다 (FR-CAC-31a).
func (e *Engine) refreshStale(ctx context.Context, st State) {
	e.busy.Lock()
	defer e.busy.Unlock()
	first := true
	for _, a := range st.Accounts {
		if a.Disabled && a.ID != st.ActiveID {
			continue
		}
		if _, ok := e.freshHeadroom(a, nil); ok {
			continue
		}
		r := e.row(a.ID)
		now := e.Now().Unix()
		if r.AuthDeadFP != "" || r.BackoffUntil > now || (r.LastAttemptAt > 0 && now-r.LastAttemptAt < fetchNowMinGapS) {
			continue
		}
		if !first {
			time.Sleep(e.stagger())
		}
		first = false
		e.fetch(ctx, a, a.ID == st.ActiveID)
	}
}

// Switch 는 API 의 전환이다 (FR-CAC-30·31·31a). 실제로 전환하면 기록을 남긴다 (FR-CAC-110a).
func (e *Engine) Switch(ctx context.Context, req SwitchRequest) (SwitchResult, error) {
	by := req.By
	if by == "" {
		by = ByUI
	}
	if by != ByUI && by != ByDmctl {
		return SwitchResult{}, fmt.Errorf("%w: by %q", ErrInvalid, req.By)
	}
	if req.ID != "" {
		return e.switchTo(ctx, req.ID, TriggerManual, by)
	}
	st, err := e.Svc.Store.Load()
	if err != nil {
		return SwitchResult{}, err
	}
	switch req.Strategy {
	case StrategyNext:
		id, ok := st.nextAfter(func(Account) bool { return true })
		if !ok {
			return SwitchResult{}, ErrNoCandidate
		}
		return e.switchTo(ctx, id, TriggerNext, by)
	case StrategyNextAvailable:
		e.refreshStale(ctx, st)
		models := e.models()
		id, ok := st.nextAfter(func(a Account) bool {
			h, known := e.freshHeadroom(a, models)
			return known && h > 0
		})
		if !ok {
			return SwitchResult{}, ErrNoCandidate
		}
		return e.switchTo(ctx, id, TriggerNextAvailable, by)
	case StrategyBest:
		e.refreshStale(ctx, st)
		id, reason := e.pickBest(st)
		if reason != "" {
			return SwitchResult{From: st.ActiveID, To: st.ActiveID, NoOp: true, Reason: reason}, nil
		}
		return e.switchTo(ctx, id, TriggerBest, by)
	}
	return SwitchResult{}, fmt.Errorf("%w: id 또는 strategy 가 필요합니다", ErrInvalid)
}

// pickBest 는 `best` 의 대상이다. 전환하지 않으면 이유를 돌려준다 (FR-CAC-31a).
func (e *Engine) pickBest(st State) (string, string) {
	models := e.models()
	var others []Account
	for _, a := range st.Accounts {
		if a.ID != st.ActiveID && !a.Disabled {
			others = append(others, a)
		}
	}
	if len(others) == 0 {
		return "", ReasonNone
	}
	cur, ok := e.freshHeadroom(accountByID(st, st.ActiveID), models)
	if !ok {
		return "", ReasonCurrentUnavailable
	}
	best, bestH, known := "", 0.0, false
	for _, a := range others {
		h, ok := e.freshHeadroom(a, models)
		if ok && (!known || h > bestH) {
			best, bestH, known = a.ID, h, true
		}
	}
	switch {
	case !known:
		return "", ReasonNoComparison
	case bestH > cur:
		return best, ""
	case cur <= 0:
		return "", ReasonExhausted
	}
	return "", ReasonStay
}

// switchTo 는 전환하고, 실제로 바뀌었으면 기록을 더한다. 기록 실패는 전환을 되돌리지 않는다.
func (e *Engine) switchTo(ctx context.Context, id, trigger, by string) (SwitchResult, error) {
	st, err := e.Svc.Store.Load()
	if err != nil {
		return SwitchResult{}, err
	}
	models := e.models()
	from := headroomPtr(e.freshHeadroom(accountByID(st, st.ActiveID), models))
	to := headroomPtr(e.freshHeadroom(accountByID(st, id), models))
	res, err := e.Svc.Switch(ctx, id)
	if err != nil || res.NoOp {
		return res, err
	}
	e.mu.Lock()
	e.lastSwitchAt = e.Now().Unix()
	e.mu.Unlock()
	h := HistoryEntry{At: e.Now().Unix(), From: res.From, To: res.To, Trigger: trigger, HeadroomFrom: from, HeadroomTo: to, By: by}
	if err := appendHistory(e.Svc.Dir, h); err != nil {
		dmlog.Infof(nil, "claude-accounts: 전환 기록 실패: %v", err)
	}
	return res, nil
}
