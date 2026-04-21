package main

import (
	"fmt"
	"time"

	"dongminal/internal/mcptool"
	"dongminal/internal/server"
	"dongminal/internal/workspace"

	"github.com/creack/pty"
)

// ── PaneReader adapter ───────────────────────────────

type paneAdapter struct{ pm *server.PaneManager }

func (a paneAdapter) List() []mcptool.PaneInfo {
	panes := a.pm.Snapshot()
	out := make([]mcptool.PaneInfo, 0, len(panes))
	for _, p := range panes {
		out = append(out, mcptool.PaneInfo{ID: p.ID, Name: p.Name, ShellPID: p.CmdProcessPID()})
	}
	return out
}

func (a paneAdapter) Has(id string) bool { return a.pm.Get(id) != nil }

func (a paneAdapter) Snapshot(id string) ([]byte, int64, bool) {
	p := a.pm.Get(id)
	if p == nil || p.Stream() == nil {
		return nil, 0, false
	}
	data, stats := p.Stream().Snapshot()
	return data, stats.TotalBytesDrop, true
}

func (a paneAdapter) Size(id string) string {
	p := a.pm.Get(id)
	if p == nil || p.PTMX() == nil {
		return "?"
	}
	rows, cols, err := pty.Getsize(p.PTMX())
	if err != nil {
		return "?"
	}
	return fmt.Sprintf("%dx%d", cols, rows)
}

func (a paneAdapter) SendPaste(id string, text []byte, submit bool) error {
	p := a.pm.Get(id)
	if p == nil || p.PTMX() == nil {
		return fmt.Errorf("pane 없음: %s", id)
	}
	var paste []byte
	paste = append(paste, 0x1b, '[', '2', '0', '0', '~')
	paste = append(paste, text...)
	paste = append(paste, 0x1b, '[', '2', '0', '1', '~')
	if _, err := p.PTMX().Write(paste); err != nil {
		return fmt.Errorf("ptmx write (paste): %w", err)
	}
	if submit {
		time.Sleep(120 * time.Millisecond)
		if _, err := p.PTMX().Write([]byte{'\r'}); err != nil {
			return fmt.Errorf("ptmx write (submit): %w", err)
		}
	}
	return nil
}

// ── WorkspaceReader adapter ──────────────────────────

type workspaceAdapter struct{ ws *workspace.Manager }

func (a workspaceAdapter) Resolve(id string) (string, error) { return a.ws.Resolve(id) }

func (a workspaceAdapter) Labels() map[string]string { return a.ws.Labels() }

func (a workspaceAdapter) Entries() []mcptool.WorkspaceEntry {
	src := a.ws.Entries()
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

// ── CommandBroadcaster adapter ───────────────────────

type cmdBroadcaster struct{ hub *server.CommandHub }

func (c cmdBroadcaster) AllowedAction(a string) bool { return c.hub.AllowedAction(a) }
func (c cmdBroadcaster) Broadcast(p []byte) int      { return c.hub.Broadcast(p) }

// ── ClientPaneResolver adapter ───────────────────────

type clientResolver struct{ pm *server.PaneManager }

func (r clientResolver) ResolveClientPane(remoteAddr string) (string, int, error) {
	clientPID, err := getClientPID(remoteAddr)
	if err != nil {
		return "", 0, err
	}
	paneShellPids := map[int]string{}
	a := paneAdapter{pm: r.pm}
	for _, p := range a.List() {
		if p.ShellPID > 0 {
			paneShellPids[p.ShellPID] = p.ID
		}
	}
	current := clientPID
	for i := 0; i < 32; i++ {
		if paneID, ok := paneShellPids[current]; ok {
			return paneID, current, nil
		}
		parent, err := getParentPID(current)
		if err != nil || parent <= 1 {
			break
		}
		current = parent
	}
	return "", 0, fmt.Errorf("clientPID=%d 가 어느 pane에도 속하지 않음", clientPID)
}
