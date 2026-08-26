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
  dmctl run member --run <uuid> --role <이름> --agent <id> --at <탭 uuid> [--brief <할 일>|-]
  dmctl run launch --member <uuid> [--model <m>] [--text] [--json]
  dmctl run report --outcome succeeded|failed --summary <3문장> [--files a,b] [--run <uuid>] [--member <uuid>]
  dmctl run status [--run <uuid>]
  dmctl run close  --run <uuid> [--force] [--keep-worktrees]
  dmctl run list

  --projection   dedicated-window(기본) | background | inline
                 전용 창이 기본이다 — 사용자 작업 공간을 침범하지 않는다.
  --isolation    none(기본) | per-run | per-member
                 격리는 명시적 선택이다. 병렬·편의는 격리 사유가 아니다.
                 per-run 은 Run 전체가 트리 하나를 공유하고, per-member 는
                 멤버마다 하나다. 격리 Run 은 **이 셸의 cwd 가 git 저장소일 때만**
                 시작된다 — 아니면 none 으로 낮추지 않고 그 자리에서 실패한다.
  --base         worktree 가 갈라져 나올 ref. 기본은 이 셸 cwd 의 HEAD 다.
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
	textOut    bool
	jsonOut    bool
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
		if a == "--keep-worktrees" {
			f.keepTrees = true
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
	if f.run == "" || f.role == "" || f.agent == "" || f.at == "" {
		fmt.Fprintln(stderr, "run member: --run·--role·--agent·--at 는 모두 필수다")
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
	raw, code := runPost("/api/runs/members", map[string]any{
		"runId": f.run, "role": f.role, "agent": f.agent, "id": f.at, "brief": f.brief,
	}, stderr)
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
	line := adapter.LaunchLine(f.model, got.Preamble)
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
	if len(rec.Cleanup) > 0 {
		fmt.Fprintln(stdout, "정리 대상 (에이전트 종료 후 dmctl close-tab --at <tabId>):")
		for _, c := range rec.Cleanup {
			fmt.Fprintf(stdout, "  role=%s  toolId=%s  tabId=%s  live=%v\n", c.Role, c.ToolID, c.TabID, c.Live)
		}
	}
	// 잔여물은 조용히 남기지 않는다 (FR-WKT-12). 지운 것은 굳이 나열하지 않는다 —
	// 목록이 길어지면 정작 남은 것이 묻힌다.
	var left []runWorktree
	for _, wt := range rec.Worktrees {
		if !wt.Removed {
			left = append(left, wt)
		}
	}
	if len(left) > 0 {
		fmt.Fprintf(stdout, "잔여물 %d건 (지우지 않았다):\n", len(left))
		for _, wt := range left {
			line := fmt.Sprintf("  %s  branch=%s  사유=%s", wt.Path, wt.Branch, wt.Residue)
			if wt.Detail != "" {
				line += "  (" + wt.Detail + ")"
			}
			fmt.Fprintln(stdout, line)
		}
	}
	return 0
}

// runWorktree 는 격리 멤버의 작업 트리와 그 정리 결과다 (FR-WKT-12).
type runWorktree struct {
	Path    string `json:"path"`
	Branch  string `json:"branch"`
	Base    string `json:"base"`
	Removed bool   `json:"removed"`
	Residue string `json:"residue"`
	Detail  string `json:"detail"`
}

type runMember struct {
	ID       string       `json:"id"`
	Role     string       `json:"role"`
	Agent    string       `json:"agent"`
	ToolID   string       `json:"toolId"`
	TabID    string       `json:"tabId"`
	State    string       `json:"state"`
	Outcome  string       `json:"outcome"`
	Summary  string       `json:"summary"`
	Worktree *runWorktree `json:"worktree"`
}

type runRecord struct {
	ID         string       `json:"id"`
	Short      string       `json:"short"`
	Objective  string       `json:"objective"`
	Projection string       `json:"projection"`
	Isolation  string       `json:"isolation"`
	State      string       `json:"state"`
	WindowID   string       `json:"windowId"`
	Repo       string       `json:"repo"`
	Base       string       `json:"base"`
	Worktree   *runWorktree `json:"worktree"`
	Members    []runMember  `json:"members"`
}

func printRun(stdout io.Writer, rec runRecord, withMembers bool) {
	fmt.Fprintf(stdout, "run=%s  short=%s  state=%s  projection=%s  isolation=%s  members=%d  objective=%s\n",
		rec.ID, rec.Short, rec.State, rec.Projection, rec.Isolation, len(rec.Members), rec.Objective)
	if !withMembers {
		return
	}
	if rec.Repo != "" {
		fmt.Fprintf(stdout, "  repo=%s  base=%s\n", rec.Repo, rec.Base)
	}
	if rec.Worktree != nil {
		printWorktree(stdout, *rec.Worktree, "  공유 트리")
	}
	for _, m := range rec.Members {
		line := fmt.Sprintf("  role=%s  state=%s  agent=%s  toolId=%s  tabId=%s", m.Role, m.State, m.Agent, m.ToolID, m.TabID)
		if m.Outcome != "" {
			line += "  outcome=" + m.Outcome
		}
		fmt.Fprintln(stdout, line)
		if m.Summary != "" {
			fmt.Fprintf(stdout, "    %s\n", m.Summary)
		}
		if m.Worktree != nil {
			printWorktree(stdout, *m.Worktree, "    트리")
		}
	}
}

// printWorktree 는 작업 트리 한 줄이다. 잔여물이 있으면 그 사실을 함께 낸다 —
// 조회는 close 를 지켜보지 못한 세션이 잔여물을 알 유일한 경로다 (FR-WKT-12).
func printWorktree(stdout io.Writer, wt runWorktree, label string) {
	line := fmt.Sprintf("%s %s  branch=%s", label, wt.Path, wt.Branch)
	if wt.Base != "" {
		line += "  base=" + wt.Base
	}
	switch {
	case wt.Residue != "":
		line += "  잔여물=" + wt.Residue
	case wt.Removed:
		line += "  (정리됨)"
	}
	fmt.Fprintln(stdout, line)
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
