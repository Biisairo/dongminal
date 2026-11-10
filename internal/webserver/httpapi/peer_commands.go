package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"sort"
	"time"

	"dongminal/internal/shared/agentadapter"
	"dongminal/internal/shared/toolhub"
	"dongminal/internal/webserver/apierr"
	"dongminal/internal/webserver/domain/peer"
	"dongminal/internal/webserver/httpresp"
)

// 노드 포트의 프로토콜 명령 (PEER_NETWORK_SRS 묶음 R, FR-PNW-40~64).

// peerMessageMax 는 message·prompt 의 상한이다 (FR-PNW-43).
const peerMessageMax = 16 << 10

// peerToolIDPattern 은 원격에서 온 도구 식별자의 모양이다. 이 값은 엔벨로프 헤더에
// 그대로 들어가므로 공백·괄호·개행을 받지 않는다 (FR-PNW-90).
var peerToolIDPattern = regexp.MustCompile(`^[A-Za-z0-9-]{1,64}$`)

// peerCmdResult 는 감사 로그에 남길 한 줄의 재료다 (FR-PNW-94). 본문은 없다.
type peerCmdResult struct {
	status int
	target string
	n      int
}

// peerCaller 는 명령을 보낸 짝이다. name 은 이 노드가 붙인 이름이다 (FR-PNW-91).
type peerCaller struct {
	name string
	fp   string
}

type peerCmdFunc func(s *Server, w http.ResponseWriter, r *http.Request, from peerCaller) peerCmdResult

// peerCommands 는 이 노드가 받는 명령이다. node.info 의 commands 가 이 목록이다.
// 함수인 이유는 node.info 가 이 표를 읽기 때문이다 — 변수면 초기화가 돈다.
func peerCommands() map[string]peerCmdFunc {
	return map[string]peerCmdFunc{
		"node.info":    (*Server).peerNodeInfo,
		"agents.list":  (*Server).peerAgentsList,
		"message.send": (*Server).peerMessageSend,
		"agent.spawn":  (*Server).peerAgentSpawn,
		"agent.status": (*Server).peerAgentStatus,
		"agent.close":  (*Server).peerAgentClose,
	}
}

func peerCommandNames() []string {
	out := make([]string, 0, len(peerCommands()))
	for op := range peerCommands() {
		out = append(out, op)
	}
	sort.Strings(out)
	return out
}

// peerCmd 는 명령 하나를 상한·감사와 함께 감싼다 (FR-PNW-43·94).
func (s *Server) peerCmd(op string, fn peerCmdFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		fp := peer.ClientFingerprint(r)
		name, _ := s.peers.NameOf(fp)
		if !s.peerLimiter.Allow(fp) {
			peerAudit("in", name, op, http.StatusTooManyRequests)
			peerFail(w, http.StatusTooManyRequests, apierr.CodePeerRateLimited, "rate limited")
			return
		}
		res := fn(s, w, r, peerCaller{name: name, fp: fp})
		peerAuditCmd("in", name, op, res)
	}
}

func (s *Server) peerNodeInfo(w http.ResponseWriter, r *http.Request, _ peerCaller) peerCmdResult {
	agents := []string{}
	for _, id := range agentadapter.IDs() {
		if ad, err := agentadapter.Get(id); err == nil && ad.Installed() {
			agents = append(agents, id)
		}
	}
	cfg := s.peers.Config()
	httpresp.JSON(w, http.StatusOK, map[string]any{
		"name": cfg.Name, "version": s.cfg.Version, "proto": peerProto,
		"commands": peerCommandNames(), "agents": agents, "allowedDirs": cfg.AllowedDirs,
	})
	return peerCmdResult{status: http.StatusOK}
}

// peerAgentTool 은 agents.list 의 한 항목이다 (FR-PNW-51).
type peerAgentTool struct {
	ToolID       string `json:"toolId"`
	Agent        string `json:"agent"`
	Window       string `json:"window"`
	Tab          string `json:"tab"`
	State        string `json:"state"`
	Cwd          string `json:"cwd"`
	SpawnedByYou bool   `json:"spawnedByYou"`
}

// agentOfTool 은 그 도구의 **지금** 전경이 에이전트면 그 어댑터다. 목록을 새로 읽는다 —
// 직접 모드는 이 호출이 낡은 전경을 다시 조회한다 (FR-PNW-57).
func (s *Server) agentOfTool(toolID string) (agentadapter.Adapter, bool) {
	if s.ToolIO == nil {
		return agentadapter.Adapter{}, false
	}
	for _, t := range s.ToolIO.List() {
		if t.ID == toolID {
			return agentadapter.ByCommand(t.ForegroundName)
		}
	}
	return agentadapter.Adapter{}, false
}

func (s *Server) peerAgentsList(w http.ResponseWriter, r *http.Request, from peerCaller) peerCmdResult {
	out := []peerAgentTool{}
	if s.ToolIO != nil {
		names := map[string][2]string{}
		if s.WorkIndex != nil {
			for _, e := range s.WorkIndex.Entries() {
				names[e.ToolID] = [2]string{e.WindowName, e.TabName}
			}
		}
		for _, t := range s.ToolIO.List() {
			ad, ok := agentadapter.ByCommand(t.ForegroundName)
			if !ok {
				continue
			}
			item := peerAgentTool{
				ToolID: t.ID, Agent: ad.ID, Window: names[t.ID][0], Tab: names[t.ID][1],
				State: s.toolStatusOf(t.ID, s.toolLive(t.ID)).State,
			}
			if s.Tools != nil {
				item.Cwd = s.Tools.Cwd(t.ID)
			}
			if owner, ok := s.peerSpawns.Owner(t.ID); ok && owner == from.fp {
				item.SpawnedByYou = true
			}
			out = append(out, item)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ToolID < out[j].ToolID })
	httpresp.JSON(w, http.StatusOK, map[string]any{"agents": out})
	return peerCmdResult{status: http.StatusOK, n: len(out)}
}

// peerMessageSend 는 짝이 보낸 메시지를 에이전트 도구에 넣는다 (FR-PNW-52·57·90).
func (s *Server) peerMessageSend(w http.ResponseWriter, r *http.Request, from peerCaller) peerCmdResult {
	var in struct {
		To      string `json:"to"`
		From    string `json:"from"`
		Message string `json:"message"`
	}
	if st := peerReadStatus(w, r, &in); st != 0 {
		return peerCmdResult{status: st}
	}
	// 감사 로그의 target 은 해석에 성공한 도구만이다 — 원격이 준 글자를 로그에 쓰지 않는다.
	toolID := ""
	fail := func(status int, code, msg string) peerCmdResult {
		peerFail(w, status, code, msg)
		return peerCmdResult{status: status, target: toolID, n: len(in.Message)}
	}
	if in.From != "" && !peerToolIDPattern.MatchString(in.From) {
		return fail(http.StatusBadRequest, apierr.CodeBadRequest, "from")
	}
	if in.Message == "" {
		return fail(http.StatusBadRequest, apierr.CodeMissingArg, "message")
	}
	if len(in.Message) > peerMessageMax {
		return fail(http.StatusRequestEntityTooLarge, apierr.CodeBodyTooBig, "message too large")
	}
	if s.WorkIndex != nil && peerToolIDPattern.MatchString(in.To) {
		toolID, _ = s.WorkIndex.ResolveStrict(in.To)
	}
	if toolID == "" || s.ToolIO == nil || !s.ToolIO.Has(toolID) {
		return fail(http.StatusNotFound, apierr.CodePeerTargetMissing, "no such tool")
	}
	// I-70·I-73: 닫는 중이면 넣지 않는다. 그 도구에 넣는 중이면 기다리지 않고 거절한다.
	leave, gerr := s.peerGate.enter(toolID)
	switch {
	case errors.Is(gerr, errPeerToolBusy):
		return fail(http.StatusConflict, apierr.CodePeerTargetBusy, "target busy")
	case gerr != nil:
		return fail(http.StatusConflict, apierr.CodePeerTargetNotAgent, "not an agent")
	}
	defer leave()
	ad, ok := s.agentOfTool(toolID)
	if !ok {
		return fail(http.StatusConflict, apierr.CodePeerTargetNotAgent, "not an agent")
	}
	env := peerEnvelope(from.name, in.From, toolID, in.Message, time.Now())
	// I-47: 위 확인은 캐시다. 붙여넣기 직전에 도구가 사는 곳에서 새로 본다.
	switch err := s.ToolIO.SendPasteIfForeground(toolID, []byte(env), true, ad.DetectCmd); {
	case errors.Is(err, toolhub.ErrForegroundChanged):
		return fail(http.StatusConflict, apierr.CodePeerTargetNotAgent, "not an agent")
	case err != nil:
		return fail(http.StatusInternalServerError, apierr.CodeInternal, "deliver failed")
	}
	httpresp.JSON(w, http.StatusOK, map[string]any{"toolId": toolID, "len": len(in.Message)})
	return peerCmdResult{status: http.StatusOK, target: toolID, n: len(in.Message)}
}

// apiPeersCall 은 짝에 프로토콜 명령 하나를 보내고 결과를 그대로 돌려준다 (FR-PNW-71·72).
func (s *Server) apiPeersCall(w http.ResponseWriter, r *http.Request) {
	if !s.peerReady(w) {
		return
	}
	var in struct {
		Peer string          `json:"peer"`
		Op   string          `json:"op"`
		From string          `json:"from"`
		Args json.RawMessage `json:"args"`
	}
	if !peerReadJSON(w, r, &in) {
		return
	}
	if _, ok := peerCommands()[in.Op]; !ok {
		peerFail(w, http.StatusBadRequest, apierr.CodePeerUnknownOp, in.Op)
		return
	}
	p, ok := s.peers.ByName(in.Peer)
	if !ok {
		peerFail(w, http.StatusNotFound, apierr.CodePeerNotFound, in.Peer)
		return
	}
	args := map[string]any{}
	if len(in.Args) > 0 && string(in.Args) != "null" {
		if err := json.Unmarshal(in.Args, &args); err != nil {
			peerFail(w, http.StatusBadRequest, apierr.CodeInvalidJSON, "args")
			return
		}
	}
	// FR-PNW-72: 보낸 도구는 이 서버가 채운다. 부른 쪽이 준 값은 식별자 해석을 지나야 한다.
	if in.Op == "message.send" || in.Op == "agent.spawn" {
		args["from"] = ""
		if in.From != "" && s.WorkIndex != nil {
			from, err := s.WorkIndex.ResolveStrict(in.From)
			if err != nil {
				peerFail(w, http.StatusBadRequest, apierr.CodeBadRequest, "from")
				return
			}
			args["from"] = from
		}
	}
	var out json.RawMessage
	tgt := peer.Target{Addr: p.Addr, Port: p.Port, Fingerprint: p.Fingerprint}
	err := s.peerClient.Call(r.Context(), tgt, peerPathPrefix+in.Op, args, &out)
	peerAuditCmd("out", p.Name, in.Op, peerOutResult(args, out, err))
	if err != nil {
		peerCallFail(w, err)
		return
	}
	s.peerSeen.Touch(p.Fingerprint, time.Now())
	// FR-PNW-28: 상대가 이 노드를 받았다는 것은 승인이 끝났다는 뜻이다.
	// C2: 바꿨을 때만 화면에 알린다. 저장 실패는 응답을 바꾸지 않는다(명령 자체는 성공했다).
	if p.State == peer.StatePendingOut && s.peers.Promote(p.Fingerprint) == nil {
		s.peersChanged("")
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(out)
}

// peerOutResult 는 나가는 명령의 감사 항목이다 (FR-PNW-94). 대상은 보낸 인자(`to`·`toolId`)나
// spawn 의 응답에서, 길이는 메시지·프롬프트에서 얻는다. 결과는 상대가 돌려준 상태다.
func peerOutResult(args map[string]any, out json.RawMessage, err error) peerCmdResult {
	res := peerCmdResult{status: http.StatusOK}
	str := func(k string) string { v, _ := args[k].(string); return v }
	res.target = str("to")
	if res.target == "" {
		res.target = str("toolId")
	}
	res.n = len(str("message")) + len(str("prompt"))
	var re *peer.RemoteError
	switch {
	case errors.As(err, &re):
		res.status = re.Status
	case err != nil:
		res.status = http.StatusBadGateway
	case res.target == "":
		var v struct {
			ToolID string `json:"toolId"`
		}
		if json.Unmarshal(out, &v) == nil && peerToolIDPattern.MatchString(v.ToolID) {
			res.target = v.ToolID
		}
	}
	if !peerToolIDPattern.MatchString(res.target) {
		res.target = ""
	}
	return res
}
