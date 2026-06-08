// Package paneline은 dmctl 과 MCP (list_panes / who_am_i) 가 공유하는
// 한 줄 출력 렌더러를 제공한다. DMCTL_WHO_AM_I_SRS FR-PL-1~3 의 단일
// 소스 — 양 채널의 byte-level 일치를 위해 fmt 외부 의존 0.
package paneline

import (
	"fmt"
	"strings"
)

type Line struct {
	FocusMarker bool
	Label       string
	UUID        string
	Short       string
	PaneID      string
	ShellPID    int
	SizeCols    int
	SizeRows    int
	Session     string
	Tab         string
	SessionUUID string
	RegionUUID  string
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
	fmt.Fprintf(&b, "  paneId=%s  shellPid=%d", l.PaneID, l.ShellPID)
	if l.SizeCols != 0 || l.SizeRows != 0 {
		fmt.Fprintf(&b, "  size=%dx%d", l.SizeCols, l.SizeRows)
	}
	fmt.Fprintf(&b, "  session=%q  tab=%q", l.Session, l.Tab)
	if l.SessionUUID != "" {
		fmt.Fprintf(&b, "  session_uuid=%s", l.SessionUUID)
	}
	if l.RegionUUID != "" {
		fmt.Fprintf(&b, "  region_uuid=%s", l.RegionUUID)
	}
	return b.String()
}
