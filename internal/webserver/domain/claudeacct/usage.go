package claudeacct

import (
	"context"
	"encoding/json"
	"errors"
	"time"
)

const (
	usagePath    = "/api/oauth/usage"
	usageBeta    = "oauth-2025-04-20"
	usageTimeout = 5 * time.Second
)

var errUsageShape = errors.New("사용량 응답을 읽을 수 없습니다")

// Window 는 한도 창 하나다. ResetsAt 은 unix 초이고 모르면 0 이다.
type Window struct {
	Pct      float64 `json:"pct"`
	ResetsAt int64   `json:"resetsAt,omitempty"`
}

// ScopedWindow 는 모델별 주간 한도다.
type ScopedWindow struct {
	Name string `json:"name"`
	Window
}

// Spend 는 추가 사용량이다 (FR-CAC-52).
type Spend struct {
	Used     float64 `json:"used"`
	Limit    float64 `json:"limit"`
	Pct      float64 `json:"pct"`
	Currency string  `json:"currency"`
}

// Usage 는 한 계정의 사용량이다.
type Usage struct {
	FiveHour *Window        `json:"fiveHour,omitempty"`
	SevenDay *Window        `json:"sevenDay,omitempty"`
	Scoped   []ScopedWindow `json:"scoped,omitempty"`
	Spend    *Spend         `json:"spend,omitempty"`
}

// UsageRaw 는 `GET /api/oauth/usage[?query]` 의 본문이다 (FR-CAC-51·60).
func (c Client) UsageRaw(ctx context.Context, token, query string) ([]byte, error) {
	path := usagePath
	if query != "" {
		path += "?" + query
	}
	return c.get(ctx, path, token, usageTimeout, map[string]string{"anthropic-beta": usageBeta})
}

func parseResetsAt(s string) int64 {
	if s == "" {
		return 0
	}
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return 0
	}
	return t.Unix()
}

// ParseUsage 는 사용량 응답을 해석한다. 창이 하나도 없거나 형식이 틀리면 오류다.
func ParseUsage(raw []byte) (Usage, error) {
	type win struct {
		Utilization *float64 `json:"utilization"`
		ResetsAt    string   `json:"resets_at"`
	}
	var v struct {
		FiveHour   *win `json:"five_hour"`
		SevenDay   *win `json:"seven_day"`
		ExtraUsage *struct {
			IsEnabled    bool     `json:"is_enabled"`
			UsedCredits  *float64 `json:"used_credits"`
			MonthlyLimit *float64 `json:"monthly_limit"`
			Utilization  *float64 `json:"utilization"`
			Currency     string   `json:"currency"`
		} `json:"extra_usage"`
		Limits []json.RawMessage `json:"limits"`
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		return Usage{}, errUsageShape
	}
	var u Usage
	conv := func(w *win) *Window {
		if w == nil || w.Utilization == nil {
			return nil
		}
		return &Window{Pct: *w.Utilization, ResetsAt: parseResetsAt(w.ResetsAt)}
	}
	u.FiveHour, u.SevenDay = conv(v.FiveHour), conv(v.SevenDay)
	if e := v.ExtraUsage; e != nil && e.IsEnabled && e.UsedCredits != nil && e.MonthlyLimit != nil && e.Utilization != nil {
		cur := e.Currency
		if cur == "" {
			cur = "USD"
		}
		u.Spend = &Spend{Used: *e.UsedCredits / 100, Limit: *e.MonthlyLimit / 100, Pct: *e.Utilization, Currency: cur}
	}
	for _, raw := range v.Limits {
		var l struct {
			Scope *struct {
				Model *struct {
					DisplayName string `json:"display_name"`
				} `json:"model"`
			} `json:"scope"`
			Percent  *float64 `json:"percent"`
			ResetsAt string   `json:"resets_at"`
		}
		if json.Unmarshal(raw, &l) != nil || l.Scope == nil || l.Scope.Model == nil || l.Scope.Model.DisplayName == "" || l.Percent == nil {
			continue
		}
		u.Scoped = append(u.Scoped, ScopedWindow{Name: l.Scope.Model.DisplayName, Window: Window{Pct: *l.Percent, ResetsAt: parseResetsAt(l.ResetsAt)}})
	}
	if u.FiveHour == nil && u.SevenDay == nil && len(u.Scoped) == 0 {
		return Usage{}, errUsageShape
	}
	return u, nil
}

// windows 는 판단에 넣을 창이다. models 가 nil 이면 모든 scoped 창을, 아니면 그 이름만 넣는다.
func (u *Usage) windows(models map[string]bool) []Window {
	var out []Window
	if u.FiveHour != nil {
		out = append(out, *u.FiveHour)
	}
	if u.SevenDay != nil {
		out = append(out, *u.SevenDay)
	}
	for _, s := range u.Scoped {
		if models == nil || models[s.Name] {
			out = append(out, s.Window)
		}
	}
	return out
}

// Headroom 은 `100 - max(사용률)` 이다 (§1.3).
func (u *Usage) Headroom(models map[string]bool) float64 {
	maxPct := 0.0
	for _, w := range u.windows(models) {
		if w.Pct > maxPct {
			maxPct = w.Pct
		}
	}
	return 100 - maxPct
}
