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
	"runtime/debug"
	"strings"
	"sync"
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

	// assetVer 는 지금 서빙하는 자산의 판이다
	// (ASSET_VERSION_SINGLE_SOURCE_SRS FR-AVS-1·3). 서빙하는 `index.html` 의
	// 자리표시자를 채우고, SSE 를 여는 화면에게 인사로 건넨다 — 두 곳이 같은 값을
	// 받는다. 자산은 바이너리에 박혀 있어 프로세스가 사는 동안 바뀌지 않으므로
	// 한 번만 계산한다 (FR-AVS-2).
	assetVerOnce sync.Once
	assetVer     string

	// helloEvery 는 SSE 인사의 주기다 (FR-RLC-20a). 제로값이면 기본값을 쓴다 —
	// 시험만이 이 값을 줄인다.
	helloEvery time.Duration
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
	// FR-NOT-1: 메모 루트는 `worktrees`·`git-worktrees` 와 같은 규약으로
	// $DONGMINAL_HOME 아래에 선다. DataDir 이 비면 자리가 없다는 뜻이므로
	// NotesDir 도 비고, 그것이 곧 FR-NOT-11 의 "메모장 표면이 없다" 이다.
	notesDir := ""
	if cfg.DataDir != "" {
		notesDir = filepath.Join(cfg.DataDir, "notes")
	}
	srv.Entries = &wsentry.Store{
		Work: deps.Work, Commands: cmds, RepoRoot: repoRoot, NotesDir: notesDir,
	}
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
		mux.Handle("/", newStaticHandler(s.cfg.StaticFS, s.assetVersion()))
	}
	mux.HandleFunc("/ws", s.handleWS)
	mux.HandleFunc("/api/", s.handleAPI)
	mux.HandleFunc("/api/commands", s.handleCommandPost)
	mux.HandleFunc("/api/commands/sse", s.handleCommandSSE)
	mux.HandleFunc("/api/command-result", s.handleCommandResult)
	// 그물이 로깅 **안쪽**에 있어야 한다 (FR-CAF-6). 그래야 패닉으로 끝난
	// 요청도 로그에 남고, 그물이 `responseWriter` 를 보고 "응답이 이미
	// 시작됐는가" 를 판정할 수 있다.
	return loggingMiddlewareFor(s, recoverMiddleware(mux))
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

// --- HTTP recover middleware ------------------------------------------------

// recoverMiddleware 는 핸들러의 패닉을 500 으로 바꾸고 스택과 함께 남긴다
// (FR-CAF-5).
//
// **왜 필요한가.** `net/http` 는 패닉을 잡아 그 연결만 끊는다. 서버는 살아남지만
// 브라우저는 아무 응답도 받지 못하고, 남는 것은 스택뿐이다 — 사용자에게는
// "한번씩 안 된다" 로 보인다. WS 경로는 이미 recover 를 쓰고 있었고
// (handlers_ws.go:229·299) HTTP 경로에만 그물이 없었다.
//
// 두 가지를 하지 않는다:
//
//	① 이미 시작된 응답의 헤더를 건드리지 않는다 (FR-CAF-6). SSE·WS 가 그 처지다.
//	② `http.ErrAbortHandler` 를 삼키지 않는다 (FR-CAF-7). 그것은 패닉의 모양을
//	   빌린 약속된 값이며, 뜻은 "조용히 끊어라" 다.
func recoverMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			v := recover()
			if v == nil {
				return
			}
			if v == http.ErrAbortHandler {
				panic(v)
			}
			log.Printf("http panic %s %s: %v\n%s", r.Method, r.URL.Path, v, debug.Stack())
			if rw, ok := w.(*responseWriter); ok && rw.wrote {
				return
			}
			http.Error(w, "internal error", http.StatusInternalServerError)
		}()
		next.ServeHTTP(w, r)
	})
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
	// wrote 는 **응답이 이미 시작됐는가** 다. 그물(recoverMiddleware)이 이것을
	// 읽는다 — 헤더가 나간 뒤의 패닉에 500 을 덧쓰면 상태가 뒤집히거나
	// `superfluous WriteHeader` 만 남는다 (FR-CAF-6). SSE 와 하이재킹된 WS 가
	// 정확히 그 처지다.
	wrote bool
}

func (rw *responseWriter) WriteHeader(status int) {
	if rw.wrote {
		return
	}
	rw.wrote = true
	rw.status = status
	rw.ResponseWriter.WriteHeader(status)
}

// Write 는 헤더를 명시적으로 쓰지 않고 본문부터 내보내는 핸들러를 위한 것이다 —
// 그 경우에도 응답은 시작된 것이며(net/http 가 200 을 먼저 보낸다), 그물은 그
// 사실을 알아야 한다.
func (rw *responseWriter) Write(b []byte) (int, error) {
	rw.wrote = true
	return rw.ResponseWriter.Write(b)
}

func (rw *responseWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	if h, ok := rw.ResponseWriter.(http.Hijacker); ok {
		// 하이재킹된 뒤로 이 ResponseWriter 는 쓸 수 없다. 그물이 여기에
		// 헤더를 쓰면 패닉이 하나 더 난다.
		rw.wrote = true
		return h.Hijack()
	}
	return nil, nil, fmt.Errorf("ResponseWriter does not implement http.Hijacker")
}

func (rw *responseWriter) Flush() {
	if f, ok := rw.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// assetVersion 은 지금 서빙하는 자산의 판을 준다. 모르면 빈 문자열이다.
//
// ASSET_VERSION_SINGLE_SOURCE_SRS FR-AVS-3: 판을 아는 자리는 **하나**다. 문서에 넣는
// 값과 인사에 싣는 값이 여기서 함께 나온다.
//
// 종전에는 서빙되는 `index.html` 을 되읽어 `?v=` 를 정규식으로 긁었다. 그때는 문서가
// 판을 손으로 적었고, 손으로 적은 상수와 갈라지는 것을 막을 길이 그것뿐이었다
// (RELOAD_CONTINUITY_SRS FR-RLC-21). 이제 문서를 **쓰는 쪽**이 여기이므로 갈릴 수가
// 없다 — 되읽는 것은 같은 값을 두 번 만드는 일이며, 깨질 정규식을 하나 더 두는 것이다.
//
// 판을 모르는 경우는 정적 자산이 아예 없는 구성 하나다 (FR-AVS-10).
func (s *Server) assetVersion() string {
	s.assetVerOnce.Do(func() {
		if s.cfg.StaticFS == nil {
			return
		}
		s.assetVer = computeAssetVersion(s.cfg.StaticFS)
	})
	return s.assetVer
}
