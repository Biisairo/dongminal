package httpapi

import (
	"net/http"

	"dongminal/internal/webserver/domain/run"
)

// 묶음 P — 동료 명부 (ORCHESTRATION_V2_SRS FR-PAT-5).
//
// 카탈로그 8패턴 중 5개가 멤버 간 직접 통신(P2P)을 본질로 하는데, 지금은 그것이
// 사실상 봉인돼 있다: 프리앰블이 `run member` 시점에 조립되므로 **그때 아직 등록되지
// 않은 동료**는 담길 수 없고, 첫 멤버의 프리앰블에는 동료가 0명이다. 상대를 지목할
// 수 없으면 말을 걸 수 없다.
//
// 해법은 프리앰블에 명부를 박는 것이 **아니다** — 명부는 승계·이탈로 변하고 박으면
// 낡는다. 멤버가 필요할 때 스스로 조회한다.

// succeededState 는 묶음 C 가 더할 MemberState 다 (FR-CBG-10). 상수가 아직 없어
// 문자열로 비교한다 — 승계된 멤버가 명부에서 사라져야 한다는 것(V-PAT-8)은 묶음 P
// 쪽 요구라서 묶음 C 의 도착을 기다릴 수 없다.
const succeededState = run.MemberState("succeeded")

// peerView 는 명부 한 줄이다 (FR-PAT-5).
//
// MemberID 와 To 가 **둘 다** 있는 이유: member uuid 는 Run 기록에서의 정체이고,
// `dmctl msg --to` 가 실제로 라우팅하는 것은 toolId 다 (workspace.Resolve 의 1단계).
// member uuid 는 공간 계층의 엔티티가 아니라 해석되지 않는다. 하나만 내면 명부를
// 받은 멤버가 말을 걸 수 없거나(uuid 만), 보고에서 자기 동료를 지목할 수
// 없다(toolId 만).
type peerView struct {
	Role     string          `json:"role"`
	MemberID string          `json:"memberId"`
	To       string          `json:"to"`
	State    run.MemberState `json:"state"`
	Headless bool            `json:"headless"`
}

// apiRunPeers implements GET /api/runs/peers (FR-PAT-5).
// 호출자의 정체로 소속 Run 을 찾아, **자기를 제외한** 동료의 role·member uuid·
// state·headless 를 낸다. Run 에 속하지 않은 도구의 호출은 거부한다.
func (s *Server) apiRunPeers(w http.ResponseWriter, r *http.Request) {
	if !s.runsReady(w) {
		return
	}
	caller := s.callerToolID(r, r.URL.Query().Get("toolId"))
	rec, self, ok := s.openRunOfTool(caller)
	if !ok {
		// 조정자는 멤버가 아니다 — 명부가 필요하면 `run status` 를 쓴다.
		// 거부 사유를 뭉뚱그리지 않는 것이 FR-PRE-6 의 규칙이다.
		writeRunError(w, run.ErrSenderNotMember, map[string]any{"toolId": caller})
		return
	}
	peers := make([]peerView, 0, len(rec.Members))
	for _, m := range rec.Members {
		if m.ID == self.ID {
			continue
		}
		// 넘긴 자리와 떠난 자리는 동료가 아니다. 명부에 남기면 아무도 읽지 않는
		// 주소로 메시지가 가고, 발신자는 응답을 기다리다 상한까지 태운다.
		if m.State == run.Released || m.State == succeededState {
			continue
		}
		peers = append(peers, peerView{
			Role:     m.Role,
			MemberID: m.ID,
			To:       m.ToolID,
			State:    s.deriveMemberState(m),
			Headless: m.Headless,
		})
	}
	writeJSON(w, map[string]any{
		"runId": rec.ID, "memberId": self.ID, "role": self.Role, "peers": peers,
	})
}

// openRunOfTool resolves a tool to its member row among OPEN runs. 저장소의
// MemberByTool 대신 목록을 훑는 이유는 Run 레코드까지 함께 필요하기 때문이다 —
// 명부는 **같은 Run 의** 동료만 낸다.
func (s *Server) openRunOfTool(toolID string) (run.Record, run.Member, bool) {
	if toolID == "" {
		return run.Record{}, run.Member{}, false
	}
	for _, rec := range s.Runs.List() {
		if rec.State != run.Open {
			continue
		}
		for _, m := range rec.Members {
			if m.ToolID == toolID {
				return rec, m, true
			}
		}
	}
	return run.Record{}, run.Member{}, false
}
