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

  실행 중인 Claude Code 세션은 약 30초 안에, 또는 다시 시작할 때 새 계정을 쓴다.
`

// accountCallBudget 은 전환의 예산이다. 전환은 Claude Code 의 락 셋을 각각 최대 9초 기다린다.
const accountCallBudget = 40 * time.Second

// accountSchemaVersion 은 `--json` 출력의 형식 판이다 (FR-CAC-103).
const accountSchemaVersion = 1

type accountRow struct {
	ID       string `json:"id"`
	Email    string `json:"email"`
	OrgName  string `json:"organizationName"`
	Alias    string `json:"alias"`
	Disabled bool   `json:"disabled"`
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
