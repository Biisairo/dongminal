package toolipc

import (
	"encoding/json"

	"dongminal/internal/shared/toolhub"
)

// AGENT_RECORD_DAEMON_SRS §3.3a — 알람 판정의 와이어.

// attn push 의 kind 다. 데몬 Tool 의 알림 셋과 하나씩 맞는다.
const (
	AttnKindAttention = "attention"
	AttnKindClear     = "clear"
	AttnKindActivity  = "activity"
)

// AttnConfigParams 는 판정 설정이다 (FR-ARD-31). IdleMS 가 0 이면 유휴 판정을 끈다.
type AttnConfigParams struct {
	IdleMS    int64 `json:"idleMs"`
	AllowBell bool  `json:"allowBell"`
}

// AttendParams 는 도구 하나의 알람 해제다 (FR-ARD-32). Typed 는 키를 눌렀는가다.
type AttendParams struct {
	Tool  string `json:"tool"`
	Typed bool   `json:"typed,omitempty"`
}

type AttendAllResult struct {
	Cleared int `json:"cleared"`
}

// ReportParams 는 서버 HTTP 로 온 보고다. 보고 소켓의 요청과 같은 모양이다.
type ReportParams struct {
	Method string          `json:"method"`
	Body   json.RawMessage `json:"body"`
}

// AttnEvent 는 attn push 다. Agent 는 알린 뒤의 상태다.
type AttnEvent struct {
	Event  string             `json:"event"`
	Tool   string             `json:"tool"`
	Kind   string             `json:"kind"`
	Reason string             `json:"reason,omitempty"`
	Agent  toolhub.AgentState `json:"agent"`
}
