package runtimebin

import (
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
)

// dmctlCommand 는 dmctl 의 명령 하나다 (REFACTOR3_GO_STRUCT_SRS FR-RGS-43). 셋 중 하나가 찬다.
// 종전에는 같은 이름 목록이 분기 둘(플래그 없는 명령·플래그 명령)과 단순 액션 표로
// 셋에 나뉘어 있었다.
type dmctlCommand struct {
	// raw 는 자기 인자를 스스로 읽는다 — 레이아웃 플래그 파서를 지나지 않는다.
	raw func(cmd string, rest []string, stdout, stderr io.Writer) int
	// flagged 는 레이아웃 플래그(parseDmctlFlags)를 읽은 뒤 돈다.
	flagged func(cmd string, p *dmctlParsed, stdout, stderr io.Writer) int
	// action 은 플래그를 실어 그대로 보내는 원격 액션이다.
	action string
}

// rawArgs 는 args 만 받는 명령을 raw 로 감싼다.
func rawArgs(f func(rest []string, stdout, stderr io.Writer) int) func(string, []string, io.Writer, io.Writer) int {
	return func(_ string, rest []string, stdout, stderr io.Writer) int { return f(rest, stdout, stderr) }
}

// rawStdin 은 stdin 을 읽는 명령을 raw 로 감싼다.
func rawStdin(f func(rest []string, stdin io.Reader, stdout, stderr io.Writer) int) func(string, []string, io.Writer, io.Writer) int {
	return func(_ string, rest []string, stdout, stderr io.Writer) int { return f(rest, os.Stdin, stdout, stderr) }
}

// rawProxy 는 인자 없이 stdin 만 읽는 statusLine 프록시를 raw 로 감싼다.
func rawProxy(f func(stdin io.Reader, stdout, stderr io.Writer) int) func(string, []string, io.Writer, io.Writer) int {
	return func(_ string, _ []string, stdout, stderr io.Writer) int { return f(os.Stdin, stdout, stderr) }
}

func dmctlPrintHelp(_ string, _ []string, stdout, _ io.Writer) int {
	fmt.Fprint(stdout, dmctlHelp)
	return 0
}

// dmctlCommands 는 dmctl 의 명령 표 한 벌이다.
var dmctlCommands = map[string]dmctlCommand{
	"-h":             {raw: dmctlPrintHelp},
	"--help":         {raw: dmctlPrintHelp},
	"help":           {raw: dmctlPrintHelp},
	"send":           {raw: rawArgs(dmctlSend)},
	"list-workspace": {raw: rawArgs(dmctlListWorkspace)},
	"who-am-i":       {raw: rawArgs(dmctlWhoAmI)},
	"notify":         {raw: rawArgs(runDmctlNotify)},
	"activity":       {raw: rawStdin(runDmctlActivity)},
	"agent-context":  {raw: rawStdin(runDmctlAgentContext)},
	"ctx-hook":       {raw: rawStdin(runDmctlCtxHook)},
	"chat-mcp":       {raw: rawStdin(runDmctlChatMCP)},
	"read-screen":    {raw: runDmctlRead},
	"read-output":    {raw: runDmctlRead},
	"send-input":     {raw: rawStdin(runDmctlSendInput)},
	"msg":            {raw: rawStdin(runDmctlMsg)},
	"open-editor":    {raw: rawArgs(runDmctlOpenEditor)},
	"open-url":       {raw: rawArgs(runOpenURL)},
	"status":         {raw: rawArgs(runDmctlStatus)},
	"wait":           {raw: rawArgs(runDmctlWait)},
	"run":            {raw: rawArgs(runDmctlRun)},
	// PEER_NETWORK_SRS FR-PNW-73 (dmctl_edge.go).
	"edges": {raw: rawArgs(runDmctlEdges)},
	"edge":  {raw: rawArgs(runDmctlEdge)},
	// CLAUDE_ACCOUNTS_SRS FR-CAC-102 (dmctl_account.go).
	"account": {raw: rawArgs(runDmctlAccount)},
	// ISSUE_AGENT_TREE_SRS 묶음 G·O (dmctl_order.go).
	"move-tab":     {raw: runDmctlMove},
	"move-window":  {raw: runDmctlMove},
	"move-group":   {raw: runDmctlMove},
	"new-group":    {raw: runDmctlGroup},
	"rename-group": {raw: runDmctlGroup},
	"delete-group": {raw: runDmctlGroup},
	"list-groups":  {raw: rawArgs(runDmctlListGroups)},
	// ISSUE_AGENT_TREE_SRS 묶음 S: Claude Code 가 부르는 statusLine 프록시.
	"statusline": {raw: rawProxy(runDmctlStatusline)},
	// SUBAGENT_USAGE_SRS: Claude Code 가 부르는 subagentStatusLine 프록시.
	"subagent-statusline": {raw: rawProxy(runDmctlSubagentStatusline)},

	"split-h":       {flagged: runDmctlSplit},
	"split-v":       {flagged: runDmctlSplit},
	"focus":         {flagged: runDmctlFocus},
	"rename-tab":    {flagged: runDmctlRename},
	"rename-window": {flagged: runDmctlRename},
	"close-tab":     {flagged: runDmctlClose},
	"close-window":  {flagged: runDmctlClose},

	"new-window":  {action: "newWindow"},
	"new-tab":     {action: "newTab"},
	"window-next": {action: "windowNext"},
	"window-prev": {action: "windowPrev"},
	"tab-next":    {action: "tabNext"},
	"tab-prev":    {action: "tabPrev"},
	"tool-up":     {action: "paneUp"},
	"tool-down":   {action: "paneDown"},
	"tool-left":   {action: "paneLeft"},
	"tool-right":  {action: "paneRight"},
}

func runDmctl(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprint(stdout, dmctlHelp)
		return 0
	}
	cmd := args[0]
	rest := args[1:]
	c := dmctlCommands[cmd]
	if c.raw != nil {
		return c.raw(cmd, rest, stdout, stderr)
	}

	// ISSUE_AGENT_TREE_SRS NFR-ORD-1: 도움말을 청한 레이아웃 명령은 서버에 아무것도
	// 보내지 않는다. 파서가 `-h`·`--help` 를 건너뛰기만 해서 `close-tab --help` 가
	// 포커스 탭을 닫았다.
	if hasHelpFlag(rest) {
		fmt.Fprint(stdout, dmctlHelp)
		return 0
	}

	parsed, err := parseDmctlFlags(rest)
	if err != nil {
		fmt.Fprintln(stderr, err.Error())
		return 2
	}
	if c.flagged != nil {
		return c.flagged(cmd, &parsed, stdout, stderr)
	}

	// FR-M9-4: 두 플래그는 닫기의 것이다. 다른 명령이 조용히 받으면 사용자는
	// 들은 줄 안다 — 받지 않는다는 사실을 그 자리에서 말한다.
	if parsed.force || parsed.background {
		fmt.Fprintf(stderr, "--force·--background 는 close-tab·close-window 에만 쓴다 (%s)\n", cmd)
		return 2
	}

	if c.action == "" {
		fmt.Fprintf(stderr, "unknown command: %s\n", cmd)
		fmt.Fprint(stderr, dmctlHelp)
		return 2
	}
	post := parsed.buildArgs()
	// WORKBENCH_REVIEW_SRS FR-WBR-22 (UX_REVISION_SRS FR-CWD-4 폐기):
	//
	//   이전 동작: 부른 셸의 도구 id 를 `cwdTool` 로 실어, 새 창의 첫 도구가
	//             호출자와 같은 cwd 에서 떴다
	//   새  동작: 아무것도 싣지 않는다 — 새 창은 **홈**에서 뜬다
	//   이유:     사용자 지시("터미널은 홈에서 시작하는 것이 맞다"). "새로 뜨는
	//             창은 누가 열었든 홈" 이라는 규칙 하나가 예측 가능하다는 판단이며,
	//             호출자와 같은 자리가 필요한 쪽(팀 창)은 `--cwd` 로 **명시한다**
	//             (FR-WBR-23)
	return dmctlPost(c.action, post, stdout, stderr)
}

func hasHelpFlag(args []string) bool {
	for _, a := range args {
		if a == "-h" || a == "--help" {
			return true
		}
	}
	return false
}

func runDmctlSplit(cmd string, parsed *dmctlParsed, stdout, stderr io.Writer) int {
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
}

// runDmctlClose 는 `close-tab`·`close-window` 다 (M9_SRS FR-M9-4 / D-M9-4).
//
// 프로세스가 도는 탭을 닫으면 브라우저가 확인창을 띄운다 (FR-BG-3) — 그 탭에는
// 셸 프롬프트가 없어 detach 를 칠 수 없고, 바로 그 탭이 창을 띄우는 탭이다.
// dmctl 로 닫는 쪽에는 그 창에 답할 손이 없으므로, **답을 미리 싣는다.**
//
//	--force      → `force:true`     그냥 닫는다 (tool-cmd.js 가 이미 받는 길, FR-RUN-6)
//	--background → `keepTool:true`  도구를 살리고 탭만 지운다 (`detachTab` 과 같은 길, FR-BG-2)
//
// `--background` 도 `force` 를 함께 싣는다 — 답을 준 요청이 확인창을 만나면 그
// 자리에서 멎는다. 플래그가 없으면 아무것도 싣지 않으므로 기존 호출의 동작이 같다.
func runDmctlClose(cmd string, parsed *dmctlParsed, stdout, stderr io.Writer) int {
	if parsed.force && parsed.background {
		fmt.Fprintln(stderr, "--force 와 --background 는 함께 쓸 수 없다 (닫기의 답은 하나다)")
		return 2
	}
	args := parsed.buildArgs()
	if parsed.force || parsed.background {
		args["force"] = true
	}
	if parsed.background {
		args["keepTool"] = true
	}
	action := "closeTab"
	if cmd == "close-window" {
		action = "closeWindow"
	}
	return dmctlPost(action, args, stdout, stderr)
}

func runDmctlFocus(cmd string, parsed *dmctlParsed, stdout, stderr io.Writer) int {
	if parsed.location == "" && parsed.positional != "" {
		parsed.location = parsed.positional
	}
	if parsed.location == "" {
		fmt.Fprintln(stderr, "usage: dmctl focus <uuid>  (list-workspace 의 uuid 컬럼 값)")
		return 2
	}
	args := parsed.buildArgs()
	// Include source tool so the browser can route the focus only to
	// windows that actually show this tool (multi-window).
	if pid := selfToolID(); pid != "" {
		args["sourcePane"] = pid
	}
	return dmctlPost("focus", args, stdout, stderr)
}

func runDmctlRename(cmd string, parsed *dmctlParsed, stdout, stderr io.Writer) int {
	action := "renameTab"
	if cmd == "rename-window" {
		action = "renameWindow"
	}
	if parsed.name == "" && parsed.positional != "" {
		parsed.name = parsed.positional
	}
	// FR-TAN-22: --auto 는 이름을 지우는 것이 아니라 **출처**를 되돌린다. 이름과
	// 함께 오면 둘 중 무엇을 원한 것인지 알 수 없으므로 거부한다 — 추측하지 않는다.
	if parsed.auto {
		if cmd != "rename-tab" {
			fmt.Fprintln(stderr, "--auto 는 rename-tab 에만 쓴다 (창 이름에는 출처가 없다)")
			return 2
		}
		if parsed.name != "" {
			fmt.Fprintln(stderr, "--auto 와 이름은 함께 쓸 수 없다")
			return 2
		}
		if parsed.location == "" {
			fmt.Fprintln(stderr, "usage: dmctl rename-tab --at <uuid> --auto")
			return 2
		}
		return dmctlRenameConfirmed(action, parsed.buildArgs(),
			renameWant{tabID: parsed.location, auto: true}, stdout, stderr)
	}
	if parsed.location == "" || parsed.name == "" {
		fmt.Fprintf(stderr, "usage: dmctl %s --at <uuid> <name>  (또는 --name <name>)\n", cmd)
		return 2
	}
	return dmctlRenameConfirmed(action, parsed.buildArgs(),
		renameWant{tabID: parsed.location, name: parsed.name, window: cmd == "rename-window"}, stdout, stderr)
}

type dmctlParsed struct {
	location   string
	count      *int
	keepFocus  bool
	name       string
	auto       bool
	sandbox    string
	workdir    string
	cwd        string
	positional string
	// M9_SRS FR-M9-4: 닫기의 답을 미리 준다. 둘은 배타다 (D-M9-4).
	force      bool
	background bool
	// ISSUE_AGENT_TREE_SRS FR-WGR-33 · FR-ORD-11: 만들 때의 자리.
	group string
	after string
	index *int
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
	if p.name != "" {
		out["name"] = p.name
	}
	if p.auto {
		out["auto"] = true
	}
	// SANDBOX_WINDOW_SRS FR-SBX-11: 새 창의 샌드박스 프로파일. 빈 값이면 일반
	// 창이며, 그때 키 자체를 싣지 않는다.
	if p.sandbox != "" {
		out["sandbox"] = p.sandbox
	}
	// FR-SBX-40: 샌드박스 창의 작업 폴더. 컨테이너 안 /work 에 붙는다.
	if p.workdir != "" {
		out["workdir"] = p.workdir
	}
	// WORKBENCH_REVIEW_SRS FR-WBR-23: 새 창의 cwd 를 **명시**한다. `--workdir` 와
	// 다른 인자다 — 저쪽은 샌드박스 컨테이너 안의 자리를 말한다.
	if p.cwd != "" {
		out["cwd"] = p.cwd
	}
	if p.group != "" {
		out["group"] = p.group
	}
	if p.after != "" {
		out["after"] = p.after
	}
	if p.index != nil {
		out["index"] = *p.index
	}
	return out
}

func parseDmctlFlags(args []string) (dmctlParsed, error) {
	var p dmctlParsed
	var positional []string
	spec := argSpec{
		vals: map[string]func(string) error{
			"--at": setStr(&p.location), "-l": setStr(&p.location),
			"--name": setStr(&p.name),
			// FR-SBX-11: new-window 전용. 그 창의 모든 도구가 대응 컨테이너 안에서 돈다.
			"--sandbox": setStr(&p.sandbox),
			// FR-SBX-40: 그 창의 작업 폴더. 생략하면 부르는 자리를 승계한다.
			"--workdir": setStr(&p.workdir),
			// WORKBENCH_REVIEW_SRS FR-WBR-23: 새 창의 첫 도구가 뜰 자리. 생략하면
			// 홈이다 (FR-WBR-20·22) — 승계는 더 이상 없다.
			"--cwd": setStr(&p.cwd),
			// ISSUE_AGENT_TREE_SRS: new-window --group · new-tab --after/--index.
			"--group": setUUID(&p.group), "--after": setUUID(&p.after),
			"--index": setPositiveInt(&p.index),
		},
		bools: map[string]*bool{
			"--no-focus": &p.keepFocus, "-n": &p.keepFocus,
			// CONVENIENCE_SRS FR-TAN-22: 탭 이름을 자동(전경 프로세스 파생)으로
			// 되돌린다. rename-tab 전용이며 이름과 함께 쓰지 않는다.
			"--auto": &p.auto,
			// M9_SRS FR-M9-4: close-tab·close-window 전용. 브라우저가 이미 받는 두 답
			// (`force`·`keepTool`)을 dmctl 이 보낼 수 있게 한다.
			"--force": &p.force, "--background": &p.background,
		},
		// -h/--help 는 최상위 도움말의 몫이다 — 여기서는 건너뛴다.
		rest:     &positional,
		strictEq: true,
	}
	if _, e := spec.parse(args); e != nil {
		if e.kind == argNeedsValue {
			return p, fmt.Errorf("flag %s requires value", e.arg)
		}
		return p, errors.New(unknownArg(e.arg))
	}
	if len(positional) > 0 {
		p.positional = positional[0]
		for _, extra := range positional[1:] {
			p.positional += " " + extra
		}
	}
	return p, nil
}
