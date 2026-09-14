package runtimebin

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strconv"

	"dongminal/internal/shared/dmenv"
)

const dmctlHelp = `dmctl — dongminal 워크스페이스 원격 제어 CLI

사용법:
  dmctl new-window [--name <이름>] [-n] [--cwd <경로>] [--sandbox <프로파일>] [--workdir <경로>]
                                         # -n: 백그라운드 생성 (포커스 유지)
                                         # --sandbox: 그 창의 도구를 컨테이너 안에서 실행
                                         # --workdir: 샌드박스 창의 작업 폴더
  dmctl new-tab [--name <이름>] [-n] [--at <uuid>] [--agent <id>]
                                         # --at: 그 **탭**이 속한 칸에 연다 (칸 uuid 가 아니다).
                                         #       생략하면 포커스 칸이다 — 부르는 쪽이 아니다
                                         # --agent: 터미널 대신 에이전트 도구 탭 (예: claude)
  dmctl split-h [N]      # 가로 분할. N 지정 시 N 개로 균등 분할 (기본 2)
  dmctl split-v [N]      # 세로 분할. N 지정 시 N 개로 균등 분할 (기본 2)
  dmctl focus <uuid>     # uuid = list-workspace 의 uuid 컬럼 값 (좌표/라벨/toolId 거부)
  dmctl close-tab [--at <uuid>] [--force | --background]
  dmctl close-window [--at <uuid>] [--force | --background]
                                         # 프로세스가 도는 탭은 브라우저가 확인창을 띄운다.
                                         # --force: 그냥 닫는다 · --background: 도구를 살리고 탭만 지운다
  dmctl window-next / window-prev
  dmctl tab-next / tab-prev
  dmctl tool-up / tool-down / tool-left / tool-right
  dmctl rename-tab --at <uuid> <이름>      # 탭 표시 이름 변경 (역할명 부여 등)
  dmctl rename-tab --at <uuid> --auto      # 탭 이름을 자동(전경 프로세스)으로 되돌린다
  dmctl rename-window --at <uuid> <이름>  # 그 도구가 속한 창 이름 변경
  dmctl open-editor --at <uuid> [--name <이름>] <파일 절대경로>
  dmctl open-url <url>   # 보고 있는 기기의 브라우저로 연다
  dmctl list-workspace [--json]         # 열린 도구 목록 (uuid 포함, ▶=현재 포커스)
  dmctl who-am-i [--json]           # 현재 쉘이 속한 탭의 식별 정보
  dmctl notify [label]              # 현재 도구에 주의 알림 (에이전트 hook 에서 호출)
  dmctl activity <agent>            # 현재 도구의 작업 상태 보고 (stdin hook JSON 파싱)
  dmctl agent-context               # 세션 상시 주입 컨텍스트 (에이전트 hook 에서 호출)
  dmctl send <action> [json-args]   # raw 전송

에이전트 접합면 — 다른 도구의 화면을 읽고 입력을 넣는다:
  dmctl read-screen [--at <uuid>] [--bytes N]   # ANSI 제거 텍스트 (기본 16384)
  dmctl read-output [--at <uuid>] [--bytes N]   # raw 바이트, ANSI 포함 (기본 8192)
  dmctl send-input --at <uuid> [--execute] <텍스트>   # 쉘 대상. - 또는 생략 시 stdin
  dmctl msg --to <uuid> [--from <uuid>] <메시지>      # 에이전트 대상 (신뢰 엔벨로프)
  dmctl status [--at <uuid> | --member <uuid>] [--json]      # 그 도구의 에이전트 상태
  dmctl wait [--at <uuid> | --member <uuid>] --for ready|done [--timeout-ms N]  # 상태 대기 (서버 long-poll)

오케스트레이션 실행 기록 — 누가 어느 Run 의 팀원인가:
  dmctl run start --objective <목적> [--projection <p>] [--isolation <i>]
  dmctl run member --run <uuid> --role <이름> --agent <id> --at <탭 uuid> [--brief -]
  dmctl run launch --member <uuid> [--model <m>]   # 기동줄(프리앰블 포함)을 낸다
  dmctl run report --outcome succeeded|failed --summary <3문장>
  dmctl run status [--run <uuid>] / dmctl run list / dmctl run close --run <uuid>
  dmctl run delete --run <uuid> / dmctl run graph --run <uuid>

  레이아웃 명령은 구독 중인 브라우저가 없으면(delivered=0) exit 1 이다 — 아무것도
  만들어지지 않았다. 생성 명령이 결과를 받지 못해도(timedOut) exit 1 이다.

  여러 에이전트를 팀으로 묶는 절차는 /dongminal:team 스킬에 있다.
  각 서브커맨드의 상세는 dmctl <서브커맨드> --help 로 본다.

위치 식별자 — uuid 만 허용:
  --at / -l / --to / --from / focus 의 인자 전부가 여기에 해당한다.
  - tab uuid: list-workspace 의 "uuid=" 컬럼 값 (예: 550e8400-... 또는 짧은 형식 모두 OK).
  - 좌표(4.1.1)·라벨(W4.P1.T1)은 거부 (400 응답).
    이유: 라벨/좌표는 다른 창 닫힘 시 reflow 되어 다른 탭을 가리킨다.

  경로별로 받는 값이 조금 다르다:
    레이아웃 (new-tab/split-*/focus/close-*/rename-*/open-editor)
      탭 uuid 만. 좌표·라벨·toolId 는 거부.
    접합면 (read-screen/read-output/send-input/msg/status/wait/run member)
      탭 uuid 또는 살아있는 toolId. 좌표·라벨은 거부.

  list-workspace 의 "label=" 컬럼은 화면을 읽기 위한 표시 전용이다 — 입력 식별자가
  아니다. 명령에 넣을 값은 언제나 "uuid=" 컬럼에서 가져온다.
  서버는 uuid 를 broadcast 직전 좌표로 번역해 브라우저에 전달한다.

공통 플래그:
  --at <uuid>, -l <uuid>  특정 위치를 대상으로 실행 (기본: 현재 포커스).
                          uuid 만 허용.
  --no-focus, -n          명령 실행 전후로 사용자 포커스를 이동시키지 않는다.
                          new-window/-tab 에선 백그라운드 생성 (활성 탭도 유지).
  --name <이름>           new-window/new-tab 전용. 새 창/탭 이름 (최대 64자).
  --cwd <경로>            new-window 전용. 첫 도구가 뜰 절대경로. 생략하면 홈이다
                          (호출자의 cwd 를 물려받지 않는다).
  --workdir <경로>        new-window 전용. 샌드박스 창의 작업 폴더. 컨테이너 안
                          /work 에 붙는다. 생략하면 부르는 자리를 승계한다.
  --sandbox <프로파일>    new-window 전용. 창을 샌드박스로 연다 (scratch · dev).
                          그 창의 모든 탭이 하나의 컨테이너를 공유하며, 창을
                          닫으면 컨테이너도 사라진다. 컨테이너 런타임(docker)이
                          필요하고, 없으면 도구 생성이 실패한다.

환경변수:
  ` + dmenv.EnvPort + ` — 기본 ` + dmenv.DefaultPort + `
  ` + dmenv.EnvHost + ` — 기본 ` + dmenv.DefaultHost + `
`

func runDmctl(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprint(stdout, dmctlHelp)
		return 0
	}
	cmd := args[0]
	rest := args[1:]

	if code, handled := runDmctlSpecial(cmd, rest, stdout, stderr); handled {
		return code
	}

	parsed, err := parseDmctlFlags(rest)
	if err != nil {
		fmt.Fprintln(stderr, err.Error())
		return 2
	}

	return runDmctlWithFlags(cmd, parsed, stdout, stderr)
}

// runDmctlSpecial handles commands that don't need flag parsing
// (help, send, list-workspace, who-am-i, notify, activity).
// Returns (exitCode, true) if handled, (0, false) otherwise.
func runDmctlSpecial(cmd string, rest []string, stdout, stderr io.Writer) (int, bool) {
	switch cmd {
	case "-h", "--help", "help":
		fmt.Fprint(stdout, dmctlHelp)
		return 0, true
	case "send":
		return dmctlSend(rest, stdout, stderr), true
	case "list-workspace":
		return dmctlListWorkspace(rest, stdout, stderr), true
	case "who-am-i":
		return dmctlWhoAmI(rest, stdout, stderr), true
	case "notify":
		return runDmctlNotify(rest, stdout, stderr), true
	case "activity":
		return runDmctlActivity(rest, os.Stdin, stdout, stderr), true
	case "agent-context":
		return runDmctlAgentContext(rest, os.Stdin, stdout, stderr), true
	case "read-screen", "read-output":
		return runDmctlRead(cmd, rest, stdout, stderr), true
	case "send-input":
		return runDmctlSendInput(rest, os.Stdin, stdout, stderr), true
	case "msg":
		return runDmctlMsg(rest, os.Stdin, stdout, stderr), true
	case "open-editor":
		return runDmctlOpenEditor(rest, stdout, stderr), true
	case "open-url":
		return runOpenURL(rest, stdout, stderr), true
	case "status":
		return runDmctlStatus(rest, stdout, stderr), true
	case "wait":
		return runDmctlWait(rest, stdout, stderr), true
	case "run":
		return runDmctlRun(rest, stdout, stderr), true
	}
	return 0, false
}

// runDmctlWithFlags handles commands that require flag parsing
// (split, focus, rename, and simple actions lookup).
func runDmctlWithFlags(cmd string, parsed dmctlParsed, stdout, stderr io.Writer) int {
	switch cmd {
	case "split-h", "split-v":
		return runDmctlSplit(cmd, &parsed, stdout, stderr)
	case "focus":
		return runDmctlFocus(cmd, &parsed, stdout, stderr)
	case "rename-tab", "rename-window":
		return runDmctlRename(cmd, &parsed, stdout, stderr)
	case "close-tab", "close-window":
		return runDmctlClose(cmd, &parsed, stdout, stderr)
	}

	// FR-M9-4: 두 플래그는 닫기의 것이다. 다른 명령이 조용히 받으면 사용자는
	// 들은 줄 안다 — 받지 않는다는 사실을 그 자리에서 말한다.
	if parsed.force || parsed.background {
		fmt.Fprintf(stderr, "--force·--background 는 close-tab·close-window 에만 쓴다 (%s)\n", cmd)
		return 2
	}

	action, ok := dmctlSimpleActions[cmd]
	if !ok {
		fmt.Fprintf(stderr, "unknown command: %s\n", cmd)
		fmt.Fprint(stderr, dmctlHelp)
		return 2
	}
	args := parsed.buildArgs()
	// WORKBENCH_REVIEW_SRS FR-WBR-22 (UX_REVISION_SRS FR-CWD-4 폐기):
	//
	//   이전 동작: 부른 셸의 도구 id 를 `cwdTool` 로 실어, 새 창의 첫 도구가
	//             호출자와 같은 cwd 에서 떴다
	//   새  동작: 아무것도 싣지 않는다 — 새 창은 **홈**에서 뜬다
	//   이유:     사용자 지시("터미널은 홈에서 시작하는 것이 맞다"). "새로 뜨는
	//             창은 누가 열었든 홈" 이라는 규칙 하나가 예측 가능하다는 판단이며,
	//             호출자와 같은 자리가 필요한 쪽(팀 창)은 `--cwd` 로 **명시한다**
	//             (FR-WBR-23)
	return dmctlPost(action, args, stdout, stderr)
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
//	--force      → `force:true`     그냥 닫는다 (app-cmd.js 가 이미 받는 길, FR-RUN-6)
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
	return dmctlPost(dmctlSimpleActions[cmd], args, stdout, stderr)
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
		return dmctlPost(action, parsed.buildArgs(), stdout, stderr)
	}
	if parsed.location == "" || parsed.name == "" {
		fmt.Fprintf(stderr, "usage: dmctl %s --at <uuid> <name>  (또는 --name <name>)\n", cmd)
		return 2
	}
	return dmctlPost(action, parsed.buildArgs(), stdout, stderr)
}

var dmctlSimpleActions = map[string]string{
	"new-window":   "newWindow",
	"new-tab":      "newTab",
	"close-tab":    "closeTab",
	"close-window": "closeWindow",
	"window-next":  "windowNext",
	"window-prev":  "windowPrev",
	"tab-next":     "tabNext",
	"tab-prev":     "tabPrev",
	"tool-up":      "paneUp",
	"tool-down":    "paneDown",
	"tool-left":    "paneLeft",
	"tool-right":   "paneRight",
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
	// M9_SRS FR-M9-43: 새 탭을 **에이전트 도구**로 연다 (M9-B24 추가 요구).
	// 빈 값이면 터미널 탭이다 — `--kind` 를 따로 두지 않는 것이 요점이며, 두
	// 플래그가 서로를 부정하는 조합(`--kind terminal --agent claude`)을 애초에
	// 만들지 않는다.
	agent string
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
	// FR-M9-43: 없으면 **싣지 않는다.** 빈 값을 실으면 받는 쪽이 "에이전트가 빈
	// 에이전트 탭" 으로 읽는다 (FR-CBG-5 의 규약).
	if p.agent != "" {
		out["agent"] = p.agent
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
		case a == "--name":
			if i+1 >= len(args) {
				return p, fmt.Errorf("flag %s requires value", a)
			}
			p.name = args[i+1]
			i += 2
			continue
		case len(a) > 7 && a[:7] == "--name=":
			p.name = a[7:]
		case a == "--no-focus" || a == "-n":
			p.keepFocus = true
		// CONVENIENCE_SRS FR-TAN-22: 탭 이름을 자동(전경 프로세스 파생)으로
		// 되돌린다. rename-tab 전용이며 이름과 함께 쓰지 않는다.
		case a == "--auto":
			p.auto = true
		// FR-M9-43: new-tab 전용. 그 탭을 에이전트 도구로 연다 (M9-B24).
		case a == "--agent":
			if i+1 >= len(args) {
				return p, fmt.Errorf("flag %s requires value", a)
			}
			p.agent = args[i+1]
			i += 2
			continue
		case len(a) > 8 && a[:8] == "--agent=":
			p.agent = a[8:]
		// FR-SBX-11: new-window 전용. 그 창의 모든 도구가 대응 컨테이너 안에서 돈다.
		case a == "--sandbox":
			if i+1 >= len(args) {
				return p, fmt.Errorf("flag %s requires value", a)
			}
			p.sandbox = args[i+1]
			i += 2
			continue
		case len(a) > 10 && a[:10] == "--sandbox=":
			p.sandbox = a[10:]
		// FR-SBX-40: 그 창의 작업 폴더. 생략하면 부르는 자리를 승계한다.
		case a == "--workdir":
			if i+1 >= len(args) {
				return p, fmt.Errorf("flag %s requires value", a)
			}
			p.workdir = args[i+1]
			i += 2
			continue
		case len(a) > 10 && a[:10] == "--workdir=":
			p.workdir = a[10:]
		// WORKBENCH_REVIEW_SRS FR-WBR-23: 새 창의 첫 도구가 뜰 자리. 생략하면
		// 홈이다 (FR-WBR-20·22) — 승계는 더 이상 없다.
		case a == "--cwd":
			if i+1 >= len(args) {
				return p, fmt.Errorf("flag %s requires value", a)
			}
			p.cwd = args[i+1]
			i += 2
			continue
		case len(a) > 6 && a[:6] == "--cwd=":
			p.cwd = a[6:]
		// M9_SRS FR-M9-4: close-tab·close-window 전용. 브라우저가 이미 받는 두 답
		// (`force`·`keepTool`)을 dmctl 이 보낼 수 있게 한다.
		case a == "--force":
			p.force = true
		case a == "--background":
			p.background = true
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

// dmctlHTTPResult 는 POST 한 번의 결과를 dmctl 의 종료 코드로 옮긴다
// (DRIFT_RECLAIM_SRS FR-DRC-11).
//
// 같은 열두 줄이 세 자리에 있었다 (`dmctlPost` · `dmctlSend` · `dmctlNotify`).
// 그중 한 줄이 이 도구의 규약이다 — **서버가 준 본문이 개행으로 끝나지 않으면
// 하나 붙인다.** 셸에서 다음 프롬프트가 같은 줄에 붙으면 사용자는 출력이 잘린 것으로
// 읽는다. 세 벌로 두면 새 종단이 그 규약을 빠뜨려도 아무것도 알려주지 않는다.
//
// echo 는 **성공** 본문을 stdout 으로 되실을지다. notify 는 되싣지 않는다 — 훅에서
// 불리므로 성공을 조용히 지나야 한다.
func dmctlHTTPResult(prefix string, status int, resp []byte, err error, echo bool, stdout, stderr io.Writer) int {
	if err != nil {
		fmt.Fprintf(stderr, "%s: %v\n", prefix, err)
		return 1
	}
	if status >= 400 {
		stderr.Write(resp)
		if len(resp) == 0 || resp[len(resp)-1] != '\n' {
			fmt.Fprintln(stderr)
		}
		return 1
	}
	if echo {
		stdout.Write(resp)
		fmt.Fprintln(stdout)
	}
	return 0
}

func dmctlPost(action string, args map[string]any, stdout, stderr io.Writer) int {
	url := baseURL() + "/api/commands"
	body := map[string]any{"action": action, "args": args}
	status, resp, err := httpPostJSON(url, body)
	if code := dmctlHTTPResult("dmctl", status, resp, err, true, stdout, stderr); code != 0 {
		return code
	}
	return dmctlDelivery(resp, stderr)
}

// dmctlDelivery 는 `/api/commands` 응답의 **배달 사실**을 종료 코드로 옮긴다
// (M8_UNIFIED_SRS D-A-2, 10-func-backend FBE-02).
//
//	이전 동작: HTTP 200 이면 exit 0 — 브라우저가 없어도(`delivered:0`), 생성 명령이
//	          아무것도 만들지 못했어도(`timedOut:true`)
//	새  동작: `delivered==0` 이면 exit 1, 생성 명령이 `timedOut` 이면 exit 1. 본문은
//	          그대로 stdout 에 남는다
//	이유:     헬프의 팀 구성 절차(`new-tab` → `run member --at <새 uuid>`)가 exit 0 을
//	          "만들어졌다" 로 읽는다. 같은 종단의 `detach` 는 이미 이렇게 판정한다
//
// 판정은 필드가 **있을 때만**이다 — 그 필드를 모르는 응답을 0 으로 읽어 실패로
// 만들지 않는다. 모른다와 없다는 다르다.
func dmctlDelivery(resp []byte, stderr io.Writer) int {
	var got struct {
		Delivered *int  `json:"delivered"`
		TimedOut  *bool `json:"timedOut"`
	}
	if json.Unmarshal(resp, &got) != nil || got.Delivered == nil {
		return 0
	}
	if *got.Delivered == 0 {
		fmt.Fprintln(stderr, "dmctl: 구독 중인 브라우저가 없습니다 — 페이지를 새로고침하세요")
		return 1
	}
	if got.TimedOut != nil && *got.TimedOut {
		fmt.Fprintln(stderr, "dmctl: 브라우저가 결과를 답하지 않았습니다 — 만들어지지 않았을 수 있습니다. list-workspace 로 확인하세요")
		return 1
	}
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
	status, resp, err := httpPostJSON(url, body)
	if code := dmctlHTTPResult("dmctl", status, resp, err, true, stdout, stderr); code != 0 {
		return code
	}
	return dmctlDelivery(resp, stderr)
}
