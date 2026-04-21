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
}

// AllowedAction reports whether the action is accepted by the hub.
func (h *CommandHub) AllowedAction(a string) bool { return allowedCmdActions[a] }

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
	payload, _ := json.Marshal(req)
	n := s.Commands.Broadcast(payload)
	log.Printf("[cmd] action=%s delivered=%d", req.Action, n)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"ok":        true,
		"delivered": n,
	})
}
