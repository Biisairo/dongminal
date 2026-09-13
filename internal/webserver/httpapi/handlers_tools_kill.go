package httpapi

import (
	"dongminal/internal/webserver/apierr"
	"encoding/json"
	"net/http"
)

// 묶음 X — 백그라운드 도구 즉시 종료 (CONVENIENCE_SRS FR-BGK-*).
//
// 지금 백그라운드 도구를 없애려면 복귀시킨 뒤 탭을 닫아야 한다 — 두 단계이고,
// 복귀가 화면을 바꾼다. 삭제 경로 자체는 이미 있다 (ToolManager.Delete 가
// background 맵에서도 함께 제거한다). 이 종단은 **새 경로가 아니라 기존 경로에
// 문을 다는 일**이다.

// apiToolKill implements POST /api/tools/kill (FR-BGK-6).
// Body: {"toolId":"..."}.
//
// SIGTERM 후 유예, 그 다음 SIGKILL (FR-BGK-7). 뒷단은 ToolManager.Delete 로,
// 그 함수가 PTY 를 닫고 SIGKILL 을 보내며 background 맵에서도 제거한다
// (V-BGK-8). 유예를 여기서 두는 이유는 Delete 의 내부 유예(50ms)가 "탭을 닫는다"
// 용도이지 "돌던 작업에 정리할 틈을 준다" 용도가 아니기 때문이다.
//
// 응답은 종료가 끝난 뒤에 나간다. 비동기로 돌리면 응답 직후의
// GET /api/tools/background 가 아직 죽지 않은 도구를 돌려주고, 모달은 지운 행을
// 다음 갱신에 되살린다.
func (s *Server) apiToolKill(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ToolID string `json:"toolId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.ToolID == "" {
		httpErr(w, "toolId 필요", http.StatusBadRequest, apierr.CodeMissingArg)
		return
	}
	// 알 수 없는 도구는 404 다 — apiToolBackgroundSet 과 같은 규약. 조용히
	// 성공하면 낡은 id 가 감춰진다.
	if s.Tools == nil {
		httpErr(w, "toolId="+body.ToolID+" 존재하지 않음", http.StatusNotFound, apierr.CodeToolNotFound)
		return
	}
	// 유예는 도구가 있는 프로세스에서 기다린다 — 직접 모드는 여기, 데몬 모드는
	// 데몬이다 (FBE-05/12). 종전에는 이 자리에서 pid 를 보고 기다렸는데, 데몬
	// 모드의 Get 은 pid 없는 합성 Tool 을 주므로 유예가 통째로 건너뛰어졌다.
	if err := s.tools(r).Terminate(body.ToolID, s.limits.toolKillGrace); err != nil {
		httpErr(w, "toolId="+body.ToolID+" 존재하지 않음", http.StatusNotFound, apierr.CodeToolNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"ok": true})
}
