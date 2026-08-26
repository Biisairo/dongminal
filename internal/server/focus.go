package server

import (
	"encoding/json"
	"net/http"
)

// broadcastFocusOwners pushes the FULL ownership map to every subscriber
// (FR-XDF-6). Incremental claim/release events would create partial state and
// ordering dependencies, and would need a self-echo filter; the full map is
// idempotent and needs neither.
func (s *Server) broadcastFocusOwners() {
	if s.Focus == nil || s.Commands == nil {
		return
	}
	payload, err := json.Marshal(map[string]any{
		"action": "window_focus",
		"args":   map[string]any{"owners": s.Focus.Snapshot()},
	})
	if err != nil {
		return
	}
	s.Commands.Broadcast(payload)
}

// apiFocusGet returns the ownership snapshot. Read-only; used by a client on
// SSE connect to align local state with the server (FR-XDF-11).
func (s *Server) apiFocusGet(w http.ResponseWriter, r *http.Request) {
	owners := map[string]string{}
	if s.Focus != nil {
		owners = s.Focus.Snapshot()
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"owners": owners})
}

// apiFocusClaim records a client's ownership of a window.
// Body: {"clientId":"...","windowId":"..."} (FR-XDF-7).
func (s *Server) apiFocusClaim(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ClientID string `json:"clientId"`
		WindowID string `json:"windowId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.ClientID == "" || body.WindowID == "" {
		http.Error(w, "clientId·windowId 필요", http.StatusBadRequest)
		return
	}
	if s.Focus == nil {
		http.Error(w, "focus registry 없음", http.StatusInternalServerError)
		return
	}
	if s.Focus.Claim(body.ClientID, body.WindowID) {
		s.broadcastFocusOwners()
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"ok": true})
}
