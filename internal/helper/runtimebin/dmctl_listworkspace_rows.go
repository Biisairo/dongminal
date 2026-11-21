package runtimebin

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"

	"dongminal/internal/shared/apipath"
	"dongminal/internal/shared/workspace"
)

// `dmctl list-workspace`·`list-groups` 의 행 — 워크스페이스 트리를 도구·그룹 행으로 편다 (dmctl_listworkspace.go 에서 옮겨 왔다, REFACTOR3_GO_STRUCT_SRS FR-RGS-43).

type toolEntry struct {
	ID       string `json:"id"`
	PID      int    `json:"pid"`
	SizeCols int    `json:"sizeCols"`
	SizeRows int    `json:"sizeRows"`
	// FgName 은 이 도구의 전경 프로세스 이름이다 (CONVENIENCE_SRS FR-TAN-5).
	// 셸이 프롬프트에서 대기 중이면 cwd 의 마지막 이름(홈은 ~)이고, 그것도 모르면
	// 빈 문자열이다 (UX_AUDIT_FIX_SRS FR-UXF-65).
	FgName string `json:"fgName"`
}

// 워크스페이스의 모양과 순회는 `shared/workspace` 의 것이다 (REFACTOR3_DEDUP_GO_SRS
// FR-RDG-23 · Q4). 같은 순회·같은 JSON 모양이 두 벌이던 것을 합쳤다. 별칭은 이 패키지의
// 짧은 이름을 남기려는 것뿐이다.
type (
	wsTree      = workspace.WsState
	wsWindow    = workspace.WsWindow
	wsGroup     = workspace.WsGroup
	wsGroupTree = workspace.WsGroupTree
	wsLayout    = workspace.WsLayout
	wsTab       = workspace.WsTab
)

// tabNameSource 는 web/js/core/layout-tree.js 의 같은 이름 함수와 **같은 규칙**이다
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

// tabDisplayName 은 화면에 보이는 이름이다 — layout-tree.js 의 tabName 과 같다.
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
// null 도 값이 없는 것이다 (서버 parseFgTabNames 와 같은 표).
func fgTabNamesEnabled() bool {
	status, body, err := httpGet(baseURL() + apipath.Settings)
	if err != nil || status < 200 || status >= 300 {
		return true
	}
	var s map[string]json.RawMessage
	if json.Unmarshal(body, &s) != nil {
		return true
	}
	var v *bool
	if json.Unmarshal(s[fgTabNamesSetting], &v) != nil || v == nil {
		return true
	}
	return *v
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
	// ISSUE_AGENT_TREE_SRS FR-WGR-34 · FR-ORD-30: 그룹과 담는 곳 안의 자리(1부터).
	// git·editor 창의 행은 window 순서 필드가 비어 있다 (FR-WGR-7).
	GroupUUID       string `json:"groupUuid,omitempty"`
	Group           string `json:"group,omitempty"`
	WindowContainer string `json:"windowContainer,omitempty"`
	WindowIndex     int    `json:"windowIndex,omitempty"`
	WindowCount     int    `json:"windowCount,omitempty"`
	TabIndex        int    `json:"tabIndex"`
	TabCount        int    `json:"tabCount"`
}

// winPos 는 window 하나가 담는 곳 안에서 선 자리다.
type winPos struct {
	container    string
	index, count int
}

// windowPositions 는 web/js/core/window-order.js 의 winOrderItems 와 **같은 규칙**이다
// (두 쪽이 testdata/window_order_vectors.json 을 함께 시험한다):
// 일반 창(type 없음)만 세고, 같은 그룹의 연속한 창은 최상위에서 한 칸이다.
func windowPositions(ws *wsTree) map[string]winPos {
	type item struct {
		group string
		wins  []string
	}
	var items []*item
	for _, w := range ws.Windows {
		if w.Type != "" {
			continue
		}
		if w.GroupID != "" && len(items) > 0 && items[len(items)-1].group == w.GroupID {
			last := items[len(items)-1]
			last.wins = append(last.wins, w.ID)
			continue
		}
		items = append(items, &item{group: w.GroupID, wins: []string{w.ID}})
	}
	out := map[string]winPos{}
	for i, it := range items {
		if it.group == "" {
			out[it.wins[0]] = winPos{container: windowContainerTop, index: i + 1, count: len(items)}
			continue
		}
		for j, id := range it.wins {
			out[id] = winPos{container: it.group, index: j + 1, count: len(it.wins)}
		}
	}
	return out
}

const windowContainerTop = "top"

// groupRow 는 `dmctl list-groups` 의 한 줄이다. Index 0 은 빈 그룹(최상위 목록 끝)이다.
type groupRow struct {
	UUID    string       `json:"uuid"`
	Name    string       `json:"name"`
	Tree    *wsGroupTree `json:"tree,omitempty"`
	Index   int          `json:"index"`
	Windows int          `json:"windows"`
}

func buildGroupRows(ws *wsTree) []groupRow {
	if ws == nil {
		return nil
	}
	top := map[string]int{}
	count := map[string]int{}
	itemIdx := 0
	prev := ""
	for _, w := range ws.Windows {
		if w.Type != "" {
			continue
		}
		if w.GroupID == "" || w.GroupID != prev {
			itemIdx++
		}
		prev = w.GroupID
		if w.GroupID != "" {
			count[w.GroupID]++
			if _, ok := top[w.GroupID]; !ok {
				top[w.GroupID] = itemIdx
			}
		}
	}
	var live, empty []groupRow
	for _, g := range ws.WindowGroups {
		r := groupRow{UUID: g.ID, Name: g.Name, Tree: g.Tree, Index: top[g.ID], Windows: count[g.ID]}
		if r.Windows == 0 {
			empty = append(empty, r)
			continue
		}
		live = append(live, r)
	}
	sort.SliceStable(live, func(i, j int) bool { return live[i].Index < live[j].Index })
	return append(live, empty...)
}

func buildListWorkspaceRows(ws *wsTree, shellPids map[string]int, sizes map[string][2]int, fg map[string]string, fgEnabled func() bool) []listWorkspaceRow {
	if ws == nil {
		return nil
	}
	var out []listWorkspaceRow
	pos := windowPositions(ws)
	groupName := map[string]string{}
	for _, g := range ws.WindowGroups {
		groupName[g.ID] = g.Name
	}
	for si, sess := range ws.Windows {
		wp := pos[sess.ID]
		var regions []*wsLayout
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
					Short:      workspace.ShortCode(tab.ID),
					ToolID:     tab.ToolID,
					ShellPID:   shellPids[tab.ToolID],
					SizeCols:   sz[0],
					SizeRows:   sz[1],
					Window:     sess.Name,
					Tab:        tabDisplayName(tab, fg, fgEnabled),
					WindowUUID: sess.ID,
					PaneUUID:   rg.ID,
					Focused:    focused,

					GroupUUID:       sess.GroupID,
					Group:           groupName[sess.GroupID],
					WindowContainer: wp.container,
					WindowIndex:     wp.index,
					WindowCount:     wp.count,
					TabIndex:        ti + 1,
					TabCount:        len(rg.Tabs),
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
