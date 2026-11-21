package httpapi

import (
	"dongminal/internal/shared/httpresp"
	"dongminal/internal/webserver/apierr"
	"net/http"
)

// apiWhoAmI implements GET /api/whoami (DMCTL_WHO_AM_I_SRS FR-API-WAI-1).
// Resolves the caller's TCP source port → clientPID → tool (32-step parent
// chain) via the injected WhoAmI resolver, then enriches with workspace
// entry + terminal size.
func (s *Server) apiWhoAmI(w http.ResponseWriter, r *http.Request) {
	// Daemon mode: use toolId query parameter if provided.
	toolID := r.URL.Query().Get("toolId")
	var shellPID int
	var err error

	if toolID != "" {
		// Verify tool exists
		if s.Tools != nil && s.Tools.Get(toolID) == nil {
			writeToolIOError(w, http.StatusNotFound, "tool not found: "+toolID)
			return
		}
		// shellPID unknown in daemon mode; leave as 0
	} else if s.WhoAmI != nil {
		toolID, shellPID, err = s.WhoAmI.ResolveClientPane(r.RemoteAddr)
		if err != nil {
			writeToolIOError(w, http.StatusNotFound, err.Error())
			return
		}
	} else {
		httpErr(w, "whoami unavailable", http.StatusInternalServerError, apierr.CodeInternal)
		return
	}

	resp := map[string]interface{}{
		"toolId":     toolID,
		"shellPid":   shellPID,
		"label":      "",
		"uuid":       "",
		"short":      "",
		"sizeCols":   0,
		"sizeRows":   0,
		"window":     "",
		"tab":        "",
		"windowUuid": "",
		"paneUuid":   "",
		"focused":    false,
	}

	if s.Tools != nil {
		for _, p := range s.Tools.List() {
			if p.ID == toolID {
				resp["sizeCols"] = p.Cols
				resp["sizeRows"] = p.Rows
				break
			}
		}
	}

	if s.Work != nil {
		for _, e := range s.Work.Entries() {
			if e.ToolID != toolID {
				continue
			}
			resp["label"] = e.Label
			resp["uuid"] = e.TabUUID
			resp["short"] = e.ShortCode
			resp["window"] = e.WindowName
			resp["tab"] = e.TabName
			resp["windowUuid"] = e.WindowUUID
			resp["paneUuid"] = e.PaneUUID
			resp["focused"] = e.IsActive
			break
		}
	}

	// ISSUE_TREE_OPS_SRS FR-ITB-6: 열린 Run 의 멤버이면 그 정체를 싣는다. migration 이
	// 이 값을 보고 승계 갈래로 간다 — 멤버가 일반 절차로 넘기면 옛 멤버가 lost 로 남는다.
	if s.Runs != nil {
		if m, ok := s.Runs.MemberByTool(toolID); ok {
			mem := map[string]any{"id": m.ID, "runId": m.RunID, "role": m.Role}
			if rec, found := s.Runs.Get(m.RunID); found && rec.Tree != "" {
				mem["tree"] = rec.Tree
			}
			resp["member"] = mem
		}
	}

	httpresp.JSON(w, http.StatusOK, resp)
}
