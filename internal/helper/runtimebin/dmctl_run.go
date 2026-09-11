// 묶음 R 의 CLI 절반이다 (RUN_ORCHESTRATION_SRS FR-RUN-8).
//
// 팀원 uuid 매핑표가 조정자의 대화 기록에만 있으면 컨텍스트 압축 한 번에 팀을
// 정리할 주체가 사라진다. `dmctl run` 은 그 기록을 서버로 옮긴다.
package runtimebin

import (
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"strings"

	"dongminal/internal/shared/agentadapter"
)

const dmctlRunHelp = `dmctl run — 오케스트레이션 실행(Run) 기록

사용법:
  dmctl run start  --objective <목적> [--projection <p>] [--isolation <i>] [--base <ref>] [--window <uuid>]
  dmctl run member --run <uuid> --role <이름> --agent <id> (--at <탭 uuid> | --headless)
                   [--brief <할 일>|-]
  dmctl run launch --member <uuid> [--model <m>] [--text] [--json]
  dmctl run report --outcome succeeded|failed --summary <3문장> [--files a,b] [--run <uuid>] [--member <uuid>]
  dmctl run status [--run <uuid>]
  dmctl run close  --run <uuid> [--force] [--keep-worktrees] [--keep-tools]
  dmctl run list
  dmctl run attach --member <uuid> [--at <탭 uuid>]
  dmctl run detach --member <uuid>
  dmctl run peers
  dmctl run succeed --member <uuid> (--at <탭 uuid> | --headless) [--model <m>] [--timeout-ms N]
  dmctl run handoff [--member <uuid>] --summary <본문>|-

  --projection   dedicated-window(기본) | background | inline
                 전용 창이 기본이다 — 사용자 작업 공간을 침범하지 않는다.
  --isolation    none(기본) | per-run | per-member
                 격리는 명시적 선택이다. 병렬·편의는 격리 사유가 아니다.
                 per-run 은 Run 전체가 트리 하나를 공유하고, per-member 는
                 멤버마다 하나다. 격리 Run 은 **이 셸의 cwd 가 git 저장소일 때만**
                 시작된다 — 아니면 none 으로 낮추지 않고 그 자리에서 실패한다.
  --base         worktree 가 갈라져 나올 ref. 기본은 이 셸 cwd 의 HEAD 다.
  --headless     탭을 점유하지 않는 멤버. --at 과 배타이며 **정확히 하나**여야 한다.
                 서버가 도구를 만들어 백그라운드(⏻)에 올린다. cwd 는 서버가
                 정한다 — 격리 Run 이면 그 멤버의 worktree, 아니면 이 셸의 cwd.
                 관측·제어는 탭 부착 멤버와 동등하다: toolId 로 read-screen·msg·
                 status 가 그대로 되고, 대기는 wait --member 를 쓴다.
  --keep-tools   close 가 헤드리스 멤버의 도구를 종료하지 않는다. 남긴 것은
                 이후 run status 의 고아 목록에 계속 나온다.
  --brief        이 멤버가 할 일의 본문. 프리앰블에 실리고 기록에 남는다.
                 값이 - 이면 stdin 에서 읽는다. 여러 줄이면 heredoc 을 써라.
  --model        기동할 모델. 그 에이전트의 모델 플래그가 확인된 경우에만 붙는다.
  --text         기동줄 대신 프리앰블 본문만 낸다.
  --json         서버 응답을 그대로 낸다 (launch 는 조립 결과를 낸다).

멤버를 띄우는 순서는 셋이다 — 지키지 않으면 첫 지시가 유실된다:

  1) dmctl run launch --member <uuid> | dmctl send-input --at <탭 uuid> --execute -
  2) dmctl wait --at <탭 uuid> --for ready          # 준비완료 확인 (FR-PRE-8)
  3) dmctl msg --to <탭 uuid> ...                   # Kickoff

2 를 건너뛰고 3 을 보내면 에이전트가 아직 뜨지 않아 셸에 텍스트가 찍히고 증발한다.
화면 모양으로 준비완료를 판정하지 마라 — wait 가 훅 상태를 근거로 판정한다.

보고(report)의 권한은 **발신 도구의 정체**다. --run/--member 는 대조용이며
생략이 정상이다 — 남의 id 를 알아도 남의 몫을 보고할 수 없다.

close 는 미보고 멤버가 있으면 거부하고 목록을 낸다. --force 로만 넘어간다.
이미 끝난 Run(closed·aborted)에 --force 를 주면 **정리 전용**으로 동작한다 — 남은
worktree 만 거두고 state·중단 사유는 그대로 둔다. 서버 재기동으로 aborted 된 Run 의
트리는 이 경로로 지운다.

격리 Run 의 정리 규칙: 작업 트리가 clean 이면 worktree 를 지우고 브랜치는 머지된
경우에만 지운다. **dirty 면 지우지 않고 잔여물로 보고한다** — 사용자 작업을 조용히
삭제하지 않는다. 전부 남기려면 --keep-worktrees. 정리하지 못한 것은 close 출력과
이후의 run status 양쪽에 남는다.
컨텍스트가 찬 멤버는 **승계**한다 (succeed). 같은 역할·brief·작업 트리를 새 멤버에게
그대로 물려주며, 격리 Run 이어도 worktree 를 새로 만들지 않는다 — 진행 중인 작업이
거기 있다. 승계는 이전 멤버에게 인수인계 요약을 청하고 기다렸다가(상한 --timeout-ms)
새 멤버를 만들며, 무응답이면 요약 없이 진행하고 그 사실을 프리앰블에 적는다.
이전 멤버는 succeeded 가 되고 close 의 미보고 검사에서 면제되지만, 그 **도구는 살아
있다** — 인수인계를 다 읽었으면 /exit → close-tab 으로 조정자가 정리한다.

handoff 는 승계당하는 멤버가 자기 요약을 남기는 명령이다. 권한은 발신 도구의
정체이며 --member 는 대조용이라 생략이 정상이다 — 남의 몫을 대신 남길 수 없다.

status 의 ctx= 는 전부 **추정**이다 (~ 표기). transcript 크기에서 환산한 값이고,
신호를 주지 않는 에이전트는 ctx=— (unknown) 으로 남는다. 모른다와 괜찮다는 다르다.

close 는 도구를 닫지 않는다 — 정리 대상을 돌려주므로, 조정자가 에이전트를
종료(예: /exit)시킨 뒤 dmctl close-tab --at <탭 uuid> 로 마무리한다. 실행 중인
도구의 탭을 서버가 바로 닫으면 브라우저가 확인창을 띄워 무인 정리가 막힌다.
`

type runFlags struct {
	run        string
	member     string
	role       string
	agent      string
	brief      string
	model      string
	at         string
	objective  string
	projection string
	isolation  string
	window     string
	outcome    string
	summary    string
	files      string
	base       string
	force      bool
	keepTrees  bool
	keepTools  bool // --keep-tools  묶음 H (FR-HLM-4)
	textOut    bool
	jsonOut    bool

	// ORCHESTRATION_V2 선등록 (PARALLEL_DELIVERY_PLAN Step 0-14). 플래그 파싱이
	// 서브커맨드와 무관한 단일 맵이라 이 구조체가 세 워크스트림의 공통 파일이다 —
	// 한 번에 열어 두면 이후 아무도 이 파일을 만지지 않는다.
	headless  bool   // --headless  묶음 H (FR-HLM-1)
	timeoutMs string // --timeout-ms 묶음 C (FR-CBG-9 의 인수인계 대기 상한)
}

// runDmctlRun implements FR-RUN-8. stdin 은 --brief - 만 소비한다.
func runDmctlRun(args []string, stdout, stderr io.Writer) int {
	return runDmctlRunStdin(os.Stdin, args, stdout, stderr)
}

func runDmctlRunStdin(stdin io.Reader, args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprint(stderr, dmctlRunHelp)
		return 2
	}
	if args[0] == "-h" || args[0] == "--help" {
		fmt.Fprint(stdout, dmctlRunHelp)
		return 0
	}
	sub := args[0]
	f, code, ok := parseRunFlags(sub, args[1:], stdout, stderr)
	if !ok {
		return code
	}
	switch sub {
	case "start":
		return runSubStart(f, stdout, stderr)
	case "member":
		return runSubMember(f, stdin, stdout, stderr)
	case "launch":
		return runSubLaunch(f, stdout, stderr)
	case "report":
		return runSubReport(f, stdout, stderr)
	case "status", "list":
		return runSubStatus(sub, f, stdout, stderr)
	case "close":
		return runSubClose(f, stdout, stderr)
	// ── ORCHESTRATION_V2 선등록 (PARALLEL_DELIVERY_PLAN Step 0-14) ──
	// 구현은 각 워크스트림의 전용 파일에 있다. 여기서 case 를 열어 두면 이후
	// 아무도 이 디스패치를 만지지 않는다.
	case "attach":
		return runSubAttach(f, stdout, stderr)
	case "detach":
		return runSubDetach(f, stdout, stderr)
	case "succeed":
		return runSubSucceed(f, stdout, stderr)
	case "handoff":
		return runSubHandoff(f, stdin, stdout, stderr)
	case "peers":
		return runSubPeers(f, stdout, stderr)
	}
	fmt.Fprintf(stderr, "run: 알 수 없는 서브커맨드: %s\n", sub)
	fmt.Fprint(stderr, dmctlRunHelp)
	return 2
}

func parseRunFlags(sub string, args []string, stdout, stderr io.Writer) (runFlags, int, bool) {
	f := runFlags{}
	str := map[string]*string{
		"--run": &f.run, "--member": &f.member, "--role": &f.role, "--agent": &f.agent,
		"--brief": &f.brief, "--model": &f.model,
		"--at": &f.at, "-l": &f.at, "--objective": &f.objective, "--projection": &f.projection,
		"--isolation": &f.isolation, "--window": &f.window, "--outcome": &f.outcome,
		"--summary": &f.summary, "--files": &f.files, "--base": &f.base,
		"--timeout-ms": &f.timeoutMs,
	}
	for i := 0; i < len(args); {
		a := args[i]
		if a == "-h" || a == "--help" {
			fmt.Fprint(stdout, dmctlRunHelp)
			return f, 0, false
		}
		if a == "--force" {
			f.force = true
			i++
			continue
		}
		if a == "--headless" {
			f.headless = true
			i++
			continue
		}
		if a == "--keep-worktrees" {
			f.keepTrees = true
			i++
			continue
		}
		if a == "--keep-tools" {
			f.keepTools = true
			i++
			continue
		}
		if a == "--json" {
			f.jsonOut = true
			i++
			continue
		}
		if a == "--text" {
			f.textOut = true
			i++
			continue
		}
		if p, ok := str[a]; ok {
			if i+1 >= len(args) {
				fmt.Fprintf(stderr, "run %s: flag %s requires value\n", sub, a)
				return f, 2, false
			}
			*p = args[i+1]
			i += 2
			continue
		}
		if eq := strings.IndexByte(a, '='); eq > 0 {
			if p, ok := str[a[:eq]]; ok {
				*p = a[eq+1:]
				i++
				continue
			}
		}
		fmt.Fprintf(stderr, "run %s: unknown argument: %s\n", sub, a)
		return f, 2, false
	}
	return f, 0, true
}

func runSubStart(f runFlags, stdout, stderr io.Writer) int {
	if strings.TrimSpace(f.objective) == "" {
		fmt.Fprintln(stderr, "run start: --objective 는 필수다")
		return 2
	}
	// 기본값은 사용자 공간 비침범 + 비격리다 (FR-SKL-1, FR-WKT-1).
	if f.projection == "" {
		f.projection = "dedicated-window"
	}
	if f.isolation == "" {
		f.isolation = "none"
	}
	body := map[string]any{
		"objective": f.objective, "projection": f.projection,
		"isolation": f.isolation, "toolId": selfToolID(),
	}
	if f.window != "" {
		body["windowId"] = f.window
	}
	if f.isolation != "none" {
		// 격리의 저장소·base 는 **조정자의 cwd** 에서 나온다 (FR-WKT-5). 서버는
		// 조정자가 어디서 일하는지 알 방법이 없으므로 여기서 실어 보낸다.
		wd, err := os.Getwd()
		if err != nil {
			fmt.Fprintf(stderr, "run start: 현재 디렉터리를 알 수 없다: %v\n", err)
			return 1
		}
		body["cwd"] = wd
		if f.base != "" {
			// - 로 시작하는 인자는 git 플래그로 오인된다 (FR-WKT-6). 서버도 막지만
			// 왕복 전에 알려 주는 편이 낫다.
			if strings.HasPrefix(f.base, "-") {
				fmt.Fprintf(stderr, "run start: --base 는 - 로 시작할 수 없다: %q\n", f.base)
				return 2
			}
			body["base"] = f.base
		}
	} else if f.base != "" {
		fmt.Fprintln(stderr, "run start: --base 는 격리 Run 에만 쓴다 (--isolation per-run|per-member)")
		return 2
	}
	raw, code := runPost("/api/runs", body, stderr)
	if code != 0 {
		return code
	}
	if f.jsonOut {
		writeRawJSON(stdout, raw)
		return 0
	}
	var rec runRecord
	if err := json.Unmarshal(raw, &rec); err != nil {
		fmt.Fprintf(stderr, "dmctl: invalid run response: %v\n", err)
		return 1
	}
	fmt.Fprintf(stdout, "run=%s  short=%s  state=%s  projection=%s  isolation=%s\n",
		rec.ID, rec.Short, rec.State, rec.Projection, rec.Isolation)
	return 0
}

func runSubMember(f runFlags, stdin io.Reader, stdout, stderr io.Writer) int {
	if f.run == "" || f.role == "" || f.agent == "" {
		fmt.Fprintln(stderr, "run member: --run·--role·--agent 는 모두 필수다")
		return 2
	}
	// FR-HLM-1: --at 과 --headless 는 배타이며 정확히 하나여야 한다. 거부는
	// 무엇을 줘야 하는지 말한다 — 어느 쪽이 빠졌는지 모르면 고칠 수 없다.
	if f.headless == (f.at != "") {
		fmt.Fprintln(stderr,
			"run member: --at <탭 uuid> 와 --headless 중 정확히 하나가 필요하다\n"+
				"  --at        그 탭의 도구를 멤버로 삼는다 (기본 — 사람이 지켜본다)\n"+
				"  --headless  탭 없이 서버가 도구를 만든다 (분할이 모자라거나 볼 이유가 없을 때)")
		return 2
	}
	// brief 는 보통 여러 줄이다. 값 - 는 stdin 을 뜻하며 send-input·msg 와 같은 규약이고
	// (FR-DMA-4/5), 조정자가 셸 따옴표와 씨름하지 않게 하는 것이 요점이다.
	// 지목하지 않았으면 읽지 않는다 — 읽으면 파이프 없는 호출이 멈춘다.
	if f.brief == "-" {
		data, err := io.ReadAll(stdin)
		if err != nil {
			fmt.Fprintf(stderr, "run member: stdin 읽기 실패: %v\n", err)
			return 2
		}
		f.brief = strings.TrimRight(string(data), "\n")
	}
	// 알 수 없는 에이전트 id 는 도구를 만들기 전에 여기서 걸러 준다. 서버도
	// 같은 검사를 하지만(FR-ADP-3), 조정자에게는 왕복 전에 알려 주는 편이 낫다.
	if _, err := agentadapter.Get(f.agent); err != nil {
		fmt.Fprintf(stderr, "run member: %v\n", err)
		return 2
	}
	body := map[string]any{
		"runId": f.run, "role": f.role, "agent": f.agent, "id": f.at, "brief": f.brief,
	}
	if f.headless {
		body["headless"] = true
		// 헤드리스 멤버의 cwd 는 서버가 확정하지만(FR-HLM-2), 격리가 아닌 Run 에서
		// 그 값은 **조정자의 cwd** 다. 서버는 조정자가 어디서 일하는지 알 방법이
		// 없으므로 run start 와 같은 이유로 여기서 실어 보낸다 (FR-WKT-5 와 같은 규약).
		wd, err := os.Getwd()
		if err != nil {
			fmt.Fprintf(stderr, "run member: 현재 디렉터리를 알 수 없다: %v\n", err)
			return 1
		}
		body["cwd"] = wd
	}
	raw, code := runPost("/api/runs/members", body, stderr)
	if code != 0 {
		return code
	}
	if f.jsonOut {
		writeRawJSON(stdout, raw)
		return 0
	}
	var m runMember
	if err := json.Unmarshal(raw, &m); err != nil {
		fmt.Fprintf(stderr, "dmctl: invalid member response: %v\n", err)
		return 1
	}
	line := fmt.Sprintf("member=%s  role=%s  agent=%s  toolId=%s  tabId=%s  state=%s",
		m.ID, m.Role, m.Agent, m.ToolID, m.TabID, m.State)
	// 헤드리스는 tabId 가 비는 것으로도 알 수 있지만, 빈 값은 "없다" 와 "아직
	// 모른다" 를 구분하지 못한다. 의도를 명시한다 (FR-HLM-2).
	if m.Headless {
		line += "  headless=true"
	}
	// 격리 Run 이면 작업 트리를 같은 줄에 낸다 — 조정자가 기동 전에 cd 로
	// 보내야 하는 경로이고(도구의 셸은 ~ 에서 시작한다), 한 줄에서 뽑을 수
	// 있어야 스킬이 왕복을 더 만들지 않는다.
	if m.Worktree != nil && m.Worktree.Path != "" {
		line += fmt.Sprintf("  worktree=%s  branch=%s", m.Worktree.Path, m.Worktree.Branch)
	}
	fmt.Fprintln(stdout, line)
	return 0
}

// runSubLaunch 은 멤버를 띄울 때 셸에 넣을 것을 낸다 (FR-PRE-1).
//
// 프리앰블 본문은 **서버가 조립한다** — Run·Member uuid·조정자·worktree 를 서버가
// 이미 알고 있고, 그 안의 규칙은 서버가 실제로 강제하는 계약의 문장화이기
// 때문이다. CLI 가 하는 일은 그 평문을 어댑터가 선언한 기동 방식으로 감싸는
// 것뿐이다 — 셸에 타이핑하는 일은 클라이언트의 몫이다.
func runSubLaunch(f runFlags, stdout, stderr io.Writer) int {
	if f.member == "" {
		fmt.Fprintln(stderr, "run launch: --member 는 필수다 (run member 가 낸 uuid)")
		return 2
	}
	q := url.Values{}
	q.Set("member", f.member)
	raw, code := runGet("/api/runs/preamble?"+q.Encode(), stderr)
	if code != 0 {
		return code
	}
	var got struct {
		RunID    string `json:"runId"`
		MemberID string `json:"memberId"`
		Role     string `json:"role"`
		Agent    string `json:"agent"`
		TabID    string `json:"tabId"`
		Preamble string `json:"preamble"`
	}
	if err := json.Unmarshal(raw, &got); err != nil {
		fmt.Fprintf(stderr, "dmctl: invalid preamble response: %v\n", err)
		return 1
	}
	// 기록에 알 수 없는 에이전트가 들어 있다면 기본 에이전트로 폴백하지 않는다
	// (FR-ADP-3) — 엉뚱한 CLI 로 띄우면 멤버가 조용히 응답 불능이 된다.
	adapter, err := agentadapter.Get(got.Agent)
	if err != nil {
		fmt.Fprintf(stderr, "run launch: %v\n", err)
		return 1
	}
	if f.textOut {
		fmt.Fprint(stdout, got.Preamble)
		return 0
	}
	// FR-OMP-22: 멤버 인자에 런타임 자리가 있는 어댑터(omp)는 그 자리를 채워야
	// 한다. 채우지 못하면 **여기서 멈춘다** — 토큰이 그대로 타이핑되면 에이전트가
	// 없는 파일을 읽고 기동이 조용히 깨진다.
	line, err := adapter.LaunchLine(AgentHooksDir(), f.model, got.Preamble)
	if err != nil {
		fmt.Fprintf(stderr, "run launch: %v\n", err)
		return 1
	}
	if f.jsonOut {
		blob, err := json.Marshal(map[string]any{
			"runId": got.RunID, "memberId": got.MemberID, "role": got.Role,
			"agent": adapter.ID, "tabId": got.TabID,
			"promptInjection": string(adapter.PromptInjection),
			"launch":          line,
			"preamble":        got.Preamble,
		})
		if err != nil {
			fmt.Fprintf(stderr, "dmctl: %v\n", err)
			return 1
		}
		writeRawJSON(stdout, blob)
		return 0
	}
	fmt.Fprintln(stdout, line)
	return 0
}

func runSubReport(f runFlags, stdout, stderr io.Writer) int {
	// 서버에 가기 전에 막는다 — 실패를 산문에만 담는 보고를 만들지 않는다.
	if f.outcome != "succeeded" && f.outcome != "failed" {
		fmt.Fprintf(stderr, "run report: --outcome 은 succeeded 또는 failed 여야 한다: %q\n", f.outcome)
		return 2
	}
	if strings.TrimSpace(f.summary) == "" {
		fmt.Fprintln(stderr, "run report: --summary 는 필수다 (무엇을 했는가 / 무엇을 발견했는가 / 무엇이 남았는가)")
		return 2
	}
	body := map[string]any{
		"outcome": f.outcome, "summary": f.summary, "toolId": selfToolID(),
	}
	if f.run != "" {
		body["runId"] = f.run
	}
	if f.member != "" {
		body["memberId"] = f.member
	}
	if f.files != "" {
		parts := []string{}
		for _, p := range strings.Split(f.files, ",") {
			if p = strings.TrimSpace(p); p != "" {
				parts = append(parts, p)
			}
		}
		body["files"] = parts
	}
	raw, code := runPost("/api/runs/report", body, stderr)
	if code != 0 {
		return code
	}
	if f.jsonOut {
		writeRawJSON(stdout, raw)
		return 0
	}
	var m runMember
	_ = json.Unmarshal(raw, &m)
	fmt.Fprintf(stdout, "reported  member=%s  role=%s  outcome=%s  state=%s\n", m.ID, m.Role, m.Outcome, m.State)
	return 0
}

func runSubStatus(sub string, f runFlags, stdout, stderr io.Writer) int {
	path := "/api/runs"
	if sub == "status" && f.run != "" {
		q := url.Values{}
		q.Set("id", f.run)
		path += "?" + q.Encode()
	}
	raw, code := runGet(path, stderr)
	if code != 0 {
		return code
	}
	if f.jsonOut {
		writeRawJSON(stdout, raw)
		return 0
	}
	if strings.Contains(path, "id=") {
		var rec runRecord
		if err := json.Unmarshal(raw, &rec); err != nil {
			fmt.Fprintf(stderr, "dmctl: invalid run response: %v\n", err)
			return 1
		}
		printRun(stdout, rec, true)
		return 0
	}
	var list struct {
		Runs []runRecord `json:"runs"`
	}
	if err := json.Unmarshal(raw, &list); err != nil {
		fmt.Fprintf(stderr, "dmctl: invalid run list: %v\n", err)
		return 1
	}
	if len(list.Runs) == 0 {
		fmt.Fprintln(stdout, "(Run 없음)")
		return 0
	}
	for _, rec := range list.Runs {
		printRun(stdout, rec, false)
	}
	return 0
}

func runSubClose(f runFlags, stdout, stderr io.Writer) int {
	if f.run == "" {
		fmt.Fprintln(stderr, "run close: --run 은 필수다")
		return 2
	}
	raw, code := runPost("/api/runs/close", map[string]any{
		"runId": f.run, "force": f.force, "keepWorktrees": f.keepTrees,
		"keepTools": f.keepTools,
	}, stderr)
	if code != 0 {
		return code
	}
	if f.jsonOut {
		writeRawJSON(stdout, raw)
		return 0
	}
	var rec struct {
		ID      string `json:"id"`
		State   string `json:"state"`
		Cleanup []struct {
			Role   string `json:"role"`
			ToolID string `json:"toolId"`
			TabID  string `json:"tabId"`
			Live   bool   `json:"live"`
		} `json:"cleanup"`
		Worktrees []runWorktree `json:"worktrees"`
		Swept     bool          `json:"swept"`
		// 묶음 H — 헤드리스 도구의 수명 (FR-HLM-4/5). KeptTools 는 --keep-tools 로
		// 살려 둔 것이고, Orphans 는 그 결과 남은 것이다. 둘은 같은 도구를 가리키지만
		// 하나는 **선택**의 보고이고 하나는 **상태**의 보고다.
		KeptTools []runOrphan `json:"keptTools"`
		Orphans   []runOrphan `json:"orphans"`
		// UX_BATCH6_SRS FR-RUN-9: 서버가 **실제로 닫은** 탭. `Cleanup` 이 대상의
		// 목록이라면 이쪽은 결과의 목록이다.
		ClosedTabs []struct {
			Role   string `json:"role"`
			TabID  string `json:"tabId"`
			Exited bool   `json:"exited"`
			Empty  bool   `json:"empty"`
		} `json:"closedTabs"`
	}
	if err := json.Unmarshal(raw, &rec); err != nil {
		fmt.Fprintf(stderr, "dmctl: invalid close response: %v\n", err)
		return 1
	}
	if rec.Swept {
		fmt.Fprintf(stdout, "run=%s  state=%s  (정리 전용 — 상태는 바꾸지 않았다)\n", rec.ID, rec.State)
	} else {
		fmt.Fprintf(stdout, "run=%s  state=%s\n", rec.ID, rec.State)
	}
	/**
	 * UX_BATCH6_SRS FR-RUN-6·9: **닫는 일은 서버가 이미 했다.**
	 *
	 *   이전 동작: "정리 대상 (에이전트 종료 후 dmctl close-tab --at …)" 를 내고
	 *             조정자가 그 목록대로 쳤다
	 *   새  동작: 무엇을 닫았는지 보고한다. 칠 것이 남지 않는다
	 *   이유:     접수 ⑩·⑬ — 그 절차를 건너뛴 조정자가 탭과 창을 남겼다
	 *
	 * 닫지 못한 것이 있으면 그것만 남긴다 — 조용히 사라지는 자원이 없어야 한다는
	 * 규약은 잔여물·보존 도구와 같다.
	 */
	if len(rec.ClosedTabs) > 0 {
		fmt.Fprintf(stdout, "탭 %d건 정리:\n", len(rec.ClosedTabs))
		for _, c := range rec.ClosedTabs {
			if c.Empty {
				fmt.Fprintf(stdout, "  tabId=%s  (빈 탭)\n", c.TabID)
				continue
			}
			note := ""
			if !c.Exited {
				note = "  (에이전트가 시한 안에 끝나지 않았다)"
			}
			fmt.Fprintf(stdout, "  role=%s  tabId=%s%s\n", c.Role, c.TabID, note)
		}
	}
	// 닫히지 않은 채 남은 멤버 탭. `--keep-tools` 를 주었거나 도구가 이미 죽어
	// 대상에서 빠진 경우이며, 그 사실을 조정자가 알아야 한다.
	closed := map[string]bool{}
	for _, c := range rec.ClosedTabs {
		closed[c.TabID] = true
	}
	var left []int
	for i, c := range rec.Cleanup {
		if c.TabID != "" && !closed[c.TabID] {
			left = append(left, i)
		}
	}
	if len(left) > 0 {
		fmt.Fprintln(stdout, "남은 탭 (필요하면 dmctl close-tab --at <tabId>):")
		for _, i := range left {
			c := rec.Cleanup[i]
			fmt.Fprintf(stdout, "  role=%s  toolId=%s  tabId=%s  live=%v\n", c.Role, c.ToolID, c.TabID, c.Live)
		}
	}
	// 보존은 선택이므로 그 선택을 되짚어 준다 (FR-HLM-4). 보존도 **보고**된다.
	if len(rec.KeptTools) > 0 {
		fmt.Fprintf(stdout, "헤드리스 도구 %d건 보존 (--keep-tools):\n", len(rec.KeptTools))
		for _, o := range rec.KeptTools {
			fmt.Fprintf(stdout, "  role=%s  toolId=%s  memberId=%s\n", o.Role, o.ToolID, o.MemberID)
		}
	}
	printOrphans(stdout, rec.Orphans)
	// 잔여물은 조용히 남기지 않는다 (FR-WKT-12). 지운 것은 굳이 나열하지 않는다 —
	// 목록이 길어지면 정작 남은 것이 묻힌다.
	var leftTrees []runWorktree
	for _, wt := range rec.Worktrees {
		if !wt.Removed {
			leftTrees = append(leftTrees, wt)
		}
	}
	if len(leftTrees) > 0 {
		fmt.Fprintf(stdout, "잔여물 %d건 (지우지 않았다):\n", len(leftTrees))
		for _, wt := range leftTrees {
			line := fmt.Sprintf("  %s  branch=%s  사유=%s", wt.Path, wt.Branch, wt.Residue)
			if wt.Detail != "" {
				line += "  (" + wt.Detail + ")"
			}
			fmt.Fprintln(stdout, line)
		}
	}
	return 0
}

// runPost/runGet share the error rendering: an enumerated refusal reason is
// surfaced as-is so the caller can act on it (FR-PRE-6).
func runPost(path string, body map[string]any, stderr io.Writer) ([]byte, int) {
	status, raw, err := httpPostJSON(baseURL()+path, body)
	return runResult(path, status, raw, err, stderr)
}

func runGet(path string, stderr io.Writer) ([]byte, int) {
	status, raw, err := httpGet(baseURL() + path)
	return runResult(path, status, raw, err, stderr)
}

func runResult(path string, status int, raw []byte, err error, stderr io.Writer) ([]byte, int) {
	if err != nil {
		fmt.Fprintf(stderr, "dmctl: %v\n", err)
		return nil, 1
	}
	if status < 200 || status >= 300 {
		printRunRefusal(stderr, status, path, raw)
		return nil, 1
	}
	return raw, 0
}

// printRunRefusal renders the enumerated reason plus any list the server
// attached (close 의 미보고 멤버 등) — 거부를 뭉뚱그리지 않는다.
func printRunRefusal(stderr io.Writer, status int, path string, raw []byte) {
	var body struct {
		Error      string      `json:"error"`
		Detail     string      `json:"detail"`
		Unreported []runMember `json:"unreported"`
	}
	if err := json.Unmarshal(raw, &body); err != nil || body.Error == "" {
		printAPIError(stderr, status, path, raw)
		return
	}
	fmt.Fprintf(stderr, "dmctl run: %s (%d)\n", body.Error, status)
	if body.Detail != "" && body.Detail != body.Error {
		fmt.Fprintf(stderr, "  %s\n", body.Detail)
	}
	for _, m := range body.Unreported {
		fmt.Fprintf(stderr, "  미보고: role=%s  state=%s  memberId=%s\n", m.Role, m.State, m.ID)
	}
}
