package runtimebin

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"

	"dongminal/internal/paneline"
)

// dmctlListPanes implements `dmctl list-panes`. /api/state 호출 후 workspace
// 트리를 순회해 paneline.Line 으로 렌더링한다 — MCP `list_panes` 와 byte-level
// 동일 포맷 (DMCTL_WHO_AM_I_SRS FR-DMC-LP-1).
func dmctlListPanes(args []string, stdout, stderr io.Writer) int {
	jsonOut := false
	sessionFilter, tabFilter := "", ""
	i := 0
	for i < len(args) {
		a := args[i]
		switch {
		case a == "-h" || a == "--help":
			fmt.Fprint(stdout, dmctlListPanesHelp)
			return 0
		case a == "--json":
			jsonOut = true
		case a == "--session" || a == "--tab":
			if i+1 >= len(args) {
				fmt.Fprintf(stderr, "list-panes: flag %s requires value\n", a)
				return 2
			}
			if a == "--session" {
				sessionFilter = args[i+1]
			} else {
				tabFilter = args[i+1]
			}
			i += 2
			continue
		default:
			fmt.Fprintf(stderr, "list-panes: unknown argument: %s\n", a)
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
		Panes     []paneEntry `json:"panes"`
		Workspace *wsTree     `json:"workspace"`
	}
	if err := json.Unmarshal(body, &state); err != nil {
		fmt.Fprintf(stderr, "dmctl: invalid /api/state response: %v\n", err)
		return 1
	}

	shellPids := make(map[string]int, len(state.Panes))
	sizes := make(map[string][2]int, len(state.Panes))
	for _, p := range state.Panes {
		shellPids[p.ID] = p.PID
		sizes[p.ID] = [2]int{p.SizeCols, p.SizeRows}
	}

	rows := buildListPanesRows(state.Workspace, shellPids, sizes)

	// LIST_PANES_NAME_FILTER_SRS FR-LPF-1/2: 이름 필터 (부분 일치, 대소문자 무시, AND).
	filtered := sessionFilter != "" || tabFilter != ""
	if filtered {
		var keep []listPanesRow
		for _, r := range rows {
			if matchFold(r.Session, sessionFilter) && matchFold(r.Tab, tabFilter) {
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
		fmt.Fprintln(stdout, "(no panes)")
		return 0
	}
	for _, r := range rows {
		line := paneline.Line{
			FocusMarker: r.Focused,
			Label:       r.Label,
			UUID:        r.UUID,
			Short:       r.Short,
			PaneID:      r.PaneID,
			ShellPID:    r.ShellPID,
			SizeCols:    r.SizeCols,
			SizeRows:    r.SizeRows,
			Session:     r.Session,
			Tab:         r.Tab,
			SessionUUID: r.SessionUUID,
			RegionUUID:  r.RegionUUID,
		}
		fmt.Fprintln(stdout, line.Render())
	}
	return 0
}

const dmctlListPanesHelp = `dmctl list-panes — 열린 pane 목록 조회

사용법:
  dmctl list-panes                      # 사람 가독성 텍스트 (▶ = 사용자 포커스)
  dmctl list-panes --json               # JSON 배열 (스크립트 친화)
  dmctl list-panes --session <substr>   # 세션 이름 필터 (부분 일치·대소문자 무시)
  dmctl list-panes --tab <substr>       # 탭 이름 필터. --session 과 AND
                                        # 매칭 0건이면 rc=1 (grep 컨벤션)

각 행: ▶|  label=...  uuid=...  short=...  paneId=...  shellPid=...  size=WxH  session="..."  tab="..."  session_uuid=...  region_uuid=...
빈 값(uuid/short/size/session_uuid/region_uuid)은 해당 컬럼이 생략된다.
`

type paneEntry struct {
	ID       string `json:"id"`
	PID      int    `json:"pid"`
	SizeCols int    `json:"sizeCols"`
	SizeRows int    `json:"sizeRows"`
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
	Label       string `json:"label"`
	UUID        string `json:"uuid"`
	Short       string `json:"short"`
	PaneID      string `json:"paneId"`
	ShellPID    int    `json:"shellPid"`
	SizeCols    int    `json:"sizeCols"`
	SizeRows    int    `json:"sizeRows"`
	Session     string `json:"session"`
	Tab         string `json:"tab"`
	SessionUUID string `json:"sessionUuid"`
	RegionUUID  string `json:"regionUuid"`
	Focused     bool   `json:"focused"`
}

func buildListPanesRows(ws *wsTree, shellPids map[string]int, sizes map[string][2]int) []listPanesRow {
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
				sz := sizes[tab.PaneID]
				out = append(out, listPanesRow{
					Label:       fmt.Sprintf("S%d.P%d.T%d", si+1, pi+1, ti+1),
					UUID:        tab.ID,
					Short:       shortCode(tab.ID),
					PaneID:      tab.PaneID,
					ShellPID:    shellPids[tab.PaneID],
					SizeCols:    sz[0],
					SizeRows:    sz[1],
					Session:     sess.Name,
					Tab:         tab.Name,
					SessionUUID: sess.ID,
					RegionUUID:  rg.ID,
					Focused:     focused,
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

// matchFold 는 substr 이 비었으면 통과, 아니면 case-insensitive substring 매칭.
func matchFold(s, substr string) bool {
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
