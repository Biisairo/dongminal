package runtimebin

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"
)

// CLAUDE_ACCOUNTS_SRS FR-CAC-102·103 — Claude 다중 계정의 dmctl 명령.

const dmctlAccountHelp = `dmctl account — Claude 다중 계정

  dmctl account list [--json]                  등록한 계정 (* 는 활성 계정)
  dmctl account add                            Claude Code 에 지금 로그인한 계정을 등록한다
  dmctl account switch <id|별칭|이메일>          그 계정으로 전환한다
  dmctl account switch --strategy next         순서상 다음 계정으로 전환한다 (제외한 계정은 건너뛴다)
  dmctl account usage [<계정>] [--refresh] [--json]
                                               사용량 (계정을 주지 않으면 모두). --refresh 는 먼저 바로 조회한다
                                               (1분 안에 조회했거나 물러나는 중이면 서버가 거절한다)

  실행 중인 Claude Code 세션은 약 30초 안에, 또는 다시 시작할 때 새 계정을 쓴다.
`

// accountCallBudget 은 전환의 예산이다. 전환은 Claude Code 의 락 셋을 각각 최대 9초 기다린다.
const accountCallBudget = 40 * time.Second

// accountSchemaVersion 은 `--json` 출력의 형식 판이다 (FR-CAC-103).
const accountSchemaVersion = 1

type accountRow struct {
	ID       string        `json:"id"`
	Email    string        `json:"email"`
	OrgName  string        `json:"organizationName"`
	Alias    string        `json:"alias"`
	Disabled bool          `json:"disabled"`
	Usage    *accountUsage `json:"usage"`
}

// accountWin 은 서버가 셈한 창 하나다. 남은 시간과 등급은 서버의 값만 쓴다 (D-CAC-15).
type accountWin struct {
	Name        string  `json:"name"`
	Pct         float64 `json:"pct"`
	ResetsInSec *int64  `json:"resetsInSec"`
	Level       string  `json:"level"`
}

type accountUsage struct {
	Status  string `json:"status"`
	Windows *struct {
		FiveHour *accountWin  `json:"fiveHour"`
		SevenDay *accountWin  `json:"sevenDay"`
		Scoped   []accountWin `json:"scoped"`
		Spend    *struct {
			Used     float64 `json:"used"`
			Limit    float64 `json:"limit"`
			Currency string  `json:"currency"`
		} `json:"spend"`
	} `json:"windows"`
	Pace struct {
		SevenDay *struct {
			ExpectedPct           float64 `json:"expectedPct"`
			AheadOfPace           bool    `json:"aheadOfPace"`
			ProjectedExhaustionAt int64   `json:"projectedExhaustionAt"`
			WillLastToReset       bool    `json:"willLastToReset"`
		} `json:"sevenDay"`
	} `json:"pace"`
	Stale             bool  `json:"stale"`
	AgeSeconds        int64 `json:"ageSeconds"`
	BackoffUntil      int64 `json:"backoffUntil"`
	LoginExpiresAt    int64 `json:"loginExpiresAt"`
	LoginExpiringSoon bool  `json:"loginExpiringSoon"`
}

type accountsOut struct {
	ActiveID string       `json:"activeId"`
	Accounts []accountRow `json:"accounts"`
}

func (a accountRow) label() string {
	if a.Alias != "" {
		return a.Alias + " <" + a.Email + ">"
	}
	return a.Email
}

var accountSubs = map[string]peerSub{
	"list":   {0, false, nil, []string{"json"}, accountList},
	"add":    {0, false, nil, nil, accountAdd},
	"switch": {0, true, []string{"strategy"}, nil, accountSwitch},
	"usage":  {0, true, nil, []string{"refresh", "json"}, accountUsageCmd},
}

func runDmctlAccount(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprint(stderr, dmctlAccountHelp)
		return 2
	}
	sub, rest := args[0], args[1:]
	if sub == "-h" || sub == "--help" || sub == "help" {
		fmt.Fprint(stdout, dmctlAccountHelp)
		return 0
	}
	spec, ok := accountSubs[sub]
	if !ok {
		fmt.Fprintf(stderr, "dmctl account: 모르는 하위 명령 %q\n", sub)
		fmt.Fprint(stderr, dmctlAccountHelp)
		return 2
	}
	pa, err := parsePeerArgs(rest, spec.flags, spec.bools)
	if pa.help {
		fmt.Fprint(stdout, dmctlAccountHelp)
		return 0
	}
	if err == nil && !spec.rest && len(pa.pos) != spec.positional {
		err = fmt.Errorf("인자가 %d 개여야 합니다", spec.positional)
	}
	if err != nil {
		fmt.Fprintf(stderr, "dmctl account %s: %v\n", sub, err)
		return 2
	}
	return spec.run(pa, stdout, stderr)
}

func accountAPI(method, path string, body map[string]any, stderr io.Writer) ([]byte, int) {
	var (
		status int
		raw    []byte
		err    error
	)
	if method == "GET" {
		status, raw, err = httpGet(baseURL() + path)
	} else {
		status, raw, err = httpPostJSONWithin(baseURL()+path, body, accountCallBudget)
	}
	return apiResultWith(status, raw, err, stderr, printPeerRefusal)
}

func loadAccounts(stderr io.Writer) (accountsOut, []byte, int) {
	raw, rc := accountAPI("GET", "/api/claude-accounts", nil, stderr)
	if rc != 0 {
		return accountsOut{}, nil, rc
	}
	var v accountsOut
	if err := json.Unmarshal(raw, &v); err != nil {
		fmt.Fprintf(stderr, "dmctl account: 응답을 읽지 못했습니다: %v\n", err)
		return accountsOut{}, nil, 1
	}
	return v, raw, 0
}

func accountList(pa peerArgs, stdout, stderr io.Writer) int {
	v, raw, rc := loadAccounts(stderr)
	if rc != 0 {
		return rc
	}
	if pa.bools["json"] {
		var m map[string]any
		_ = json.Unmarshal(raw, &m)
		m["schemaVersion"] = accountSchemaVersion
		b, _ := json.Marshal(m)
		fmt.Fprintln(stdout, clean(string(b)))
		return 0
	}
	for _, a := range v.Accounts {
		mark := "  "
		if a.ID == v.ActiveID {
			mark = "* "
		}
		extra := ""
		if a.Disabled {
			extra = "  disabled"
		}
		fmt.Fprintf(stdout, "%s%s  org=%s  id=%s%s\n", mark, clean(a.label()), clean(a.OrgName), clean(a.ID), extra)
	}
	return 0
}

func accountAdd(_ peerArgs, stdout, stderr io.Writer) int {
	raw, rc := accountAPI("POST", "/api/claude-accounts/add", map[string]any{}, stderr)
	if rc != 0 {
		return rc
	}
	var v struct {
		Created bool       `json:"created"`
		Account accountRow `json:"account"`
	}
	_ = json.Unmarshal(raw, &v)
	verb := "갱신"
	if v.Created {
		verb = "등록"
	}
	fmt.Fprintf(stdout, "%s: %s  id=%s\n", verb, clean(v.Account.label()), clean(v.Account.ID))
	return 0
}

// resolveAccount 는 id·별칭·이메일(대소문자 무시)로 계정을 찾는다.
func resolveAccount(v accountsOut, ref string) (accountRow, bool) {
	for _, a := range v.Accounts {
		if a.ID == ref || (a.Alias != "" && a.Alias == ref) || strings.EqualFold(a.Email, ref) {
			return a, true
		}
	}
	return accountRow{}, false
}

func accountSwitch(pa peerArgs, stdout, stderr io.Writer) int {
	strategy := pa.flags["strategy"]
	if (strategy == "") == (len(pa.pos) == 0) || len(pa.pos) > 1 {
		fmt.Fprint(stderr, "dmctl account switch: <계정> 하나 또는 --strategy 하나가 필요합니다\n")
		return 2
	}
	v, _, rc := loadAccounts(stderr)
	if rc != 0 {
		return rc
	}
	body := map[string]any{"strategy": strategy}
	if strategy == "" {
		a, ok := resolveAccount(v, pa.pos[0])
		if !ok {
			fmt.Fprintf(stderr, "dmctl account: 그런 계정이 없습니다: %s\n", clean(pa.pos[0]))
			return 1
		}
		body = map[string]any{"id": a.ID}
	}
	raw, rc := accountAPI("POST", "/api/claude-accounts/switch", body, stderr)
	if rc != 0 {
		return rc
	}
	var res struct {
		To   string `json:"to"`
		NoOp bool   `json:"noop"`
	}
	_ = json.Unmarshal(raw, &res)
	to, _ := resolveAccount(v, res.To)
	if res.NoOp {
		fmt.Fprintf(stdout, "이미 활성 계정입니다: %s\n", clean(to.label()))
		return 0
	}
	fmt.Fprintf(stdout, "전환: %s\n실행 중인 Claude Code 세션은 약 30초 안에, 또는 다시 시작할 때 새 계정을 씁니다.\n", clean(to.label()))
	return 0
}

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
func accountUsageCmd(pa peerArgs, stdout, stderr io.Writer) int {
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
			if _, rc := accountAPI("POST", "/api/claude-accounts/refresh", map[string]any{"id": a.ID}, stderr); rc != 0 {
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
