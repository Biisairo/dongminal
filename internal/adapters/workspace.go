package adapters

import (
	"dongminal/internal/toolaccess"
	"dongminal/internal/workspace"
)

// Workspace는 workspace.Manager 를 toolaccess.WorkspaceReader 로 어댑트한다.
type Workspace struct{ WS *workspace.Manager }

func (a Workspace) Resolve(id string) (string, error) { return a.WS.Resolve(id) }

func (a Workspace) Labels() map[string]string { return a.WS.Labels() }

func (a Workspace) CoordinateOf(id string) (string, error) { return a.WS.CoordinateOf(id) }

func (a Workspace) IsKnownTabID(id string) bool { return a.WS.IsKnownTabID(id) }

func (a Workspace) Entries() []toolaccess.WorkspaceEntry {
	src := a.WS.Entries()
	out := make([]toolaccess.WorkspaceEntry, len(src))
	for i, e := range src {
		out[i] = toolaccess.WorkspaceEntry{
			ToolID:     e.ToolID,
			Label:      e.Label,
			WindowName: e.WindowName,
			TabName:    e.TabName,
			IsActive:   e.IsActive,
			WindowUUID: e.WindowUUID,
			PaneUUID:   e.PaneUUID,
			TabUUID:    e.TabUUID,
			ShortCode:  e.ShortCode,
		}
	}
	return out
}
