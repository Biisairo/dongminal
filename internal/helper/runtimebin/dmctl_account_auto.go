package runtimebin

import (
	"encoding/json"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"
)

// CLAUDE_ACCOUNTS_SRS FR-CAC-31a·76·102·110a — 스마트 전환의 결과 문구, 자동 전환, 전환 기록.

const (
	historyDefaultLimit = 20
	historyMaxLimit     = 1000
	historyTimeLayout   = "2006-01-02 15:04"
)

var accountStrategies = map[string]bool{"next": true, "next-available": true, "best": true}

// accountReasonText 는 `best` 가 전환하지 않은 이유의 문구다.
func accountReasonText(reason string) string {
	switch reason {
	case "none":
		return "제외되지 않은 다른 계정이 없습니다"
	case "current-unavailable":
		return "활성 계정의 사용량을 모릅니다"
	case "no-comparison":
		return "비교할 수 있는 다른 계정의 사용량이 없습니다"
	case "exhausted":
		return "모든 계정의 한도가 찼습니다"
	case "stay":
		return "활성 계정의 여유가 가장 큽니다"
	}
	return reason
}

type autoView struct {
	Settings struct {
		Enabled         bool     `json:"enabled"`
		Threshold       float64  `json:"threshold"`
		WeeklyThreshold *float64 `json:"weeklyThreshold"`
		IntervalSeconds int      `json:"intervalSeconds"`
		CooldownSeconds int      `json:"cooldownSeconds"`
		HysteresisPct   float64  `json:"hysteresisPct"`
		Strategy        string   `json:"strategy"`
		UnhealthyTicks  int      `json:"unhealthyTicks"`
		Models          []string `json:"models"`
	} `json:"settings"`
	State struct {
		Status     string `json:"status"`
		LastSwitch *struct {
			At      int64  `json:"at"`
			From    string `json:"from"`
			To      string `json:"to"`
			Trigger string `json:"trigger"`
		} `json:"lastSwitch"`
		Quarantined []string `json:"quarantined"`
	} `json:"state"`
}

func autoStatusText(status string) string {
	switch status {
	case "on":
		return "켜짐"
	case "unmanaged":
		return "켜짐 — 활성 계정이 등록되지 않아 판단하지 않습니다"
	case "exhausted":
		return "켜짐 — 모든 후보의 한도가 차서 쉬는 중입니다"
	}
	return "꺼짐"
}

// accountName 은 계정 ID 의 표시 이름이다. 지워진 계정은 "삭제된 계정" 이다.
func accountName(v accountsOut, id string) string {
	if a, ok := resolveAccount(v, id); ok && id != "" {
		return clean(a.label())
	}
	return "삭제된 계정"
}

func accountAuto(pa peerArgs, stdout, stderr io.Writer) int {
	switch pa.pos[0] {
	case "on", "off":
		raw, rc := accountAPI("PUT", "/api/claude-accounts/autoswitch", map[string]any{"enabled": pa.pos[0] == "on"}, stderr)
		if rc != 0 {
			return rc
		}
		var v autoView
		_ = json.Unmarshal(raw, &v)
		fmt.Fprintf(stdout, "자동 전환: %s\n", autoStatusText(v.State.Status))
		return 0
	case "status":
		return accountAutoStatus(pa, stdout, stderr)
	}
	fmt.Fprintf(stderr, "dmctl account auto: on, off, status 중 하나여야 합니다: %s\n", clean(pa.pos[0]))
	return 2
}

func accountAutoStatus(pa peerArgs, stdout, stderr io.Writer) int {
	raw, rc := accountAPI("GET", "/api/claude-accounts/autoswitch", nil, stderr)
	if rc != 0 {
		return rc
	}
	if pa.bools["json"] {
		var m map[string]any
		_ = json.Unmarshal(raw, &m)
		m["schemaVersion"] = accountSchemaVersion
		b, _ := json.MarshalIndent(m, "", "  ")
		fmt.Fprintln(stdout, string(b))
		return 0
	}
	var v autoView
	if err := json.Unmarshal(raw, &v); err != nil {
		fmt.Fprintf(stderr, "dmctl account: 응답을 읽지 못했습니다: %v\n", err)
		return 1
	}
	accts, _, rc := loadAccounts(stderr)
	if rc != 0 {
		return rc
	}
	s := v.Settings
	weekly := "문턱값과 같음"
	if s.WeeklyThreshold != nil {
		weekly = strconv.FormatFloat(*s.WeeklyThreshold, 'f', -1, 64) + "%"
	}
	models := "5시간·주간만"
	if len(s.Models) > 0 {
		models = strings.Join(s.Models, ", ")
	}
	fmt.Fprintf(stdout, "자동 전환: %s\n", autoStatusText(v.State.Status))
	fmt.Fprintf(stdout, "문턱값 %s%% · 주간 문턱값 %s · 전략 %s · 판단 간격 %d초 · 쿨다운 %d초 · 히스테리시스 %s%%p · 모름 허용 %d번 · 모델 %s\n",
		strconv.FormatFloat(s.Threshold, 'f', -1, 64), weekly, clean(s.Strategy), s.IntervalSeconds, s.CooldownSeconds,
		strconv.FormatFloat(s.HysteresisPct, 'f', -1, 64), s.UnhealthyTicks, clean(models))
	if ls := v.State.LastSwitch; ls != nil {
		fmt.Fprintf(stdout, "마지막 전환: %s  %s → %s  (%s)\n", time.Unix(ls.At, 0).Local().Format(historyTimeLayout),
			accountName(accts, ls.From), accountName(accts, ls.To), clean(ls.Trigger))
	}
	if len(v.State.Quarantined) > 0 {
		names := make([]string, len(v.State.Quarantined))
		for i, id := range v.State.Quarantined {
			names[i] = accountName(accts, id)
		}
		fmt.Fprintf(stdout, "격리(토큰 갱신 영구 실패, 다시 추가하면 풀림): %s\n", strings.Join(names, ", "))
	}
	return 0
}

func accountHistory(pa peerArgs, stdout, stderr io.Writer) int {
	limit := historyDefaultLimit
	if s, ok := pa.flags["limit"]; ok {
		n, err := strconv.Atoi(s)
		if err != nil || n < 1 || n > historyMaxLimit {
			fmt.Fprint(stderr, "dmctl account history: --limit 은 1~1000 입니다\n")
			return 2
		}
		limit = n
	}
	accts, _, rc := loadAccounts(stderr)
	if rc != 0 {
		return rc
	}
	raw, rc := accountAPI("GET", "/api/claude-accounts/history?limit="+strconv.Itoa(limit), nil, stderr)
	if rc != 0 {
		return rc
	}
	var v struct {
		Entries []struct {
			At      int64  `json:"at"`
			From    string `json:"from"`
			To      string `json:"to"`
			Trigger string `json:"trigger"`
			By      string `json:"by"`
		} `json:"entries"`
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		fmt.Fprintf(stderr, "dmctl account: 응답을 읽지 못했습니다: %v\n", err)
		return 1
	}
	if len(v.Entries) == 0 {
		fmt.Fprintln(stdout, "전환 기록이 없습니다.")
		return 0
	}
	for _, e := range v.Entries {
		fmt.Fprintf(stdout, "%s  %s → %s  %s  %s\n", time.Unix(e.At, 0).Local().Format(historyTimeLayout),
			accountName(accts, e.From), accountName(accts, e.To), clean(e.Trigger), clean(e.By))
	}
	return 0
}
