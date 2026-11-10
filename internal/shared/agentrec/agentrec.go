// Package agentrec 는 에이전트 보고의 해석과 기록 값의 모양이다. 데몬과 서버가 같은
// 한 벌을 쓴다 (AGENT_RECORD_DAEMON_SRS §3.2a). 데몬은 서버가 꺼져 있어도 보고를
// 기록해야 하고(FR-ARD-25), webserver 를 import 할 수 없으므로 여기 둔다.
package agentrec

import (
	"encoding/json"
	"maps"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"dongminal/internal/shared/activity"
	"dongminal/internal/shared/agentadapter"
	"dongminal/internal/shared/platform"
	"dongminal/internal/shared/statusline"
)

// SocketFile 은 데몬의 보고 소켓 이름이다. 데몬 소켓과 같은 0700 폴더에 산다 (FR-ARD-20).
const SocketFile = "report.sock"

// 보고 소켓이 받는 메서드는 넷뿐이다 (FR-ARD-21).
const (
	MethodActivity  = "report.activity"
	MethodUsage     = "report.usage"
	MethodSubagents = "report.subagents"
	MethodNotify    = "report.notify"
)

// IOTimeout 은 보고 소켓 연결 하나의 읽기·쓰기 시한이다.
const IOTimeout = 2 * time.Second

const (
	// ToolMax·DetailMax 는 활동 문자열의 상한이다 (NFR-AAP-3).
	ToolMax   = 64
	DetailMax = 512
	// SubagentDoneKeep 은 done 이 된 서브에이전트 활동을 남겨 두는 기한이다 (FR-ASV-12).
	SubagentDoneKeep = 30 * time.Second
)

// SocketPath 는 home 인스턴스의 보고 소켓 경로다. 데몬과 dmctl 이 이 함수 하나로 찾는다.
func SocketPath(home string) string {
	return filepath.Join(filepath.Dir(platform.Current().IPC.Endpoint(home)), SocketFile)
}

// KnownMethod 는 보고 소켓이 받는 메서드인가다.
func KnownMethod(m string) bool {
	switch m {
	case MethodActivity, MethodUsage, MethodSubagents, MethodNotify:
		return true
	}
	return false
}

// Request 는 보고 소켓의 요청 한 줄이다. Body 는 같은 보고의 HTTP 본문 그대로다.
type Request struct {
	Method string          `json:"method"`
	Body   json.RawMessage `json:"body"`
}

// Reply 는 보고 소켓의 응답 한 줄이다.
type Reply struct {
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
}

// ActivityReport 는 `POST /api/tools/activity/set` 과 report.activity 의 본문이다.
type ActivityReport struct {
	ToolID string `json:"toolId"`
	State  string `json:"state"`
	Tool   string `json:"tool"`
	Detail string `json:"detail"`
	// UserPrompt 는 이 턴이 사용자 프롬프트에서 시작되었다는 곁들이 값이다 (FR-ATN-2).
	UserPrompt bool `json:"userPrompt"`
	// Agent 는 보고한 에이전트의 id 다 (FR-AEV-10). 비면 종전 판정 그대로 간다.
	Agent string `json:"agent"`
	// SessionID 는 훅이 실어 보내지만 쓰지 않는다 (AGENT_GUI_REMOVAL_SRS FR-AGR-9).
	SessionID string `json:"sessionId"`
	// AgentID 가 있으면 서브에이전트 활동이다 (FR-ASV-10).
	AgentID   string `json:"agentId"`
	AgentType string `json:"agentType"`
}

// UsageReport 는 `POST /api/tools/usage` 와 report.usage 의 본문이다.
type UsageReport struct {
	ToolID string           `json:"toolId"`
	Usage  statusline.Usage `json:"usage"`
}

// SubagentsReport 는 `POST /api/tools/subagents` 와 report.subagents 의 본문이다.
type SubagentsReport struct {
	ToolID string                `json:"toolId"`
	Tasks  []statusline.Subagent `json:"tasks"`
}

// NotifyReport 는 `POST /api/tools/attention/set` 과 report.notify 의 본문이다.
type NotifyReport struct {
	ToolID string `json:"toolId"`
	Reason string `json:"reason"`
}

// NotifyReason 은 알람 사유다. 비면 signaled 다.
func NotifyReason(r string) string {
	if r == "" {
		return "signaled"
	}
	return r
}

// Usage 는 도구 하나의 statusLine 사용량 기록이다 — 받은 값과 받은 시각(밀리초).
type Usage struct {
	statusline.Usage
	ObservedAt int64 `json:"observedAt"`
}

// ContextTokens 는 지금 맥락에 든 토큰이다 — 입력·캐시 생성·캐시 읽기의 합.
// 출력은 다음 요청의 입력이 되기 전까지 맥락이 아니다.
func (u *Usage) ContextTokens() (float64, bool) {
	if u.ContextWindow == nil || u.ContextWindow.CurrentUsage == nil {
		return 0, false
	}
	c := u.ContextWindow.CurrentUsage
	sum, any := 0.0, false
	for _, v := range []*float64{c.InputTokens, c.CacheCreationInputTokens, c.CacheReadInputTokens} {
		if v != nil {
			sum += *v
			any = true
		}
	}
	return sum, any
}

// SubagentList 는 서브에이전트 목록 기록이다. 시각은 밀리초다.
type SubagentList struct {
	Tasks      []statusline.Subagent `json:"tasks"`
	ObservedAt int64                 `json:"observedAt"`
}

// SubagentActivity 는 서브에이전트 하나의 훅 활동이다 (FR-ASV-10).
type SubagentActivity struct {
	AgentType string    `json:"agentType,omitempty"`
	State     string    `json:"state"`
	Tool      string    `json:"tool,omitempty"`
	Detail    string    `json:"detail,omitempty"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// ValidSubagentState 는 서브에이전트 활동이 가질 수 있는 상태인가다 (FR-ASV-10).
func ValidSubagentState(s string) bool {
	return s == activity.Working || s == activity.Waiting || s == activity.Done
}

// SubagentActivityOf 는 보고에서 정리한 서브에이전트 활동이다.
func SubagentActivityOf(r ActivityReport) SubagentActivity {
	return SubagentActivity{
		AgentType: Sanitize(r.AgentType, ToolMax),
		State:     r.State,
		Tool:      Sanitize(r.Tool, ToolMax),
		Detail:    Sanitize(r.Detail, DetailMax),
	}
}

// PutSubagentActivity 는 m 에 활동 하나를 덮어쓰고 m 을 돌려준다. m 이 nil 이면 만든다.
// statusline.SubagentMaxTasks 를 넘으면 가장 오래 갱신되지 않은 것을 버린다 (FR-ASV-11).
func PutSubagentActivity(m map[string]SubagentActivity, agentID string, a SubagentActivity, now time.Time) map[string]SubagentActivity {
	if m == nil {
		m = map[string]SubagentActivity{}
	}
	a.UpdatedAt = now
	m[agentID] = a
	for len(m) > statusline.SubagentMaxTasks {
		oldest := ""
		for id, v := range m {
			if oldest == "" || v.UpdatedAt.Before(m[oldest].UpdatedAt) {
				oldest = id
			}
		}
		delete(m, oldest)
	}
	return m
}

// LimitRecord 는 에이전트 하나의 계정 한도 기록이다. 시각은 밀리초다.
type LimitRecord struct {
	Windows    map[string]statusline.RateWindow `json:"windows"`
	ObservedAt int64                            `json:"observedAt"`
}

// MergeLimits 는 agent 의 한도를 m 에 넣고 m 을 돌려준다. 빈 한도는 넣지 않는다 (FR-ASV-20).
func MergeLimits(m map[string]LimitRecord, agent string, windows map[string]statusline.RateWindow, at time.Time) map[string]LimitRecord {
	if len(windows) == 0 {
		return m
	}
	if m == nil {
		m = map[string]LimitRecord{}
	}
	m[agent] = LimitRecord{Windows: maps.Clone(windows), ObservedAt: at.UnixMilli()}
	return m
}

// Sanitize 는 제어 문자를 지우고 길이를 max 바이트로 묶는다 (NFR-AAP-3). 자를 때는
// 상한 이하의 마지막 글자 경계까지 물린다 — 끊긴 바이트는 카드에 □ 로 보인다 (IPC-27).
func Sanitize(s string, max int) string {
	s = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, s)
	if len(s) > max {
		cut := max
		for cut > 0 && !utf8.RuneStart(s[cut]) {
			cut--
		}
		s = s[:cut]
	}
	return s
}

// AgentReportsUserTurn 은 그 에이전트가 턴의 출처를 말할 수 있는지다 (FR-AEV-12). 선언을
// 읽을 뿐 추측하지 않는다.
//
// 모르는 id 에는 참을 준다 — 종전 판정 그대로 간다는 뜻이다. 거짓을 주면 알 수 없는
// 보고자의 모든 `done` 이 무조건 알람이 된다.
func AgentReportsUserTurn(id string) bool {
	if id == "" {
		return true
	}
	a, err := agentadapter.Get(id)
	if err != nil {
		return true
	}
	return a.Signals.UserTurn
}
