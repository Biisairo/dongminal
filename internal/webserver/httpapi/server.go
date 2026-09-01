// Package httpapi owns the HTTP/MCP endpoints and subsystem managers. A
// *Server value aggregates the per-instance state (tool registry, workspace
// store, MCP session registry, tool registry) so that two independent servers
// can coexist in a single process (tests, embedded scenarios).
package httpapi

import (
	"dongminal/internal/webserver/gitapi"

	"dongminal/internal/webserver/hub"

	"bufio"
	"context"
	"dongminal/internal/webserver/domain/wsentry"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"
)

// Config carries process-level knobs.
type Config struct {
	Port     string
	DataDir  string
	StaticFS fs.FS
}

// Server owns the HTTP server lifecycle.
//
// **주입 표면은 Deps 하나다** (DEEPENING_REFACTOR_SRS 묶음 E). 이전에는 같은
// 필드 14개가 `Deps` 와 `Server` 에 각각 선언되고 `New` 가 한 줄씩 옮겼다 —
// 필드를 하나 더할 때 **세 자리**를 고쳐야 했고, `New` 에서 빠뜨리면 컴파일이
// 통과하면서 조용히 nil 이 됐다. 임베딩이 그 세 자리를 하나로 만든다.
//
// 대가는 테스트 리터럴이 한 겹 길어지는 것이다 (`&Server{Deps: Deps{Tools: m}}`).
// 필드 추가 지점이 셋에서 하나로 줄는 것과 교환한다 (FR-DPN-52).
type Server struct {
	Deps

	cfg Config
	// Focus holds window→client ownership (FR-XDF-1). in-memory only.
	Focus *hub.FocusRegistry
	// Entries 는 workspace.json 최상위의 두 목록 — git.pinned[] 와 editors.list[] —
	// 을 함께 소유한다 (EDITOR_TAB_SRS FR-EDT-116). /api/editors/* 와 /api/fs/* 의
	// 루트 가드가 이것을 읽는다 (FR-EDT-113). Work 가 nil 이면 그 종단만 실패한다.
	Entries *wsentry.Store

	// git 은 /api/git/* 을 소유한다. **Git 이 nil 이어도 이 자리는 만들어진다** —
	// `UserWorktrees` 만 있는 배선에서도 Worktrees 탭이 답해야 하기 때문이다.
	// 그래서 `Git == nil` 은 라우팅 miss 가 아니라 핸들러 안의 503 으로 걸린다
	// (gitapi.gitResolveRepo, FR-GIT-60 · FR-DPN-24).
	git *gitapi.GitServer

	started time.Time

	// misses 는 "없는 도구를 향한 WebSocket 요청"의 되풀이를 센다
	// (RECONNECT_STORM_SRS FR-RCS-9). 제로값이 곧 빈 추적기라 New 가 세우지 않는다.
	misses missTracker

	// holds 는 지금 **붙잡고 있는** 미스 연결의 수다
	// (CONNECTIVITY_RESILIENCE_SRS FR-CNR-2·4). 소켓을 닫지 않는 것이 재연결의
	// 고리를 끊는 유일한 수단이므로(D-2), 그 대가인 열린 연결 수에 상한이 있어야
	// 한다.
	holds atomic.Int64

	// lastReq·lastWS 는 마지막 요청·WS 연결의 단조 시각(나노초)이다
	// (FR-CNR-8·11). **핫패스 필터로 로그에서 빠지는 요청도 여기는 갱신한다** —
	// 로그에 안 남는 것과 오지 않은 것은 다르며, 그 차이가 진단의 전부다.
	lastReq atomic.Int64
	lastWS  atomic.Int64

	// wsOpen 은 지금 붙어 있는 WebSocket 수다 (FR-CNR-8). 붙잡힌 연결도 여기
	// 포함된다 — 그것이 자원을 쓰고 있다는 사실이 진단에 실려야 한다.
	wsOpen atomic.Int64
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
	// 기본값 주입은 여기 남는다 — 그것이 `Deps` 가 통과 모듈이 아닌 이유다
	// (FR-DPN-51). 나머지 필드는 임베딩이 그대로 옮긴다: 여기에 한 줄씩 적지
	// 않으므로 새 필드를 빠뜨릴 자리가 없다.
	deps.Commands = cmds
	deps.Settings = settings
	srv := &Server{
		Deps:    deps,
		cfg:     cfg,
		Focus:   hub.NewFocusRegistry(),
		started: time.Now(),
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
	return loggingMiddlewareFor(s, mux)
}

// Run starts the HTTP server on addr and blocks until ctx is cancelled.
func (s *Server) Run(ctx context.Context, addr string) error {
	srv := &http.Server{Addr: addr, Handler: s.Handler()}

	// FR-CNR-8·12: 끊긴 순간이 기록에 남게 한다. 서버 수명과 함께 시작하고
	// 끝난다 — 지금은 "끊겼다" 는 사실 자체가 아무 데도 남지 않는다 (§2.3).
	diagCtx, stopDiag := context.WithCancel(ctx)
	defer stopDiag()
	go s.runDiagSnapshots(diagCtx, DiagSnapshotEvery)

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
	return loggingMiddlewareFor(nil, next)
}

// loggingMiddlewareFor 는 로그와 함께 **마지막 요청 시각**을 새긴다
// (FR-CNR-11). srv 가 nil 이면 새기지 않는다 — 서버 없이 쓰는 테스트가 있다.
//
// 새기는 자리가 `shouldLogRequest` **바깥**인 것이 요점이다. 핫패스 필터로
// 로그에서 빠지는 `/api/ping` 도 "요청이 왔다" 는 사실은 같으며, 진단이 가르려는
// 것이 정확히 그 사실이다 (§2.3).
func loggingMiddlewareFor(srv *Server, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		if srv != nil {
			srv.lastReq.Store(start.UnixNano())
		}
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
