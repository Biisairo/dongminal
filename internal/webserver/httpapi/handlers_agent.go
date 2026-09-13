package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"

	"dongminal/internal/shared/agentadapter"
	"dongminal/internal/shared/dmenv"
	"dongminal/internal/shared/dmlog"
	"dongminal/internal/shared/platform"
	"dongminal/internal/shared/toolhub"
	"dongminal/internal/shared/workspace"
	"dongminal/internal/webserver/apierr"
	"dongminal/internal/webserver/domain/agentsess"
)

// 에이전트 도구의 HTTP 표면 (M8_UNIFIED_SRS 묶음 P·T·B — FR-APS-5·6 · FR-AGT-4·8·10·11 ·
// FR-ABG-10·20).
//
// 생성은 `POST /api/tools?kind=agent&agent=<id>` — 터미널 도구와 **같은 종단**을
// 지난다 (FR-AGT-8). 그 뒤의 프롬프트·승인·제어·재생·휴면·재개는 `/api/agent/*` 다. 이 파일은
// 에이전트 이름을 모른다 — 어댑터 id 는 요청이 실어 오고 등록부가 판정한다 (FR-U-1).

// agentMgr 는 해석층이다. 늦게 세우는 이유는 테스트가 `&Server{Deps: …}` 로 서버를
// 만들기 때문이다 — New 를 지나지 않아도 첫 호출에 선다.
func (s *Server) agentMgr() *agentsess.Manager {
	s.agentOnce.Do(func() {
		s.agents = agentsess.New(agentsess.Deps{
			Sink:     agentSink{s: s},
			Write:    func(id string, data []byte) error { return s.Tools.Write(id, data) },
			Snapshot: func(id string) (toolhub.ToolSnapshot, error) { return s.Tools.SnapshotTool(id) },
			DataDir:  s.cfg.DataDir,
		})
	})
	return s.agents
}

// agentSink 는 해석층의 두 출구다 (agentsess.Sink).
type agentSink struct{ s *Server }

func (k agentSink) Event(toolID string, le agentsess.Logged) {
	if k.s.Commands == nil {
		return
	}
	b, _ := json.Marshal(map[string]any{
		"action": "agent_event",
		"args":   map[string]any{"toolId": toolID, "seq": le.Seq, "at": le.At, "ev": le.Ev},
	})
	k.s.Commands.Broadcast(b)
}

// Activity 는 `activity/set` 과 같은 함수를 지난다 (D-C-2). turnKnown 은 참이다 —
// 에이전트 도구에서는 입력을 넣은 주체가 우리이므로 턴의 출처를 언제나 안다
// (FR-AAL-2).
func (k agentSink) Activity(toolID, state, tool, detail string, userPrompt bool) {
	k.s.reportActivity(toolID, state, tool, detail, userPrompt, true)
}

// AgentOutput 은 도구 출력 청크의 입구다 — 두 모드의 배선이 이것을 부른다 (D-C-2).
// 에이전트 도구의 바이트면 true 다; 호출자는 그때 터미널 경로(L1 OSC·L2 무장)를
// 지나지 않는다 (FR-AAL-5). 세션이 아직 없는 에이전트 도구의 바이트도 true 다 —
// 열 때 스냅샷이 되메운다.
//
// 종류는 청크에 실려 온다 (D-C-10). 여기서 목록에 되묻지 않는다 — 데몬 모드의
// 이 호출은 ToolClient 의 readLoop 안이고, 목록은 그 readLoop 이 응답을 읽어야
// 끝나는 RPC 다. 되물으면 시한(5초)까지 막혔다가 연결을 떨어뜨린다 (§2-25).
func (s *Server) AgentOutput(toolID string, kind toolhub.ToolKind, data []byte, end int64) bool {
	if kind != toolhub.KindAgent {
		return false
	}
	s.agentMgr().Feed(toolID, data, end)
	return true
}

// AgentExit 은 도구의 죽음이다 — 세션은 남고 오류·휴면 상태가 된다 (D-C-11·15). info 는
// 종료 코드와 stderr 꼬리다.
func (s *Server) AgentExit(toolID string, info toolhub.ExitInfo) {
	s.agentMgr().Exit(toolID, info)
}

// AgentForget 은 사용자의 닫기다 — 세션·레코드·로그를 지운다. 도구를 지우는 길
// (`DELETE /api/tools/<id>`·백그라운드 kill)이 **먼저** 부른다: 그래야 뒤따르는 exit 이
// 오류 상태를 만들지 않는다.
func (s *Server) AgentForget(toolID string) {
	s.agentMgr().Forget(toolID)
}

// AgentRestore 는 부팅이다 (D-C-14). 레코드마다 — 도구가 살아 있으면(데몬 모드, D-C-5)
// `Resume` 으로 채택하고, 없으면 오류 상태로 되살린다. 어느 탭도 참조하지 않는 레코드는
// 버린다 — 판정은 `LoadAll` 과 같은 `workspace.ReferencedToolIDs` 다. 레코드 없이 살아
// 있는 에이전트 도구(옛 판이 남긴 것)는 종전대로 빈 옵션으로 채택한다.
func (s *Server) AgentRestore() {
	if s.Tools == nil {
		return
	}
	alive := map[string]toolhub.ToolInfo{}
	for _, ti := range s.Tools.List() {
		if ti.Kind == toolhub.KindAgent {
			alive[ti.ID] = ti
		}
	}
	refs := map[string]struct{}{}
	if s.Work != nil {
		raw, _ := s.Work.Snapshot()
		if r, err := workspace.ReferencedToolIDs(raw); err == nil {
			refs = r
		}
	}
	m := s.agentMgr()
	m.Restore(
		func(id string) bool { _, ok := alive[id]; return ok },
		func(id string) bool { _, ok := refs[id]; return ok },
	)
	for id, ti := range alive {
		if m.Get(id) != nil {
			continue
		}
		ad, err := agentadapter.Get(ti.Agent)
		if err != nil || ad.Proto == nil {
			dmlog.Warnf(nil, "[agent %s] 어댑터 %q 를 되살리지 못했다: %v", id, ti.Agent, err)
			continue
		}
		if _, err := m.Open(id, ad, agentadapter.LaunchOpts{}); err != nil {
			dmlog.Warnf(nil, "[agent %s] open: %v", id, err)
		}
	}
}

// agentToolsList 는 `/api/state` 의 도구 목록이다 (D-C-17) — toolhub 의 목록에 휴면·오류
// 세션을 합친다. 그래야 브라우저의 `clean()` 이 그 탭을 살려 둔다.
func (s *Server) agentToolsList(tools []toolhub.ToolInfo) []toolhub.ToolInfo {
	return append(tools, s.agentMgr().Dormant()...)
}

// resolveAgentBin 은 실행 파일이다 (D-C-7): `DONGMINAL_AGENT_BIN_DIR/<DetectCmd>` 가
// 있으면 그것, 없으면 PATH.
func resolveAgentBin(ad agentadapter.Adapter) (string, error) {
	name := ad.DetectCmd + platform.Current().Paths.ExeSuffix()
	if dir := os.Getenv(dmenv.EnvAgentBinDir); dir != "" {
		p := filepath.Join(dir, name)
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p, nil
		}
	}
	return exec.LookPath(ad.DetectCmd)
}

// createAgentTool 은 `POST /api/tools?kind=agent` 의 갈래다 (FR-AGT-1·8). 어댑터의
// 프로토콜 표면이 argv 를 만들고, toolhub 는 그것을 파이프로 띄운다 (FR-AGT-2·3).
func (s *Server) createAgentTool(w http.ResponseWriter, r *http.Request, cwd string, cols, rows uint16) {
	q := r.URL.Query()
	ad, err := agentadapter.Get(q.Get("agent"))
	if err != nil {
		httpErr(w, "unknown agent", http.StatusBadRequest, apierr.CodeAgentUnknown)
		return
	}
	if ad.Proto == nil {
		// FR-APS-4: 없는 것은 부재로 — 터미널 셸로 조용히 내려가지 않는다.
		httpErr(w, "agent has no protocol surface", http.StatusBadRequest, apierr.CodeAgentNoProto)
		return
	}
	bin, err := resolveAgentBin(ad)
	if err != nil {
		httpErr(w, "agent binary not found", http.StatusNotFound, apierr.CodeAgentBinMissing)
		return
	}
	opts := agentadapter.LaunchOpts{
		Bin: bin, Cwd: cwd, Model: q.Get("model"), Resume: q.Get("resume"),
		PermissionMode: q.Get("permissionMode"), Approval: q.Get("approval"),
	}
	argv := ad.Proto.Launch(opts)
	tool, err := s.tools(r).Create(cwd, cols, rows, toolhub.Placement{
		WindowUUID: q.Get("window"), Kind: toolhub.KindAgent, Argv: argv, Agent: ad.ID,
	})
	if err != nil {
		if errors.Is(err, toolhub.ErrToolCap) {
			fail(w, http.StatusTooManyRequests, err.Error(), nil)
			return
		}
		fail(w, http.StatusInternalServerError, "도구를 만들지 못했습니다", err)
		return
	}
	if _, err := s.agentMgr().Open(tool.ID, ad, opts); err != nil {
		fail(w, http.StatusInternalServerError, "도구를 만들지 못했습니다", err)
		return
	}
	writeJSON(w, map[string]string{"id": tool.ID, "name": tool.Name, "kind": string(toolhub.KindAgent), "agent": ad.ID})
}

// agentEntry 는 `GET /api/agents` 의 한 줄이다 — 등록부에서 파생한다 (FR-U-1).
type agentEntry struct {
	ID string `json:"id"`
	// Proto 는 에이전트 도구로 뜰 수 있는가 (FR-APS-9). Available 은 실행 파일이
	// 있는가. 둘 다 참이어야 메뉴에 나타난다.
	Proto     bool `json:"proto"`
	Available bool `json:"available"`
}

func (s *Server) apiAgentsList(w http.ResponseWriter, r *http.Request) {
	out := make([]agentEntry, 0)
	for _, id := range agentadapter.IDs() {
		ad, _ := agentadapter.Get(id)
		e := agentEntry{ID: id, Proto: ad.Proto != nil}
		if e.Proto {
			_, err := resolveAgentBin(ad)
			e.Available = err == nil
		}
		out = append(out, e)
	}
	writeJSON(w, out)
}

// agentSession 은 요청의 도구에 딸린 세션이다. 없으면 404 를 쓰고 nil.
func (s *Server) agentSession(w http.ResponseWriter, toolID string) *agentsess.Session {
	if toolID == "" {
		httpErr(w, "toolId required", http.StatusBadRequest, apierr.CodeMissingArg)
		return nil
	}
	sess := s.agentMgr().Get(toolID)
	if sess == nil {
		httpErr(w, "agent session not found", http.StatusNotFound, apierr.CodeAgentNoSession)
		return nil
	}
	return sess
}

// apiAgentEvents 는 재생이다 (D-C-3): `?tool=&since=` → 상태 + since 뒤의 이벤트. 잘렸으면
// 요약 스냅샷이 함께 온다 (D-C-13).
func (s *Server) apiAgentEvents(w http.ResponseWriter, r *http.Request) {
	sess := s.agentSession(w, r.URL.Query().Get("tool"))
	if sess == nil {
		return
	}
	since, _ := strconv.ParseInt(r.URL.Query().Get("since"), 10, 64)
	evs, truncated, snap := sess.Replay(since)
	if evs == nil {
		evs = []agentsess.Logged{}
	}
	out := map[string]any{"state": sess.State(), "events": evs, "truncated": truncated}
	if snap != nil {
		out["snapshot"] = snap
	}
	writeJSON(w, out)
}

// apiAgentHibernate 는 명시적 휴면이다 (FR-ABG-10·11). 프로세스를 끝내고(`Terminate`) 그 exit
// 관측이 세션을 휴면으로 마감한다 — 신원이 없으면 409 (D-C-16).
func (s *Server) apiAgentHibernate(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ToolID string `json:"toolId"`
	}
	if !decodeJSONBody(w, r, &body) {
		return
	}
	sess := s.agentSession(w, body.ToolID)
	if sess == nil {
		return
	}
	tools := s.tools(r)
	err := s.agentMgr().Hibernate(body.ToolID, func() error {
		if err := tools.Terminate(body.ToolID, s.limits.toolKillGrace); err != nil && !errors.Is(err, toolhub.ErrToolNotFound) {
			return err
		}
		return nil
	})
	if err != nil {
		s.agentErr(w, err)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

// apiAgentResume 은 재개다 (FR-ABG-10) — 같은 toolId 로 새 프로세스를 세운다 (D-C-11,
// `Placement.ReuseID`). 기동 옵션은 레코드의 것 + 실행 파일이다.
func (s *Server) apiAgentResume(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ToolID string `json:"toolId"`
	}
	if !decodeJSONBody(w, r, &body) {
		return
	}
	sess := s.agentSession(w, body.ToolID)
	if sess == nil {
		return
	}
	st := sess.State()
	if st.Dormant == "" {
		httpErr(w, "agent not dormant", http.StatusConflict, apierr.CodeAgentNotDormant)
		return
	}
	if !st.Resumable {
		httpErr(w, "agent has no session identity", http.StatusConflict, apierr.CodeAgentNoIdentity)
		return
	}
	ad, err := agentadapter.Get(st.Agent)
	if err != nil || ad.Proto == nil {
		httpErr(w, "unknown agent", http.StatusBadRequest, apierr.CodeAgentUnknown)
		return
	}
	bin, err := resolveAgentBin(ad)
	if err != nil {
		httpErr(w, "agent binary not found", http.StatusNotFound, apierr.CodeAgentBinMissing)
		return
	}
	opts := sess.ResumeOpts()
	opts.Bin = bin
	tool, err := s.tools(r).Create(opts.Cwd, 0, 0, toolhub.Placement{
		Kind: toolhub.KindAgent, Argv: ad.Proto.Launch(opts), Agent: ad.ID, ReuseID: body.ToolID,
	})
	if err != nil {
		if errors.Is(err, toolhub.ErrToolCap) {
			fail(w, http.StatusTooManyRequests, err.Error(), nil)
			return
		}
		fail(w, http.StatusInternalServerError, "도구를 만들지 못했습니다", err)
		return
	}
	if tool.ID != body.ToolID {
		// 옛 데몬이 reuseId 를 모른다 — 새 신원으로는 탭을 이을 수 없다. 방금 띄운 것을 거둔다.
		_ = s.tools(r).Delete(tool.ID)
		fail(w, http.StatusInternalServerError, "도구를 만들지 못했습니다", errors.New("daemon ignored reuseId"))
		return
	}
	if err := s.agentMgr().Reopen(body.ToolID, opts); err != nil {
		s.agentErr(w, err)
		return
	}
	writeJSON(w, map[string]string{"id": tool.ID, "name": tool.Name, "kind": string(toolhub.KindAgent), "agent": ad.ID})
}

func (s *Server) apiAgentPrompt(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ToolID string `json:"toolId"`
		Text   string `json:"text"`
	}
	if !decodeJSONBody(w, r, &body) {
		return
	}
	sess := s.agentSession(w, body.ToolID)
	if sess == nil {
		return
	}
	if body.Text == "" {
		httpErr(w, "text required", http.StatusBadRequest, apierr.CodeMissingArg)
		return
	}
	if err := sess.Prompt(body.Text); err != nil {
		s.agentErr(w, err)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func (s *Server) apiAgentApprove(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ToolID  string            `json:"toolId"`
		ID      string            `json:"id"`
		Choice  string            `json:"choice"`
		Answers map[string]string `json:"answers"`
	}
	if !decodeJSONBody(w, r, &body) {
		return
	}
	sess := s.agentSession(w, body.ToolID)
	if sess == nil {
		return
	}
	if body.ID == "" {
		httpErr(w, "id required", http.StatusBadRequest, apierr.CodeMissingArg)
		return
	}
	if err := sess.Approve(body.ID, agentadapter.Decision{Choice: body.Choice, Answers: body.Answers}); err != nil {
		s.agentErr(w, err)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func (s *Server) apiAgentControl(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ToolID string `json:"toolId"`
		Kind   string `json:"kind"`
		Value  string `json:"value"`
	}
	if !decodeJSONBody(w, r, &body) {
		return
	}
	sess := s.agentSession(w, body.ToolID)
	if sess == nil {
		return
	}
	if err := sess.Control(agentadapter.ControlOp{Kind: body.Kind, Value: body.Value}); err != nil {
		s.agentErr(w, err)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func (s *Server) apiAgentInterrupt(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ToolID string `json:"toolId"`
	}
	if !decodeJSONBody(w, r, &body) {
		return
	}
	sess := s.agentSession(w, body.ToolID)
	if sess == nil {
		return
	}
	if err := sess.Interrupt(); err != nil {
		s.agentErr(w, err)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

// apiAgentTUILine 은 TUI 출구의 한 줄이다 (FR-AGT-10) — 브라우저가 터미널 탭을 열고
// 그 셸에 타이핑한다. 인용은 이 호스트의 셸 규칙이다.
func (s *Server) apiAgentTUILine(w http.ResponseWriter, r *http.Request) {
	sess := s.agentSession(w, r.URL.Query().Get("tool"))
	if sess == nil {
		return
	}
	argv := sess.TUIResume()
	if len(argv) == 0 {
		httpErr(w, "tui resume unsupported", http.StatusBadRequest, apierr.CodeAgentUnsupported)
		return
	}
	writeJSON(w, map[string]string{"line": agentsess.TUIResumeLine(argv, platform.Current().Shell.Quote), "sessionId": sess.SessionID()})
}

// agentErr 는 해석층의 오류를 코드로 옮긴다 (D-B-3: 문장은 프론트의 것이다).
func (s *Server) agentErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, agentadapter.ErrNotOpen):
		httpErr(w, "approval not open", http.StatusConflict, apierr.CodeApprovalNotOpen)
	case errors.Is(err, agentadapter.ErrUnsupported):
		httpErr(w, "unsupported", http.StatusBadRequest, apierr.CodeAgentUnsupported)
	case errors.Is(err, agentsess.ErrNoSession):
		httpErr(w, "agent session not found", http.StatusNotFound, apierr.CodeAgentNoSession)
	case errors.Is(err, agentsess.ErrNoIdentity):
		httpErr(w, "agent has no session identity", http.StatusConflict, apierr.CodeAgentNoIdentity)
	case errors.Is(err, agentsess.ErrDormant):
		httpErr(w, "agent dormant", http.StatusConflict, apierr.CodeAgentDormant)
	case errors.Is(err, agentsess.ErrNotDormant):
		httpErr(w, "agent not dormant", http.StatusConflict, apierr.CodeAgentNotDormant)
	default:
		fail(w, http.StatusBadRequest, err.Error(), err)
	}
}

// agentState 는 Server 가 해석층을 위해 드는 것이다 — Server 에 임베딩된다.
type agentState struct {
	agentOnce sync.Once
	agents    *agentsess.Manager
}
