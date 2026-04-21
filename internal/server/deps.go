package server

import (
	"context"
	"encoding/json"

	"dongminal/internal/mcptool"
)

// PaneHub is the minimum surface that HTTP/WS handlers need from the pane
// registry. *PaneManager satisfies it naturally.
type PaneHub interface {
	List() []map[string]interface{}
	Create(cwd string, cols, rows uint16) (*Pane, error)
	Get(id string) *Pane
	Delete(id string)
}

// CodeServerHost exposes the subset of CodeServerManager consumed by handlers.
type CodeServerHost interface {
	List() []map[string]interface{}
	Start(folder string) (*CodeServerInst, error)
	Get(id string) *CodeServerInst
	Touch(id string) bool
	Stop(id string)
}

// WorkspaceStore is implemented by *workspace.Manager; kept as an interface so
// tests can inject a fake without bringing up the real persister. Only the
// methods actually consumed by HTTP handlers in this package are listed —
// Resolve / Labels / Entries / InvalidatePane are callers' concerns
// (internal/mcptool/tools/* + main).
type WorkspaceStore interface {
	Raw() []byte
	CurrentRev() uint64
	Save(blob []byte, ifMatch string) (uint64, error)
}

// ToolDispatcher abstracts *mcptool.Registry for the MCP handler.
type ToolDispatcher interface {
	List() []map[string]any
	Dispatch(ctx context.Context, name string, args json.RawMessage) (mcptool.Result, error)
}

// CommandBroker abstracts *CommandHub. Methods stay unexported — the SSE
// handler is package-internal, so only same-package types satisfy it.
type CommandBroker interface {
	add() *cmdSub
	remove(*cmdSub)
	Broadcast(payload []byte) int
}

// SettingsStore abstracts the in-memory + on-disk settings blob holder.
type SettingsStore interface {
	get() []byte
	set([]byte)
	save()
}

// Deps is the full injection surface for New.
type Deps struct {
	Panes    PaneHub
	CS       CodeServerHost
	Work     WorkspaceStore
	Tools    ToolDispatcher
	Commands CommandBroker
	Settings SettingsStore
}
