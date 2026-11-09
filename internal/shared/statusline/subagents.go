package statusline

import (
	"encoding/json"
	"reflect"
)

// SubagentMaxTasks 는 한 보고에 싣는 서브에이전트의 최대 수다 (SUBAGENT_USAGE_SRS FR-SAU-4).
const SubagentMaxTasks = 32

// Subagent 는 subagentStatusLine 입력의 `tasks` 원소에서 내보내도 되는 값 전부다
// (SUBAGENT_USAGE_SRS FR-SAU-1·2). 설명 글(`description`·`label`)과 경로(`cwd`)는 여기
// 없으므로 나가지 않는다 (FR-SAU-3). `effort` 는 글자이거나 토큰 예산(수)이다 — 같은
// 입력 이름을 두 필드가 나눠 받고, 타입이 맞는 쪽만 채워진다.
type Subagent struct {
	ID           *string  `json:"id,omitempty" sl:"id"`
	AgentType    *string  `json:"agentType,omitempty" sl:"agentType"`
	Status       *string  `json:"status,omitempty" sl:"status"`
	Model        *string  `json:"model,omitempty" sl:"model"`
	Effort       *string  `json:"effort,omitempty" sl:"effort"`
	EffortBudget *float64 `json:"effortBudget,omitempty" sl:"effort"`
	WindowTokens *float64 `json:"windowTokens,omitempty" sl:"contextWindowSize"`
	Tokens       *float64 `json:"tokens,omitempty" sl:"tokenCount"`
	StartTime    *float64 `json:"startTime,omitempty" sl:"startTime"`
}

// SubagentsFromInput 은 subagentStatusLine 입력의 `tasks` 에서 허용 목록의 값만 꺼낸다.
// `tasks` 가 배열이 아니면 ok 가 거짓이다. 빈 배열은 빈(nil 아닌) 목록이다.
func SubagentsFromInput(raw []byte) ([]Subagent, bool) {
	var in struct {
		Tasks []any `json:"tasks"`
	}
	if json.Unmarshal(raw, &in) != nil || in.Tasks == nil {
		return nil, false
	}
	out := make([]Subagent, 0, min(len(in.Tasks), SubagentMaxTasks))
	for _, t := range in.Tasks {
		if len(out) == SubagentMaxTasks {
			break
		}
		m, ok := t.(map[string]any)
		if !ok {
			continue
		}
		var s Subagent
		fill(reflect.ValueOf(&s).Elem(), m)
		if s.ID == nil {
			continue
		}
		out = append(out, s)
	}
	return out, true
}
