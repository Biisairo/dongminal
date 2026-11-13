package claudeacct

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"time"
)

// 묶음 F — 제한 초기화 (FR-CAC-60~65). 형식은 Claude Code 2.1.323 의 `juniper-tide`·`cedar-ember` 와 같다.

// 두 프로그램 (FR-CAC-60).
const (
	ProgramJuniper = "juniper_tide"
	ProgramCedar   = "cedar_ember"
)

const (
	queryJuniper = "at_wall=1&skip_spend=1"
	queryCedar   = "cedar_ember=1&skip_spend=1"
	claimTimeout = 25 * time.Second
	// resetsEvery 는 상태를 조회하는 사용량 조회 성공의 간격이다 — 3번에 1번 (FR-CAC-60).
	resetsEvery = 3
)

var (
	grantIDRe   = regexp.MustCompile(`^[a-z0-9_-]{1,40}$`)
	requestIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
	// resetWindows 는 clears·blocking·exhausted 에 남기는 창 이름이다 (FR-CAC-60a).
	resetWindows = []string{"five_hour", "seven_day", "seven_day_overage_included", "seven_day_opus",
		"seven_day_sonnet", "seven_day_cowork", "seven_day_omelette", "seven_day_oauth_apps"}
	// claimResults 는 프로그램마다 서버가 낼 수 있는 결과다. 모르는 값은 unavailable 이다.
	claimResults = map[string][]string{
		ProgramJuniper: {"reset", "already_used", "not_limited", "ineligible", "unavailable"},
		ProgramCedar:   {"reset", "already_used", "not_limited", "cooldown", "ineligible", "unavailable"},
	}
)

// JuniperStatus 는 주간 5시간 초기화의 상태다. 시각은 unix 초이고 모르면 0 이다.
type JuniperStatus struct {
	Eligible         bool   `json:"eligible"`
	IneligibleReason string `json:"ineligibleReason,omitempty"`
	Available        bool   `json:"available"`
	NextAvailableAt  int64  `json:"nextAvailableAt,omitempty"`
}

// CedarGrant 는 초기화 티켓 하나다.
type CedarGrant struct {
	ID                string         `json:"id"`
	Label             string         `json:"label"`
	ResetsTotal       int            `json:"resetsTotal"`
	ResetsLeft        int            `json:"resetsLeft"`
	StartsAt          int64          `json:"startsAt,omitempty"`
	EndsAt            int64          `json:"endsAt,omitempty"`
	Clears            []string       `json:"clears"`
	Paused            bool           `json:"paused"`
	UsableNow         bool           `json:"usableNow"`
	UseRequiresLimit  bool           `json:"useRequiresLimit"`
	PercentUsed       map[string]int `json:"percentUsed,omitempty"`
	Blocking          []string       `json:"blocking"`
	GivesBackWeekly   bool           `json:"givesBackWeekly"`
	UnavailableReason string         `json:"unavailableReason,omitempty"`
}

// CedarStatus 는 초기화 티켓의 상태다.
type CedarStatus struct {
	Eligible         bool         `json:"eligible"`
	IneligibleReason string       `json:"ineligibleReason,omitempty"`
	AtLimit          bool         `json:"atLimit"`
	Exhausted        []string     `json:"exhausted"`
	CooldownUntil    int64        `json:"cooldownUntil,omitempty"`
	WeeklyResetsAt   int64        `json:"weeklyResetsAt,omitempty"`
	Grants           []CedarGrant `json:"grants"`
}

// Resets 는 한 계정의 두 상태다. 프로그램이 없으면 그 필드가 nil 이다 (FR-CAC-61).
type Resets struct {
	Juniper   *JuniperStatus `json:"juniperTide,omitempty"`
	Cedar     *CedarStatus   `json:"cedarEmber,omitempty"`
	FetchedAt int64          `json:"fetchedAt"`
}

// ClaimResult 는 사용의 결과다 (FR-CAC-63).
type ClaimResult struct {
	Result          string   `json:"result"`
	Reason          string   `json:"reason,omitempty"`
	ResetsLeft      *int     `json:"resetsLeft,omitempty"`
	Cleared         []string `json:"cleared,omitempty"`
	NextAvailableAt int64    `json:"nextAvailableAt,omitempty"`
	WeeklyResetsAt  int64    `json:"weeklyResetsAt,omitempty"`
	CooldownUntil   int64    `json:"cooldownUntil,omitempty"`
}

func knownWindows(in []string) []string {
	out := []string{}
	for _, w := range in {
		if slices.Contains(resetWindows, w) {
			out = append(out, w)
		}
	}
	return out
}

func strOr(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func timeOf(p *string) int64 { return parseResetsAt(strOr(p)) }

// block 은 본문의 한 필드를 꺼낸다. 없거나 null 이면 nil 이다.
func block(raw []byte, name string) json.RawMessage {
	var top map[string]json.RawMessage
	if json.Unmarshal(raw, &top) != nil {
		return nil
	}
	b := top[name]
	if len(b) == 0 || string(b) == "null" {
		return nil
	}
	return b
}

// ParseJuniper 는 `?at_wall=1` 응답의 `juniper_tide` 다. 없거나 형식이 틀리면 nil 이다.
func ParseJuniper(raw []byte) *JuniperStatus {
	b := block(raw, ProgramJuniper)
	if b == nil {
		return nil
	}
	var v struct {
		Eligible         *bool   `json:"eligible"`
		IneligibleReason *string `json:"ineligible_reason"`
		Available        *bool   `json:"available"`
		NextAvailableAt  *string `json:"next_available_at"`
	}
	if json.Unmarshal(b, &v) != nil || v.Eligible == nil {
		return nil
	}
	return &JuniperStatus{Eligible: *v.Eligible, IneligibleReason: strOr(v.IneligibleReason),
		Available: v.Available != nil && *v.Available, NextAvailableAt: timeOf(v.NextAvailableAt)}
}

func parseGrant(b json.RawMessage) (CedarGrant, bool) {
	var v struct {
		ID                string         `json:"id"`
		Label             string         `json:"label"`
		ResetsTotal       int            `json:"resets_total"`
		ResetsLeft        *int           `json:"resets_left"`
		StartsAt          *string        `json:"starts_at"`
		EndsAt            *string        `json:"ends_at"`
		Clears            []string       `json:"clears"`
		Paused            bool           `json:"paused"`
		UsableNow         bool           `json:"usable_now"`
		UseRequiresLimit  *bool          `json:"use_requires_limit"`
		PercentUsed       map[string]any `json:"percent_used"`
		Blocking          []string       `json:"blocking"`
		GivesBackWeekly   bool           `json:"gives_back_weekly"`
		UnavailableReason *string        `json:"unavailable_reason"`
	}
	if json.Unmarshal(b, &v) != nil || !grantIDRe.MatchString(v.ID) || v.ResetsLeft == nil || *v.ResetsLeft < 0 {
		return CedarGrant{}, false
	}
	pct := map[string]int{}
	for k, x := range v.PercentUsed {
		if f, ok := x.(float64); ok && slices.Contains(resetWindows, k) && f == float64(int(f)) && f >= 0 && f <= 100 {
			pct[k] = int(f)
		}
	}
	return CedarGrant{
		ID: v.ID, Label: v.Label, ResetsTotal: max(0, v.ResetsTotal), ResetsLeft: *v.ResetsLeft,
		StartsAt: timeOf(v.StartsAt), EndsAt: timeOf(v.EndsAt), Clears: knownWindows(v.Clears),
		Paused: v.Paused, UsableNow: v.UsableNow, UseRequiresLimit: v.UseRequiresLimit == nil || *v.UseRequiresLimit,
		PercentUsed: pct, Blocking: knownWindows(v.Blocking), GivesBackWeekly: v.GivesBackWeekly,
		UnavailableReason: strOr(v.UnavailableReason),
	}, true
}

// ParseCedar 는 `?cedar_ember=1` 응답의 `cedar_ember` 다. 형식이 틀린 티켓은 그 티켓만 뺀다.
func ParseCedar(raw []byte) *CedarStatus {
	b := block(raw, ProgramCedar)
	if b == nil {
		return nil
	}
	var v struct {
		Eligible         *bool             `json:"eligible"`
		IneligibleReason *string           `json:"ineligible_reason"`
		AtLimit          bool              `json:"at_limit"`
		Exhausted        []string          `json:"exhausted"`
		Grants           []json.RawMessage `json:"grants"`
		WeeklyResetsAt   *string           `json:"weekly_resets_at"`
		CooldownUntil    *string           `json:"cooldown_until"`
	}
	if json.Unmarshal(b, &v) != nil || v.Eligible == nil {
		return nil
	}
	c := &CedarStatus{Eligible: *v.Eligible, IneligibleReason: strOr(v.IneligibleReason), AtLimit: v.AtLimit,
		Exhausted: knownWindows(v.Exhausted), WeeklyResetsAt: timeOf(v.WeeklyResetsAt),
		CooldownUntil: timeOf(v.CooldownUntil), Grants: []CedarGrant{}}
	for _, g := range v.Grants {
		if cg, ok := parseGrant(g); ok {
			c.Grants = append(c.Grants, cg)
		}
	}
	return c
}

// claimResultOf 는 사용 요청의 답을 결과로 바꾼다 (FR-CAC-63). err 가 상태 오류가 아니면 응답을 받지 못한 것이다.
func claimResultOf(program string, raw []byte, err error) ClaimResult {
	if err != nil {
		var se *HTTPStatusError
		if !errors.As(err, &se) {
			return ClaimResult{Result: "unconfirmed"}
		}
		switch se.Status {
		case 429:
			return ClaimResult{Result: "rate_limited"}
		case 401, 403:
			return ClaimResult{Result: "auth_error"}
		}
		return ClaimResult{Result: "error"}
	}
	var v struct {
		Result          *string  `json:"result"`
		Reason          *string  `json:"reason"`
		ResetsLeft      *int     `json:"resets_left"`
		Cleared         []string `json:"cleared"`
		NextAvailableAt *string  `json:"next_available_at"`
		WeeklyResetsAt  *string  `json:"weekly_resets_at"`
		CooldownUntil   *string  `json:"cooldown_until"`
	}
	if json.Unmarshal(raw, &v) != nil || v.Result == nil {
		return ClaimResult{Result: "error"}
	}
	res := *v.Result
	if !slices.Contains(claimResults[program], res) {
		res = "unavailable"
	}
	out := ClaimResult{Result: res}
	if program == ProgramJuniper {
		out.NextAvailableAt = timeOf(v.NextAvailableAt)
		return out
	}
	out.Reason = strOr(v.Reason)
	if v.ResetsLeft != nil && *v.ResetsLeft >= 0 {
		out.ResetsLeft = v.ResetsLeft
	}
	if c := knownWindows(v.Cleared); len(c) > 0 {
		out.Cleared = c
	}
	out.WeeklyResetsAt, out.CooldownUntil = timeOf(v.WeeklyResetsAt), timeOf(v.CooldownUntil)
	return out
}

// ClaimReset 은 `POST /api/organizations/{org}/reset_rate_limits` 다 (FR-CAC-62). 25초 제한.
func (c Client) ClaimReset(ctx context.Context, token, org string, body map[string]any) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, claimTimeout)
	defer cancel()
	b, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base()+"/api/organizations/"+url.PathEscape(org)+"/reset_rate_limits", bytes.NewReader(b))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", c.UserAgent)
	resp, err := c.client().Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxAPIBody))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return raw, &HTTPStatusError{Status: resp.StatusCode, RetryAfter: resp.Header.Get("Retry-After")}
	}
	return raw, nil
}
