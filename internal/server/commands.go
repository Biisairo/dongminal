package server

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strconv"
	"sync"
	"time"
)

type cmdSub struct {
	ch   chan []byte
	done chan struct{}
	once sync.Once
}

// TabRef pairs a newly created tab's uuid with its server-assigned paneId
// (REMOTE_COMMAND_RESULT_SRS — 호출자가 uuid→paneId 재조회 불필요).
type TabRef struct {
	UUID   string `json:"uuid"`
	PaneID string `json:"paneId"`
}

// CmdResult is the set of entities a creating command produced, echoed back by
// the browser and returned to the caller via long-poll correlation.
type CmdResult struct {
	NewSessions []string `json:"newSessions"`
	NewRegions  []string `json:"newRegions"`
	NewTabs     []TabRef `json:"newTabs"`
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
	"newSession": true,
	"newTab":     true,
	"splitH":     true,
	"splitV":     true,
}

// IsCreatingAction reports whether action creates new entities (FR-RCR-1).
func IsCreatingAction(action string) bool { return creatingActions[action] }

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
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
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
	"newSession":   true,
	"newTab":       true,
	"splitH":       true,
	"splitV":       true,
	"focus":        true,
	"closeTab":     true,
	"closeSession": true,
	"sessionNext":  true,
	"sessionPrev":  true,
	"tabNext":      true,
	"tabPrev":      true,
	"paneUp":       true,
	"paneDown":     true,
	"paneLeft":     true,
	"paneRight":    true,
	"openMdTab":     true,
	"renameTab":     true,
	"renameSession": true,
	// md_scroll_changed is emitted server-side after PUT /api/md-scroll. It is
	// not in the dmctl POST path; clients receive it via SSE only.
	"md_scroll_changed": true,
}

// AllowedAction reports whether the action is accepted by the hub.
func (h *CommandHub) AllowedAction(a string) bool { return allowedCmdActions[a] }

// translateLocationUUID rewrites args.location in-place when the value is a
// UUID, replacing it with the canonical "S{n}.P{n}.T{n}" coordinate that the
// browser parses. Non-UUID values (coordinate / paneId / label / empty) and
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
	// FR-DMC-9: location 은 list-panes 의 uuid (tab.id) 만 허용. 좌표/라벨/paneId
	// 는 거부 — 사용자가 reflow 위험이 있는 식별자를 무의식적으로 쓰는 표면을 차단.
	if !ws.IsKnownTabID(loc) {
		return loc, "", fmt.Errorf("location 은 list-panes 의 uuid 만 허용 (좌표/라벨/paneId 거부): %q", loc)
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
		resp["newSessions"] = res.NewSessions
		resp["newRegions"] = res.NewRegions
		resp["newTabs"] = res.NewTabs
		resp["timedOut"] = timedOut
		log.Printf("[cmd] action=%s%s delivered=%d newTabs=%d timedOut=%t",
			req.Action, locField, n, len(res.NewTabs), timedOut)
	} else {
		// FR-RCR-5: 비생성 명령은 기존과 완전히 동일 (대기 없음, 새 필드 없음).
		payload, _ := json.Marshal(req)
		n := s.Commands.Broadcast(payload)
		resp["delivered"] = n
		log.Printf("[cmd] action=%s%s delivered=%d", req.Action, locField, n)
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
		ReqId       string   `json:"reqId"`
		NewSessions []string `json:"newSessions"`
		NewRegions  []string `json:"newRegions"`
		NewTabs     []TabRef `json:"newTabs"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid json: "+err.Error(), http.StatusBadRequest)
		return
	}
	if body.ReqId != "" {
		s.Commands.DeliverResult(body.ReqId, CmdResult{
			NewSessions: body.NewSessions,
			NewRegions:  body.NewRegions,
			NewTabs:     body.NewTabs,
		})
	}
	w.WriteHeader(http.StatusOK)
}
