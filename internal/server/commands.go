package server

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"sync"
	"time"
)

type cmdSub struct {
	ch   chan []byte
	done chan struct{}
	once sync.Once
}

// CommandHub broadcasts workspace UI commands to SSE subscribers.
type CommandHub struct {
	mu   sync.Mutex
	subs map[*cmdSub]struct{}
}

func NewCommandHub() *CommandHub {
	return &CommandHub{subs: map[*cmdSub]struct{}{}}
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
	"openMdTab":    true,
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
	payload, _ := json.Marshal(req)
	n := s.Commands.Broadcast(payload)
	locField := ""
	switch {
	case finalLoc == "":
	case origLoc != finalLoc:
		locField = fmt.Sprintf(" location=%s uuid=%s", finalLoc, origLoc)
	default:
		locField = " location=" + finalLoc
	}
	log.Printf("[cmd] action=%s%s delivered=%d", req.Action, locField, n)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"ok":                true,
		"delivered":         n,
		"action":            req.Action,
		"location":          finalLoc,
		"requestedLocation": origLoc,
	})
}
