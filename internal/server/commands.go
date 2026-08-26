package server

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strconv"
	"sync"
	"time"

	"dongminal/internal/shared/uuid"
)

type cmdSub struct {
	ch   chan []byte
	done chan struct{}
	once sync.Once
}

// TabRef pairs a newly created tab's uuid with its server-assigned toolId
// (REMOTE_COMMAND_RESULT_SRS — 호출자가 uuid→toolId 재조회 불필요).
type TabRef struct {
	UUID   string `json:"uuid"`
	ToolID string `json:"toolId"`
}

// CmdResult is the set of entities a creating command produced, echoed back by
// the browser and returned to the caller via long-poll correlation.
type CmdResult struct {
	NewWindows []string `json:"newWindows"`
	NewPanes   []string `json:"newPanes"`
	NewTabs    []TabRef `json:"newTabs"`
}

// CommandHub broadcasts workspace UI commands to SSE subscribers.
type CommandHub struct {
	mu   sync.Mutex
	subs map[*cmdSub]struct{}

	// pending maps a creating command's reqId to the channel awaiting the
	// browser's echo (REMOTE_COMMAND_RESULT_SRS FR-RCR-2/3). Guarded by pmu.
	pmu     sync.Mutex
	pending map[string]chan CmdResult
}

func NewCommandHub() *CommandHub {
	return &CommandHub{
		subs:    map[*cmdSub]struct{}{},
		pending: map[string]chan CmdResult{},
	}
}

// creatingActions are the commands that produce new entities and thus support
// result correlation. Others broadcast immediately with no await.
var creatingActions = map[string]bool{
	"newWindow": true,
	"newTab":    true,
	"splitH":    true,
	"splitV":    true,
}

// IsCreatingAction reports whether action creates new entities (FR-RCR-1).
func IsCreatingAction(action string) bool { return creatingActions[action] }

// singleExecutorActions are the commands that add an entity to the workspace
// tree and therefore must run on exactly ONE client
// (WORKSPACE_IDENTITY_SRS FR-SXE-1). It is wider than creatingActions:
// openEditorTab and restoreTool allocate a tab id without taking part in the
// reqId echo protocol.
//
// Everything else stays ungated — focus is per-client by definition, and the
// remaining mutations are idempotent across clients.
var singleExecutorActions = map[string]bool{
	"newWindow":     true,
	"newTab":        true,
	"splitH":        true,
	"splitV":        true,
	"openEditorTab": true,
	"restoreTool":   true,
}

// IsSingleExecutorAction reports whether action must run on one client only.
func IsSingleExecutorAction(action string) bool { return singleExecutorActions[action] }

const defaultCommandResultTimeout = 3 * time.Second

// CommandResultTimeout is the long-poll wait, overridable via env (NFR-RCR-1).
func CommandResultTimeout() time.Duration {
	if v := os.Getenv("DONGMINAL_CMD_RESULT_TIMEOUT_MS"); v != "" {
		if ms, err := strconv.Atoi(v); err == nil && ms > 0 {
			return time.Duration(ms) * time.Millisecond
		}
	}
	return defaultCommandResultTimeout
}

// NewReqId returns a fresh 1회성 correlation key.
func NewReqId() string {
	// FR-UNI-14: canonical uuid. 이전에는 16바이트 hex(32자, 구분자·버전 비트 없음)
	// 였다. 엔트로피가 동등하므로 echo 상관 동작(FR-RCR-*)은 불변이다.
	return uuid.NewString()
}

// BroadcastAndAwait broadcasts payload (which must already embed reqId) and
// blocks until the browser echoes the result for reqId or timeout elapses. If
// no subscriber received the broadcast (delivered=0) it returns immediately
// without waiting (FR-RCR-2).
func (h *CommandHub) BroadcastAndAwait(payload []byte, reqId string, timeout time.Duration) (CmdResult, int, bool) {
	ch := make(chan CmdResult, 1)
	h.pmu.Lock()
	h.pending[reqId] = ch
	h.pmu.Unlock()

	n := h.Broadcast(payload)
	if n == 0 {
		h.clearPending(reqId)
		return CmdResult{}, 0, false
	}
	select {
	case res := <-ch:
		return res, n, false
	case <-time.After(timeout):
		h.clearPending(reqId)
		return CmdResult{}, n, true
	}
}

// DeliverResult routes a browser echo to the awaiting BroadcastAndAwait. The
// first echo wins (channel removed); unknown/expired reqId is a no-op
// (FR-RCR-3, NFR-RCR-3).
func (h *CommandHub) DeliverResult(reqId string, res CmdResult) {
	h.pmu.Lock()
	ch, ok := h.pending[reqId]
	if ok {
		delete(h.pending, reqId)
	}
	h.pmu.Unlock()
	if ok {
		ch <- res // buffered cap 1, non-blocking
	}
}

func (h *CommandHub) clearPending(reqId string) {
	h.pmu.Lock()
	delete(h.pending, reqId)
	h.pmu.Unlock()
}

// pendingCount is a test helper for leak detection.
func (h *CommandHub) pendingCount() int {
	h.pmu.Lock()
	defer h.pmu.Unlock()
	return len(h.pending)
}

func (h *CommandHub) add() *cmdSub {
	s := &cmdSub{ch: make(chan []byte, 16), done: make(chan struct{})}
	h.mu.Lock()
	h.subs[s] = struct{}{}
	h.mu.Unlock()
	return s
}

func (h *CommandHub) remove(s *cmdSub) {
	s.once.Do(func() { close(s.done) })
	h.mu.Lock()
	delete(h.subs, s)
	h.mu.Unlock()
}

// Broadcast delivers payload to all subscribers; returns delivered count.
func (h *CommandHub) Broadcast(payload []byte) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	n := 0
	for s := range h.subs {
		select {
		case s.ch <- payload:
			n++
		default:
			log.Printf("[cmd] subscriber channel full, dropping")
		}
	}
	return n
}

var allowedCmdActions = map[string]bool{
	"newWindow":     true,
	"newTab":        true,
	"splitH":        true,
	"splitV":        true,
	"focus":         true,
	"closeTab":      true,
	"closeWindow":   true,
	"windowNext":    true,
	"windowPrev":    true,
	"tabNext":       true,
	"tabPrev":       true,
	"paneUp":        true,
	"paneDown":      true,
	"paneLeft":      true,
	"paneRight":     true,
	"openEditorTab": true,
	"renameTab":     true,
	"renameWindow":  true,
	"detachTab":     true,
	"restoreTool":   true,
}

// AllowedAction reports whether the action is accepted by the hub.
func (h *CommandHub) AllowedAction(a string) bool { return allowedCmdActions[a] }

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

	sub := s.Commands.add()
	defer s.Commands.remove(sub)

	// FR-XDF-8: 구독에 clientId 를 결선한다. cmdSub 자체에는 신원이 없으므로
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
	flusher.Flush()

	keep := time.NewTicker(15 * time.Second)
	defer keep.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-sub.done:
			return
		case msg := <-sub.ch:
			fmt.Fprintf(w, "data: %s\n\n", msg)
			flusher.Flush()
		case <-keep.C:
			fmt.Fprint(w, ": keep\n\n")
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
	if !allowedCmdActions[req.Action] {
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
	if IsSingleExecutorAction(req.Action) && s.Focus != nil {
		req.ExecClientId = s.Focus.Executor()
	}

	resp := map[string]interface{}{
		"ok":                true,
		"action":            req.Action,
		"location":          finalLoc,
		"requestedLocation": origLoc,
	}

	if IsCreatingAction(req.Action) {
		// FR-RCR-4: reqId 발급 → broadcast → 브라우저 echo 대기 → 새 id 포함 반환.
		req.ReqId = NewReqId()
		payload, _ := json.Marshal(req)
		res, n, timedOut := s.Commands.BroadcastAndAwait(payload, req.ReqId, CommandResultTimeout())
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
		ReqId      string   `json:"reqId"`
		NewWindows []string `json:"newWindows"`
		NewPanes   []string `json:"newPanes"`
		NewTabs    []TabRef `json:"newTabs"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid json: "+err.Error(), http.StatusBadRequest)
		return
	}
	if body.ReqId != "" {
		s.Commands.DeliverResult(body.ReqId, CmdResult{
			NewWindows: body.NewWindows,
			NewPanes:   body.NewPanes,
			NewTabs:    body.NewTabs,
		})
	}
	w.WriteHeader(http.StatusOK)
}
