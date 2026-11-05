// Package toolline은 dmctl 과 MCP (list_workspace / who_am_i) 가 공유하는
// 한 줄 출력 렌더러를 제공한다. DMCTL_WHO_AM_I_SRS FR-PL-1~3 의 단일
// 소스 — 양 채널의 byte-level 일치를 위해 fmt 외부 의존 0.
package toolline

import (
	"fmt"
	"strings"
)

type Line struct {
	FocusMarker bool
	Label       string
	UUID        string
	Short       string
	ToolID      string
	ShellPID    int
	SizeCols    int
	SizeRows    int
	Window      string
	Tab         string
	WindowUUID  string
	PaneUUID    string
	// ISSUE_AGENT_TREE_SRS FR-WGR-34 · FR-ORD-31. 0·빈 값이면 열을 생략한다 (FR-PL-2).
	Group              string
	WinIndex, WinCount int
	TabIndex, TabCount int
}

// Render는 FR-PL-1 의 표준 라인을 반환한다. 개행 미포함.
// 빈 값 컬럼은 FR-PL-2 에 따라 생략된다.
func (l Line) Render() string {
	var b strings.Builder
	if l.FocusMarker {
		b.WriteString("▶ ")
	} else {
		b.WriteString("  ")
	}
	fmt.Fprintf(&b, "label=%s", l.Label)
	if l.UUID != "" {
		fmt.Fprintf(&b, "  uuid=%s", l.UUID)
	}
	if l.Short != "" {
		fmt.Fprintf(&b, "  short=%s", l.Short)
	}
	fmt.Fprintf(&b, "  toolId=%s  shellPid=%d", l.ToolID, l.ShellPID)
	if l.SizeCols != 0 || l.SizeRows != 0 {
		fmt.Fprintf(&b, "  size=%dx%d", l.SizeCols, l.SizeRows)
	}
	fmt.Fprintf(&b, "  window=%q  tab=%q", l.Window, l.Tab)
	if l.WindowUUID != "" {
		fmt.Fprintf(&b, "  window_uuid=%s", l.WindowUUID)
	}
	if l.PaneUUID != "" {
		fmt.Fprintf(&b, "  pane_uuid=%s", l.PaneUUID)
	}
	if l.Group != "" {
		fmt.Fprintf(&b, "  group=%q", l.Group)
	}
	if l.WinCount != 0 {
		fmt.Fprintf(&b, "  win_pos=%d/%d", l.WinIndex, l.WinCount)
	}
	if l.TabCount != 0 {
		fmt.Fprintf(&b, "  tab_pos=%d/%d", l.TabIndex, l.TabCount)
	}
	return b.String()
}
