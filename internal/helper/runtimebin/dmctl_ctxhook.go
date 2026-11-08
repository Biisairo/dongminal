package runtimebin

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
)

// ISSUE_TREE_OPS_SRS 묶음 M — 맥락 훅 (FR-ITM-10~14).
//
// claude 의 PostToolUse·UserPromptSubmit 이 부른다. 판정은 서버가 한다 — 설정·트리
// 멤버 여부·사용률을 모두 서버가 안다(D-ITO-5). 이 명령은 판정을 additionalContext 로
// 옮길 뿐이며, **어떤 실패에도 조용히 0 으로 끝난다** — 훅이 에이전트를 막으면 안 된다.

const dmctlCtxHookHelp = `dmctl ctx-hook <agent> — 맥락 기준 migration 제안 (에이전트 훅에서 호출)

stdin 의 훅 JSON 에서 이벤트 이름을 읽고, 서버에 이 도구의 판정을 묻는다
(GET /api/tools/migration-advice). 설정 migrationHook(기본 끔)이 켜져 있고 맥락 사용률이
설정 migrationHookCtxPct(기본 50) 이상이면 additionalContext 로 /dongminal:migration 을 강하게 제안한다. 강제하지 않는다.
issue-tree 노드는 건너뛴다 — 그 노드는 issue-tree 설정과 절차를 따른다.
`

// hookStdinMax 는 훅 stdin 을 읽는 상한이다(activity·agent-context 와 같은 크기).
const hookStdinMax = 1 << 16

type ctxAdvice struct {
	Verdict string   `json:"verdict"`
	UsedPct *float64 `json:"usedPct"`
	CtxPct  int      `json:"ctxPct"`
}

func runDmctlCtxHook(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	for _, a := range args {
		if isHelpArg(a) {
			fmt.Fprint(stdout, dmctlCtxHookHelp)
			return 0
		}
	}
	var in struct {
		Event string `json:"hook_event_name"`
	}
	data, _ := io.ReadAll(io.LimitReader(stdin, hookStdinMax))
	_ = json.Unmarshal(data, &in)
	tool := selfToolID()
	if tool == "" || in.Event == "" {
		return 0
	}
	status, body, err := httpGetWithin(baseURL()+"/api/tools/migration-advice?id="+url.QueryEscape(tool), hookBudget)
	if err != nil || status != http.StatusOK {
		return 0
	}
	var adv ctxAdvice
	if json.Unmarshal(body, &adv) != nil {
		return 0
	}
	text := ctxAdviceText(adv)
	if text == "" {
		return 0
	}
	blob, err := json.Marshal(map[string]any{
		"hookSpecificOutput": map[string]any{"hookEventName": in.Event, "additionalContext": text},
	})
	if err != nil {
		return 0
	}
	stdout.Write(blob)
	fmt.Fprintln(stdout)
	return 0
}

// ctxAdviceText 는 판정의 문구다. 매 훅마다 사용률을 싣고 강하게 제안하되 강제하지
// 않는다 (사용자 결정 2026-11-06).
func ctxAdviceText(a ctxAdvice) string {
	switch a.Verdict {
	case "advise":
		if a.UsedPct == nil {
			return ""
		}
		return fmt.Sprintf("[dongminal] 지금 맥락 %.0f%% · 기준 %d%%. 이 세션을 /dongminal:migration 으로 새 세션에 넘겨라.\n"+
			"지금 맥락이 진행 중인 작업에 꼭 필요할 때(여러 파일에 걸친 수정을 반쯤 했거나, 디버깅 단서를 들고 있을 때)만 "+
			"지금 넘기지 않아도 된다 — 그 단계를 마친 뒤 넘긴다. 그 밖에는 지금 넘긴다.", *a.UsedPct, a.CtxPct)
	case "unknown":
		return "[dongminal] 맥락 사용률을 읽을 수 없어 migration 기준을 적용하지 못한다. 이 알림은 한 번만 나온다."
	}
	return ""
}
