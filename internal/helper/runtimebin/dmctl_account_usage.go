package runtimebin

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"

	"dongminal/internal/shared/apipath"
)

// CLAUDE_ACCOUNTS_SRS — `dmctl account usage` 의 사용량 표시 (dmctl_account.go 에서 옮겨 왔다, REFACTOR3_GO_STRUCT_SRS FR-RGS-43).

// accountSpan 은 남은 초를 큰 단위 둘로 쓴다 — 화면(`limitResetText`)과 같은 규칙이다.
func accountSpan(sec int64) string {
	if sec <= 0 {
		return "곧"
	}
	m := sec / 60
	d, h := m/1440, m/60%24
	switch {
	case d > 0:
		return fmt.Sprintf("%d일 %d시간", d, h)
	case m >= 60:
		return fmt.Sprintf("%d시간 %d분", h, m%60)
	}
	return fmt.Sprintf("%d분", m)
}

var accountLevelText = map[string]string{"warn": " (경고)", "critical": " (위험)"}

func accountWinLine(w io.Writer, name string, win *accountWin) {
	line := fmt.Sprintf("    %s %.0f%%%s", clean(name), win.Pct, accountLevelText[win.Level])
	if win.ResetsInSec != nil {
		line += "  " + accountSpan(*win.ResetsInSec) + " 후 초기화"
	}
	fmt.Fprintln(w, line)
}

func accountMoney(n float64, cur string) string {
	v := fmt.Sprintf("%.2f", n)
	if n == float64(int64(n)) {
		v = fmt.Sprintf("%d", int64(n))
	}
	if cur == "USD" {
		return "$" + v
	}
	return v + " " + clean(cur)
}

// printAccountUsage 는 계정 하나의 사용량이다 (FR-CAC-55·56·57·91 의 글자판).
func printAccountUsage(w io.Writer, a accountRow, active bool) {
	mark := "  "
	if active {
		mark = "* "
	}
	head := []string{mark + clean(a.label())}
	u := a.Usage
	if u != nil && u.Status != "" && u.Status != "ok" {
		head = append(head, clean(u.Status))
		if u.BackoffUntil > 0 {
			head = append(head, "다음 시도 "+time.Unix(u.BackoffUntil, 0).Format("15:04"))
		}
	}
	if u != nil && u.Stale {
		head = append(head, fmt.Sprintf("%d분 전", max(1, u.AgeSeconds/60)))
	}
	fmt.Fprintln(w, strings.Join(head, " · "))
	if u == nil || u.Windows == nil {
		if u == nil || u.Status == "" {
			fmt.Fprintln(w, "    아직 조회하지 않음")
		}
		return
	}
	ws := u.Windows
	if ws.FiveHour != nil {
		accountWinLine(w, "5시간", ws.FiveHour)
	}
	if ws.SevenDay != nil {
		accountWinLine(w, "주간", ws.SevenDay)
	}
	if p := u.Pace.SevenDay; p != nil {
		parts := []string{fmt.Sprintf("예상 %g%%", p.ExpectedPct)}
		if p.AheadOfPace {
			parts = append(parts, "속도가 앞섬")
		}
		switch {
		case p.WillLastToReset:
			parts = append(parts, "초기화까지 버팀")
		case p.ProjectedExhaustionAt > 0:
			parts = append(parts, "초기화 전 소진 ("+time.Unix(p.ProjectedExhaustionAt, 0).Format("01-02 15:04")+")")
		default:
			parts = append(parts, "초기화 전 소진")
		}
		fmt.Fprintln(w, "    주간 예측 "+strings.Join(parts, " · "))
	}
	for i := range ws.Scoped {
		accountWinLine(w, ws.Scoped[i].Name, &ws.Scoped[i])
	}
	printAccountResets(w, u)
	if sp := ws.Spend; sp != nil {
		fmt.Fprintf(w, "    추가 사용량 %s / %s\n", accountMoney(sp.Used, sp.Currency), accountMoney(sp.Limit, sp.Currency))
	}
	if u.LoginExpiresAt > 0 {
		soon := ""
		if u.LoginExpiringSoon {
			soon = " (7일 안)"
		}
		fmt.Fprintf(w, "    로그인 만료 %s%s\n", time.Unix(u.LoginExpiresAt, 0).Format("2006-01-02"), soon)
	}
}

// accountUsageCmd 는 `dmctl account usage [<계정>] [--refresh] [--json]` 이다 (FR-CAC-102).
// --refresh 는 대상 계정마다 바로 조회하고(FR-CAC-58), 실패한 계정이 있어도 나머지와 출력을 마친 뒤 1 로 끝난다.
func accountUsageCmd(pa subArgs, stdout, stderr io.Writer) int {
	if len(pa.pos) > 1 {
		fmt.Fprint(stderr, "dmctl account usage: 계정은 하나까지입니다\n")
		return 2
	}
	v, raw, rc := loadAccounts(stderr)
	if rc != 0 {
		return rc
	}
	pick := func(v accountsOut) ([]accountRow, bool) {
		if len(pa.pos) == 0 {
			return v.Accounts, true
		}
		a, ok := resolveAccount(v, pa.pos[0])
		return []accountRow{a}, ok
	}
	rows, ok := pick(v)
	if !ok {
		fmt.Fprintf(stderr, "dmctl account: 그런 계정이 없습니다: %s\n", clean(pa.pos[0]))
		return 1
	}
	code := 0
	if pa.bools["refresh"] {
		for _, a := range rows {
			if _, rc := accountAPI("POST", apipath.ClaudeAccountsRefresh, map[string]any{"id": a.ID}, stderr); rc != 0 {
				code = 1
			}
		}
		if v, raw, rc = loadAccounts(stderr); rc != 0 {
			return rc
		}
		if rows, ok = pick(v); !ok {
			fmt.Fprintf(stderr, "dmctl account: 그런 계정이 없습니다: %s\n", clean(pa.pos[0]))
			return 1
		}
	}
	if pa.bools["json"] {
		var full struct {
			Accounts []map[string]any `json:"accounts"`
		}
		_ = json.Unmarshal(raw, &full)
		keep := map[string]bool{}
		for _, a := range rows {
			keep[a.ID] = true
		}
		out := []map[string]any{}
		for _, a := range full.Accounts {
			if id, _ := a["id"].(string); keep[id] {
				out = append(out, a)
			}
		}
		b, _ := json.Marshal(map[string]any{"schemaVersion": accountSchemaVersion, "activeId": v.ActiveID, "accounts": out})
		fmt.Fprintln(stdout, clean(string(b)))
		return code
	}
	for _, a := range rows {
		printAccountUsage(stdout, a, a.ID == v.ActiveID)
	}
	return code
}

// accountWindowNames 는 초기화가 채우는 창의 이름이다. 모르는 창은 원래 이름을 쓴다.
var accountWindowNames = map[string]string{"five_hour": "5시간", "seven_day": "주간"}

func accountWindowName(w string) string {
	if n, ok := accountWindowNames[w]; ok {
		return n
	}
	return clean(w)
}

// printAccountResets 는 쓸 수 있는 제한 초기화 줄이다 (FR-CAC-65). 대상이 아니면 아무것도 쓰지 않는다.
func printAccountResets(w io.Writer, u *accountUsage) {
	if u.Resets == nil {
		return
	}
	if j := u.Resets.Juniper; j != nil && j.Eligible {
		switch {
		case j.Available:
			fmt.Fprintln(w, "    주간 5시간 초기화: 쓸 수 있음")
		case j.NextAvailableAt > 0:
			fmt.Fprintf(w, "    주간 5시간 초기화: 다음 가능 %s\n", time.Unix(j.NextAvailableAt, 0).Format("01-02 15:04"))
		}
	}
	if c := u.Resets.Cedar; c != nil && c.Eligible {
		for _, g := range c.Grants {
			if g.ResetsLeft <= 0 {
				continue
			}
			parts := []string{fmt.Sprintf("%d/%d회 남음", g.ResetsLeft, g.ResetsTotal)}
			if g.EndsAt > 0 {
				parts = append(parts, time.Unix(g.EndsAt, 0).Format("01-02")+"까지")
			}
			switch {
			case g.Paused:
				parts = append(parts, "멈춤")
			case g.UsableNow:
				parts = append(parts, "쓸 수 있음")
			}
			fmt.Fprintf(w, "    초기화 티켓 %s: %s  (--grant %s)\n", clean(g.name()), strings.Join(parts, " · "), clean(g.ID))
		}
	}
}
