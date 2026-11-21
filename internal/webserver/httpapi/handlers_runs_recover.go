package httpapi

import (
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"dongminal/internal/shared/agentadapter"
	"dongminal/internal/shared/dmenv"
	"dongminal/internal/shared/dmlog"
	"dongminal/internal/shared/toolhub"
	"dongminal/internal/webserver/domain/claudeacct"
	"dongminal/internal/webserver/domain/run"
)

// RUN_RECOVERY_SRS — 데몬이 죽은 뒤 빈 셸이 된 Run 의 에이전트를 세션 id 로 재개한다.

// 건너뛴 사유 (FR-RRC-11). 표의 순서가 판정의 순서다.
const (
	reasonEnded            = "ended"
	reasonNoTool           = "no-tool"
	reasonNoAgent          = "no-agent"
	reasonNoResume         = "no-resume"
	reasonNoSession        = "no-session"
	reasonBadSession       = "bad-session"
	reasonRecovering       = "recovering"
	reasonUnknown          = "unknown"
	reasonRunningHere      = "running-here"
	reasonRunningElsewhere = "running-elsewhere"
	reasonBusy             = "busy"
)

// 결과 (FR-RRC-17).
const (
	recoverResumed = "resumed"
	recoverSkipped = "skipped"
	recoverFailed  = "failed"

	recoverCoordinator = "coordinator"
	recoverMember      = "member"
)

// recoverHold 는 재개줄을 넣은 도구를 다시 넣지 않는 동안이다 (FR-RRC-18). 에이전트가 떠서
// 셸의 자식·세션 등록부에 보이기 전까지는 두 번째 요청도 셸을 비었다고 본다.
const recoverHold = 15 * time.Second

// recoverHolds 는 도구별 재개 시각이다. 판정 전에 자리를 잡아, 겹친 요청이 같은 셸에 두 번 넣지 않는다.
type recoverHolds struct {
	mu sync.Mutex
	at map[string]time.Time
}

// take 는 도구의 자리를 잡는다. 이미 잡혀 있고 시한 안이면 거짓이다.
func (h *recoverHolds) take(toolID string, now time.Time) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if at, ok := h.at[toolID]; ok && now.Sub(at) < recoverHold {
		return false
	}
	if h.at == nil {
		h.at = map[string]time.Time{}
	}
	h.at[toolID] = now
	return true
}

// release 는 넣지 않은 도구의 자리를 푼다.
func (h *recoverHolds) release(toolID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.at, toolID)
}

// recoverTarget 은 복구할 수 있는 자리 하나다 — 조정자 또는 멤버.
type recoverTarget struct {
	coord     bool
	memberID  string
	toolID    string
	agent     string
	sessionID string
	ended     bool
}

type recoverResult struct {
	Target     string `json:"target"`
	MemberID   string `json:"memberId,omitempty"`
	ToolID     string `json:"toolId,omitempty"`
	Agent      string `json:"agent,omitempty"`
	Outcome    string `json:"outcome"`
	Reason     string `json:"reason,omitempty"`
	NeedsForce bool   `json:"needsForce,omitempty"`
}

// runWideTargets 는 Run 단위 복구의 대상이다 (FR-RRC-12). 조정자 도구가 없는 Run 은 조정자를 넣지 않는다.
func runWideTargets(rec run.Record) []recoverTarget {
	var out []recoverTarget
	if rec.CoordinatorToolID != "" {
		out = append(out, coordTarget(rec))
	}
	for _, m := range rec.Members {
		out = append(out, memberTarget(m))
	}
	return out
}

func coordTarget(rec run.Record) recoverTarget {
	t := recoverTarget{coord: true, toolID: rec.CoordinatorToolID, agent: rec.CoordinatorAgent}
	if rec.Coordinator != nil {
		t.sessionID = rec.Coordinator.SessionID
	}
	return t
}

func memberTarget(m run.Member) recoverTarget {
	ended := m.Reported()
	switch m.State {
	case run.Done, run.Failed, run.Released, run.Succeeded:
		ended = true
	}
	return recoverTarget{memberID: m.ID, toolID: m.ToolID, agent: m.Agent, sessionID: m.SessionID, ended: ended}
}

// recoverStatic 은 판정 1~6 이다 (FR-RRC-11). 프로세스를 보지 않는다. 빈 사유면 통과다.
func recoverStatic(t recoverTarget, live bool) (agentadapter.Adapter, string) {
	switch {
	case t.ended:
		return agentadapter.Adapter{}, reasonEnded
	case t.toolID == "" || !live:
		return agentadapter.Adapter{}, reasonNoTool
	case t.agent == "":
		return agentadapter.Adapter{}, reasonNoAgent
	}
	ad, err := agentadapter.Get(t.agent)
	if err != nil || !ad.CanResume() {
		return agentadapter.Adapter{}, reasonNoResume
	}
	if t.sessionID == "" {
		return agentadapter.Adapter{}, reasonNoSession
	}
	if !agentadapter.ValidSessionID(t.sessionID) {
		return agentadapter.Adapter{}, reasonBadSession
	}
	return ad, ""
}

// recoverDynamic 은 판정 7~10 이다 (FR-RRC-11·13). 강제는 판정 불가만 넘는다 — 세션이
// 돈다거나 셸이 점유됐다고 확인된 것은 강제여도 건너뛴다.
func recoverDynamic(regOK bool, shell toolhub.ShellState, force bool) (reason string, needsForce bool) {
	if !force && (!regOK || shell == toolhub.ShellUnknown) {
		return reasonUnknown, true
	}
	switch shell {
	case toolhub.ShellHere:
		return reasonRunningHere, false
	case toolhub.ShellElsewhere:
		return reasonRunningElsewhere, false
	case toolhub.ShellBusy:
		return reasonBusy, false
	}
	return "", false
}

// recoverable 은 보기의 버튼 근거다 (FR-RRC-26). 판정 1~6 만 본다.
func (s *Server) recoverable(t recoverTarget) bool {
	if t.toolID == "" {
		return false
	}
	_, why := recoverStatic(t, s.toolLiveness(t.toolID) != livenessDead)
	return why == ""
}

// shellState 는 데몬에 셸 판정을 묻는다 (FR-RRC-10).
func (s *Server) shellState(toolID string, pids []int) toolhub.ShellState {
	if s.runAux.recoverProbe != nil {
		return s.runAux.recoverProbe(toolID, pids)
	}
	return s.Tools.ShellProbe(toolID, pids)
}

// agentConfigDirs 는 에이전트 설정 폴더 목록이다 — 기본 `~/.claude` 와 계정 프로필 폴더 전부
// (FR-RRC-5). 세션 등록부를 찾는 자리다.
func (s *Server) agentConfigDirs() []string {
	if s.runAux.recoverDirs != nil {
		return s.runAux.recoverDirs()
	}
	if s.ca != nil {
		return s.ca.svc.ConfigDirs()
	}
	if home, err := os.UserHomeDir(); err == nil {
		return []string{claudeacct.DefaultClaudePaths(home).ConfigHome}
	}
	return nil
}

// recoverOne 은 대상 하나를 판정하고, 통과하면 재개줄을 넣는다 (FR-RRC-11·18·21). dirs 는 요청마다
// 한 번 만든 설정 폴더 목록이고, single 은 대상 하나 복구인가다 — needsForce 는 그때만 싣는다.
func (s *Server) recoverOne(t recoverTarget, dirs []string, force, single bool) recoverResult {
	out := recoverResult{Target: recoverMember, MemberID: t.memberID, ToolID: t.toolID, Agent: t.agent}
	if t.coord {
		out.Target = recoverCoordinator
	}
	ad, why := recoverStatic(t, t.toolID != "" && s.toolLiveness(t.toolID) != livenessDead)
	if why != "" {
		out.Outcome, out.Reason = recoverSkipped, why
		return out
	}
	if !s.runAux.recoverHeld.take(t.toolID, time.Now()) {
		out.Outcome, out.Reason = recoverSkipped, reasonRecovering
		return out
	}
	var pids []int
	regOK := true
	if ad.SessionPIDs != nil {
		pids, regOK = ad.SessionPIDs(t.sessionID, dirs)
	}
	why, needsForce := recoverDynamic(regOK, s.shellState(t.toolID, pids), force)
	if why != "" {
		s.runAux.recoverHeld.release(t.toolID)
		out.Outcome, out.Reason, out.NeedsForce = recoverSkipped, why, needsForce && single
		return out
	}
	hooks := ""
	if s.cfg.DataDir != "" {
		hooks = dmenv.AgentHooksDirIn(filepath.Join(s.cfg.DataDir, dmenv.BinDir))
	}
	line, err := ad.ResumeLine(hooks, t.sessionID, !t.coord)
	if err == nil {
		err = s.deliverToTool(t.toolID, line, true)
	}
	if err != nil {
		s.runAux.recoverHeld.release(t.toolID)
		out.Outcome, out.Reason = recoverFailed, err.Error()
		return out
	}
	out.Outcome = recoverResumed
	return out
}

// apiRunRecover implements POST /api/runs/recover (FR-RRC-20).
func (s *Server) apiRunRecover(w http.ResponseWriter, r *http.Request) {
	if !s.runsReady(w) {
		return
	}
	var body struct {
		RunID       string `json:"runId"`
		MemberID    string `json:"memberId"`
		Coordinator bool   `json:"coordinator"`
		Force       bool   `json:"force"`
	}
	if !decodeJSONBody(w, r, &body) {
		return
	}
	single := body.MemberID != "" || body.Coordinator
	if (body.MemberID != "" && body.Coordinator) || (body.Force && !single) {
		writeRunError(w, run.ErrInvalidArgument, map[string]any{"runId": body.RunID})
		return
	}
	rec, ok := s.Runs.Get(body.RunID)
	if !ok {
		writeRunError(w, run.ErrUnknownRun, map[string]any{"runId": body.RunID})
		return
	}
	if rec.State != run.Open {
		writeRunError(w, run.ErrRunClosed, map[string]any{"runId": body.RunID})
		return
	}
	var targets []recoverTarget
	switch {
	case body.Coordinator:
		targets = []recoverTarget{coordTarget(rec)}
	case body.MemberID != "":
		for _, m := range rec.Members {
			if m.ID == body.MemberID {
				targets = []recoverTarget{memberTarget(m)}
			}
		}
		if targets == nil {
			writeRunError(w, run.ErrUnknownMember, map[string]any{"memberId": body.MemberID})
			return
		}
	default:
		targets = runWideTargets(rec)
	}
	dirs := s.agentConfigDirs()
	results := make([]recoverResult, 0, len(targets))
	resumed := 0
	for _, t := range targets {
		res := s.recoverOne(t, dirs, body.Force, single)
		if res.Outcome == recoverResumed {
			resumed++
		}
		// FR-RRC-27: 대상·결과·사유만 남긴다. 재개줄 본문은 남기지 않는다.
		dmlog.Infof(nil, "[runs] recover run=%s target=%s member=%s tool=%s outcome=%s reason=%s",
			rec.ID, res.Target, res.MemberID, res.ToolID, res.Outcome, res.Reason)
		results = append(results, res)
	}
	if resumed > 0 {
		s.broadcastRunChanged(rec)
	}
	writeJSON(w, map[string]any{"runId": rec.ID, "results": results})
}
