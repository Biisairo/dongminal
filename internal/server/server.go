// Package server owns the HTTP/MCP endpoints and subsystem managers. A
// *Server value aggregates the per-instance state (pane registry, code-server
// host, workspace store, MCP session registry, tool registry) so that two
// independent servers can coexist in a single process (tests, embedded
// scenarios).
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
	"path/filepath"
	"sync"
	"time"

)

// Config carries process-level knobs.
type Config struct {
	Port     string
	DataDir  string
	StaticFS fs.FS
}

// Server owns the HTTP server lifecycle.
type Server struct {
	cfg      Config
	Panes    PaneHub
	CS       CodeServerHost
	Work     WorkspaceStore
	Tools    ToolDispatcher
	Commands CommandBroker
	MCP      *MCPSessionRegistry
	Settings SettingsStore

	started time.Time

	mu      sync.Mutex
	httpSrv *http.Server
}

// New constructs a Server from cfg + deps. If deps.Commands is nil, a fresh
// CommandHub is created.
func New(cfg Config, deps Deps) (*Server, error) {
	cmds := deps.Commands
	if cmds == nil {
		cmds = NewCommandHub()
	}
	settingsPath := ""
	if cfg.DataDir != "" {
		settingsPath = filepath.Join(cfg.DataDir, "settings.json")
	} else {
		settingsPath = "settings.json"
	}
	settings := deps.Settings
	if settings == nil {
		settings = newSettingsStore(settingsPath)
	}
	return &Server{
		cfg:      cfg,
		Panes:    deps.Panes,
		CS:       deps.CS,
		Work:     deps.Work,
		Tools:    deps.Tools,
		Commands: cmds,
		MCP:      NewMCPSessionRegistry(),
		Settings: settings,
		started:  time.Now(),
	}, nil
}

// Started returns the NewServer timestamp.
func (s *Server) Started() time.Time { return s.started }

// PersistSettings writes the current settings blob to disk (called from
// shutdown path in main).
func (s *Server) PersistSettings() {
	if s.Settings != nil {
		s.Settings.save()
	}
}

// Handler returns the top-level http.Handler.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	if s.cfg.StaticFS != nil {
		mux.Handle("/", http.FileServer(http.FS(s.cfg.StaticFS)))
	}
	mux.HandleFunc("/ws", s.handleWS)
	mux.HandleFunc("/api/", s.handleAPI)
	mux.HandleFunc("/cs/", s.handleCSProxy)
	mux.HandleFunc("/api/commands", s.handleCommandPost)
	mux.HandleFunc("/api/commands/sse", s.handleCommandSSE)
	mux.HandleFunc("/mcp/sse", s.handleMCPSSE)
	mux.HandleFunc("/mcp/message", s.handleMCPMessage)
	return loggingMiddleware(mux)
}

// MCPHandler returns just the /mcp/* subset.
func (s *Server) MCPHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/mcp/sse", s.handleMCPSSE)
	mux.HandleFunc("/mcp/message", s.handleMCPMessage)
	return mux
}

// Run starts the HTTP server on addr and blocks until ctx is cancelled.
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

// Shutdown gracefully stops the HTTP server.
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

type MCPSession struct {
	ID         string
	Ch         chan []byte
	Done       chan struct{}
	RemoteAddr string

	once sync.Once
}

type MCPSessionRegistry struct {
	mu       sync.Mutex
	sessions map[string]*MCPSession
}

func NewMCPSessionRegistry() *MCPSessionRegistry {
	return &MCPSessionRegistry{sessions: make(map[string]*MCPSession)}
}

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

func (r *MCPSessionRegistry) Get(id string) *MCPSession {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.sessions[id]
}

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

// --- HTTP logging middleware ------------------------------------------------

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
