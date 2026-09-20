// Package httpapi owns the HTTP/MCP endpoints and subsystem managers. A
// *Server value aggregates the per-instance state (tool registry, workspace
// store, MCP session registry, tool registry) so that two independent servers
// can coexist in a single process (tests, embedded scenarios).
package httpapi

import (
	"dongminal/internal/webserver/gitapi"

	"dongminal/internal/webserver/hub"

	"context"
	"io/fs"
	"net/http"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"dongminal/internal/webserver/domain/ext"
	"dongminal/internal/webserver/domain/git/store"
	"dongminal/internal/webserver/domain/submodule"
	"dongminal/internal/webserver/domain/wsentry"

	"dongminal/internal/webserver/domain/git/core"
)

// Config carries process-level knobs.
type Config struct {
	Port     string
	DataDir  string
	StaticFS fs.FS
	// AllowedHosts 는 `--allowed-host` 로 명시 추가한 이름들이다
	// (REQUEST_GATE_SRS FR-RQG-6). `*.ts.net` 처럼 접미사 와일드카드를 쓸 수 있다.
	//
	// 기본 허용 집합(loopback·이 기계의 인터페이스 주소·호스트명·ACL 의 호스트명
	// 항목)은 서버가 스스로 유도하므로 대개 비어 있다. 오버레이 망의 이름으로
	// 붙는 배치에서만 필요하다.
	AllowedHosts []string
	// Version 은 이 서버 바이너리의 판이다 (VERSION_HEALTH_SRS FR-VHL-10).
	//
	// **주입받는다.** 판의 단일 출처는 `internal/ctl/cli.Version` 이고(빌드 때
	// ldflags 로 새겨진다) 이 층이 그것을 import 하면 아래에서 위를 본다 —
	// 데몬이 `SetBuildVersion` 으로 받는 것과 같은 근거다.
	//
	// 비어 있으면 헬스의 `version` 이 빈 값이고, 그때 데몬과의 비교는 **불일치가
	// 아니다** (FR-VHL-11 — 모르는 것을 다르다고 읽지 않는다).
	Version string
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
	// Seats 는 도구마다 **답장을 보낼 연결 하나**를 정한다
	// (TERM_REPLY_SEAT_SRS FR-RPS-1). `Focus` 와 같은 성질이다 — 서버가 권위로
	// 들고, 재시작하면 모두 풀린다. 두 배선(direct·daemon)이 이 자리 하나를
	// 함께 쓴다: PTY 가 어느 프로세스에 있든 **WS 연결은 언제나 여기 있다**
	// (FR-RPS-2).
	Seats *hub.ReplySeats
	// Entries 는 workspace.json 최상위의 두 목록 — git.pinned[] 와 editors.list[] —
	// 을 함께 소유한다 (EDITOR_TAB_SRS FR-EDT-116). /api/editors/* 와 /api/fs/* 의
	// 루트 가드가 이것을 읽는다 (FR-EDT-113). Work 가 nil 이면 그 종단만 실패한다.
	Entries *wsentry.Store

	// git 은 /api/git/* 을 소유한다. **Git 이 nil 이어도 이 자리는 만들어진다** —
	// `UserWorktrees` 만 있는 배선에서도 Worktrees 탭이 답해야 하기 때문이다.
	// 그래서 `Git == nil` 은 라우팅 miss 가 아니라 핸들러 안의 503 으로 걸린다
	// (gitapi.gitResolveRepo, FR-GIT-60 · FR-DPN-24).
	git *gitapi.GitServer

	// gitWatch 는 저장소 signature 를 감시해 `git_changed` 를 방송한다
	// (GIT_PUSH_OBSERVE_SRS). `Git` 이 nil 이면 이 자리도 nil 이고, 그때
	// `GitServer.Watch` 가 nil 이라 표명이 무해하게 지나간다.
	gitWatch *hub.GitWatcher

	// Access 는 접속 허용 목록이다 (ACCESS_ALLOWLIST_SRS). nil 이 아니면 게이트가
	// 모든 표면 앞에 선다. `--expose` 뒤에 아무 제어가 없던 자리를 여기가 메운다.
	Access *accessStore

	// hosts 는 `Host`·`Origin` 판정의 허용 집합이다 (REQUEST_GATE_SRS FR-RQG-6).
	// `Access` 의 `self` 를 읽으므로 그 뒤에 만들어진다.
	hosts *hostAllow

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

	// limits 는 요청 상한과 유예다 (M8 `GO-9`). 종전에는 패키지 전역이라 "두
	// 서버가 한 프로세스에 공존한다" 는 이 파일 머리말의 계약을 깼고, 테스트가
	// 전역을 낮추면 같은 프로세스의 다른 서버까지 낮아졌다. `New` 가 기본값을
	// 채우고 시험만이 서버 하나의 값을 낮춘다.
	limits serverLimits

	// fsOps 는 탐색기의 파일 조작을 직렬화한다 (FR-EDT-115). 잡는 구간은
	// **실제 파일 조작**뿐이다 — 본문 읽기와 경로 판정은 밖에서 한다.
	fsOps sync.Mutex

	// contextNotices 는 이미 보낸 컨텍스트 통지를 기억한다 (FR-CBG-7). 서버
	// 수명이지 프로세스 수명이 아니다.
	contextNotices contextNoticeLog

	// agentSessions 는 **도구 단위** 세션 신원이다 (M9_SRS FR-M9-32 / M9-B15).
	//
	// Run 의 것(`ContextState.SessionID`)과 **따로 사는 이유**: 활동 훅은 Run 과
	// 무관한 에이전트 전부에서 돈다(dongminal 셸이 `claude` 를 래핑하므로 사용자가
	// 손으로 띄운 탭도 포함이다). 종전에는 그 신원이 `ObserveContext` 에서
	// `found=false` 로 버려졌고, 그래서 `FR-AGT-10` 의 반대 방향이 설 자리가 없었다.
	//
	// `AttnTracker` 에 두지 않는 이유는 그것이 **daemon 모드 전용**이라서다 —
	// 모드에 따라 신원이 사라지면 그 위에 선 기능이 모드에 따라 사라진다.
	//
	// 서버 수명이다. 프로세스가 다시 서면 비지만, 훅이 다음 보고에서 다시 채운다 —
	// 그 사이는 "모른다" 이고 그때 진입점은 서지 않는다 (FR-M9-33 의 DoD).
	agentSessions sync.Map // toolID → *AgentSessionInfo
}

// serverLimits 는 서버 하나의 상한·유예다. const 가 아닌 것은 테스트가 낮춰
// 잡기 위해서다 — 실제 값으로 픽스처를 만들면 테스트가 파일시스템을 만든다.
type serverLimits struct {
	// fsList·fsDelete·fsCopy — FS_LIST_MAX·FS_DELETE_MAX (FR-EDT-65·118), 복사는
	// 같은 규약이다 (FR-WBR-66): 먼저 세고, 넘으면 시작하지 않는다.
	fsList   int
	fsDelete int
	fsCopy   int
	// uploadMaxBytes 는 업로드 본문의 상한이다 (FR-FTR-5, D-6).
	uploadMaxBytes int64
	// toolKillGrace 는 SIGTERM 과 SIGKILL 사이의 유예다 (FR-BGK-7).
	toolKillGrace time.Duration
}

func defaultLimits() serverLimits {
	return serverLimits{
		fsList:         10000,
		fsDelete:       10000,
		fsCopy:         10000,
		uploadMaxBytes: 512 << 20,
		toolKillGrace:  3 * time.Second,
	}
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
	accessPath := "access.json"
	if cfg.DataDir != "" {
		accessPath = filepath.Join(cfg.DataDir, "access.json")
	}
	access := newAccessStore(accessPath)
	// 부팅 시 1회 — 자기 인터페이스 주소를 모른 채로 서면 자기 이름으로 붙는
	// 첫 요청이 막힌다 (FR-ACL-5a).
	access.refresh()
	srv := &Server{
		Deps:    deps,
		cfg:     cfg,
		Focus:   hub.NewFocusRegistry(),
		Seats:   hub.NewReplySeats(),
		Access:  access,
		started: time.Now(),
		limits:  defaultLimits(),
	}
	// REQUEST_GATE_SRS FR-RQG-6: 허용 호스트 집합은 `access.self` 를 읽으므로
	// 그 뒤에 선다. 새 수집 코드를 만들지 않는 것이 이 설계의 요점이다.
	srv.hosts = newHostAllow(access, cfg.AllowedHosts)
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
	// FR-EXT-9b: 플러그인 선언의 자리. 칸 이름은 `ext` 가 정한다 — 여기서 따로
	// 적으면 탐색기가 보는 곳과 조달이 쓰는 곳이 갈린다.
	pluginsDir := ""
	if cfg.DataDir != "" {
		pluginsDir = ext.PluginsDir(ext.RootIn(cfg.DataDir))
	}
	srv.Entries = &wsentry.Store{
		Work: deps.Work, Commands: cmds, RepoRoot: repoRoot,
		NotesDir: notesDir, PluginsDir: pluginsDir,
	}
	// GIT_PUSH_OBSERVE_SRS: signature 감시자. 저장소 계층이 없으면 서지 않는다 —
	// 감시할 대상이 없고, 그때 `GitServer.Watch` 는 nil 이라 표명이 무해하게
	// 지나간다.
	if deps.Git != nil {
		srv.gitWatch = hub.NewGitWatcher(deps.Git, cmds)
	}
	srv.git = &gitapi.GitServer{
		Git:      deps.Git,
		Work:     deps.Work,
		Commands: cmds,
		Tools:    deps.Tools,
		Watch:    srv.gitWatch,
		// UX_BATCH5_SRS FR-SUB-1: 서브모듈 Manager 는 **Git 이 있을 때만** 선다.
		// 저장소가 없는 배선에서는 물을 대상이 없고, nil 이면 그 표면이 503 이다
		// (UserWorktrees 와 같은 규약).
		// M9_SRS FR-M9-21 / D-M9-16: **그림 전용 git 실행기.**
		//
		// 공용 `deps.Git` 의 Service 는 출력 상한이 서비스 전체에 하나이고
		// (1MiB, FR-GIT-6) 그것으로는 흔한 스크린샷 하나가 상한에 걸린다.
		// 그림이 지나는 자리만 파일 종단과 **같은 상한**(`fileReadMaxBytes`)을
		// 쓴다 — 두 종단이 같은 그림에 다른 답을 주면 사용자는 어느 쪽이
		// 맞는지 알 수 없다.
		Images:          core.New(core.WithMaxOutput(int(fileReadMaxBytes))),
		Submodules:      submoduleManager(deps.Git),
		UserWorktrees:   deps.UserWorktrees,
		RunWorktreeRoot: runWorktreeRoot,
		// FILE_API_BOUNDARY_SRS 묶음 G 는 **폐기됐다** (2026-09-20, 사용자 결정).
		// `RepoGuard` 를 주입하지 않는다 — nil 이면 제한하지 않는다는 규약이
		// 이미 있으므로(gitapi.go 의 필드 주석) 새 갈래를 만들지 않는다.
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
	// VIEWER_URL_OPEN_SRS FR-VUO-19: 부작용 없는 판정 조회.
	mux.HandleFunc("/api/open-url/where", s.handleOpenURLWhere)
	// 그물이 로깅 **안쪽**에 있어야 한다 (FR-CAF-6). 그래야 패닉으로 끝난
	// 요청도 로그에 남고, 그물이 `responseWriter` 를 보고 "응답이 이미
	// 시작됐는가" 를 판정할 수 있다.
	// 게이트는 로깅 **안쪽**, recover **바깥쪽**이다 (FR-ACL-10): 거절이 접근
	// 로그에 남아야 하고, mux 바깥이라야 정적 자산·/api/*·/ws 가 한 겹에 덮인다.
	//
	// REQUEST_GATE_SRS FR-RQG-1(개정): 게이트가 **둘**이고 직렬이다.
	//
	//	accessGate   어느 기기인가   (출발지 IP)
	//	requestGate  어느 출처인가   (Origin·Host·Sec-Fetch·Content-Type)
	//
	// **"누구인가" 를 묻는 게이트는 없다.** 이 제품은 인증을 지원하지 않는다
	// (로드맵 결정 9) — 접근 통제는 오버레이 망(Tailscale)과 이 두 게이트가
	// 맡고, 그 보증 범위는 보안 경계 문서가 적는다. 종전에 여기 있던 빈
	// `authGate` 는 그 결정으로 **제거됐다**. 영구 폐기된 기능의 자리를 남겨 두면
	// 그것이 곧 "예정" 으로 읽힌다.
	//
	// 순서가 계약이다. ACL 이 1차 필터로 먼저 서고, 출처 판정이 그 안에서
	// 브라우저 매개 요청을 가른다 — ACL 은 그것을 가르지 못한다(출발지가 사용자
	// 자신의 기기다).
	//
	// OBSERVABILITY_SRS 묶음 R: **요청 ID 가 맨 바깥이다.** 로깅보다 앞에 서야
	// 접근 로그가 그 ID 를 실을 수 있고, 게이트보다 앞에 서야 **거절된 요청에도**
	// ID 가 있다 (D-OBS-2) — 거절이야말로 사용자가 묻는 자리다.
	return reqIDMiddleware(loggingMiddlewareFor(s, accessGate(s.Access,
		requestGate(s.hosts, recoverMiddleware(mux)))))
}

// Run starts the HTTP server on addr and blocks until ctx is cancelled.
// ShutdownGrace 는 종료 시 진행 중인 요청에 주는 시간이다.
//
// 짧은 이유는 오래 사는 연결이 있기 때문이다 — SSE·WebSocket·대기 종단(최대
// 30분)이 `Shutdown` 을 그 수명만큼 붙든다. 그 둘을 다 만족시키는 값은 없으므로,
// **진행 중인 짧은 요청을 지키는 데까지만** 준다.
const ShutdownGrace = 2 * time.Second

func (s *Server) Run(ctx context.Context, addr string) error {
	srv := &http.Server{
		Addr:    addr,
		Handler: s.Handler(),
		// REQUEST_GATE_SRS FR-RQG-18: 타임아웃이 하나도 없었다.
		//
		// 헤더를 천천히 보내는 연결(slowloris)이 fd 와 goroutine 을 무기한
		// 점유했고, keep-alive 유휴 연결도 회수되지 않았다.
		//
		// **`ReadTimeout`·`WriteTimeout` 은 두지 않는다.** 전역으로 걸면 SSE
		// (`handleCommandSSE`)·WebSocket·대기 종단(`handlers_status.go`, 최대
		// 30분)이 그 시각에 끊긴다. 그 셋은 오래 사는 것이 설계다. 핸들러별
		// 마감이 필요하면 `http.ResponseController` 가 그 자리다.
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

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
		// FR-RQG-19: **먼저 정중하게, 그다음 끊는다.**
		//
		// 종전에는 곧바로 `Close()` 였다. 그 이유("브라우저가 끊김을 즉시 알게
		// 한다")는 유효하지만, 진행 중인 응답을 쓰는 도중에 끊으면 사용자의
		// 저장이 반만 나간다 — 워크스페이스 PUT 이 그 자리다.
		//
		// `ShutdownGrace` 가 짧아서 즉시성은 사실상 유지된다: 짧은 요청은 그
		// 안에 끝나고, 오래 사는 SSE·WS 는 뒤따르는 `Close()` 가 끊는다.
		grace, cancel := context.WithTimeout(context.Background(), ShutdownGrace)
		_ = srv.Shutdown(grace)
		cancel()
		_ = srv.Close()
		return <-errCh
	case err := <-errCh:
		return err
	}
}

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

// submoduleManager 는 서브모듈 조작의 Manager 를 만든다 (UX_BATCH5_SRS FR-SUB-1).
//
// **domain/git 의 화이트리스트를 지나지 않는다.** `git submodule` 이 한 하위
// 명령에 읽기와 쓰기를 함께 갖기 때문이며, 그것이 이 도메인이 따로 있는 이유
// 전부다 (D-9 정정). worktree Manager 와 같은 모양이다.
//
// **그러나 실행 방법은 함께 쓴다** (GIT_EXEC_UNIFY_SRS FR-GXU-10) — 화이트리스트를
// 지나지 않는 것과 git 을 직접 띄우는 것은 다른 문장이다. `RunnerFor` 가 core 의
// 실행 층으로 보내므로 환경·마감·출력 상한·오류 분류·기록이 한 벌이 된다.
func submoduleManager(git *store.Store) *submodule.Manager {
	if git == nil {
		return nil
	}
	return submodule.New(submodule.RunnerFor(git.Service()))
}

// StartGitWatch 는 signature 감시 회차를 돌린다 (GIT_PUSH_OBSERVE_SRS FR-GPO-13).
//
// `StartRunReaper` 와 같은 형태로 합성 루트가 부른다. 감시자가 없으면(저장소
// 계층이 없는 배선) 아무 일도 하지 않는다.
func (s *Server) StartGitWatch(stop <-chan struct{}) {
	hub.StartGitWatch(s.gitWatch, stop)
}
