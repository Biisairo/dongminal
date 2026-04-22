package adapters

import (
	"dongminal/internal/mcptool"
	"dongminal/internal/workspace"
)

// Workspace는 workspace.Manager 를 mcptool.WorkspaceReader 로 어댑트한다.
type Workspace struct{ WS *workspace.Manager }

func (a Workspace) Resolve(id string) (string, error) { return a.WS.Resolve(id) }

func (a Workspace) Labels() map[string]string { return a.WS.Labels() }

func (a Workspace) Entries() []mcptool.WorkspaceEntry {
	src := a.WS.Entries()
	out := make([]mcptool.WorkspaceEntry, len(src))
	for i, e := range src {
		out[i] = mcptool.WorkspaceEntry{
			PaneID:      e.PaneID,
			Label:       e.Label,
			SessionName: e.SessionName,
			TabName:     e.TabName,
			IsActive:    e.IsActive,
		}
	}
	return out
}
