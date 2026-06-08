package server

import (
	"encoding/json"
	"net/http"
)

// apiWhoAmI implements GET /api/whoami (DMCTL_WHO_AM_I_SRS FR-API-WAI-1).
// Resolves the caller's TCP source port → clientPID → pane (32-step parent
// chain) via the injected WhoAmI resolver, then enriches with workspace
// entry + terminal size.
func (s *Server) apiWhoAmI(w http.ResponseWriter, r *http.Request) {
	if s.WhoAmI == nil {
		http.Error(w, "whoami unavailable", http.StatusInternalServerError)
		return
	}
	paneID, shellPID, err := s.WhoAmI.ResolveClientPane(r.RemoteAddr)
	if err != nil {
		writeWhoAmIError(w, http.StatusNotFound, err.Error())
		return
	}

	resp := map[string]interface{}{
		"paneId":      paneID,
		"shellPid":    shellPID,
		"label":       "",
		"uuid":        "",
		"short":       "",
		"sizeCols":    0,
		"sizeRows":    0,
		"session":     "",
		"tab":         "",
		"sessionUuid": "",
		"regionUuid":  "",
		"focused":     false,
	}

	if s.Panes != nil {
		for _, p := range s.Panes.List() {
			if id, _ := p["id"].(string); id == paneID {
				if c, ok := p["sizeCols"].(int); ok {
					resp["sizeCols"] = c
				}
				if rr, ok := p["sizeRows"].(int); ok {
					resp["sizeRows"] = rr
				}
				break
			}
		}
	}

	if s.Work != nil {
		for _, e := range s.Work.Entries() {
			if e.PaneID != paneID {
				continue
			}
			resp["label"] = e.Label
			resp["uuid"] = e.TabUUID
			resp["short"] = e.ShortCode
			resp["session"] = e.SessionName
			resp["tab"] = e.TabName
			resp["sessionUuid"] = e.SessionUUID
			resp["regionUuid"] = e.RegionUUID
			resp["focused"] = e.IsActive
			break
		}
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

func writeWhoAmIError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
