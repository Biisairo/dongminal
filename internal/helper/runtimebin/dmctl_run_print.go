// dmctl 의 run 출력이다 (RUN_ORCHESTRATION_SRS 묶음 R).
//
// `dmctl_run.go` 에서 갈라 나왔다 (DRIFT_RECLAIM_SRS FR-DRC-13). 이 패키지는 이미
// run 을 주제별로 갈라 두었고(`dmctl_run_context.go` · `_headless.go` · `_peers.go`),
// 남아 있던 두 덩어리가 **명령을 받는 쪽**과 **결과를 보이는 쪽**이었다.
//
// 여기 있는 타입들은 서버 응답을 읽기 위한 모양이며 **도메인 타입이 아니다** —
// `domain/run` 의 것을 그대로 쓰지 않는 이유는 이 바이너리가 서버 패키지를
// 참조하지 않기 때문이다. 필드가 갈리면 그 사실은 이 화면에서만 드러난다.
package runtimebin

import (
	"fmt"
	"io"
	"strings"
)

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

	// 묶음 H — 헤드리스 멤버 (FR-HLM-2). TabID 가 비는 것과 짝이며, 둘을 함께
	// 보아야 "지금 화면에 있나" 를 알 수 있다.
	Headless bool `json:"headless"`

	// 묶음 C — 컨텍스트 예산 (FR-CBG-13). 전부 서버측 추정이며, ContextLevel 이
	// 비어 있으면 **모른다**는 뜻이다 (FR-CBG-5).
	ContextRatio float64 `json:"contextRatio"`
	ContextLevel string  `json:"contextLevel"`
	CompactCount int     `json:"compactCount"`
	// UX_BATCH6_SRS FR-CTX-8: 비율의 **분자와 분모**. 조정자가 "200k 로 재고
	// 있나" 를 산문 없이 확인할 수 있어야 한다 (접수 ⑨).
	ContextTokens int64   `json:"contextTokens"`
	ContextLimit  float64 `json:"contextLimit"`
	SucceededFrom string  `json:"succeededFrom"`
}

// memberContext 는 멤버 행에 붙는 컨텍스트 조각이다 (FR-CBG-13).
//
// **추정임이 드러나야 한다** (NFR-CBG-3). 그래서 숫자에는 언제나 ~ 가 붙고,
// 모르는 것은 0% 가 아니라 — 로 나온다 — 관측되지 않는 에이전트가 여유로워
// 보이면 조정자가 그 멤버에게 큰 일을 준다.
func (m runMember) contextCell() string {
	if m.ContextLevel == "" {
		return "ctx=— (unknown)"
	}
	cell := fmt.Sprintf("ctx=~%d%% (%s)", int(m.ContextRatio*100+0.5), m.ContextLevel)
	// 실측 토큰이 있으면 분자와 분모를 함께 낸다 (FR-CTX-8). 없으면 종전대로
	// 비율만이며, 그때의 비율은 파일 크기 추정이다 (FR-CTX-4).
	if m.ContextTokens > 0 && m.ContextLimit > 0 {
		cell += fmt.Sprintf(" [%s/%s]", tokenShort(float64(m.ContextTokens)), tokenShort(m.ContextLimit))
	}
	if m.CompactCount > 0 {
		cell += fmt.Sprintf(" compact=%d", m.CompactCount)
	}
	return cell
}

// tokenShort 는 토큰 수를 자릿수가 읽히는 크기로 줄인다. 정확한 값은 기록의
// 것이고, 여기서 필요한 것은 "몇십만인가 몇백만인가" 다.
func tokenShort(v float64) string {
	switch {
	case v >= 1e6:
		return fmt.Sprintf("%.1fM", v/1e6)
	case v >= 1e3:
		return fmt.Sprintf("%.0fk", v/1e3)
	}
	return fmt.Sprintf("%.0f", v)
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

	// Orphans 는 끝난 Run 에 남은 살아있는 헤드리스 도구다 (FR-HLM-5).
	Orphans []runOrphan `json:"orphans"`
}

// runOrphan 은 거두지 못한 헤드리스 도구 하나다. worktree 잔여물과 같은 규약이며
// (FR-WKT-12), 조용히 남는 자원이 없어야 한다는 것이 그 규약의 요점이다.
type runOrphan struct {
	MemberID string `json:"memberId"`
	Role     string `json:"role"`
	ToolID   string `json:"toolId"`
}

func printRun(stdout io.Writer, rec runRecord, withMembers bool) {
	fmt.Fprintf(stdout, "run=%s  short=%s  state=%s  projection=%s  isolation=%s  members=%d  objective=%s\n",
		rec.ID, rec.Short, rec.State, rec.Projection, rec.Isolation, len(rec.Members), rec.Objective)
	if !withMembers {
		return
	}
	// FR-CBG-14: 컨텍스트가 위태로운 멤버는 **머리줄**에 낸다. 조정자가 멤버
	// 목록을 끝까지 읽지 않아도 보여야 한다.
	if alert := contextHeadline(rec.Members); alert != "" {
		fmt.Fprintf(stdout, "  %s\n", alert)
	}
	if rec.Repo != "" {
		fmt.Fprintf(stdout, "  repo=%s  base=%s\n", rec.Repo, rec.Base)
	}
	if rec.Worktree != nil {
		printWorktree(stdout, *rec.Worktree, "  공유 트리")
	}
	for _, m := range rec.Members {
		line := fmt.Sprintf("  role=%s  state=%s  agent=%s  toolId=%s  tabId=%s", m.Role, m.State, m.Agent, m.ToolID, m.TabID)
		if m.Headless {
			line += "  headless=true"
		}
		if m.Outcome != "" {
			line += "  outcome=" + m.Outcome
		}
		line += "  " + m.contextCell()
		if m.SucceededFrom != "" {
			line += "  승계←" + m.SucceededFrom
		}
		fmt.Fprintln(stdout, line)
		if m.Summary != "" {
			fmt.Fprintf(stdout, "    %s\n", m.Summary)
		}
		if m.Worktree != nil {
			printWorktree(stdout, *m.Worktree, "    트리")
		}
	}
	printOrphans(stdout, rec.Orphans)
}

// printOrphans 는 거두지 못한 헤드리스 도구를 낸다 (FR-HLM-5).
//
// 남은 것이 없으면 아무것도 찍지 않는다 — 조용할 때 조용한 것이 목록을 목록답게
// 만든다. 거두는 길을 함께 적는 이유는 worktree 잔여물과 같다: 조회가 close 를
// 지켜보지 못한 세션이 그것을 알 유일한 경로이므로, 알려 주고 끝내면 안 된다.
func printOrphans(stdout io.Writer, orphans []runOrphan) {
	if len(orphans) == 0 {
		return
	}
	fmt.Fprintf(stdout, "  고아 %d건 (헤드리스 도구가 살아 있다 — dmctl run close --run <uuid> --force 로 거둔다):\n",
		len(orphans))
	for _, o := range orphans {
		fmt.Fprintf(stdout, "    role=%s  toolId=%s  memberId=%s\n", o.Role, o.ToolID, o.MemberID)
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

// contextHeadline 은 warn 이상인 멤버를 한 줄로 요약한다 (FR-CBG-14).
// 아무도 위태롭지 않으면 빈 문자열이며, 그때는 아무것도 찍지 않는다 — 조용할
// 때 조용한 것이 경고를 경고답게 만든다.
func contextHeadline(members []runMember) string {
	var warn, critical []string
	for _, m := range members {
		switch m.ContextLevel {
		case "warn":
			warn = append(warn, m.Role)
		case "critical":
			critical = append(critical, m.Role)
		}
	}
	if len(warn) == 0 && len(critical) == 0 {
		return ""
	}
	parts := []string{}
	if len(critical) > 0 {
		parts = append(parts, fmt.Sprintf("critical %d명(%s)", len(critical), strings.Join(critical, ", ")))
	}
	if len(warn) > 0 {
		parts = append(parts, fmt.Sprintf("warn %d명(%s)", len(warn), strings.Join(warn, ", ")))
	}
	return "컨텍스트 주의(추정): " + strings.Join(parts, "  ") + " — 승계는 dmctl run succeed"
}
