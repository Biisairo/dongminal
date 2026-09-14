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

// M9_SRS FR-M9-15 (D-A-10 — 분리는 **이동만**이다): `dmctl_run.go` 에서 옮겨 왔다.
//
// 여기 모인 것은 **서브커맨드 하나하나가 하는 일**이다. `dmctl_run.go` 에 남은 것은
// 헬프와 인자 해석, 그리고 어느 서브커맨드로 갈지를 정하는 갈래 하나다 — 명령이
// 늘어도 그 갈래는 한 줄씩만 자란다.

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
	// 프리앰블은 늦은 인수인계를 서버가 기다려 준다 (FR-RUN-4) — 그 상한만큼의 예산이다.
	raw, code := runGetWithin("/api/runs/preamble?"+q.Encode(), preambleBudget, stderr)
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
	// M8 D-A-4 (FBE-06·14): 기동줄이 싣지 못한 것을 **말한다.** `adapter.go` 가 "호출자가
	// 별도로 붙여넣어야 한다" 고 적은 그 호출자가 이 명령이고, 종전에는 신호가 없었다.
	// 종료 코드는 그대로 0 — 기동줄은 유효하다.
	for _, n := range launchNotes(adapter, got.MemberID, got.TabID, f.model) {
		fmt.Fprintln(stderr, "run launch: "+n)
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

// launchNotes 는 기동줄에 실리지 못한 것의 안내다 (M8 D-A-4). 비어 있으면 기동줄이
// 프리앰블·모델을 다 들었다는 뜻이다.
func launchNotes(a agentadapter.Adapter, memberID, tabID, model string) []string {
	var notes []string
	if a.PromptInjection != agentadapter.PromptArgv {
		at := tabID
		if at == "" {
			at = "<탭 uuid>"
		}
		notes = append(notes, fmt.Sprintf(
			"%s 는 기동줄에 프리앰블을 싣지 못한다 (%s). 뜬 뒤에 따로 붙여넣어라: "+
				"dmctl wait --at %s --for ready && dmctl run launch --member %s --text | dmctl send-input --at %s --execute -",
			a.ID, a.PromptInjection, at, memberID, at))
	}
	if model != "" && a.ModelFlag == "" {
		notes = append(notes, fmt.Sprintf("%s 의 모델 플래그를 모른다 — --model %s 를 생략했다", a.ID, model))
	}
	return notes
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
	// close 는 `/exit` 뒤 셸 복귀를 서버가 기다리고(FR-RUN-6) worktree 까지 거둔다 —
	// 10초 공용 클라이언트로는 정상 경로가 끊긴다 (M8 D-A-1).
	raw, code := runPostWithin("/api/runs/close", map[string]any{
		"runId": f.run, "force": f.force, "keepWorktrees": f.keepTrees,
		"keepTools": f.keepTools,
	}, closeBudget, stderr)
	if code != 0 {
		return code
	}
	if f.jsonOut {
		writeRawJSON(stdout, raw)
		return 0
	}
	var rec closeResponse
	if err := json.Unmarshal(raw, &rec); err != nil {
		fmt.Fprintf(stderr, "dmctl: invalid close response: %v\n", err)
		return 1
	}
	printCloseReport(stdout, rec)
	return 0
}

// closeResponse 는 `POST /api/runs/close` 의 응답 중 사람이 읽는 보고에 쓰는 부분이다.
