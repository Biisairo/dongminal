package claudeacct

import (
	"strconv"
	"strings"
	"time"
)

// 알림 사건 (FR-CAC-100a).
const (
	AlertAutoswitch        = "autoswitch"
	AlertNearLimit         = "near_limit"
	AlertAllExhausted      = "all_exhausted"
	AlertRelogin           = "relogin"
	AlertLoginExpiring     = "login_expiring"
	AlertAutoswitchStopped = "autoswitch_stopped"
)

// Alert 는 SSE `claude_account_alert` 의 본문이다. 이름은 표시 이름뿐이다 (FR-CAC-101).
type Alert struct {
	Kind           string `json:"kind"`
	Name           string `json:"name,omitempty"`
	From           string `json:"from,omitempty"`
	To             string `json:"to,omitempty"`
	Trigger        string `json:"trigger,omitempty"`
	Window         string `json:"window,omitempty"`
	ResetsAt       int64  `json:"resetsAt,omitempty"`
	ExpiresAt      int64  `json:"expiresAt,omitempty"`
	ResetAvailable bool   `json:"resetAvailable,omitempty"`
}

// displayName 은 별칭, 없으면 이메일 앞 두 글자 + `***@` 다 (FR-CAC-101).
func displayName(a Account) string {
	if a.Alias != "" {
		return a.Alias
	}
	local, _, _ := strings.Cut(a.Email, "@")
	r := []rune(local)
	if len(r) > 2 {
		r = r[:2]
	}
	return string(r) + "***@"
}

const (
	alertKeepS = 8 * 86400
	dayLayout  = "2006-01-02"
)

// Usable 은 지금 쓸 수 있는 제한 초기화가 있는가다 (FR-CAC-65 의 "초기화 사용…" 조건).
func (r *Resets) Usable() bool {
	if r == nil {
		return false
	}
	if j := r.Juniper; j != nil && j.Eligible && j.Available {
		return true
	}
	if c := r.Cedar; c != nil && c.Eligible {
		for _, g := range c.Grants {
			if g.ResetsLeft > 0 && g.UsableNow {
				return true
			}
		}
	}
	return false
}

// once 는 억제 키가 없으면 기록하고 true 다 (FR-CAC-100a).
func (a *Auto) once(key string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if _, sent := a.file.State.Notified[key]; sent {
		return false
	}
	if a.file.State.Notified == nil {
		a.file.State.Notified = map[string]int64{}
	}
	a.file.State.Notified[key] = a.Now().Unix()
	a.saveLocked()
	return true
}

func (a *Auto) pruneNotified() {
	a.mu.Lock()
	defer a.mu.Unlock()
	cut := a.Now().Unix() - alertKeepS
	n := len(a.file.State.Notified)
	for k, at := range a.file.State.Notified {
		if at < cut {
			delete(a.file.State.Notified, k)
		}
	}
	if len(a.file.State.Notified) != n {
		a.saveLocked()
	}
}

// evaluateAlerts 는 자동 전환이 꺼져 있어도 도는 알림 판정이다 (FR-CAC-100·100a).
func (a *Auto) evaluateAlerts(s AutoSettings) {
	a.pruneNotified()
	st, err := a.Eng.Svc.Store.Load()
	if err != nil {
		return
	}
	now := a.Now()
	models := modelSet(s.Models)
	for _, acc := range st.Accounts {
		r := a.Eng.row(acc.ID)
		if r.Status == StatusReloginRequired && r.AuthDeadFP != "" && a.once("relogin:"+acc.ID+":"+r.AuthDeadFP) {
			a.notify(Alert{Kind: AlertRelogin, Name: displayName(acc)})
		}
		if exp := r.LoginExpiresAt; exp > 0 && exp-now.Unix() <= loginWarnS &&
			a.once("expiring:"+acc.ID+":"+now.Local().Format(dayLayout)) {
			a.notify(Alert{Kind: AlertLoginExpiring, Name: displayName(acc), ExpiresAt: exp})
		}
	}
	i := st.Find(st.ActiveID)
	if i < 0 {
		return
	}
	active := a.view(st.Accounts[i], s, models)
	if !active.known {
		return
	}
	exhausted, usable := true, false
	for _, acc := range st.Accounts {
		usable = usable || a.Eng.row(acc.ID).Resets.Usable()
		if acc.Disabled && acc.ID != st.ActiveID {
			continue
		}
		h, ok := a.Eng.freshHeadroom(acc, models)
		exhausted = exhausted && ok && h <= 0
	}
	if exhausted {
		if a.once("exhausted:" + strconv.FormatInt(active.b.ResetsAt, 10)) {
			a.notify(Alert{Kind: AlertAllExhausted, ResetAvailable: usable})
		}
		return
	}
	if !active.over() {
		return
	}
	cands := a.candidates(st, s, models)
	ranked := rank(TriggerProactive, s, active, cands, "")
	if s.Strategy == AutoStrategyPriorityConsumeFirst {
		ranked = rankPriority(active, cands)
	}
	if len(ranked) > 0 {
		return
	}
	key := "near:" + st.ActiveID + ":" + active.b.Name + ":" + strconv.FormatInt(active.b.ResetsAt, 10)
	if a.once(key) {
		a.notify(Alert{Kind: AlertNearLimit, Name: displayName(st.Accounts[i]), Window: active.b.Name, ResetsAt: active.b.ResetsAt})
	}
}

// Text 는 Telegram 으로 보낼 글이다 (FR-CAC-100a). 모르는 사건은 빈 글이다.
func (a Alert) Text() string {
	switch a.Kind {
	case AlertAutoswitch:
		return "Claude 계정 자동 전환: " + a.From + " → " + a.To + " (" + a.Trigger + ")"
	case AlertNearLimit:
		return "Claude 계정 한도 임박: " + a.Name + " 의 " + a.Window + " 창이 라인에 닿았고 전환할 계정이 없습니다"
	case AlertAllExhausted:
		if a.ResetAvailable {
			return "Claude 계정: 모든 계정의 한도가 찼습니다 — 쓸 수 있는 제한 초기화가 있습니다"
		}
		return "Claude 계정: 모든 계정의 한도가 찼습니다"
	case AlertRelogin:
		return "Claude 계정 " + a.Name + ": 다시 로그인해야 합니다"
	case AlertLoginExpiring:
		return "Claude 계정 " + a.Name + ": 로그인 만료가 가까워졌습니다 (" + time.Unix(a.ExpiresAt, 0).Local().Format(dayLayout) + ")"
	case AlertAutoswitchStopped:
		return "Claude 계정 자동 전환을 껐습니다 — cswap auto 가 돌고 있습니다"
	}
	return ""
}
