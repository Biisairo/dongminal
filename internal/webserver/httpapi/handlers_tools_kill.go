package httpapi

import (
	"encoding/json"
	"net/http"
	"time"

	"dongminal/internal/shared/platform"
	"dongminal/internal/shared/toolhub"
)

// 묶음 X — 백그라운드 도구 즉시 종료 (CONVENIENCE_SRS FR-BGK-*).
//
// 지금 백그라운드 도구를 없애려면 복귀시킨 뒤 탭을 닫아야 한다 — 두 단계이고,
// 복귀가 화면을 바꾼다. 삭제 경로 자체는 이미 있다 (ToolManager.Delete 가
// background 맵에서도 함께 제거한다). 이 종단은 **새 경로가 아니라 기존 경로에
// 문을 다는 일**이다.

// toolKillGrace 는 SIGTERM 과 SIGKILL 사이의 유예다 (FR-BGK-7). 테스트가
// 줄여 쓴다 — 3 초를 실제로 기다리는 테스트는 재현 가능하지만 느리다.
var toolKillGrace = 3 * time.Second

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
		http.Error(w, "toolId 필요", http.StatusBadRequest)
		return
	}
	// 알 수 없는 도구는 404 다 — apiToolBackgroundSet 과 같은 규약. 조용히
	// 성공하면 낡은 id 가 감춰진다.
	if s.Tools == nil {
		http.Error(w, "toolId="+body.ToolID+" 존재하지 않음", http.StatusNotFound)
		return
	}
	tool := s.Tools.Get(body.ToolID)
	if tool == nil {
		http.Error(w, "toolId="+body.ToolID+" 존재하지 않음", http.StatusNotFound)
		return
	}
	terminateWithGrace(tool, toolKillGrace)
	s.Tools.Delete(body.ToolID)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"ok": true})
}

// terminateWithGrace 는 tool 의 프로세스에 SIGTERM 을 보내고 종료를 grace 만큼
// 기다린다 (FR-BGK-7). 강제 종료는 하지 않는다 — 호출자의 Delete 가 한다.
//
// 데몬 모드에서 Get 은 cmd 없는 Tool 을 돌려주므로 pid 가 0 이다. 그때는 여기서
// 할 수 있는 일이 없고, Delete 가 데몬 쪽 ToolManager 로 건너가 같은 순서를 밟는다.
func terminateWithGrace(tool *toolhub.Tool, grace time.Duration) {
	pid := tool.CmdProcessPID()
	if pid <= 0 {
		return
	}
	if err := platform.Current().Process.Terminate(pid); err != nil {
		return
	}
	select {
	case <-tool.Wait():
	case <-time.After(grace):
	}
}
