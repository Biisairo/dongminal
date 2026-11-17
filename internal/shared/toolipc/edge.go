package toolipc

import "encoding/json"

// PEER_DAEMON_SRS §3.5a — 간선(노드)의 와이어. 데몬이 노드이고 서버는 통로와 로컬 API
// 위임만 한다. FeatureEdge 를 양쪽이 말할 때만 쓴다.

// EdgeParams 는 로컬 API 연산 하나다 (FR-PDM-30). Args 는 HTTP 요청 본문 그대로다.
type EdgeParams struct {
	Args    json.RawMessage `json:"args,omitempty"`
	IfMatch string          `json:"ifMatch,omitempty"`
	Op      string          `json:"op"`
}

// EdgeResult 는 그 답이다. Code 가 비지 않으면 오류이고 Body 가 없다.
type EdgeResult struct {
	Body    json.RawMessage `json:"body,omitempty"`
	Code    string          `json:"code,omitempty"`
	ETag    string          `json:"etag,omitempty"`
	Message string          `json:"message,omitempty"`
	Status  int             `json:"status"`
}

// EdgePortParams 는 서버가 연 노드 포트의 상태다 (FR-PDM-14).
type EdgePortParams struct {
	Addr      string `json:"addr,omitempty"`
	Error     string `json:"error,omitempty"`
	Listening bool   `json:"listening,omitempty"`
}

// EdgeRef 는 맺거나 지운 간선 하나다 (EDGE_PAIRING_SRS FR-EPR-5·23).
type EdgeRef struct {
	FP   string `json:"fp"`
	Name string `json:"name"`
}

// EdgesEvent 는 edges push 다. 본문은 `edges_changed` 의 인자와 같다 (FR-PDM-27).
type EdgesEvent struct {
	Event   string   `json:"event"`
	Paired  *EdgeRef `json:"paired,omitempty"`
	Removed *EdgeRef `json:"removed,omitempty"`
}
