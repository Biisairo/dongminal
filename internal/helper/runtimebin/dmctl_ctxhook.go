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
(GET /api/tools/migration-advice). 설정 migrationHook(기본 끔)이 켜져 있으면 additionalContext 로
알린다. 맥락 사용률이 기준 migrationHookCtxPct(기본 50)의 80% 이상이면 다음 일의 크기를 보고
/dongminal:migration 시점을 판단하라고 알리고, 85% 이상이면 판단 없이 지금 넘기라고 알린다.
issue-tree 노드는 건너뛴다 — 그 노드는 issue-tree 설정과 절차를 따른다.
`

// hookStdinMax 는 훅 stdin 을 읽는 상한이다(activity·agent-context 와 같은 크기).
const hookStdinMax = 1 << 16

type ctxAdvice struct {
	Verdict  string   `json:"verdict"`
	UsedPct  *float64 `json:"usedPct"`
	CtxPct   int      `json:"ctxPct"`
	JudgePct float64  `json:"judgePct"`
	CapPct   int      `json:"capPct"`
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

// ctxAdviceText 는 판정의 문구다. 매 훅마다 사용률을 싣는다. `advise` 는 넘길 시점을
// 판단하게 하고, `must` 는 판단 없이 넘기게 한다 (FR-ITM-12·16·23).
func ctxAdviceText(a ctxAdvice) string {
	switch a.Verdict {
	case "advise":
		if a.UsedPct == nil {
			return ""
		}
		return fmt.Sprintf("[dongminal] 지금 맥락 %.0f%% · 기준 %d%% (판단은 %.0f%% 부터, %d%% 이상이면 무조건 넘긴다).\n"+
			"기준쯤에서 넘기는 것이 좋다. 지금 하려는 일(또는 하던 일)을 끝냈을 때 맥락이 어디쯤일지 가늠하라.\n"+
			"- 기준을 크게 넘거나 %d%% 에 닿을 것 같으면: 그 일을 시작하지 말고 지금 넘겨라 — /dongminal:migration.\n"+
			"- 기준에서 크게 벗어나지 않을 것 같으면: 그 일을 끝내고 넘겨라. 끝냈을 때 아직 기준보다 한참 아래면 다음 일에서 다시 판단한다.\n"+
			"어느 쪽인지 지금 맥락·기준·예상치를 넣어 사용자에게 한 줄로 알려라.",
			*a.UsedPct, a.CtxPct, a.JudgePct, a.CapPct, a.CapPct)
	case "must":
		if a.UsedPct == nil {
			return ""
		}
		return fmt.Sprintf("[dongminal] 지금 맥락 %.0f%% — 상한 %d%% 에 닿았다. 판단하지 말고 지금 /dongminal:migration 으로 넘겨라.\n"+
			"넘기는 일 자체도 맥락을 쓴다. 자동 압축이 없는 세션은 100%% 에 닿으면 넘길 수 없다.", *a.UsedPct, a.CapPct)
	case "unknown":
		return "[dongminal] 맥락 사용률을 읽을 수 없어 migration 기준을 적용하지 못한다. 이 알림은 한 번만 나온다."
	}
	return ""
}
