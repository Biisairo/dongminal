package runtimebin

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"

	"dongminal/internal/shared/apipath"
)

// CLAUDE_ACCOUNTS_SRS FR-CAC-62·63 — `dmctl account reset` 의 확인과 결과 문구 (dmctl_account.go 에서 옮겨 왔다, REFACTOR3_GO_STRUCT_SRS FR-RGS-43).

// accountResultText 는 사용 결과의 문구다 (FR-CAC-63).
var accountResultText = map[string]string{
	"reset":        "초기화했습니다",
	"already_used": "이미 썼습니다",
	"not_limited":  "지금은 한도에 걸려 있지 않아 쓸 수 없습니다",
	"cooldown":     "아직 쓸 수 없습니다 (대기 중)",
	"ineligible":   "이 계정은 쓸 수 없습니다",
	"unavailable":  "지금은 쓸 수 없습니다",
	"rate_limited": "요청이 너무 많습니다. 잠시 뒤 다시 하세요",
	"auth_error":   "인증에 실패했습니다. Claude Code 에서 다시 로그인하세요",
	"error":        "실패했습니다",
	"unconfirmed":  "확인하지 못했습니다 — 잠시 뒤 사용량을 확인하세요. 자동으로 다시 보내지 않습니다",
}

// accountResetPrompt 는 FR-CAC-62 의 확인 내용이다. 서버가 아는 상태가 없으면 그 사실만 적는다.
func accountResetPrompt(w io.Writer, a accountRow, program, grant string) {
	fmt.Fprintf(w, "계정: %s\n", clean(a.label()))
	if program == "juniper_tide" {
		fmt.Fprintln(w, "주간 5시간 초기화를 씁니다.\n  채우는 것: 5시간\n  주간 한도에서 차감됩니다.")
		return
	}
	var g *accountGrant
	if u := a.Usage; u != nil && u.Resets != nil && u.Resets.Cedar != nil {
		for i := range u.Resets.Cedar.Grants {
			if u.Resets.Cedar.Grants[i].ID == grant {
				g = &u.Resets.Cedar.Grants[i]
			}
		}
	}
	if g == nil {
		fmt.Fprintf(w, "초기화 티켓 %s 를 씁니다. (서버가 아는 상태가 없어 내용을 보일 수 없습니다)\n", clean(grant))
		return
	}
	names := []string{}
	for _, c := range g.Clears {
		names = append(names, accountWindowName(c))
	}
	fmt.Fprintf(w, "초기화 티켓 %s 를 씁니다.\n  채우는 것: %s\n  남은 횟수 %d/%d\n", clean(g.name()), strings.Join(names, ", "), g.ResetsLeft, g.ResetsTotal)
	if g.EndsAt > 0 {
		fmt.Fprintf(w, "  기한: %s\n", time.Unix(g.EndsAt, 0).Format("2006-01-02 15:04"))
	}
	if g.GivesBackWeekly {
		fmt.Fprintln(w, "  쓴 만큼 주간 한도를 돌려받습니다.")
	} else {
		fmt.Fprintln(w, "  주간 한도에서 차감됩니다.")
	}
}

// accountReset 은 `dmctl account reset` 이다 (FR-CAC-62·65). 결과가 reset 이 아니면 1 로 끝난다.
func accountReset(pa subArgs, stdout, stderr io.Writer) int {
	program, grant := pa.flags["program"], pa.flags["grant"]
	switch {
	case program == "juniper_tide" && grant == "":
	case program == "cedar_ember" && grant != "":
	default:
		fmt.Fprint(stderr, "dmctl account reset: --program juniper_tide, 또는 --program cedar_ember --grant <id> 가 필요합니다\n")
		return 2
	}
	v, _, rc := loadAccounts(stderr)
	if rc != 0 {
		return rc
	}
	a, ok := resolveAccount(v, pa.pos[0])
	if !ok {
		fmt.Fprintf(stderr, "dmctl account: 그런 계정이 없습니다: %s\n", clean(pa.pos[0]))
		return 1
	}
	if !pa.bools["yes"] {
		accountResetPrompt(stdout, a, program, grant)
		fmt.Fprint(stdout, "계속할까요? [y/N] ")
		line, _ := bufio.NewReader(pa.stdin).ReadString('\n')
		if ans := strings.ToLower(strings.TrimSpace(line)); ans != "y" && ans != "yes" {
			fmt.Fprintln(stdout, "\n취소했습니다.")
			return 1
		}
	}
	body := map[string]any{"id": a.ID, "program": program}
	if grant != "" {
		body["grantId"] = grant
	}
	raw, rc := accountAPI("POST", apipath.ClaudeAccountsReset, body, stderr)
	if rc != 0 {
		return rc
	}
	var res struct {
		Result          string `json:"result"`
		ResetsLeft      *int   `json:"resetsLeft"`
		NextAvailableAt int64  `json:"nextAvailableAt"`
		CooldownUntil   int64  `json:"cooldownUntil"`
	}
	_ = json.Unmarshal(raw, &res)
	msg, ok := accountResultText[res.Result]
	if !ok {
		msg = "알 수 없는 결과: " + clean(res.Result)
	}
	if res.ResetsLeft != nil {
		msg += fmt.Sprintf(" (남은 횟수 %d)", *res.ResetsLeft)
	}
	if res.CooldownUntil > 0 {
		msg += " — " + time.Unix(res.CooldownUntil, 0).Format("01-02 15:04") + " 뒤에 다시"
	}
	if res.NextAvailableAt > 0 && res.Result == "reset" {
		msg += " — 다음 가능 " + time.Unix(res.NextAvailableAt, 0).Format("01-02 15:04")
	}
	fmt.Fprintln(stdout, msg)
	if res.Result != "reset" {
		return 1
	}
	return 0
}
