package httpapi

import (
	"dongminal/internal/webserver/apierr"
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

// apiFocusRelease drops the windows a client owns **without ending its SSE
// subscription** (UX_BATCH10_SRS FR-UXB-20~23 / D-UXB-3).
//
// Body: {"clientId":"..."}. 계기는 브라우저의 `blur` 다 — 지금은 내 차례가
// 아니라는 말이며, 그 말이 없으면 빼앗은 쪽이 떠나도 빼앗긴 쪽이 영영 dim 이다.
func (s *Server) apiFocusRelease(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ClientID string `json:"clientId"`
	}
	ok, answered := readBodyHTTP(w, r, &body)
	if answered {
		return
	}
	if !ok || body.ClientID == "" {
		// FR-B-8: 새 오류 문장은 서버가 아니라 프론트 카탈로그(`err.<code>`)의
		// 것이다 — 본문은 코드의 영어 서술이고, 사람의 말은 코드가 고른다.
		httpErr(w, "clientId required", http.StatusBadRequest, apierr.CodeMissingArg)
		return
	}
	if s.Focus == nil {
		httpErr(w, "focus registry unavailable", http.StatusInternalServerError, apierr.CodeInternal)
		return
	}
	if s.Focus.Release(body.ClientID) {
		s.broadcastFocusOwners()
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"ok": true})
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
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"ok": true})
}
