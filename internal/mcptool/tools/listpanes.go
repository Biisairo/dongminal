package tools

import (
	"context"
	"fmt"
	"strings"

	"dongminal/internal/mcptool"
	"dongminal/internal/paneline"
)

const ListPanesName = "list_panes"

var ListPanesSpec = map[string]any{
	"name":        ListPanesName,
	"description": "현재 열린 모든 pane 목록을 반환. 각 행은 표준 KEY=VALUE 라인 (label/uuid/short/paneId/shellPid/size/session/tab/session_uuid/region_uuid). ▶ 표시는 사용자가 현재 포커스한 pane. 같은 워크스페이스 내 다른 Claude Code 인스턴스를 식별하고 send_agent_message 로 통신할 때는 **uuid 를 사용**할 것. dmctl `list-panes` 와 byte-level 동일 포맷.",
	"inputSchema": map[string]any{
		"type":       "object",
		"properties": map[string]any{},
	},
}

type ListPanesArgs struct{}

type ListPanesDeps struct {
	PM mcptool.PaneReader
	WS mcptool.WorkspaceReader
}

func ListPanesHandler(d ListPanesDeps) func(context.Context, ListPanesArgs) (mcptool.Result, error) {
	return func(_ context.Context, _ ListPanesArgs) (mcptool.Result, error) {
		rawEntries := d.WS.Entries()
		panes := d.PM.List()

		shellPids := make(map[string]int, len(panes))
		for _, p := range panes {
			shellPids[p.ID] = p.ShellPID
		}

		entries := make([]mcptool.WorkspaceEntry, 0, len(rawEntries))
		seen := make(map[string]bool, len(rawEntries))
		for _, e := range rawEntries {
			seen[e.PaneID] = true
			if !d.PM.Has(e.PaneID) {
				continue
			}
			entries = append(entries, e)
		}

		var orphans []mcptool.PaneInfo
		for _, p := range panes {
			if !seen[p.ID] {
				orphans = append(orphans, p)
			}
		}

		var sb strings.Builder
		sb.WriteString("Pane 목록 (▶ = 사용자 포커스):\n")
		if len(entries) == 0 && len(orphans) == 0 {
			sb.WriteString("  (없음)\n")
		}
		for _, e := range entries {
			cols, rows := parseSize(d.PM.Size(e.PaneID))
			line := paneline.Line{
				FocusMarker: e.IsActive,
				Label:       e.Label,
				UUID:        e.TabUUID,
				Short:       e.ShortCode,
				PaneID:      e.PaneID,
				ShellPID:    shellPids[e.PaneID],
				SizeCols:    cols,
				SizeRows:    rows,
				Session:     e.SessionName,
				Tab:         e.TabName,
				SessionUUID: e.SessionUUID,
				RegionUUID:  e.RegionUUID,
			}
			sb.WriteString(line.Render())
			sb.WriteByte('\n')
		}
		if len(orphans) > 0 {
			sb.WriteString("\n[workspace 미등록]\n")
			for _, p := range orphans {
				fmt.Fprintf(&sb, "  paneId=%s  shellPid=%d  size=%s  name=%q\n",
					p.ID, p.ShellPID, d.PM.Size(p.ID), p.Name)
			}
		}
		return mcptool.TextResult(sb.String()), nil
	}
}

// parseSize는 "WxH" 형식 문자열을 정수 쌍으로 변환한다. 실패하면 0,0.
func parseSize(s string) (int, int) {
	x := strings.IndexByte(s, 'x')
	if x <= 0 || x == len(s)-1 {
		return 0, 0
	}
	c, errC := atoiNonNeg(s[:x])
	r, errR := atoiNonNeg(s[x+1:])
	if errC != nil || errR != nil {
		return 0, 0
	}
	return c, r
}

func atoiNonNeg(s string) (int, error) {
	n := 0
	if s == "" {
		return 0, fmt.Errorf("empty")
	}
	for _, ch := range s {
		if ch < '0' || ch > '9' {
			return 0, fmt.Errorf("nan")
		}
		n = n*10 + int(ch-'0')
	}
	return n, nil
}
