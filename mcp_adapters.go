package main

import (
	"fmt"
	"time"

	"dongminal/internal/mcptool"

	"github.com/creack/pty"
)

// ── PaneReader adapter ───────────────────────────────

type paneAdapter struct{ pm *PaneManager }

func (a paneAdapter) List() []mcptool.PaneInfo {
	a.pm.mu.Lock()
	defer a.pm.mu.Unlock()
	out := make([]mcptool.PaneInfo, 0, len(a.pm.panes))
	for _, p := range a.pm.panes {
		pid := 0
		if p.cmd != nil && p.cmd.Process != nil {
			pid = p.cmd.Process.Pid
		}
		out = append(out, mcptool.PaneInfo{ID: p.ID, Name: p.Name, ShellPID: pid})
	}
	return out
}

func (a paneAdapter) Has(id string) bool { return a.pm.get(id) != nil }

func (a paneAdapter) Snapshot(id string) ([]byte, int64, bool) {
	p := a.pm.get(id)
	if p == nil || p.stream == nil {
		return nil, 0, false
	}
	data, stats := p.stream.Snapshot()
	return data, stats.TotalBytesDrop, true
}

func (a paneAdapter) Size(id string) string {
	p := a.pm.get(id)
	if p == nil || p.ptmx == nil {
		return "?"
	}
	rows, cols, err := pty.Getsize(p.ptmx)
	if err != nil {
		return "?"
	}
	return fmt.Sprintf("%dx%d", cols, rows)
}

func (a paneAdapter) SendPaste(id string, text []byte, submit bool) error {
	p := a.pm.get(id)
	if p == nil || p.ptmx == nil {
		return fmt.Errorf("pane 없음: %s", id)
	}
	var paste []byte
	paste = append(paste, 0x1b, '[', '2', '0', '0', '~')
	paste = append(paste, text...)
	paste = append(paste, 0x1b, '[', '2', '0', '1', '~')
	if _, err := p.ptmx.Write(paste); err != nil {
		return fmt.Errorf("ptmx write (paste): %w", err)
	}
	if submit {
		time.Sleep(120 * time.Millisecond)
		if _, err := p.ptmx.Write([]byte{'\r'}); err != nil {
			return fmt.Errorf("ptmx write (submit): %w", err)
		}
	}
	return nil
}

// ── WorkspaceReader adapter ──────────────────────────

type workspaceAdapter struct{}

func (workspaceAdapter) Resolve(id string) (string, error) { return wsMgr.Resolve(id) }

func (workspaceAdapter) Labels() map[string]string { return wsMgr.Labels() }

func (workspaceAdapter) Entries() []mcptool.WorkspaceEntry {
	src := wsMgr.Entries()
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

type cmdBroadcaster struct{}

func (cmdBroadcaster) AllowedAction(a string) bool { return allowedCmdActions[a] }
func (cmdBroadcaster) Broadcast(p []byte) int      { return broadcastCmd(p) }

// ── ClientPaneResolver adapter ───────────────────────

type clientResolver struct{ pm *PaneManager }

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
