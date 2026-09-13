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
	"dongminal/internal/webserver/apierr"
	"dongminal/internal/webserver/domain/agentsess"
)

// 에이전트 도구의 HTTP 표면 (M8_UNIFIED_SRS 묶음 P·T — FR-APS-5·6 · FR-AGT-4·8·10·11).
//
// 생성은 `POST /api/tools?kind=agent&agent=<id>` — 터미널 도구와 **같은 종단**을
// 지난다 (FR-AGT-8). 그 뒤의 프롬프트·승인·제어·재생은 `/api/agent/*` 다. 이 파일은
// 에이전트 이름을 모른다 — 어댑터 id 는 요청이 실어 오고 등록부가 판정한다 (FR-U-1).

// agentMgr 는 해석층이다. 늦게 세우는 이유는 테스트가 `&Server{Deps: …}` 로 서버를
// 만들기 때문이다 — New 를 지나지 않아도 첫 호출에 선다.
func (s *Server) agentMgr() *agentsess.Manager {
	s.agentOnce.Do(func() {
		s.agents = agentsess.New(agentsess.Deps{
			Sink:     agentSink{s: s},
			Write:    func(id string, data []byte) error { return s.Tools.Write(id, data) },
			Snapshot: func(id string) (toolhub.ToolSnapshot, error) { return s.Tools.SnapshotTool(id) },
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

// AgentExit 은 도구의 죽음이다 — 세션을 닫는다.
func (s *Server) AgentExit(toolID string) {
	s.agentMgr().Exit(toolID)
}

// AgentAdoptExisting 은 이미 살아 있는 에이전트 도구에 세션을 세운다 — 데몬 모드의
// 서버 재시동이 그 경우다 (D-C-5: 도구는 데몬의 것이라 살아남는다). 어댑터는
// ToolInfo.Agent 가 말한다.
func (s *Server) AgentAdoptExisting() {
	if s.Tools == nil {
		return
	}
	for _, ti := range s.Tools.List() {
		if ti.Kind != toolhub.KindAgent {
			continue
		}
		ad, err := agentadapter.Get(ti.Agent)
		if err != nil || ad.Proto == nil {
			dmlog.Warnf(nil, "[agent %s] 어댑터 %q 를 되살리지 못했다: %v", ti.ID, ti.Agent, err)
			continue
		}
		if _, err := s.agentMgr().Open(ti.ID, ad); err != nil {
			dmlog.Warnf(nil, "[agent %s] open: %v", ti.ID, err)
		}
	}
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
	argv := ad.Proto.Launch(agentadapter.LaunchOpts{
		Bin: bin, Cwd: cwd, Model: q.Get("model"), Resume: q.Get("resume"), PermissionMode: q.Get("permissionMode"),
	})
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
	if _, err := s.agentMgr().Open(tool.ID, ad); err != nil {
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

// apiAgentEvents 는 재생이다 (D-C-3): `?tool=&since=` → 상태 + since 뒤의 이벤트.
func (s *Server) apiAgentEvents(w http.ResponseWriter, r *http.Request) {
	sess := s.agentSession(w, r.URL.Query().Get("tool"))
	if sess == nil {
		return
	}
	since, _ := strconv.ParseInt(r.URL.Query().Get("since"), 10, 64)
	evs, truncated := sess.Events(since)
	if evs == nil {
		evs = []agentsess.Logged{}
	}
	writeJSON(w, map[string]any{"state": sess.State(), "events": evs, "truncated": truncated})
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
	default:
		fail(w, http.StatusBadRequest, err.Error(), err)
	}
}

// agentState 는 Server 가 해석층을 위해 드는 것이다 — Server 에 임베딩된다.
type agentState struct {
	agentOnce sync.Once
	agents    *agentsess.Manager
}
