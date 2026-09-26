package httpapi

import (
	"dongminal/internal/webserver/apierr"
	"dongminal/internal/webserver/httpresp"
	"dongminal/internal/webserver/sse"
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
	s.Commands.Broadcast(sse.Payload("window_focus", map[string]any{"owners": s.Focus.Snapshot()}))
}

// apiFocusGet returns the ownership snapshot. Read-only; used by a client on
// SSE connect to align local state with the server (FR-XDF-11).
func (s *Server) apiFocusGet(w http.ResponseWriter, r *http.Request) {
	owners := map[string]string{}
	if s.Focus != nil {
		owners = s.Focus.Snapshot()
	}
	httpresp.JSON(w, http.StatusOK, map[string]any{"owners": owners})
}

// apiFocusClaim records a client's ownership of a window.
// Body: {"clientId":"...","windowId":"..."} (FR-XDF-7).
func (s *Server) apiFocusClaim(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ClientID string `json:"clientId"`
		WindowID string `json:"windowId"`
	}
	ok, answered := readBodyHTTP(w, r, &body)
	if answered {
		return
	}
	if !ok || body.ClientID == "" || body.WindowID == "" {
		httpErr(w, "clientId·windowId 필요", http.StatusBadRequest, apierr.CodeMissingArg)
		return
	}
	if s.Focus == nil {
		httpErr(w, "focus registry 없음", http.StatusInternalServerError, apierr.CodeInternal)
		return
	}
	if s.Focus.Claim(body.ClientID, body.WindowID) {
		s.broadcastFocusOwners()
	}
	httpresp.JSON(w, http.StatusOK, map[string]any{"ok": true})
}
