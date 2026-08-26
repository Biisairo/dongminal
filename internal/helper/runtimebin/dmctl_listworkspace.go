package runtimebin

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"

	"dongminal/internal/helper/toolline"
	"dongminal/internal/shared/workspace"
)

// dmctlListWorkspace implements `dmctl list-workspace`. /api/state 호출 후 workspace
// 트리를 순회해 toolline.Line 으로 렌더링한다 — MCP `list_workspace` 와 byte-level
// 동일 포맷 (DMCTL_WHO_AM_I_SRS FR-DMC-LP-1).
func dmctlListWorkspace(args []string, stdout, stderr io.Writer) int {
	jsonOut := false
	windowFilter, tabFilter := "", ""
	i := 0
	for i < len(args) {
		a := args[i]
		switch {
		case a == "-h" || a == "--help":
			fmt.Fprint(stdout, dmctlListWorkspaceHelp)
			return 0
		case a == "--json":
			jsonOut = true
		case a == "--window" || a == "--tab":
			if i+1 >= len(args) {
				fmt.Fprintf(stderr, "list-workspace: flag %s requires value\n", a)
				return 2
			}
			if a == "--window" {
				windowFilter = args[i+1]
			} else {
				tabFilter = args[i+1]
			}
			i += 2
			continue
		default:
			fmt.Fprintf(stderr, "list-workspace: unknown argument: %s\n", a)
			return 2
		}
		i++
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
		Tools     []toolEntry `json:"tools"`
		Workspace *wsTree     `json:"workspace"`
	}
	if err := json.Unmarshal(body, &state); err != nil {
		fmt.Fprintf(stderr, "dmctl: invalid /api/state response: %v\n", err)
		return 1
	}

	shellPids := make(map[string]int, len(state.Tools))
	sizes := make(map[string][2]int, len(state.Tools))
	for _, p := range state.Tools {
		shellPids[p.ID] = p.PID
		sizes[p.ID] = [2]int{p.SizeCols, p.SizeRows}
	}

	rows := buildListWorkspaceRows(state.Workspace, shellPids, sizes)

	// LIST_PANES_NAME_FILTER_SRS FR-LPF-1/2: 이름 필터 (부분 일치, 대소문자 무시, AND).
	filtered := windowFilter != "" || tabFilter != ""
	if filtered {
		var keep []listWorkspaceRow
		for _, r := range rows {
			if MatchFold(r.Window, windowFilter) && MatchFold(r.Tab, tabFilter) {
				keep = append(keep, r)
			}
		}
		rows = keep
		if len(rows) == 0 {
			if jsonOut {
				stdout.Write([]byte("[]\n"))
			} else {
				fmt.Fprintln(stderr, "(no match)")
			}
			return 1
		}
	}

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
		fmt.Fprintln(stdout, "(no tools)")
		return 0
	}
	for _, r := range rows {
		line := toolline.Line{
			FocusMarker: r.Focused,
			Label:       r.Label,
			UUID:        r.UUID,
			Short:       r.Short,
			ToolID:      r.ToolID,
			ShellPID:    r.ShellPID,
			SizeCols:    r.SizeCols,
			SizeRows:    r.SizeRows,
			Window:      r.Window,
			Tab:         r.Tab,
			WindowUUID:  r.WindowUUID,
			PaneUUID:    r.PaneUUID,
		}
		fmt.Fprintln(stdout, line.Render())
	}
	return 0
}

const dmctlListWorkspaceHelp = `dmctl list-workspace — 열린 도구 목록 조회

사용법:
  dmctl list-workspace                     # 사람 가독성 텍스트 (▶ = 사용자 포커스)
  dmctl list-workspace --json              # JSON 배열 (스크립트 친화)
  dmctl list-workspace --window <substr>   # 창 이름 필터 (부분 일치·대소문자 무시)
  dmctl list-workspace --tab <substr>      # 탭 이름 필터. --window 과 AND
                                           # 매칭 0건이면 rc=1 (grep 컨벤션)

각 행: ▶|  label=...  uuid=...  short=...  toolId=...  shellPid=...  size=WxH  window="..."  tab="..."  window_uuid=...  pane_uuid=...
빈 값(uuid/short/size/window_uuid/pane_uuid)은 해당 컬럼이 생략된다.
`

type toolEntry struct {
	ID       string `json:"id"`
	PID      int    `json:"pid"`
	SizeCols int    `json:"sizeCols"`
	SizeRows int    `json:"sizeRows"`
}

type wsTree struct {
	ActiveWindow string     `json:"activeWindow"`
	Windows      []wsWindow `json:"windows"`
}

type wsWindow struct {
	ID          string              `json:"id"`
	Name        string              `json:"name"`
	FocusedPane string              `json:"focusedPane"`
	Layout      *workspace.WsLayout `json:"layout"`
}

type listWorkspaceRow struct {
	Label      string `json:"label"`
	UUID       string `json:"uuid"`
	Short      string `json:"short"`
	ToolID     string `json:"toolId"`
	ShellPID   int    `json:"shellPid"`
	SizeCols   int    `json:"sizeCols"`
	SizeRows   int    `json:"sizeRows"`
	Window     string `json:"window"`
	Tab        string `json:"tab"`
	WindowUUID string `json:"windowUuid"`
	PaneUUID   string `json:"paneUuid"`
	Focused    bool   `json:"focused"`
}

func buildListWorkspaceRows(ws *wsTree, shellPids map[string]int, sizes map[string][2]int) []listWorkspaceRow {
	if ws == nil {
		return nil
	}
	var out []listWorkspaceRow
	for si, sess := range ws.Windows {
		var regions []*workspace.WsLayout
		workspace.CollectPanes(sess.Layout, &regions)
		for pi, rg := range regions {
			for ti, tab := range rg.Tabs {
				focused := sess.ID == ws.ActiveWindow &&
					sess.FocusedPane == rg.ID &&
					rg.ActiveTab == tab.ID
				sz := sizes[tab.ToolID]
				out = append(out, listWorkspaceRow{
					Label:      fmt.Sprintf("W%d.P%d.T%d", si+1, pi+1, ti+1),
					UUID:       tab.ID,
					Short:      shortCode(tab.ID),
					ToolID:     tab.ToolID,
					ShellPID:   shellPids[tab.ToolID],
					SizeCols:   sz[0],
					SizeRows:   sz[1],
					Window:     sess.Name,
					Tab:        tab.Name,
					WindowUUID: sess.ID,
					PaneUUID:   rg.ID,
					Focused:    focused,
				})
			}
		}
	}
	return out
}

// MatchFold returns true when substr is empty or s contains substr (case-insensitive).
func MatchFold(s, substr string) bool {
	if substr == "" {
		return true
	}
	return strings.Contains(strings.ToLower(s), strings.ToLower(substr))
}

func shortCode(uuid string) string {
	if len(uuid) >= 8 {
		return uuid[:8]
	}
	return uuid
}
