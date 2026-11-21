package runtimebin

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"

	"dongminal/internal/shared/apipath"
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
                                               (3분 안에 조회했거나 물러나는 중이면 서버가 거절한다)
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

  새로 시작하는 Claude Code 세션부터 새 계정을 쓴다. 실행 중인 세션은 건드리지 않는다.
`

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

var accountSubs = map[string]subSpec{
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
	pa, err := parseSubArgs(rest, spec.flags, spec.bools)
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
	raw, code, _ := httpExit(status, raw, err, stderr, codeRule())
	return raw, code
}

func loadAccounts(stderr io.Writer) (accountsOut, []byte, int) {
	raw, rc := accountAPI("GET", apipath.ClaudeAccounts, nil, stderr)
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

func accountList(pa subArgs, stdout, stderr io.Writer) int {
	v, raw, rc := loadAccounts(stderr)
	if rc != 0 {
		return rc
	}
	if pa.bools["json"] {
		// FR-RDG-26 (DM-F5): 본문이 객체가 아니면(null) 빈 객체에서 시작한다 — 이전에는 nil 맵에 써서 panic 했다.
		var m map[string]any
		if json.Unmarshal(raw, &m) != nil || m == nil {
			m = map[string]any{}
		}
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

func accountAdd(_ subArgs, stdout, stderr io.Writer) int {
	raw, rc := accountAPI("POST", apipath.ClaudeAccountsAdd, map[string]any{}, stderr)
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

func accountSwitch(pa subArgs, stdout, stderr io.Writer) int {
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
	raw, rc := accountAPI("POST", apipath.ClaudeAccountsSwitch, body, stderr)
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
	fmt.Fprintf(stdout, "전환: %s\n새로 시작하는 Claude Code 세션부터 새 계정을 씁니다. 실행 중인 세션은 건드리지 않습니다.\n", clean(to.label()))
	if res.PinnedRunning {
		fmt.Fprintln(stdout, "이 계정은 고정 실행 중인 탭이 있습니다. 그 탭은 영향을 받지 않습니다.")
	}
	return 0
}
