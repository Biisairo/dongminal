package runtimebin

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"sync"

	"dongminal/internal/helper/toolline"
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
	fg := make(map[string]string, len(state.Tools))
	for _, p := range state.Tools {
		shellPids[p.ID] = p.PID
		sizes[p.ID] = [2]int{p.SizeCols, p.SizeRows}
		if p.FgName != "" {
			fg[p.ID] = p.FgName
		}
	}

	// FR-TAN-18: `tab="..."` 는 **화면에 보이는 이름**이다. 설정을 함께 읽는
	// 이유가 그것이다 — 사용자가 파생을 껐으면 에이전트도 껐을 때의 이름을
	// 봐야 한다.
	rows := buildListWorkspaceRows(state.Workspace, shellPids, sizes, fg, onceBool(fgTabNamesEnabled))

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
	// FgName 은 이 도구의 전경 프로세스 이름이다 (CONVENIENCE_SRS FR-TAN-5).
	// 셸이 프롬프트에서 대기 중이거나 조회에 실패하면 빈 문자열이다.
	FgName string `json:"fgName"`
}

type wsTree struct {
	ActiveWindow string     `json:"activeWindow"`
	Windows      []wsWindow `json:"windows"`
}

type wsWindow struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	FocusedPane string    `json:"focusedPane"`
	Layout      *wsLayout `json:"layout"`
}

// wsLayout·wsTab 은 workspace.WsLayout 의 dmctl 판이다. 갈라 둔 이유는
// `type`·`nameSource` 두 필드다 — 표시 이름 규칙(FR-TAN-1/3)만 그것을 읽고,
// 공유 워크스페이스 모델은 읽을 일이 없다. 이 파일이 이미 wsTree·wsWindow 를
// 자기 것으로 들고 있는 것과 같은 결이며, 그 덕에 `shared/workspace` 를
// 건드리지 않는다.
type wsLayout struct {
	Type      string      `json:"type"`
	ID        string      `json:"id"`
	Tabs      []wsTab     `json:"tabs"`
	ActiveTab string      `json:"activeTab"`
	Children  []*wsLayout `json:"children"`
}

type wsTab struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	ToolID string `json:"toolId"`
	// Type·NameSource 는 표시 이름 규칙이 읽는다 (FR-TAN-3/1).
	Type       string `json:"type"`
	NameSource string `json:"nameSource"`
}

// collectPanes 는 workspace.CollectPanes 와 같은 순회다 (pane 을 트리 순서대로).
func collectPanes(n *wsLayout, out *[]*wsLayout) {
	if n == nil {
		return
	}
	if n.Type == "pane" {
		*out = append(*out, n)
		return
	}
	for _, c := range n.Children {
		collectPanes(c, out)
	}
}

// tabNameSource 는 web/js/core/helpers.js 의 같은 이름 함수와 **같은 규칙**이다
// (FR-TAN-1/3/4). 두 곳이 갈라지면 에이전트가 화면과 다른 것을 보게 된다
// (FR-TAN-18).
func tabNameSource(t wsTab) string {
	switch t.Type {
	case "editor", "run", "git":
		// FR-TAN-3: 이름이 콘텐츠에서 파생되므로 본 묶음의 대상이 아니다.
		return nameSourceManual
	}
	if t.NameSource == nameSourceManual || t.NameSource == nameSourceAuto {
		return t.NameSource
	}
	// FR-TAN-4: 구 워크스페이스에는 필드가 없다. 기본 이름이면 auto, 아니면
	// 사용자가 준 이름으로 본다.
	if t.Name == defaultTabName {
		return nameSourceAuto
	}
	return nameSourceManual
}

// tabDisplayName 은 화면에 보이는 이름이다 — helpers.js 의 tabName 과 같다.
// auto 인 탭만 파생 이름을 받고, manual 은 어떤 경우에도 덮이지 않는다
// (FR-TAN-15).
//
// `enabled` 가 값이 아니라 함수인 것은 요청을 아끼기 위해서다 — 설정은 서버에
// 있고(FR-TAN-19), 파생 이름이 실제로 쓰일 자리가 하나도 없으면 그 값은 결과를
// 바꿀 수 없다. 그래서 판정 순서가 파생 이름 **뒤**다.
func tabDisplayName(t wsTab, fg map[string]string, enabled func() bool) string {
	if tabNameSource(t) != nameSourceAuto {
		return t.Name
	}
	n := fg[t.ToolID]
	if n == "" || !enabled() {
		return t.Name
	}
	return n
}

// onceBool 은 값을 처음 필요할 때 한 번만 구한다.
func onceBool(f func() bool) func() bool {
	var once sync.Once
	var v bool
	return func() bool {
		once.Do(func() { v = f() })
		return v
	}
}

const (
	defaultTabName    = "Shell"
	nameSourceAuto    = "auto"
	nameSourceManual  = "manual"
	fgTabNamesSetting = "fgTabNames"
)

// fgTabNamesEnabled 는 FR-TAN-19 의 설정을 읽는다. 기본은 켬이며, 설정을 읽지
// 못하면 기본으로 간다 — 이름 하나 때문에 목록 조회가 실패하면 안 된다.
func fgTabNamesEnabled() bool {
	status, body, err := httpGet(baseURL() + "/api/settings")
	if err != nil || status < 200 || status >= 300 {
		return true
	}
	var s map[string]json.RawMessage
	if json.Unmarshal(body, &s) != nil {
		return true
	}
	raw, ok := s[fgTabNamesSetting]
	if !ok {
		return true
	}
	var v bool
	if json.Unmarshal(raw, &v) != nil {
		return true
	}
	return v
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

func buildListWorkspaceRows(ws *wsTree, shellPids map[string]int, sizes map[string][2]int, fg map[string]string, fgEnabled func() bool) []listWorkspaceRow {
	if ws == nil {
		return nil
	}
	var out []listWorkspaceRow
	for si, sess := range ws.Windows {
		var regions []*wsLayout
		collectPanes(sess.Layout, &regions)
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
					Tab:        tabDisplayName(tab, fg, fgEnabled),
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
