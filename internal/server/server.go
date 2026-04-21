// Package server wires HTTP/MCP endpoints and subsystem managers into a
// single *Server value so the process can host multiple independent instances
// (tests, embedded scenarios) instead of relying on package-main globals.
//
// Stage 5a of Candidate 5: subsystem types (PaneManager, CodeServerManager,
// etc.) live in package main. To avoid the import cycle, main owns the
// concrete values and passes them in via Deps as interface-typed references.
// Handler bodies remain in package main and still read shim globals (pm, csm,
// wsMgr, toolRegistry, mcpReg). Stage 5b/5c (method-conversion, deeper
// abstractions) are out of scope.
package server

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"sync"
	"time"
)

// Config carries process-level knobs. StaticFS is the already-sub'd fs (the
// embedded "static/" tree); pass nil in tests to skip serving static files.
type Config struct {
	Port     string
	DataDir  string
	StaticFS fs.FS
}

// --- DI interfaces ----------------------------------------------------------
//
// These are intentionally minimal: Stage 5a's handlers live in package main
// and access concrete types via shim globals, so *Server itself never calls
// the methods listed below. The interfaces exist to (a) document the contract
// Server expects from main, and (b) let tests inject fakes without dragging
// in the real PaneManager/CodeServerManager.

// PaneHub is main's pane registry. Stage 5a holds it only for DI clarity.
type PaneHub interface{}

// CodeServerHost is main's code-server session manager.
type CodeServerHost interface{}

// WorkspaceStore is the workspace persistence layer (implemented by
// *workspace.Manager).
type WorkspaceStore interface {
	Raw() []byte
	CurrentRev() uint64
	InvalidatePane(string)
}

// ToolDispatcher is the MCP tool registry (implemented by *mcptool.Registry).
type ToolDispatcher interface {
	List() []map[string]any
	Names() []string
}

// CommandBroker is the SSE command fan-out used by /api/commands.
type CommandBroker interface{}

// SettingsStore is the settings.json persistence layer.
type SettingsStore interface{}

// Handlers bundles the HTTP handler funcs provided by package main. Stage 5a
// leaves handler bodies untouched in main; Server merely wires them into the
// ServeMux.
type Handlers struct {
	API         http.Handler
	WS          http.Handler
	CSProxy     http.Handler
	CommandSSE  http.Handler
	CommandPost http.Handler
	MCPSSE      http.Handler
	MCPMessage  http.Handler
}

// Deps is the full injection surface for New.
type Deps struct {
	Panes    PaneHub
	CS       CodeServerHost
	Work     WorkspaceStore
	Tools    ToolDispatcher
	Commands CommandBroker
	Settings SettingsStore
	Handlers Handlers
}

// Server owns the HTTP server lifecycle and borrows subsystem refs from Deps.
type Server struct {
	cfg      Config
	Panes    PaneHub
	CS       CodeServerHost
	Work     WorkspaceStore
	Tools    ToolDispatcher
	Commands CommandBroker
	MCP      *MCPSessionRegistry
	Settings SettingsStore

	handlers Handlers
	started  time.Time

	mu      sync.Mutex
	httpSrv *http.Server
}

// New constructs a Server from cfg + deps. Returns an error slot for forward
// compatibility; Stage 5a cannot fail here because deps are owned by main.
func New(cfg Config, deps Deps) (*Server, error) {
	return &Server{
		cfg:      cfg,
		Panes:    deps.Panes,
		CS:       deps.CS,
		Work:     deps.Work,
		Tools:    deps.Tools,
		Commands: deps.Commands,
		Settings: deps.Settings,
		MCP:      NewMCPSessionRegistry(),
		handlers: deps.Handlers,
		started:  time.Now(),
	}, nil
}

// Started returns the NewServer timestamp (used by /api/stats for uptime).
func (s *Server) Started() time.Time { return s.started }

// Handler returns the top-level http.Handler (ServeMux + logging middleware).
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	if s.cfg.StaticFS != nil {
		mux.Handle("/", http.FileServer(http.FS(s.cfg.StaticFS)))
	}
	if s.handlers.WS != nil {
		mux.Handle("/ws", s.handlers.WS)
	}
	if s.handlers.API != nil {
		mux.Handle("/api/", s.handlers.API)
	}
	if s.handlers.CSProxy != nil {
		mux.Handle("/cs/", s.handlers.CSProxy)
	}
	if s.handlers.CommandPost != nil {
		mux.Handle("/api/commands", s.handlers.CommandPost)
	}
	if s.handlers.CommandSSE != nil {
		mux.Handle("/api/commands/sse", s.handlers.CommandSSE)
	}
	if s.handlers.MCPSSE != nil {
		mux.Handle("/mcp/sse", s.handlers.MCPSSE)
	}
	if s.handlers.MCPMessage != nil {
		mux.Handle("/mcp/message", s.handlers.MCPMessage)
	}
	return loggingMiddleware(mux)
}

// MCPHandler returns just the /mcp/* subset (useful if the MCP endpoints need
// to be hosted on a separate listener).
func (s *Server) MCPHandler() http.Handler {
	mux := http.NewServeMux()
	if s.handlers.MCPSSE != nil {
		mux.Handle("/mcp/sse", s.handlers.MCPSSE)
	}
	if s.handlers.MCPMessage != nil {
		mux.Handle("/mcp/message", s.handlers.MCPMessage)
	}
	return mux
}

// Run starts the HTTP server on addr and blocks until ctx is cancelled or the
// server errors. On cancel, it initiates a graceful shutdown.
func (s *Server) Run(ctx context.Context, addr string) error {
	srv := &http.Server{Addr: addr, Handler: s.Handler()}
	s.mu.Lock()
	s.httpSrv = srv
	s.mu.Unlock()

	errCh := make(chan error, 1)
	go func() {
		err := srv.ListenAndServe()
		if err == http.ErrServerClosed {
			err = nil
		}
		errCh <- err
	}()

	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
		return <-errCh
	case err := <-errCh:
		return err
	}
}

// Shutdown gracefully stops the HTTP server. Caller is expected to persist
// domain state (panes, settings) and stop side processes (code-server) before
// or after calling this.
func (s *Server) Shutdown(ctx context.Context) error {
	s.mu.Lock()
	srv := s.httpSrv
	s.mu.Unlock()
	if srv == nil {
		return nil
	}
	return srv.Shutdown(ctx)
}

// --- MCP session registry ---------------------------------------------------

// MCPSession represents a single SSE-attached MCP client.
type MCPSession struct {
	ID         string
	Ch         chan []byte
	Done       chan struct{}
	RemoteAddr string

	once sync.Once
}

// MCPSessionRegistry replaces the former package-main mcpSessions global.
type MCPSessionRegistry struct {
	mu       sync.Mutex
	sessions map[string]*MCPSession
}

// NewMCPSessionRegistry builds an empty registry.
func NewMCPSessionRegistry() *MCPSessionRegistry {
	return &MCPSessionRegistry{sessions: make(map[string]*MCPSession)}
}

// New allocates, registers and returns a fresh session with a random hex id.
func (r *MCPSessionRegistry) New() *MCPSession {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	id := hex.EncodeToString(b)
	s := &MCPSession{
		ID:   id,
		Ch:   make(chan []byte, 32),
		Done: make(chan struct{}),
	}
	r.mu.Lock()
	r.sessions[id] = s
	r.mu.Unlock()
	return s
}

// Get returns the session with the given id or nil.
func (r *MCPSessionRegistry) Get(id string) *MCPSession {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.sessions[id]
}

// Close removes the session from the registry and closes its done channel.
// Idempotent.
func (r *MCPSessionRegistry) Close(s *MCPSession) {
	if s == nil {
		return
	}
	s.once.Do(func() {
		close(s.Done)
		r.mu.Lock()
		delete(r.sessions, s.ID)
		r.mu.Unlock()
	})
}

// --- HTTP logging middleware (moved out of main.go) -------------------------

func loggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rw := &responseWriter{ResponseWriter: w, status: 200}
		next.ServeHTTP(rw, r)
		if r.URL.Path != "/api/ping" && r.URL.Path != "/api/stats" {
			log.Printf("http %s %s %d %s addr=%s",
				r.Method, r.URL.Path, rw.status, time.Since(start).Round(time.Millisecond), r.RemoteAddr)
		}
	})
}

type responseWriter struct {
	http.ResponseWriter
	status int
}

func (rw *responseWriter) WriteHeader(status int) {
	rw.status = status
	rw.ResponseWriter.WriteHeader(status)
}

func (rw *responseWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	if h, ok := rw.ResponseWriter.(http.Hijacker); ok {
		return h.Hijack()
	}
	return nil, nil, fmt.Errorf("ResponseWriter does not implement http.Hijacker")
}

func (rw *responseWriter) Flush() {
	if f, ok := rw.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}
