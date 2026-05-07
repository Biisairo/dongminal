package tools

import (
	"context"
	"fmt"
	"strings"

	"dongminal/internal/mcptool"
)

const ListPanesName = "list_panes"

var ListPanesSpec = map[string]any{
	"name":        ListPanesName,
	"description": "현재 열린 모든 pane 목록과 라벨(S1.P2.T3) 반환. 각 pane 의 shellPid 포함. ▶ 표시는 사용자가 현재 포커스한 pane. 같은 워크스페이스 내 다른 Claude Code 인스턴스를 식별하고 send_agent_message 로 통신할 때 사용.",
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
			marker := "  "
			if e.IsActive {
				marker = "▶ "
			}
			fmt.Fprintf(&sb, "%s%s  paneId=%s  shellPid=%d  size=%s  session=%q  tab=%q\n",
				marker, e.Label, e.PaneID, shellPids[e.PaneID], d.PM.Size(e.PaneID), e.SessionName, e.TabName)
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
