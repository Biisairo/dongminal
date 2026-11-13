package runtimebin

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"time"
)

// CLAUDE_ACCOUNTS_SRS FR-CAC-102·103 — Claude 다중 계정의 dmctl 명령.

const dmctlAccountHelp = `dmctl account — Claude 다중 계정

  dmctl account list [--json]                  등록한 계정 (* 는 활성 계정)
  dmctl account add                            Claude Code 에 지금 로그인한 계정을 등록한다
  dmctl account switch <id|별칭|이메일>          그 계정으로 전환한다
  dmctl account switch --strategy next|next-available|best
                                               next = 순서상 다음 계정 (제외한 계정은 건너뛴다)
                                               next-available = next 와 같되 한도가 찼거나 사용량을 모르는 계정도 건너뛴다
                                               best = 여유가 가장 큰 계정 (활성 계정보다 크지 않으면 전환하지 않는다)
  dmctl account usage [<계정>] [--refresh] [--json]
                                               사용량 (계정을 주지 않으면 모두). --refresh 는 먼저 바로 조회한다
                                               (1분 안에 조회했거나 물러나는 중이면 서버가 거절한다)
  dmctl account reset <계정> --program juniper_tide|cedar_ember [--grant <id>] [--yes]
                                               제한 초기화를 쓴다. --yes 가 없으면 무엇을 채우는지 보이고 y 를 받아야 보낸다
                                               (juniper_tide = 주간 5시간 초기화, cedar_ember = 초기화 티켓, --grant 로 티켓을 고른다)
  dmctl account auto on|off|status [--json]    자동 전환을 켜고 끄거나 설정·상태를 본다
  dmctl account history [--limit N]            전환 기록 (최신 먼저, 기본 20건, 1~1000)
  dmctl account pin [--tab <toolId>] <계정>|--clear
                                               탭에 계정을 지정하거나 푼다 (기본은 이 탭). 탭을 닫으면 지정이 지워진다
  dmctl account map <계정> [경로]              폴더(기본은 현재 폴더)와 그 아래에서 claude 를 이 계정으로 실행한다
  dmctl account unmap [경로]                   폴더 연결을 푼다 (기본은 현재 폴더)
  dmctl account maps                           폴더 연결과 탭 지정 목록

  탭 지정이 폴더 연결보다 앞선다. 지정은 실행 중인 claude 에는 적용되지 않고 다음 실행부터 적용된다.

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
	Resets            *struct {
		Juniper *struct {
			Eligible        bool  `json:"eligible"`
			Available       bool  `json:"available"`
			NextAvailableAt int64 `json:"nextAvailableAt"`
		} `json:"juniperTide"`
		Cedar *struct {
			Eligible bool           `json:"eligible"`
			Grants   []accountGrant `json:"grants"`
		} `json:"cedarEmber"`
	} `json:"resets"`
}

type accountGrant struct {
	ID              string   `json:"id"`
	Label           string   `json:"label"`
	ResetsTotal     int      `json:"resetsTotal"`
	ResetsLeft      int      `json:"resetsLeft"`
	EndsAt          int64    `json:"endsAt"`
	Clears          []string `json:"clears"`
	Paused          bool     `json:"paused"`
	UsableNow       bool     `json:"usableNow"`
	GivesBackWeekly bool     `json:"givesBackWeekly"`
}

func (g accountGrant) name() string {
	if g.Label != "" {
		return g.Label
	}
	return g.ID
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
	"list":    {0, false, nil, []string{"json"}, accountList},
	"add":     {0, false, nil, nil, accountAdd},
	"switch":  {0, true, []string{"strategy"}, nil, accountSwitch},
	"usage":   {0, true, nil, []string{"refresh", "json"}, accountUsageCmd},
	"reset":   {1, false, []string{"program", "grant"}, []string{"yes"}, accountReset},
	"auto":    {1, false, nil, []string{"json"}, accountAuto},
	"history": {0, false, []string{"limit"}, nil, accountHistory},
	"pin":     {0, true, []string{"tab"}, []string{"clear"}, accountPin},
	"map":     {0, true, nil, nil, accountMap},
	"unmap":   {0, true, nil, nil, accountUnmap},
	"maps":    {0, false, nil, nil, accountMaps},
}

func runDmctlAccount(args []string, stdout, stderr io.Writer) int {
	return runDmctlAccountStdin(os.Stdin, args, stdout, stderr)
}

func runDmctlAccountStdin(stdin io.Reader, args []string, stdout, stderr io.Writer) int {
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
	pa.stdin = stdin
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
		status, raw, err = httpJSONWithin(method, baseURL()+path, body, accountCallBudget)
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
	if strategy != "" && !accountStrategies[strategy] {
		fmt.Fprint(stderr, "dmctl account switch: --strategy 는 next, next-available, best 중 하나입니다\n")
		return 2
	}
	v, _, rc := loadAccounts(stderr)
	if rc != 0 {
		return rc
	}
	body := map[string]any{"strategy": strategy, "by": "dmctl"}
	if strategy == "" {
		a, ok := resolveAccount(v, pa.pos[0])
		if !ok {
			fmt.Fprintf(stderr, "dmctl account: 그런 계정이 없습니다: %s\n", clean(pa.pos[0]))
			return 1
		}
		body = map[string]any{"id": a.ID, "by": "dmctl"}
	}
	raw, rc := accountAPI("POST", "/api/claude-accounts/switch", body, stderr)
	if rc != 0 {
		return rc
	}
	var res struct {
		To            string `json:"to"`
		NoOp          bool   `json:"noop"`
		Reason        string `json:"reason"`
		PinnedRunning bool   `json:"pinnedRunning"`
	}
	_ = json.Unmarshal(raw, &res)
	to, _ := resolveAccount(v, res.To)
	if res.Reason != "" {
		fmt.Fprintf(stdout, "전환하지 않았습니다: %s\n", accountReasonText(res.Reason))
		return 0
	}
	if res.NoOp {
		fmt.Fprintf(stdout, "이미 활성 계정입니다: %s\n", clean(to.label()))
		return 0
	}
	fmt.Fprintf(stdout, "전환: %s\n실행 중인 Claude Code 세션은 약 30초 안에, 또는 다시 시작할 때 새 계정을 씁니다.\n", clean(to.label()))
	if res.PinnedRunning {
		fmt.Fprintln(stdout, "이 계정은 고정 실행 중인 탭이 있습니다. 그 탭은 영향을 받지 않습니다.")
	}
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
func accountReset(pa peerArgs, stdout, stderr io.Writer) int {
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
	raw, rc := accountAPI("POST", "/api/claude-accounts/reset", body, stderr)
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
