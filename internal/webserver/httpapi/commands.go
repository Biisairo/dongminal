package httpapi

import (
	"dongminal/internal/webserver/hub"

	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"time"
)

// translateLocationUUID rewrites args.location in-place when the value is a
// UUID, replacing it with the canonical "W{n}.P{n}.T{n}" coordinate that the
// browser parses. Non-UUID values (coordinate / toolId / label / empty) and
// missing location field pass through with no rewrite, preserving every
// existing dmctl and MCP call (NFR-UID-0). Returns (origLoc, finalLoc) so the
// caller can log both forms when the input was a UUID.
func translateLocationUUID(rawArgs *json.RawMessage, ws WorkspaceStore) (orig, final string, err error) {
	if rawArgs == nil || len(*rawArgs) == 0 || ws == nil {
		return "", "", nil
	}
	var args map[string]any
	if uerr := json.Unmarshal(*rawArgs, &args); uerr != nil {
		return "", "", nil // not an object — leave untouched
	}
	loc, ok := args["location"].(string)
	if !ok || loc == "" {
		return "", "", nil
	}
	// FR-DMC-9: location 은 list-workspace 의 uuid (tab.id) 만 허용. 좌표/라벨/toolId
	// 는 거부 — 사용자가 reflow 위험이 있는 식별자를 무의식적으로 쓰는 표면을 차단.
	if !ws.IsKnownTabID(loc) {
		return loc, "", fmt.Errorf("location 은 list-workspace 의 uuid 만 허용 (좌표/라벨/toolId 거부): %q", loc)
	}
	coord, cerr := ws.CoordinateOf(loc)
	if cerr != nil {
		return loc, "", cerr
	}
	args["location"] = coord
	patched, merr := json.Marshal(args)
	if merr != nil {
		return loc, coord, merr
	}
	*rawArgs = patched
	return loc, coord, nil
}

func (s *Server) handleCommandSSE(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)

	sub := s.Commands.Add()
	defer s.Commands.Remove(sub)

	// FR-XDF-8: 구독에 clientId 를 결선한다. hub.cmdSub 자체에는 신원이 없으므로
	// 이 결선 없이는 구독 해제와 소유권 해제를 이을 수 없다.
	// FR-XDF-9: 구독이 끊기면 그 Client 의 소유권을 즉시 해제한다 —
	// grace period 없음. epoch 로 재연결 경합을 막는다 (FR-XDF-10).
	if cid := r.URL.Query().Get("clientId"); cid != "" && s.Focus != nil {
		ep := s.Focus.Attach(cid)
		defer func() {
			if s.Focus.Detach(cid, ep) {
				s.broadcastFocusOwners()
			}
		}()
	}

	fmt.Fprint(w, ": connected\n\n")
	// RELOAD_CONTINUITY_SRS FR-RLC-20: **첫 이벤트로 자기 판을 말한다.** 자산은
	// 바이너리에 박혀 있어(`web/embed.go`) 그것이 바뀌는 길은 프로세스 교체뿐이고,
	// 프로세스가 바뀌면 이 구독은 반드시 끊긴다 — 그러므로 **구독이 열리는 순간이
	// 곧 "자산이 바뀌었을 수 있는 순간"** 이며, 화면은 주기적으로 물어볼 필요가 없다.
	hello := s.helloEvent()
	fmt.Fprintf(w, "data: %s\n\n", hello)
	flusher.Flush()

	// FR-RLC-20a: 인사가 keepalive 를 **대신한다.** 종전의 `: keep` 주석은 연결을
	// 살려 두기만 했다 — `EventSource` 는 주석에 이벤트를 발화하지 않으므로 화면은
	// 그것이 왔는지 알 수 없었고, 따라서 구독이 살아 있는지도 알 수 없었다.
	// 잠에서 깬 기기의 half-open 소켓이 정확히 그 틈에 산다 (FR-RLC-20b).
	keep := time.NewTicker(s.helloInterval())
	defer keep.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-sub.Closed():
			return
		case msg := <-sub.Messages():
			fmt.Fprintf(w, "data: %s\n\n", msg)
			flusher.Flush()
		case <-keep.C:
			fmt.Fprintf(w, "data: %s\n\n", hello)
			flusher.Flush()
		}
	}
}

func (s *Server) handleCommandPost(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	var req struct {
		Action string          `json:"action"`
		Args   json.RawMessage `json:"args,omitempty"`
		ReqId  string          `json:"reqId,omitempty"`
		// ExecClientId names the single client that must perform this command
		// (FR-SXE-2). Empty for ungated actions and when nothing is subscribed,
		// which FR-SXE-3 reads as "do not gate".
		ExecClientId string `json:"execClientId,omitempty"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, "invalid json: "+err.Error(), http.StatusBadRequest)
		return
	}
	if !hub.AllowedCmdActions[req.Action] {
		http.Error(w, "unknown action: "+req.Action, http.StatusBadRequest)
		return
	}
	origLoc, finalLoc, err := translateLocationUUID(&req.Args, s.Work)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	locField := ""
	switch {
	case finalLoc == "":
	case origLoc != finalLoc:
		locField = fmt.Sprintf(" location=%s uuid=%s", finalLoc, origLoc)
	default:
		locField = " location=" + finalLoc
	}

	// FR-SXE-2: 지명은 브로드캐스트 직전에 한다. 여기서 정하지 않으면 구독 중인
	// 모든 브라우저가 각자 엔터티를 만들어 하나만 참조되고 나머지가 고아가 된다.
	req.ExecClientId = ""
	if hub.IsSingleExecutorAction(req.Action) && s.Focus != nil {
		req.ExecClientId = s.Focus.Executor()
	}

	resp := map[string]interface{}{
		"ok":                true,
		"action":            req.Action,
		"location":          finalLoc,
		"requestedLocation": origLoc,
	}

	if hub.IsCreatingAction(req.Action) {
		// FR-RCR-4: reqId 발급 → broadcast → 브라우저 echo 대기 → 새 id 포함 반환.
		req.ReqId = hub.NewReqId()
		payload, _ := json.Marshal(req)
		res, n, timedOut := s.Commands.BroadcastAndAwait(payload, req.ReqId, hub.CommandResultTimeout())
		resp["delivered"] = n
		resp["newWindows"] = res.NewWindows
		resp["newPanes"] = res.NewPanes
		resp["newTabs"] = res.NewTabs
		resp["timedOut"] = timedOut
		log.Printf("[cmd] action=%s%s delivered=%d newTabs=%d timedOut=%t",
			req.Action, locField, n, len(res.NewTabs), timedOut)
	} else {
		// FR-RCR-5: 비생성 명령은 기존과 완전히 동일 (대기 없음, 새 필드 없음).
		payload, _ := json.Marshal(req)
		n := s.Commands.Broadcast(payload)
		resp["delivered"] = n
		log.Printf("[cmd] action=%s%s delivered=%d payload=%s", req.Action, locField, n, string(payload))
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

// handleCommandResult receives the browser's echo for a creating command and
// routes it to the awaiting handleCommandPost / MCP handler (FR-RCR-3).
func (s *Server) handleCommandResult(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		ReqId      string       `json:"reqId"`
		NewWindows []string     `json:"newWindows"`
		NewPanes   []string     `json:"newPanes"`
		NewTabs    []hub.TabRef `json:"newTabs"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid json: "+err.Error(), http.StatusBadRequest)
		return
	}
	if body.ReqId != "" {
		s.Commands.DeliverResult(body.ReqId, hub.CmdResult{
			NewWindows: body.NewWindows,
			NewPanes:   body.NewPanes,
			NewTabs:    body.NewTabs,
		})
	}
	w.WriteHeader(http.StatusOK)
}

// sseHelloEvery 는 SSE 인사의 기본 주기다 (RELOAD_CONTINUITY_SRS FR-RLC-20a).
// 종전 keepalive 주석과 같은 값이라 오가는 양이 늘지 않는다.
const sseHelloEvery = 15 * time.Second

func (s *Server) helloInterval() time.Duration {
	if s.helloEvery > 0 {
		return s.helloEvery
	}
	return sseHelloEvery
}

// helloEvent 는 구독에 보낼 인사 한 줄이다.
//
// FR-RLC-22: 판을 모르면 **판만 뺀다.** 빈 값을 실으면 받는 쪽이 "달라졌다" 로 읽고,
// 인사를 통째로 거르면 생존 신호가 함께 사라져 화면이 멀쩡한 구독을 죽었다고
// 판정한다 (FR-RLC-25).
func (s *Server) helloEvent() []byte {
	m := map[string]any{"action": "server_hello"}
	if v := s.assetVersion(); v != "" {
		m["args"] = map[string]any{"assetVersion": v}
	}
	b, err := json.Marshal(m)
	if err != nil {
		return []byte(`{"action":"server_hello"}`)
	}
	return b
}
