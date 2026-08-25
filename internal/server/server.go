// Package server owns the HTTP/MCP endpoints and subsystem managers. A
// *Server value aggregates the per-instance state (tool registry, workspace
// store, MCP session registry, tool registry) so that two independent servers
// can coexist in a single process (tests, embedded scenarios).
package server

import (
	"bufio"
	"context"
	"dongminal/internal/run"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"dongminal/internal/toolaccess"
)

// Config carries process-level knobs.
type Config struct {
	Port     string
	DataDir  string
	StaticFS fs.FS
}

// Server owns the HTTP server lifecycle.
type Server struct {
	cfg         Config
	Tools       ToolHub
	Work        WorkspaceStore
	Commands    CommandBroker
	Settings    SettingsStore
	WhoAmI      toolaccess.ClientToolResolver
	ToolIO      toolaccess.ToolReader
	WorkIndex   toolaccess.WorkspaceReader
	Stats       StatsSnapshotter
	AttnTracker *AttnTracker
	Runs        *run.Store
	// Focus holds window→client ownership (FR-XDF-1). in-memory only.
	Focus *FocusRegistry

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
		cfg:         cfg,
		Tools:       deps.Tools,
		Work:        deps.Work,
		Commands:    cmds,
		Focus:       NewFocusRegistry(),
		Settings:    settings,
		WhoAmI:      deps.WhoAmI,
		ToolIO:      deps.ToolIO,
		WorkIndex:   deps.WorkIndex,
		Stats:       deps.Stats,
		AttnTracker: deps.AttnTracker,
		Runs:        deps.Runs,
		started:     time.Now(),
	}, nil
}

// Started returns the NewServer timestamp.
func (s *Server) Started() time.Time { return s.started }

// Handler returns the top-level http.Handler.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	if s.cfg.StaticFS != nil {
		mux.Handle("/", http.FileServer(http.FS(s.cfg.StaticFS)))
	}
	mux.HandleFunc("/ws", s.handleWS)
	mux.HandleFunc("/api/", s.handleAPI)
	mux.HandleFunc("/api/commands", s.handleCommandPost)
	mux.HandleFunc("/api/commands/sse", s.handleCommandSSE)
	mux.HandleFunc("/api/command-result", s.handleCommandResult)
	return loggingMiddleware(mux)
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
		// Close immediately so browsers detect disconnection instantly.
		_ = srv.Close()
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

// --- HTTP logging middleware ------------------------------------------------

func loggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rw := &responseWriter{ResponseWriter: w, status: 200}
		next.ServeHTTP(rw, r)
		if shouldLogRequest(r.URL.Path, rw.status) {
			log.Printf("http %s %s %d %s addr=%s",
				r.Method, r.URL.Path, rw.status, time.Since(start).Round(time.Millisecond), r.RemoteAddr)
		}
	})
}

// shouldLogRequest filters high-frequency hot-path endpoints from the access
// log. Errors (status>=400) always log so failures stay observable. Split
// tools / tool-delete flows hammer /api/workspace and /api/tools dozens of
// times per second; logging each one caused hundreds of ms of keyboard-input
// lag (H5).
func shouldLogRequest(path string, status int) bool {
	if status >= 400 {
		return true
	}
	switch path {
	case "/api/ping", "/api/stats":
		return false
	}
	if strings.HasPrefix(path, "/api/workspace") || strings.HasPrefix(path, "/api/tools") {
		return false
	}
	return true
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
