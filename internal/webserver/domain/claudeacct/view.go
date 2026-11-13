package claudeacct

import "dongminal/internal/webserver/domain/run"

const (
	// loginWarnS 는 로그인 만료 경고를 시작하는 남은 시간이다 (FR-CAC-45).
	loginWarnS = 7 * 86400
	// usageWarnPct·usageCriticalPct 는 사용률의 경고 경계다 — statusLine 한도와 같은 규칙이다 (D-ASV-9, FR-CAC-93).
	usageWarnPct     = 70
	usageCriticalPct = 90
)

// UsageLevel 은 사용률의 경고 등급이다. 경계 아래면 빈 값이다.
func UsageLevel(pct float64) string {
	switch {
	case pct >= usageCriticalPct:
		return run.LevelCritical
	case pct >= usageWarnPct:
		return run.LevelWarn
	}
	return ""
}

// WindowView 는 화면에 그릴 창 하나다. 남은 시간과 등급은 서버가 셈한다 (D-ASV-10).
type WindowView struct {
	Window
	ResetsInSec *int64 `json:"resetsInSec,omitempty"`
	Level       string `json:"level"`
}

// ScopedWindowView 는 모델별 주간 창의 뷰다.
type ScopedWindowView struct {
	Name string `json:"name"`
	WindowView
}

// WindowsView 는 한 계정의 창 전부다.
type WindowsView struct {
	FiveHour *WindowView        `json:"fiveHour,omitempty"`
	SevenDay *WindowView        `json:"sevenDay,omitempty"`
	Scoped   []ScopedWindowView `json:"scoped,omitempty"`
	Spend    *Spend             `json:"spend,omitempty"`
}

func windowView(w Window, now int64) WindowView {
	v := WindowView{Window: w, Level: UsageLevel(w.Pct)}
	if w.ResetsAt > 0 {
		left := max(0, w.ResetsAt-now)
		v.ResetsInSec = &left
	}
	return v
}

func windowsView(u *Usage, now int64) *WindowsView {
	v := &WindowsView{Spend: u.Spend}
	if u.FiveHour != nil {
		w := windowView(*u.FiveHour, now)
		v.FiveHour = &w
	}
	if u.SevenDay != nil {
		w := windowView(*u.SevenDay, now)
		v.SevenDay = &w
	}
	for _, s := range u.Scoped {
		v.Scoped = append(v.Scoped, ScopedWindowView{Name: s.Name, WindowView: windowView(s.Window, now)})
	}
	return v
}

// PaceView 는 주간 창들의 예측이다.
type PaceView struct {
	SevenDay *Pace            `json:"sevenDay,omitempty"`
	Scoped   map[string]*Pace `json:"scoped,omitempty"`
}

// UsageView 는 화면·dmctl 로 가는 사용량이다. 토큰은 없다.
type UsageView struct {
	Status            string       `json:"status,omitempty"`
	Windows           *WindowsView `json:"windows,omitempty"`
	Pace              PaceView     `json:"pace"`
	FetchedAt         int64        `json:"fetchedAt,omitempty"`
	AgeSeconds        int64        `json:"ageSeconds,omitempty"`
	Stale             bool         `json:"stale,omitempty"`
	NextPollAt        int64        `json:"nextPollAt,omitempty"`
	BackoffUntil      int64        `json:"backoffUntil,omitempty"`
	LoginExpiresAt    int64        `json:"loginExpiresAt,omitempty"`
	LoginExpiringSoon bool         `json:"loginExpiringSoon,omitempty"`
	Resets            *Resets      `json:"resets,omitempty"`
}

// AccountView 는 계정과 그 사용량이다.
type AccountView struct {
	Account
	Active bool       `json:"active"`
	Usage  *UsageView `json:"usage"`
	// StatusLine 은 그 계정의 statusLine 값이다 (FR-CAC-78·93). 받은 적이 없으면 없다.
	StatusLine *StatusLineView `json:"statusLine,omitempty"`
	// ProfileWarnings 는 마지막 프로필 준비에서 잇지 못한 공유 항목이다 (FR-CAC-88b).
	ProfileWarnings []string `json:"profileWarnings,omitempty"`
}

// StatusLineView 는 statusLine 줄 하나의 값이다 (FR-CAC-93). Name 은 등록되지 않은 계정에만 있다.
type StatusLineView struct {
	Name       string            `json:"name,omitempty"`
	Windows    StatusLineWindows `json:"windows"`
	ObservedAt int64             `json:"observedAt"`
	AgeSeconds int64             `json:"ageSeconds"`
	Stale      bool              `json:"stale"`
}

// StatusLineWindows 는 statusLine 이 주는 두 창이다.
type StatusLineWindows struct {
	FiveHour *WindowView `json:"fiveHour,omitempty"`
	SevenDay *WindowView `json:"sevenDay,omitempty"`
}

// StatusLineViewOf 는 at(unix 초)에 받은 statusLine 값의 뷰다.
func StatusLineViewOf(u Usage, at, now int64) *StatusLineView {
	v := &StatusLineView{ObservedAt: at, AgeSeconds: max(0, now-at)}
	v.Stale = v.AgeSeconds > freshForDecisionS
	if u.FiveHour != nil {
		w := windowView(*u.FiveHour, now)
		v.Windows.FiveHour = &w
	}
	if u.SevenDay != nil {
		w := windowView(*u.SevenDay, now)
		v.Windows.SevenDay = &w
	}
	return v
}

// MaskedName 은 등록되지 않은 계정의 표시 이름이다 (FR-CAC-101).
func MaskedName(email string) string { return displayName(Account{Email: email}) }

// BuildViews 는 계정 순서대로 뷰를 만든다 (FR-CAC-55·57).
func BuildViews(st State, rows map[string]Row, now int64) []AccountView {
	out := make([]AccountView, 0, len(st.Accounts))
	for _, a := range st.Accounts {
		r := rows[a.ID]
		uv := &UsageView{
			Status: r.Status, NextPollAt: r.NextPollAt, BackoffUntil: r.BackoffUntil,
			LoginExpiresAt: r.LoginExpiresAt, Resets: r.Resets,
		}
		if r.LoginExpiresAt > 0 && r.LoginExpiresAt-now <= loginWarnS {
			uv.LoginExpiringSoon = true
		}
		if r.LastGood != nil {
			uv.Windows, uv.FetchedAt = windowsView(r.LastGood, now), r.FetchedAt
			uv.AgeSeconds = max(0, now-r.FetchedAt)
			uv.Stale = uv.AgeSeconds > freshForDecisionS
			if w := r.LastGood.SevenDay; w != nil {
				uv.Pace.SevenDay = ComputePace(w.Pct, w.ResetsAt, r.FetchedAt)
			}
			for _, s := range r.LastGood.Scoped {
				if p := ComputePace(s.Pct, s.ResetsAt, r.FetchedAt); p != nil {
					if uv.Pace.Scoped == nil {
						uv.Pace.Scoped = map[string]*Pace{}
					}
					uv.Pace.Scoped[s.Name] = p
				}
			}
		}
		out = append(out, AccountView{Account: a, Active: a.ID == st.ActiveID, Usage: uv})
	}
	return out
}
