package sse

import (
	"encoding/json"

	"dongminal/internal/shared/dmlog"
)

// event 는 방송 본문의 봉투다. 키 순서가 `json.Marshal(map{action,args})` 와 같아
// 바이트가 종전과 같다 (FR-OPT-0-3). args 가 nil 이면 키를 싣지 않는다.
type event struct {
	Action string `json:"action"`
	Args   any    `json:"args,omitempty"`
}

// Payload 는 `{"action":…,"args":…}` 본문이다 (IPC-20). 종전에는 빌더마다 같은
// Marshal 을 적고 오류를 버렸다 — 여기서는 로그를 남기고 action 만 싣는다.
func Payload(action string, args any) []byte {
	b, err := json.Marshal(event{Action: action, Args: args})
	if err != nil {
		dmlog.Errorf(nil, "[sse] %s 본문 직렬화 실패 — args 를 뺀다: %v", action, err)
		b, _ = json.Marshal(event{Action: action})
	}
	return b
}

// WorkspaceChanged 는 `workspace_changed` 본문이다. 워크스페이스 저장·표식·목록
// 편집(wsentry)이 함께 쓴다 (HTTP-15 — 종전에는 세 자리가 따로 조립했다).
func WorkspaceChanged(rev uint64) []byte {
	return Payload("workspace_changed", map[string]any{"rev": rev})
}
