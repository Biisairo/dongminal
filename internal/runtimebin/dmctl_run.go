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
	"strings"
)

const dmctlRunHelp = `dmctl run — 오케스트레이션 실행(Run) 기록

사용법:
  dmctl run start  --objective <목적> [--projection <p>] [--isolation <i>] [--window <uuid>]
  dmctl run member --run <uuid> --role <이름> --agent <id> --at <탭 uuid>
  dmctl run report --outcome succeeded|failed --summary <3문장> [--files a,b] [--run <uuid>] [--member <uuid>]
  dmctl run status [--run <uuid>]
  dmctl run close  --run <uuid> [--force]
  dmctl run list

  --projection   dedicated-window(기본) | background | inline
                 전용 창이 기본이다 — 사용자 작업 공간을 침범하지 않는다.
  --isolation    none(기본) | per-run | per-member
                 격리는 명시적 선택이다. 병렬·편의는 격리 사유가 아니다.
  --json         서버 응답을 그대로 낸다.

보고(report)의 권한은 **발신 도구의 정체**다. --run/--member 는 대조용이며
생략이 정상이다 — 남의 id 를 알아도 남의 몫을 보고할 수 없다.

close 는 미보고 멤버가 있으면 거부하고 목록을 낸다. --force 로만 넘어간다.
close 는 도구를 닫지 않는다 — 정리 대상을 돌려주므로, 조정자가 에이전트를
종료(예: /exit)시킨 뒤 dmctl close-tab --at <탭 uuid> 로 마무리한다. 실행 중인
도구의 탭을 서버가 바로 닫으면 브라우저가 확인창을 띄워 무인 정리가 막힌다.
`

type runFlags struct {
	run        string
	member     string
	role       string
	agent      string
	at         string
	objective  string
	projection string
	isolation  string
	window     string
	outcome    string
	summary    string
	files      string
	force      bool
	jsonOut    bool
}

// runDmctlRun implements FR-RUN-8.
func runDmctlRun(args []string, stdout, stderr io.Writer) int {
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
		return runSubMember(f, stdout, stderr)
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
		"--at": &f.at, "-l": &f.at, "--objective": &f.objective, "--projection": &f.projection,
		"--isolation": &f.isolation, "--window": &f.window, "--outcome": &f.outcome,
		"--summary": &f.summary, "--files": &f.files,
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
		if a == "--json" {
			f.jsonOut = true
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

func runSubMember(f runFlags, stdout, stderr io.Writer) int {
	if f.run == "" || f.role == "" || f.agent == "" || f.at == "" {
		fmt.Fprintln(stderr, "run member: --run·--role·--agent·--at 는 모두 필수다")
		return 2
	}
	raw, code := runPost("/api/runs/members", map[string]any{
		"runId": f.run, "role": f.role, "agent": f.agent, "id": f.at,
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
	fmt.Fprintf(stdout, "member=%s  role=%s  agent=%s  toolId=%s  tabId=%s  state=%s\n",
		m.ID, m.Role, m.Agent, m.ToolID, m.TabID, m.State)
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
	raw, code := runPost("/api/runs/close", map[string]any{"runId": f.run, "force": f.force}, stderr)
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
	}
	if err := json.Unmarshal(raw, &rec); err != nil {
		fmt.Fprintf(stderr, "dmctl: invalid close response: %v\n", err)
		return 1
	}
	fmt.Fprintf(stdout, "run=%s  state=%s\n", rec.ID, rec.State)
	if len(rec.Cleanup) > 0 {
		fmt.Fprintln(stdout, "정리 대상 (에이전트 종료 후 dmctl close-tab --at <tabId>):")
		for _, c := range rec.Cleanup {
			fmt.Fprintf(stdout, "  role=%s  toolId=%s  tabId=%s  live=%v\n", c.Role, c.ToolID, c.TabID, c.Live)
		}
	}
	return 0
}

type runMember struct {
	ID      string `json:"id"`
	Role    string `json:"role"`
	Agent   string `json:"agent"`
	ToolID  string `json:"toolId"`
	TabID   string `json:"tabId"`
	State   string `json:"state"`
	Outcome string `json:"outcome"`
	Summary string `json:"summary"`
}

type runRecord struct {
	ID         string      `json:"id"`
	Short      string      `json:"short"`
	Objective  string      `json:"objective"`
	Projection string      `json:"projection"`
	Isolation  string      `json:"isolation"`
	State      string      `json:"state"`
	WindowID   string      `json:"windowId"`
	Members    []runMember `json:"members"`
}

func printRun(stdout io.Writer, rec runRecord, withMembers bool) {
	fmt.Fprintf(stdout, "run=%s  short=%s  state=%s  projection=%s  isolation=%s  members=%d  objective=%s\n",
		rec.ID, rec.Short, rec.State, rec.Projection, rec.Isolation, len(rec.Members), rec.Objective)
	if !withMembers {
		return
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
	}
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
