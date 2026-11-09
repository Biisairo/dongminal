package statusline

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

// SUBAGENT_USAGE_SRS — 서브에이전트 항목의 허용 목록 (TC-SAU-1).

// 2026-11-09 실측 입력에 effort·모르는 필드를 더한 표본. 둘째 원소는 effort 가 수(토큰 예산)다.
const subagentSample = `{"session_id":"9cfd","transcript_path":"/Users/x/.claude/projects/p/9cfd.jsonl",
"cwd":"PROJ","prompt_id":"598f","columns":238,"tasks":[
{"id":"a3b7","type":"local_agent","agentType":"Explore","status":"running","description":"secret plan",
"label":"secret label","name":"probe","startTime":1794204238088,"model":"claude-haiku-5-5","effort":"low",
"contextWindowSize":1000000,"tokenCount":19250,"tokenSamples":[0,17078,19250],"cwd":"PROJ","leak":"x"},
{"id":"b001","agentType":"Plan","status":"completed","effort":8000,"tokenCount":5},
{"agentType":"NoID","status":"running"}]}`

func subagentsJSON(t *testing.T, raw string) ([]map[string]any, bool) {
	t.Helper()
	tasks, ok := SubagentsFromInput([]byte(raw))
	blob, err := json.Marshal(tasks)
	if err != nil {
		t.Fatal(err)
	}
	var out []map[string]any
	if err := json.Unmarshal(blob, &out); err != nil {
		t.Fatal(err)
	}
	return out, ok
}

func TestSubagentsFromInput_Allowlist(t *testing.T) {
	got, ok := subagentsJSON(t, subagentSample)
	if !ok {
		t.Fatal("tasks 배열이 있는데 ok=false")
	}
	if len(got) != 2 {
		t.Fatalf("id 없는 원소는 버린다 (FR-SAU-4): %v", got)
	}
	want := map[string]any{
		"id": "a3b7", "agentType": "Explore", "status": "running", "model": "claude-haiku-5-5",
		"effort": "low", "windowTokens": float64(1000000), "tokens": float64(19250),
		"startTime": float64(1794204238088),
	}
	if fmt.Sprint(got[0]) != fmt.Sprint(want) {
		t.Fatalf("got  %v\nwant %v", got[0], want)
	}
	blob, _ := json.Marshal(got)
	for _, banned := range []string{"secret", "PROJ", "/Users/x", "leak", "probe", "tokenSamples", "local_agent"} {
		if strings.Contains(string(blob), banned) {
			t.Errorf("허용 목록 밖의 값 %q 이 나갔다 (FR-SAU-3): %s", banned, blob)
		}
	}
}

// FR-SAU-2: effort 가 수이면 effortBudget 으로 간다.
func TestSubagentsFromInput_EffortBudget(t *testing.T) {
	got, _ := subagentsJSON(t, subagentSample)
	if got[1]["effortBudget"] != float64(8000) {
		t.Fatalf("effortBudget: %v", got[1])
	}
	if _, ok := got[1]["effort"]; ok {
		t.Fatalf("수 effort 가 effort 에 실렸다: %v", got[1])
	}
}

// FR-SAU-4: 앞에서부터 SubagentMaxTasks 개만.
func TestSubagentsFromInput_Cap(t *testing.T) {
	var b strings.Builder
	b.WriteString(`{"tasks":[`)
	for i := range SubagentMaxTasks + 1 {
		if i > 0 {
			b.WriteString(",")
		}
		fmt.Fprintf(&b, `{"id":"t%d"}`, i)
	}
	b.WriteString(`]}`)
	got, _ := subagentsJSON(t, b.String())
	if len(got) != SubagentMaxTasks || got[0]["id"] != "t0" {
		t.Fatalf("len=%d first=%v", len(got), got[0])
	}
}

// FR-SAU-6: tasks 가 빈 배열이면 ok 이고 빈 목록이다. 없거나 배열이 아니면 ok=false.
func TestSubagentsFromInput_EmptyAndMissing(t *testing.T) {
	tasks, ok := SubagentsFromInput([]byte(`{"tasks":[]}`))
	if !ok || len(tasks) != 0 || tasks == nil {
		t.Fatalf("빈 배열: ok=%v tasks=%v (nil 이면 JSON 이 null 이 된다)", ok, tasks)
	}
	for _, raw := range []string{`{}`, `{"tasks":{}}`, `not json`, `{"tasks":null}`} {
		if _, ok := SubagentsFromInput([]byte(raw)); ok {
			t.Errorf("%s → ok=true", raw)
		}
	}
}
