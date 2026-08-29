// Package httpapi owns the HTTP/MCP endpoints and subsystem managers. A
// *Server value aggregates the per-instance state (tool registry, workspace
// store, MCP session registry, tool registry) so that two independent servers
// can coexist in a single process (tests, embedded scenarios).
package httpapi

import (
	"dongminal/internal/webserver/gitapi"

	"dongminal/internal/webserver/hub"

	"dongminal/internal/shared/toolhub"

	"bufio"
	"context"
	"dongminal/internal/webserver/domain/git/store"
	"dongminal/internal/webserver/domain/run"
	"dongminal/internal/webserver/domain/worktree"
	"dongminal/internal/webserver/domain/wsentry"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"dongminal/internal/webserver/seam/toolaccess"
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
	Tools       toolhub.ToolHub
	Work        WorkspaceStore
	Commands    hub.CommandBroker
	Settings    SettingsStore
	WhoAmI      toolaccess.ClientToolResolver
	ToolIO      toolaccess.ToolReader
	WorkIndex   toolaccess.WorkspaceReader
	Stats       StatsSnapshotter
	AttnTracker *hub.AttnTracker
	Runs        *run.Store
	// Worktrees owns $DONGMINAL_HOME/worktrees (RUN_ORCHESTRATION_SRS 묶음 W).
	// nil 이면 격리를 요청한 Run 만 거부되고(FR-WKT-11), isolation=none 경로는
	// 영향이 없다 (NFR-RUN-1).
	Worktrees *worktree.Manager
	// Git 은 git 조회 앞의 single-flight·TTL 캐시다 (GIT_SRS 묶음 A~C). nil 이면
	// /api/git/* 만 503 이고 그 밖의 동작에는 영향이 없다 (FR-GIT-60).
	Git *store.Store
	// Focus holds window→client ownership (FR-XDF-1). in-memory only.
	Focus *hub.FocusRegistry
	// Entries 는 workspace.json 최상위의 두 목록 — git.pinned[] 와 editors.list[] —
	// 을 함께 소유한다 (EDITOR_TAB_SRS FR-EDT-116). /api/editors/* 와 /api/fs/* 의
	// 루트 가드가 이것을 읽는다 (FR-EDT-113). Work 가 nil 이면 그 종단만 실패한다.
	Entries *wsentry.Store

	// git 은 /api/git/* 을 소유한다. Git 이 nil 이면 이 자리도 nil 이고,
	// handleAPI 가 라우팅 miss 로 404 를 낸다 (FR-GIT-60 의 503 은 핸들러 안에서).
	git *gitapi.GitServer

	started time.Time

	mu sync.Mutex
}

// New constructs a Server from cfg + deps. If deps.Commands is nil, a fresh
// hub.CommandHub is created.
func New(cfg Config, deps Deps) (*Server, error) {
	cmds := deps.Commands
	if cmds == nil {
		cmds = hub.NewCommandHub()
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
	srv := &Server{
		cfg:         cfg,
		Tools:       deps.Tools,
		Work:        deps.Work,
		Commands:    cmds,
		Focus:       hub.NewFocusRegistry(),
		Settings:    settings,
		WhoAmI:      deps.WhoAmI,
		ToolIO:      deps.ToolIO,
		WorkIndex:   deps.WorkIndex,
		Stats:       deps.Stats,
		AttnTracker: deps.AttnTracker,
		Runs:        deps.Runs,
		Worktrees:   deps.Worktrees,
		Git:         deps.Git,
		started:     time.Now(),
	}
	runWorktreeRoot := ""
	if deps.Worktrees != nil {
		runWorktreeRoot = deps.Worktrees.Root()
	}
	// FR-EDT-116(D-17): RepoRoot 를 주입한다 — 이렇게 해야 httpapi 가 gitapi 를
	// import 하지 않고도 "Editor 루트가 저장소의 루트인가"를 판정한다. Git 이
	// 없으면 그 연동만 서지 않고 Editor 목록 자체는 그대로 돈다.
	var repoRoot wsentry.RepoRootFn
	if deps.Git != nil {
		repoRoot = deps.Git.RepoRoot
	}
	srv.Entries = &wsentry.Store{Work: deps.Work, Commands: cmds, RepoRoot: repoRoot}
	srv.git = &gitapi.GitServer{
		Git:             deps.Git,
		Work:            deps.Work,
		Commands:        cmds,
		Tools:           deps.Tools,
		UserWorktrees:   deps.UserWorktrees,
		RunWorktreeRoot: runWorktreeRoot,
	}
	return srv, nil
}

// Handler returns the top-level http.Handler.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	if s.cfg.StaticFS != nil {
		// 정적 자산에는 내용 기반 ETag 를 붙인다 — go:embed 파일은 ModTime 이 zero 라
		// FileServer 만으로는 검증자가 하나도 없다 (static.go).
		mux.Handle("/", newStaticHandler(s.cfg.StaticFS))
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
