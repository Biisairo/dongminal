package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"path/filepath"
	"time"

	"dongminal/internal/shared/agentadapter"
	"dongminal/internal/shared/dmenv"
	"dongminal/internal/shared/pollwait"
	"dongminal/internal/webserver/apierr"
	"dongminal/internal/webserver/domain/peer"
	"dongminal/internal/webserver/httpresp"
	"dongminal/internal/webserver/hub"
)

// agent.spawn · agent.status · agent.close (PEER_NETWORK_SRS FR-PNW-53~55·58~64).

const (
	peerPlaceWindow = "window"
	peerPlaceTab    = "tab"
	// peerCloseWait 은 종료 명령 뒤 에이전트가 끝나기를 기다리는 상한이다. 보내는 쪽의
	// 요청 한도(15초, FR-PNW-44) 안에 답해야 한다 (I-20).
	peerCloseWait = 10 * time.Second
	peerClosePoll = 200 * time.Millisecond
)

// peerAgentSpawn 은 이 노드에 에이전트를 띄운다. 보내는 쪽은 에이전트·폴더·첫
// 프롬프트·자리만 정한다 — 인자·권한 모드·환경 변수는 정할 수 없다 (FR-PNW-60).
func (s *Server) peerAgentSpawn(w http.ResponseWriter, r *http.Request, from peerCaller) peerCmdResult {
	var in struct {
		Agent     string `json:"agent"`
		Cwd       string `json:"cwd"`
		Prompt    string `json:"prompt"`
		Placement string `json:"placement"`
		At        string `json:"at"`
		Name      string `json:"name"`
		From      string `json:"from"`
	}
	if !peerReadJSON(w, r, &in) {
		return peerCmdResult{status: http.StatusBadRequest}
	}
	fail := func(status int, code, msg string) peerCmdResult {
		peerFail(w, status, code, msg)
		return peerCmdResult{status: status, n: len(in.Prompt)}
	}
	if in.From != "" && !peerToolIDPattern.MatchString(in.From) {
		return fail(http.StatusBadRequest, apierr.CodeBadRequest, "from")
	}
	if len(in.Prompt) > peerMessageMax {
		return fail(http.StatusRequestEntityTooLarge, apierr.CodeBodyTooBig, "prompt too large")
	}
	switch in.Placement {
	case "", peerPlaceWindow:
		in.Placement = peerPlaceWindow
	case peerPlaceTab:
		if in.At == "" {
			return fail(http.StatusBadRequest, apierr.CodeMissingArg, "at")
		}
	default:
		return fail(http.StatusBadRequest, apierr.CodeBadRequest, "placement")
	}
	if peer.ValidName(in.Name) != nil {
		in.Name = ""
	}
	ad, err := agentadapter.Get(in.Agent)
	if err != nil || !ad.Installed() {
		return fail(http.StatusBadRequest, apierr.CodePeerAgentMissing, "agent unavailable")
	}
	cwd, ok := peer.DirAllowed(in.Cwd, s.peers.Config().AllowedDirs)
	if !ok {
		return fail(http.StatusForbidden, apierr.CodePeerDirNotAllowed, "dir not allowed")
	}
	if s.Tools == nil || s.ToolIO == nil {
		return fail(http.StatusServiceUnavailable, apierr.CodeToolsUnready, "tools unavailable")
	}
	toolID, headless, err := s.peerSpawnShell(r.Context(), cwd, in.Placement, in.At, in.Name)
	if err != nil {
		return fail(http.StatusInternalServerError, apierr.CodeInternal, "create tool failed")
	}
	prompt := ""
	if in.Prompt != "" {
		prompt = peerEnvelope(from.name, in.From, toolID, in.Prompt, time.Now())
	}
	hooksDir := dmenv.AgentHooksDirIn(filepath.Join(s.cfg.DataDir, dmenv.BinDir))
	line, err := ad.LaunchLine(hooksDir, "", prompt)
	if err != nil {
		return fail(http.StatusInternalServerError, apierr.CodeInternal, "launch line")
	}
	if err := s.peerSpawns.Record(toolID, from.fp); err != nil {
		return fail(http.StatusInternalServerError, apierr.CodeSaveFailed, "record")
	}
	if err := s.deliverToTool(toolID, line, true); err != nil {
		return fail(http.StatusInternalServerError, apierr.CodeInternal, "deliver failed")
	}
	httpresp.JSON(w, http.StatusOK, map[string]any{"toolId": toolID, "headless": headless})
	return peerCmdResult{status: http.StatusOK, target: toolID, n: len(in.Prompt)}
}

// peerSpawnShell 은 cwd 에 셸 도구 하나를 세운다 (FR-PNW-61, I-18).
//
//	window: 브라우저가 있으면 newWindow(cwd) 의 첫 탭 셸
//	tab:    헤드리스 셸을 cwd 에 띄운 뒤 at 도구의 칸에 붙인다 (restoreTool)
//	그 밖:  브라우저가 없으면 헤드리스 셸
func (s *Server) peerSpawnShell(ctx context.Context, cwd, placement, at, name string) (string, bool, error) {
	if placement == peerPlaceWindow && s.Commands != nil {
		args := map[string]any{"cwd": cwd, "keepFocus": true}
		if name != "" {
			args["name"] = name
		}
		req := map[string]any{"action": "newWindow", "args": args, "reqId": hub.NewReqId()}
		if hub.IsSingleExecutorAction("newWindow") && s.Focus != nil {
			req["execClientId"] = s.Focus.Executor()
		}
		payload, _ := json.Marshal(req)
		res, n, timedOut := s.Commands.BroadcastAndAwait(payload, req["reqId"].(string), hub.CommandResultTimeout())
		if n > 0 && !timedOut && len(res.NewTabs) > 0 && res.NewTabs[0].ToolID != "" {
			return res.NewTabs[0].ToolID, false, nil
		}
	}
	toolID, err := s.createHeadlessTool(cwd, "")
	if err != nil {
		return "", true, err
	}
	if placement == peerPlaceTab {
		args := map[string]any{"toolId": toolID}
		if tab := s.tabIDOfTool(at); tab != "" {
			if coord, err := s.WorkIndex.CoordinateOf(tab); err == nil {
				args["location"] = coord
			}
		}
		if s.broadcastLayout("restoreTool", args) > 0 && s.awaitTab(ctx, toolID, true) != "" {
			return toolID, false, nil
		}
	}
	return toolID, true, nil
}

// peerStateOf 는 FR-PNW-54 의 어휘다. 에이전트가 돌지 않으면 ended, 활동의 done 은 idle 이다.
func (s *Server) peerStateOf(toolID string) string {
	if !s.toolLive(toolID) {
		return "ended"
	}
	if _, ok := s.agentOfTool(toolID); !ok {
		return "ended"
	}
	st := s.toolStatusOf(toolID, true).State
	if st == "done" {
		return "idle"
	}
	return st
}

func (s *Server) peerAgentStatus(w http.ResponseWriter, r *http.Request, _ peerCaller) peerCmdResult {
	var in struct {
		ToolID string `json:"toolId"`
	}
	if !peerReadJSON(w, r, &in) {
		return peerCmdResult{status: http.StatusBadRequest}
	}
	state, target := "ended", ""
	if peerToolIDPattern.MatchString(in.ToolID) {
		state, target = s.peerStateOf(in.ToolID), in.ToolID
	}
	httpresp.JSON(w, http.StatusOK, map[string]any{"toolId": target, "state": state})
	return peerCmdResult{status: http.StatusOK, target: target}
}

// peerAgentClose 는 띄운 짝만 닫는다. 종료 명령을 보낸 뒤 도구를 닫는다 (FR-PNW-63).
func (s *Server) peerAgentClose(w http.ResponseWriter, r *http.Request, from peerCaller) peerCmdResult {
	var in struct {
		ToolID string `json:"toolId"`
	}
	if !peerReadJSON(w, r, &in) {
		return peerCmdResult{status: http.StatusBadRequest}
	}
	owner, ok := "", false
	if peerToolIDPattern.MatchString(in.ToolID) {
		owner, ok = s.peerSpawns.Owner(in.ToolID)
	}
	if !ok || owner != from.fp {
		peerFail(w, http.StatusForbidden, apierr.CodePeerNotOwner, "not owner")
		return peerCmdResult{status: http.StatusForbidden}
	}
	toolID := in.ToolID
	if ad, ok := s.agentOfTool(toolID); ok && ad.ExitCommand != "" && s.Tools != nil && s.Tools.Busy(toolID) {
		_ = s.deliverToTool(toolID, ad.ExitCommand, true)
		ctx, cancel := context.WithTimeout(r.Context(), peerCloseWait)
		_ = pollwait.Until(ctx, peerCloseWait, peerClosePoll, func() bool { return !s.Tools.Busy(toolID) })
		cancel()
	}
	closed := false
	if tab := s.tabIDOfTool(toolID); tab != "" {
		closed = s.broadcastLayout("closeTab", map[string]any{"location": tab, "force": true}) > 0
	}
	if !closed && s.Tools != nil {
		_ = s.Tools.Delete(toolID)
	}
	_ = s.peerSpawns.Forget(toolID)
	httpresp.JSON(w, http.StatusOK, map[string]any{"closed": true})
	return peerCmdResult{status: http.StatusOK, target: toolID}
}
