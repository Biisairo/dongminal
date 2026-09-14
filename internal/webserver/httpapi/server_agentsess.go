package httpapi

import (
	"time"
)

// M9_SRS FR-M9-15 (D-A-10 — 분리는 **이동만**이다): `server.go` 에서 옮겨 왔다.
//
// 여기 모인 것은 **도구 단위 에이전트 세션의 신원**이다 (FR-M9-32·41). 훅이 실어 온
// 세션 id·에이전트·전사본 경로를 붙들고, 올리기가 그것을 되짚는다. `server.go` 에
// 남은 것은 서버의 구성과 수명이며, 이 신원은 그 위에 얹힌 한 겹이다.

// AgentSessionInfo 는 그 도구에서 도는 에이전트의 신원이다 (FR-M9-32).
//
// Agent 를 함께 드는 이유는 **어댑터를 골라야 하기 때문이다** — 세션 id 만으로는
// `claude --resume` 인지 `codex resume` 인지 알 수 없다.
type AgentSessionInfo struct {
	SessionID string `json:"sessionId"`
	Agent     string `json:"agent,omitempty"`
	UpdatedAt int64  `json:"updatedAt,omitempty"`
	// TranscriptPath 는 그 세션의 기록이 있는 **로컬 파일**이다 (M9_SRS FR-M9-41).
	//
	// 훅만이 이것을 안다 — 자리도 형식도 에이전트마다 다르다. 올리기가 그 파일을
	// 읽어 화면을 채운다 (`agentsess.LoadHistory`).
	//
	// **와이어로 나가지 않는다**: `json:"-"` 가 그 규약의 첫 방벽이다. 이 구조체는
	// 서버 안에서만 살지만, 누군가 이것을 응답에 실으면 경로가 브라우저로 샌다.
	TranscriptPath string `json:"-"`
}

// noteAgentSession 은 훅이 실어 온 신원을 붙든다 (FR-M9-32).
//
// **빈 세션 id 는 아무것도 하지 않는다.** 활동 훅은 신원 없이도 오며(압축·바이트만
// 실은 보고), 그때 빈 값으로 덮으면 "모른다" 가 "없다" 가 된다 — FR-CBG-5 가 막으려는
// 바로 그 치환이다.
func (s *Server) noteAgentSession(toolID, sessionID, agent, transcript string) {
	if toolID == "" || sessionID == "" {
		return
	}
	// FR-M9-41: 경로를 말하지 않은 보고가 있던 경로를 지우지 않는다 — 세션 id 와
	// 같은 규약이다. 압축만 실은 보고에도 신원은 오지만 경로는 오지 않는다.
	if transcript == "" {
		if prev := s.AgentSession(toolID); prev != nil && prev.SessionID == sessionID {
			transcript = prev.TranscriptPath
		}
	}
	s.agentSessions.Store(toolID, &AgentSessionInfo{
		SessionID: sessionID, Agent: agent, UpdatedAt: time.Now().UnixNano(),
		TranscriptPath: transcript,
	})
}

// transcriptFor 는 그 세션 신원의 전사본 경로다 (FR-M9-41). 모르면 빈 문자열.
//
// **도구가 아니라 세션으로 찾는 이유**: 올리기는 셸의 세션을 **새 `toolId`** 로
// 여는 일이라, 여는 쪽의 도구에는 신원이 없다. 아는 것은 재개할 세션 id 하나이며
// 그것이 두 자리를 잇는 유일한 값이다.
//
// **에이전트도 함께 맞춰야 한다** (사용자 지적 2026-09-14 — *"id 만 보고 어떤
// 에이전트에서 가져올지 확인이 되나?"*). 세션 id 는 **형식을 말하지 않는 값**이고,
// 전사본의 형식은 에이전트마다 다르다 (`ParseHistory` 가 어댑터에 있는 이유가 그것이다).
// id 만으로 고르면 다른 에이전트의 전사본을 이 어댑터의 파서에 넘기는 길이 열린다.
//
// 올리기 경로에서는 `agent` 와 `resume` 이 같은 응답(`/api/agent/session`)에서 함께
// 오므로 실제로는 어긋나지 않는다. 그것은 **호출자의 예의**이지 이 함수의 보장이
// 아니며, 보장은 여기 있어야 한다.
//
// 보고에 에이전트가 없으면 **맞춰 볼 수 없으므로 쓰지 않는다** — 모르는 것을 "맞다"
// 로 읽지 않는다 (FR-CBG-5).
func (s *Server) transcriptFor(sessionID, agentID string) string {
	if sessionID == "" || agentID == "" {
		return ""
	}
	out := ""
	s.agentSessions.Range(func(_, v any) bool {
		info, _ := v.(*AgentSessionInfo)
		if info != nil && info.SessionID == sessionID && info.Agent == agentID && info.TranscriptPath != "" {
			out = info.TranscriptPath
			return false
		}
		return true
	})
	return out
}

// AgentSession 은 그 도구의 세션 신원이다. 모르면 nil 이다 — 빈 구조체를 돌려주면
// 받는 쪽이 "신원이 빈 세션" 으로 읽는다.
func (s *Server) AgentSession(toolID string) *AgentSessionInfo {
	v, ok := s.agentSessions.Load(toolID)
	if !ok {
		return nil
	}
	info, _ := v.(*AgentSessionInfo)
	return info
}
