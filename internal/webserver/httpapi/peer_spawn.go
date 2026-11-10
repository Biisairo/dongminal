package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"dongminal/internal/shared/agentadapter"
	"dongminal/internal/shared/dmlog"
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
	// peerSpawnMax 는 한 짝이 띄워 살아 있는 도구의 상한이다 (I-31).
	peerSpawnMax = 4
)

var errPeerWindowTimeout = errors.New("새 창 요청이 시간 안에 끝나지 않았다")

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
	if st := peerReadStatus(w, r, &in); st != 0 {
		return peerCmdResult{status: st}
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
	// 데몬이 목록을 모르는 동안에는 살아 있는 도구를 셀 수 없다 — "죽음" 으로 읽으면 모든
	// 기록이 정리된다 (TOOL_LIST_UNKNOWN_SRS, 재리뷰 C-1).
	if s.Tools == nil || s.ToolIO == nil || !s.toolListKnown() {
		return fail(http.StatusServiceUnavailable, apierr.CodeToolsUnready, "tools unavailable")
	}
	release, ok := s.peerSpawns.Reserve(from.fp, peerSpawnMax, s.toolLive)
	if !ok {
		return fail(http.StatusTooManyRequests, apierr.CodePeerSpawnLimit, "spawn limit")
	}
	defer release()
	// I-30: 원격 프롬프트는 셸 명령줄에 싣지 않는다. 인용 규칙이 셸마다 달라 명령 주입이 된다.
	// I-46: Run 멤버의 dmctl 사전 허용도 싣지 않는다 — 받는 노드의 평소 권한으로 돈다.
	line := ad.BareLaunchLine()
	toolID, headless, err := s.peerSpawnShell(r.Context(), cwd, in.Placement, in.At, in.Name)
	if err != nil {
		return fail(http.StatusInternalServerError, apierr.CodeInternal, "create tool failed")
	}
	// 기록을 먼저 남긴다 — 아래 정리가 실패해도 그 도구는 상한에 세고 원격에서 닫을 수 있다.
	// 기록했으면 자리 예약을 바로 푼다. 둘을 함께 세면 같은 spawn 이 두 번 세진다 (리뷰 C-5).
	if err := s.peerSpawns.Record(toolID, from.fp); err != nil {
		s.peerCloseTool(r.Context(), toolID)
		return fail(http.StatusInternalServerError, apierr.CodeSaveFailed, "record")
	}
	release()
	// I-32: 도구를 만든 뒤의 실패는 도구를 닫고 기록을 지운다. 닫지 못하면 기록을 남기고
	// 500 internal 이다 (리뷰 C-6).
	undo := func(status int, code, msg string) peerCmdResult {
		if !s.peerCloseTool(r.Context(), toolID) {
			return fail(http.StatusInternalServerError, apierr.CodeInternal, "close failed")
		}
		_ = s.peerSpawns.Forget(toolID)
		return fail(status, code, msg)
	}
	// L-12: 판정과 생성 사이에 경로 요소가 바뀌었을 수 있다. 셸이 실제로 선 곳을 다시
	// 본다. 모르면(Windows 등) 판정을 믿는다.
	if actual := s.Tools.Cwd(toolID); actual != "" {
		if _, ok := peer.DirAllowed(actual, s.peers.Config().AllowedDirs); !ok {
			return undo(http.StatusForbidden, apierr.CodePeerDirNotAllowed, "dir not allowed")
		}
	}
	if err := s.deliverToTool(toolID, line, true); err != nil {
		return undo(http.StatusInternalServerError, apierr.CodeInternal, "deliver failed")
	}
	if in.Prompt != "" {
		go s.peerDeliverPrompt(toolID, ad, from.fp, peerEnvelope(from.name, in.From, toolID, in.Prompt, time.Now()))
	}
	httpresp.JSON(w, http.StatusOK, map[string]any{"toolId": toolID, "headless": headless})
	return peerCmdResult{status: http.StatusOK, target: toolID, n: len(in.Prompt)}
}

// peerDeliverPrompt 는 띄운 에이전트가 준비되면 첫 프롬프트를 그 입력에 넣는다 (I-30).
// 전경이 띄운 그 에이전트가 아니면 넣지 않는다 — 셸에 들어가면 원격 글이 명령이 된다.
//
// 기다리는 동안 짝이 해제되면 넣지 않는다 — 해제는 즉시 효력을 갖는다 (FR-PNW-31).
func (s *Server) peerDeliverPrompt(toolID string, ad agentadapter.Adapter, ownerFP, text string) {
	ctx, cancel := context.WithTimeout(context.Background(), s.limits.peerPromptWait)
	defer cancel()
	allowQuiescence := !ad.Readiness.Hooks
	err := pollwait.OnOrAt(ctx, s.limits.peerPromptWait, s.activityChanged.C, func(now time.Time) (bool, time.Time) {
		if !s.toolLive(toolID) {
			// 도구가 사라졌다 — 기다릴 것이 없다. 아래 재확인이 넣지 않게 한다.
			return true, time.Time{}
		}
		if !s.peerRunsAgent(toolID, ad.ID) {
			return false, now.Add(waitLivenessInterval)
		}
		status, _, _ := evaluateWait("ready", s.toolStatusOf(toolID, true), allowQuiescence)
		return status == "ready", now.Add(waitLivenessInterval)
	})
	if err != nil {
		dmlog.Infof(nil, "[peer] spawn 프롬프트를 버렸다 tool=%s: 에이전트가 준비되지 않았다", toolID)
		return
	}
	if !s.peerRunsAgent(toolID, ad.ID) || !s.peers.IsPeer(ownerFP) || s.peerIsClosing(toolID) {
		return
	}
	// I-47: 붙여넣기 직전에 도구가 사는 곳에서 전경을 새로 본다.
	if err := s.ToolIO.SendPasteIfForeground(toolID, []byte(text), true, ad.DetectCmd); err != nil {
		dmlog.Infof(nil, "[peer] spawn 프롬프트를 넣지 않았다 tool=%s: %v", toolID, err)
	}
}

// peerIsClosing 은 agent.close 가 그 도구를 닫는 중인가다 (I-59).
func (s *Server) peerIsClosing(toolID string) bool {
	_, ok := s.peerClosing.Load(toolID)
	return ok
}

// toolListKnown 은 도구 목록이 관측된 사실인가다. 데몬 재접속 창에서는 거짓이다.
func (s *Server) toolListKnown() bool {
	if s.Tools == nil {
		return false
	}
	_, ok := s.Tools.ListOK()
	return ok
}

// peerRunsAgent 는 도구가 살아 있고 전경이 agentID 에이전트인가다.
func (s *Server) peerRunsAgent(toolID, agentID string) bool {
	cur, ok := s.agentOfTool(toolID)
	return ok && cur.ID == agentID && s.toolLive(toolID)
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
		// I-33: 화면이 늦게라도 창을 띄울 수 있다. 헤드리스까지 만들면 도구가 둘이 된다.
		if n > 0 && timedOut {
			return "", false, errPeerWindowTimeout
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
	if st := peerReadStatus(w, r, &in); st != 0 {
		return peerCmdResult{status: st}
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
	if st := peerReadStatus(w, r, &in); st != 0 {
		return peerCmdResult{status: st}
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
	// I-59: 종료 명령을 보낸 뒤 에이전트가 끝나는 동안 원격 글이 들어가면 셸에 남는다.
	s.peerClosing.Store(toolID, struct{}{})
	defer s.peerClosing.Delete(toolID)
	if ad, ok := s.agentOfTool(toolID); ok && ad.ExitCommand != "" && s.Tools != nil && s.Tools.Busy(toolID) {
		_ = s.deliverToTool(toolID, ad.ExitCommand, true)
		ctx, cancel := context.WithTimeout(r.Context(), peerCloseWait)
		_ = pollwait.Until(ctx, peerCloseWait, peerClosePoll, func() bool { return !s.Tools.Busy(toolID) })
		cancel()
	}
	if !s.peerCloseTool(r.Context(), toolID) {
		peerFail(w, http.StatusInternalServerError, apierr.CodeInternal, "close failed")
		return peerCmdResult{status: http.StatusInternalServerError, target: toolID}
	}
	_ = s.peerSpawns.Forget(toolID)
	httpresp.JSON(w, http.StatusOK, map[string]any{"closed": true})
	return peerCmdResult{status: http.StatusOK, target: toolID}
}

// peerCloseTool 은 도구를 닫고 닫혔는가를 돌려준다 (I-32). 탭이 있으면 화면에 닫게 하고,
// 방송을 받은 화면이 있어도 실제로 닫혔는지 확인한다. 남아 있으면 직접 지운다.
func (s *Server) peerCloseTool(ctx context.Context, toolID string) bool {
	// 목록을 모르면 닫혔는지도 모른다. 닫혔다고 답하지 않는다 (재리뷰 C-1).
	if !s.toolListKnown() {
		return false
	}
	if tab := s.tabIDOfTool(toolID); tab != "" &&
		s.broadcastLayout("closeTab", map[string]any{"location": tab, "force": true}) > 0 {
		wait := s.limits.peerTabCloseWait
		c, cancel := context.WithTimeout(ctx, wait)
		_ = pollwait.Until(c, wait, peerClosePoll, func() bool { return !s.toolLive(toolID) })
		cancel()
	}
	if !s.toolLive(toolID) {
		return true
	}
	return s.Tools != nil && s.Tools.Delete(toolID) == nil
}
