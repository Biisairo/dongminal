package runtimebin

import (
	"encoding/json"
	"fmt"
	"io"
)

// dmctlListPanes implements `dmctl list-panes` (FR-DMC-1~3). It calls
// /api/state once, parses the workspace tree, recomputes positional labels
// (S{n}.P{n}.T{n}), joins shellPid from the panes[] map, and prints one
// human-readable line per tab — with a ▶ marker on the user-focused pane.
// With --json the same records are emitted as a JSON array (FR-DMC-2).
func dmctlListPanes(args []string, stdout, stderr io.Writer) int {
	jsonOut := false
	for _, a := range args {
		switch a {
		case "-h", "--help":
			fmt.Fprint(stdout, dmctlListPanesHelp)
			return 0
		case "--json":
			jsonOut = true
		default:
			fmt.Fprintf(stderr, "list-panes: unknown argument: %s\n", a)
			return 2
		}
	}

	status, body, err := httpGet(baseURL() + "/api/state")
	if err != nil {
		fmt.Fprintf(stderr, "dmctl: %v\n", err)
		return 1
	}
	if status < 200 || status >= 300 {
		fmt.Fprintf(stderr, "dmctl: /api/state returned status %d: %s\n", status, body)
		return 1
	}

	var state struct {
		Panes     []paneEntry `json:"panes"`
		Workspace *wsTree     `json:"workspace"`
	}
	if err := json.Unmarshal(body, &state); err != nil {
		fmt.Fprintf(stderr, "dmctl: invalid /api/state response: %v\n", err)
		return 1
	}

	shellPids := make(map[string]int, len(state.Panes))
	for _, p := range state.Panes {
		shellPids[p.ID] = p.PID
	}

	rows := buildListPanesRows(state.Workspace, shellPids)

	if jsonOut {
		enc := json.NewEncoder(stdout)
		if len(rows) == 0 {
			stdout.Write([]byte("[]\n"))
			return 0
		}
		_ = enc.Encode(rows)
		return 0
	}

	if len(rows) == 0 {
		fmt.Fprintln(stdout, "(no panes)")
		return 0
	}
	for _, r := range rows {
		marker := "  "
		if r.Focused {
			marker = "▶ "
		}
		fmt.Fprintf(stdout,
			"%s%s  uuid=%s  short=%s  paneId=%s  shellPid=%d  session=%q  tab=%q\n",
			marker, r.Label, r.UUID, r.Short, r.PaneID, r.ShellPID, r.Session, r.Tab,
		)
	}
	return 0
}

const dmctlListPanesHelp = `dmctl list-panes — 열린 pane 목록 조회

사용법:
  dmctl list-panes          # 사람 가독성 텍스트 (▶ = 사용자 포커스)
  dmctl list-panes --json   # JSON 배열 (스크립트 친화)

각 행: label  uuid=...  short=...  paneId=...  shellPid=...  session="..."  tab="..."
`

type paneEntry struct {
	ID  string `json:"id"`
	PID int    `json:"pid"`
}

type wsTree struct {
	ActiveSession string      `json:"activeSession"`
	Sessions      []wsSession `json:"sessions"`
}

type wsSession struct {
	ID            string    `json:"id"`
	Name          string    `json:"name"`
	FocusedRegion string    `json:"focusedRegion"`
	Layout        *wsLayout `json:"layout"`
}

type wsLayout struct {
	Type      string      `json:"type"`
	ID        string      `json:"id"`
	ActiveTab string      `json:"activeTab"`
	Tabs      []wsTab     `json:"tabs"`
	Children  []*wsLayout `json:"children"`
}

type wsTab struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	PaneID string `json:"paneId"`
}

type listPanesRow struct {
	Label    string `json:"label"`
	UUID     string `json:"uuid"`
	Short    string `json:"short"`
	PaneID   string `json:"paneId"`
	ShellPID int    `json:"shellPid"`
	Session  string `json:"session"`
	Tab      string `json:"tab"`
	Focused  bool   `json:"focused"`
}

func buildListPanesRows(ws *wsTree, shellPids map[string]int) []listPanesRow {
	if ws == nil {
		return nil
	}
	var out []listPanesRow
	for si, sess := range ws.Sessions {
		var regions []*wsLayout
		collectRegions(sess.Layout, &regions)
		for pi, rg := range regions {
			for ti, tab := range rg.Tabs {
				focused := sess.ID == ws.ActiveSession &&
					sess.FocusedRegion == rg.ID &&
					rg.ActiveTab == tab.ID
				out = append(out, listPanesRow{
					Label:    fmt.Sprintf("S%d.P%d.T%d", si+1, pi+1, ti+1),
					UUID:     tab.ID,
					Short:    shortCode(tab.ID),
					PaneID:   tab.PaneID,
					ShellPID: shellPids[tab.PaneID],
					Session:  sess.Name,
					Tab:      tab.Name,
					Focused:  focused,
				})
			}
		}
	}
	return out
}

func collectRegions(n *wsLayout, out *[]*wsLayout) {
	if n == nil {
		return
	}
	if n.Type == "region" {
		*out = append(*out, n)
		return
	}
	if n.Type == "split" {
		for _, c := range n.Children {
			collectRegions(c, out)
		}
	}
}

func shortCode(uuid string) string {
	if len(uuid) >= 8 {
		return uuid[:8]
	}
	return uuid
}

