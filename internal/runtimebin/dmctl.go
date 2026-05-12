package runtimebin

import (
	"encoding/json"
	"fmt"
	"io"
	"strconv"
)

const dmctlHelp = `dmctl — dongminal 워크스페이스 원격 제어 CLI

사용법:
  dmctl new-session
  dmctl new-tab
  dmctl split-h [N]      # 가로 분할. N 지정 시 N 개로 균등 분할 (기본 2)
  dmctl split-v [N]      # 세로 분할. N 지정 시 N 개로 균등 분할 (기본 2)
  dmctl focus <위치>     # 위치 = "4.1.1" / "S4.P1.T1" 좌표, 또는 tab UUID
  dmctl close-tab
  dmctl close-session
  dmctl session-next / session-prev
  dmctl tab-next / tab-prev
  dmctl pane-up / pane-down / pane-left / pane-right
  dmctl send <action> [json-args]   # raw 전송

위치 식별자:
  - "4.1.1" / "S4.P1.T1"     현재 레이아웃의 positional 좌표 (1-base, reflow 가능)
  - tab UUID (36자)          레이아웃 변경 무관한 안정 식별자. list_panes 의 uuid 필드.
  UUID 입력은 서버가 broadcast 직전에 좌표로 번역하여 브라우저에 전달한다.

공통 플래그:
  --at <위치>, -l <위치>  특정 위치를 대상으로 실행 (기본: 현재 포커스).
                          좌표/UUID 모두 가능.
  --no-focus, -n          명령 실행 전후로 사용자 포커스를 이동시키지 않는다.

환경변수:
  DONGMINAL_PORT — 기본 58146
  DONGMINAL_HOST — 기본 127.0.0.1
`

func runDmctl(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprint(stdout, dmctlHelp)
		return 0
	}
	cmd := args[0]
	rest := args[1:]

	switch cmd {
	case "-h", "--help", "help":
		fmt.Fprint(stdout, dmctlHelp)
		return 0
	case "send":
		return dmctlSend(rest, stdout, stderr)
	}

	parsed, err := parseDmctlFlags(rest)
	if err != nil {
		fmt.Fprintln(stderr, err.Error())
		return 2
	}

	switch cmd {
	case "split-h", "split-v":
		action := "splitH"
		if cmd == "split-v" {
			action = "splitV"
		}
		if parsed.positional != "" {
			n, err := strconv.Atoi(parsed.positional)
			if err != nil || n < 0 {
				fmt.Fprintf(stderr, "split count must be a positive integer: %s\n", parsed.positional)
				return 2
			}
			if n < 2 {
				fmt.Fprintln(stderr, "split count must be >= 2")
				return 2
			}
			parsed.count = &n
		}
		return dmctlPost(action, parsed.buildArgs(), stdout, stderr)
	case "focus":
		if parsed.location == "" && parsed.positional != "" {
			parsed.location = parsed.positional
		}
		if parsed.location == "" {
			fmt.Fprintln(stderr, "usage: dmctl focus <location>  (예: 4.1.1 또는 S4.P1.T1)")
			return 2
		}
		return dmctlPost("focus", parsed.buildArgs(), stdout, stderr)
	}

	action, ok := dmctlSimpleActions[cmd]
	if !ok {
		fmt.Fprintf(stderr, "unknown command: %s\n", cmd)
		fmt.Fprint(stderr, dmctlHelp)
		return 2
	}
	return dmctlPost(action, parsed.buildArgs(), stdout, stderr)
}

var dmctlSimpleActions = map[string]string{
	"new-session":   "newSession",
	"new-tab":       "newTab",
	"close-tab":     "closeTab",
	"close-session": "closeSession",
	"session-next":  "sessionNext",
	"session-prev":  "sessionPrev",
	"tab-next":      "tabNext",
	"tab-prev":      "tabPrev",
	"pane-up":       "paneUp",
	"pane-down":     "paneDown",
	"pane-left":     "paneLeft",
	"pane-right":    "paneRight",
}

type dmctlParsed struct {
	location   string
	count      *int
	keepFocus  bool
	positional string
}

func (p dmctlParsed) buildArgs() map[string]any {
	out := map[string]any{}
	if p.location != "" {
		out["location"] = p.location
	}
	if p.count != nil {
		out["count"] = *p.count
	}
	if p.keepFocus {
		out["keepFocus"] = true
	}
	return out
}

func parseDmctlFlags(args []string) (dmctlParsed, error) {
	var p dmctlParsed
	var positional []string
	i := 0
	for i < len(args) {
		a := args[i]
		switch {
		case a == "--at" || a == "-l":
			if i+1 >= len(args) {
				return p, fmt.Errorf("flag %s requires value", a)
			}
			p.location = args[i+1]
			i += 2
			continue
		case len(a) > 5 && a[:5] == "--at=":
			p.location = a[5:]
		case len(a) > 3 && a[:3] == "-l=":
			p.location = a[3:]
		case a == "--no-focus" || a == "-n":
			p.keepFocus = true
		case a == "-h" || a == "--help":
			// caller handles top-level help; ignore here
		case a == "--":
			positional = append(positional, args[i+1:]...)
			i = len(args)
			continue
		case len(a) > 0 && a[0] == '-':
			return p, fmt.Errorf("unknown flag: %s", a)
		default:
			positional = append(positional, a)
		}
		i++
	}
	if len(positional) > 0 {
		p.positional = positional[0]
		for _, extra := range positional[1:] {
			p.positional += " " + extra
		}
	}
	return p, nil
}

func dmctlPost(action string, args map[string]any, stdout, stderr io.Writer) int {
	url := baseURL() + "/api/commands"
	body := map[string]any{"action": action, "args": args}
	_, resp, err := httpPostJSON(url, body)
	if err != nil {
		fmt.Fprintf(stderr, "dmctl: %v\n", err)
		return 1
	}
	stdout.Write(resp)
	fmt.Fprintln(stdout)
	return 0
}

func dmctlSend(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprintln(stderr, "usage: dmctl send <action> [json-args]")
		return 2
	}
	action := args[0]
	var rawArgs any = map[string]any{}
	if len(args) >= 2 && args[1] != "" {
		if err := json.Unmarshal([]byte(args[1]), &rawArgs); err != nil {
			fmt.Fprintf(stderr, "dmctl: invalid json args: %v\n", err)
			return 2
		}
	}
	url := baseURL() + "/api/commands"
	body := map[string]any{"action": action, "args": rawArgs}
	_, resp, err := httpPostJSON(url, body)
	if err != nil {
		fmt.Fprintf(stderr, "dmctl: %v\n", err)
		return 1
	}
	stdout.Write(resp)
	fmt.Fprintln(stdout)
	return 0
}
