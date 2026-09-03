package main

import (
	"dongminal/internal/webserver/hub"

	"dongminal/internal/shared/sandboxplace"
	"dongminal/internal/shared/toolhub"

	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"time"

	"dongminal/internal/ctl/cli"
	"dongminal/internal/daemon/boot"
	"dongminal/internal/helper/runtimebin"
	"dongminal/internal/shared/dmenv"
	"dongminal/internal/shared/platform"
	"dongminal/internal/shared/runtime"
	"dongminal/internal/shared/uuid"
	"dongminal/internal/shared/workspace"
	"dongminal/internal/webserver/domain/git/core"
	"dongminal/internal/webserver/domain/git/store"
	"dongminal/internal/webserver/domain/run"
	"dongminal/internal/webserver/domain/sysstat"
	"dongminal/internal/webserver/domain/worktree"
	"dongminal/internal/webserver/httpapi"
	"dongminal/internal/webserver/seam/adapters"
	"dongminal/internal/webserver/toolclient"
	"dongminal/web"
)

func dataPath(dataDir, name string) string {
	dir := dataDir
	if dir == "" {
		dir = "."
	}
	return filepath.Join(dir, name)
}

// dialOrStartDaemon connects to a running dongminald or starts one,
// returning a ToolClient ready for use. Falls back to nil if the daemon
// is not available and the direct ToolManager path should be used.
//
// Goroutine lifecycle: DialPaneClientWithReconnect spawns a supervise()
// goroutine that watches for connection loss and reconnects with backoff.
// When the caller is done with the ToolClient, it MUST call Close(), which
// closes pc.closed and sets pc.stopped. Both the outer and inner reconnect
// loops in supervise() check <-pc.closed and pc.stopped in their select
// statements, ensuring the goroutine exits promptly. The wrapper goroutine
// here (lines 50-53) is fire-and-forget: it writes its result to a buffered
// channel and exits, regardless of whether the outer select consumes it.
func dialOrStartDaemon(home string) *toolclient.ToolClient {
	// 종단 주소는 platform 이 만든다 — 데몬(boot.Run)이 listen 하는 주소와 같은
	// 함수에서 나와야 표현이 바뀌어도 양쪽이 함께 옮겨간다 (FR-XIP-1).
	endpoint := platform.Current().IPC.Endpoint(home)

	// spawn is handed to the reconnect supervisor so it can respawn dongminald
	// if it dies while we are running (FR-13).
	spawn := func() error { return startDaemon(home) }

	// Try connecting. DialToolClient sends hello and waits for response.
	// If the old dongminal is still shutting down, this blocks until
	// dongminald processes the new connection. Add a timeout via goroutine.
	type result struct {
		pc  *toolclient.ToolClient
		err error
	}
	ch := make(chan result, 1)
	go func() {
		pc, err := toolclient.DialPaneClientWithReconnect(endpoint, spawn)
		ch <- result{pc, err}
	}()

	select {
	case r := <-ch:
		if r.err == nil {
			log.Printf("connected to dongminald at %s", endpoint)
			return r.pc
		}
		// Connection failed (e.g. socket doesn't exist). Start fresh daemon.
	case <-time.After(3 * time.Second):
		// Daemon is busy with old connection. Wait for the goroutine to finish.
		log.Printf("dongminald busy, waiting for old connection to clear...")
		r := <-ch
		if r.err == nil {
			log.Printf("connected to dongminald (after waiting)")
			return r.pc
		}
	}

	// Daemon not running or not reachable. Start it.
	log.Printf("dongminald not reachable, starting...")
	if err := startDaemon(home); err != nil {
		log.Printf("failed to start dongminald: %v (falling back to direct mode)", err)
		return nil
	}

	// Wait for daemon socket to appear
	for i := 0; i < 20; i++ {
		time.Sleep(100 * time.Millisecond)
		pc, err := toolclient.DialPaneClientWithReconnect(endpoint, spawn)
		if err == nil {
			log.Printf("connected to newly started dongminald")
			return pc
		}
	}
	log.Printf("dongminald did not become ready (falling back to direct mode)")
	return nil
}

// startDaemon spawns dongminald as a fully detached child process.
func startDaemon(home string) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	cmd := exec.Command(exe, "d")
	cmd.Env = append(os.Environ(), "DONGMINAL_HOME="+home)
	// Detach from parent: dongminald survives dongminal restart.
	platform.Current().Process.Detach(cmd)
	// Redirect output to log file so terminal stays clean.
	logPath := filepath.Join(home, "daemon.log")
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err == nil {
		cmd.Stdout = logFile
		cmd.Stderr = logFile
		defer logFile.Close()
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	log.Printf("dongminald started pid=%d log=%s", cmd.Process.Pid, logPath)
	// Release the process; dongminald outlives us.
	return nil
}

type builtDeps struct {
	deps        httpapi.Deps
	pm          *toolhub.ToolManager
	attnTracker *hub.AttnTracker
	sampler     *sysstat.Sampler
	wsMgr       *workspace.Manager
}

// restoreHeadlessBackground puts the restored headless tools back into the
// background registry (FR-HLM-3).
//
// LoadAll 은 도구를 되살리기만 한다. 백그라운드 등록은 런타임 상태라 tools.json
// 에 없으므로 여기서 되돌려야 한다 — 등록하지 않으면 탭에도 ⏻ 목록에도 없는,
// 어디서도 닿을 수 없는 도구가 된다 (FR-BGR-5 와 같은 이유).
//
// **되살아난 것은 빈 셸이다.** 그 안에서 돌던 에이전트는 돌아오지 않는다. 그럼에도
// 되살리는 이유는 소유자 때문이다 — Run 은 재시작으로 aborted 가 되고(FR-RUN-5),
// 그 도구는 FR-HLM-5 의 고아로 run status 에 나타나 run close 로 거둬진다.
// 기재하지 않으면 거둘 대상조차 사라진다.
func restoreHeadlessBackground(pm *toolhub.ToolManager, headless map[string]struct{}) {
	restored := 0
	for id := range headless {
		if pm.SetBackground(id, true) {
			restored++
		}
	}
	if restored > 0 {
		log.Printf("[run] 헤드리스 도구 %d개를 백그라운드로 복원", restored)
	}
}

// wireSandbox 는 샌드박스 배치를 꽂는다 (SANDBOX_WINDOW_SRS FR-SBX-10).
//
// 런타임을 찾지 못하면 **꽂지 않고 nil 을 낸다.** 그 상태에서 샌드박스 창의
// 도구를 만들면 ToolManager 가 명확한 오류로 실패시킨다 — 호스트 셸로 조용히
// 내려가지 않는 것이 이 기능의 안전 요구다 (FR-SBX-21). 런타임이 없어도 나머지
// 기능은 영향받지 않는다 (NFR-SBX-3).
func wireSandbox(pm *toolhub.ToolManager, cfg httpapi.Config) *sandboxplace.Placer {
	pl := sandboxplace.Wire(cfg.DataDir, cli.Version, cfg.Port)
	if pl == nil {
		return nil
	}
	pm.SetPlacer(pl.Place)
	return pl
}

// liveWindowUUIDs 는 회수에 넘길 살아 있는 Window 목록이다. nil 은 그대로
// 옮긴다 — "판단 근거 없음" 이 회수 쪽에서 구분되어야 한다 (FR-SBX-9).
func liveWindowUUIDs(ws []workspace.WindowInfo) []string {
	if ws == nil {
		return nil
	}
	out := make([]string, 0, len(ws))
	for _, w := range ws {
		out = append(out, w.UUID)
	}
	return out
}

func buildDeps(cfg httpapi.Config) (builtDeps, error) {
	pm := toolhub.NewToolManager(cfg.DataDir, nil)
	placer := wireSandbox(pm, cfg)
	cmdHub := hub.NewCommandHub()
	// Wire attention SSE before LoadAll so restored tools also get detection.
	hub.WireAttention(pm, cmdHub)
	hub.WireActivity(pm, cmdHub)
	// CONVENIENCE_SRS FR-TAN-7: direct 모드는 PTY 를 자기가 들고 있으므로 전경
	// 조회도 여기서 일어난다. 데몬 모드의 짝은 serve() 의 OnForeground 다.
	hub.WireForeground(pm, cmdHub)

	// FR-HLM-3: 지난 세대의 헤드리스 도구를 **펜싱 전에** 읽는다. buildCommonDeps
	// 안의 runStore.Load 가 열린 Run 을 aborted 로 확정하므로(FR-RUN-5), 그 뒤에
	// 물으면 되살릴 대상이 하나도 남지 않는다.
	headless := run.HeadlessToolIDs(cfg.DataDir)

	bd, err := buildCommonDeps(cfg, pm, cmdHub, nil)
	if err != nil {
		return builtDeps{}, err
	}

	pm.SetInvalidator(bd.wsMgr.InvalidateTool)
	// 소유 판별을 꽂아야 SaveAll 이 헤드리스 도구를 기재한다 (FR-HLM-3). 이것이
	// 없으면 FR-BG-9 의 제외 규칙이 그대로 적용돼 다음 부팅에 되살릴 것이 없다.
	pm.SetOwnedTools(func() map[string]struct{} { return run.HeadlessToolIDs(cfg.DataDir) })
	refs, err := workspace.ReferencedToolIDs(bd.wsMgr.Raw())
	if err != nil {
		return builtDeps{}, fmt.Errorf("workspace 참조 해석: %w", err)
	}
	for id := range headless {
		refs[id] = struct{}{}
	}
	pm.LoadAll(refs)
	restoreHeadlessBackground(pm, headless)
	bd.pm = pm

	// 부팅 시 고아 회수 (FR-SBX-8). 지난 세대가 남긴 컨테이너 중 이제 없는
	// Window 의 것을 치운다.
	if placer != nil {
		bd.deps.Sandbox = placer
		placer.Reap(liveWindowUUIDs(bd.wsMgr.Windows()))
	}

	return bd, nil
}

// buildDepsWithHub is the daemon-mode variant that uses a ToolHub (ToolClient)
// instead of a direct ToolManager. Attention/activity are not wired here
// because in daemon mode they are driven by output push events from dongminald.
func buildDepsWithHub(cfg httpapi.Config, toolHub toolhub.ToolHub) (builtDeps, error) {
	cmdHub := hub.NewCommandHub()
	// 배치는 데몬이 한다(boot.Run). 여기서는 회수만 맡는다 — 회수는 workspace 를
	// 봐야 하고 그 주인은 웹서버 프로세스다 (FR-SBX-9).
	reaper := sandboxplace.Wire(cfg.DataDir, cli.Version, cfg.Port)

	// Attention/activity tracker for daemon mode (in-memory in dongminal).
	// L1 OSC detection works from terminal escape sequences. L2 idle detection
	// uses the busy RPC to dongminald to check foreground process status, so a
	// bare prompt does not raise a bogus alarm (FR-15).
	attnTracker := hub.NewAttnTracker(cmdHub, hub.DefaultIdleMS())
	if bp, ok := toolHub.(interface{ Busy(string) bool }); ok {
		attnTracker.SetBusyProbe(bp.Busy)
	}
	// FR-ATL-6: 종료 통지를 놓쳐도 죽은 도구의 알람이 복원되지 않게 한다.
	if lp, ok := toolHub.(interface{ IsLive(string) bool }); ok {
		attnTracker.SetLiveProbe(lp.IsLive)
	}

	bd, err := buildCommonDeps(cfg, toolHub, cmdHub, attnTracker)
	if err != nil {
		return bd, err
	}
	if reaper != nil {
		bd.deps.Sandbox = reaper
		// 부팅 시 고아 회수 (FR-SBX-8).
		reaper.Reap(liveWindowUUIDs(bd.wsMgr.Windows()))
	}
	return bd, nil
}

// buildCommonDeps wires up the managers shared by both direct and daemon modes.
// toolHub provides Liveness (IsLive) for the workspace manager and ToolHub for
// the tool adapters.
func buildCommonDeps(cfg httpapi.Config, toolHub toolhub.ToolHub, cmdHub *hub.CommandHub, attnTracker *hub.AttnTracker) (builtDeps, error) {

	wsMgr, err := workspace.New(toolHub, workspace.FilePersister{Path: dataPath(cfg.DataDir, "workspace.json")})
	if err != nil {
		return builtDeps{}, err
	}

	var pa adapters.Tool
	var resolver adapters.Client
	if _, ok := toolHub.(*toolhub.ToolManager); ok {
		// Direct mode: use the concrete ToolManager for richer adapter access.
		pa = adapters.Tool{PM: toolHub.(*toolhub.ToolManager)}
		resolver = adapters.Client{PM: toolHub.(*toolhub.ToolManager)}
	} else {
		pa = adapters.Tool{Hub: toolHub}
		resolver = adapters.Client{Hub: toolHub}
	}

	wa := adapters.Workspace{WS: wsMgr}

	// Run 레코드 저장소 (RUN_ORCHESTRATION_SRS 묶음 R). epoch 는 이 기동의
	// 식별자이며, 이전 세대가 열어둔 Run 을 로드 시 aborted 로 확정한다
	// (FR-RUN-5) — 백그라운드 도구가 재기동을 넘지 못하므로(FR-BG-9) 되살릴
	// 실체가 없다. Load 는 파일이 없거나 손상돼도 부팅을 막지 않는다.
	runStore := run.NewStore(cfg.DataDir, uuid.NewString())
	if err := runStore.Load(); err != nil {
		log.Printf("run store load: %v", err)
	}

	// worktree 격리의 관리자 (묶음 W). 자기 영역은 $DONGMINAL_HOME/worktrees
	// 아래뿐이고, 정리 대상은 Run 레코드가 정한다 (FR-WKT-9/10). 격리를 쓰지
	// 않는 Run 은 이 객체를 건드리지 않는다.
	worktrees := worktree.New(dataPath(cfg.DataDir, "worktrees"))

	// Git 창 Worktrees 탭의 사용자 worktree 관리자 (FR-WKT-13) — 위 worktrees 와는
	// 별개의 Manager 인스턴스이며 root 만 형제(git-worktrees)다. checkPath 가 서로의
	// root 밖을 거부하므로 이 둘이 갈라진 것만으로 Run 정리가 사용자 worktree 를
	// 건드리지 않는다는 것이 구조적으로 보장된다 — 그 사실이 I7 안전의 전부다.
	userWorktrees := worktree.New(dataPath(cfg.DataDir, "git-worktrees"))

	// 상태바 지표 샘플러. 커널을 주기적으로 읽어 스냅샷을 유지하므로 /api/stats 가
	// 요청 경로에서 커널을 호출하지 않는다 (SYSTEM_STATS_SRS FR-STAT-8/9/11).
	sampler := sysstat.NewSampler(sysstat.NewReader(), sysstat.DefaultInterval, "/")

	// git 조회 앞의 single-flight + TTL 캐시 (GIT_SRS 묶음 C). 브라우저 창이
	// 여러 개여도 git 실행 횟수가 창 수에 비례하지 않게 한다 (FR-GIT-63).
	gitStore := store.NewStore(core.New())

	return builtDeps{
		deps: httpapi.Deps{
			Tools:         toolHub,
			Work:          wsMgr,
			Commands:      cmdHub,
			AttnTracker:   attnTracker,
			WhoAmI:        resolver,
			ToolIO:        pa,
			WorkIndex:     wa,
			Stats:         sampler,
			Runs:          runStore,
			Worktrees:     worktrees,
			UserWorktrees: userWorktrees,
			Git:           gitStore,
		},
		pm:          nil, // set by caller in direct mode
		attnTracker: attnTracker,
		wsMgr:       wsMgr,
		sampler:     sampler,
	}, nil
}

func main() {
	if code, ok := runtimebin.Dispatch(os.Args); ok {
		os.Exit(code)
	}

	log.SetFlags(log.Ldate | log.Ltime | log.Lmicroseconds)

	// 데몬 진입점. `dongminal d` 이거나 argv[0] basename 이 dongminald 인
	// 경우다 — 내부 진입점이므로 액션 목록에 없다 (FR-CLI-8). startDaemon()
	// 이 `exe d` 로 자식을 띄우는 계약을 유지한다.
	if (len(os.Args) > 1 && os.Args[1] == "d") || filepath.Base(os.Args[0]) == "dongminald" {
		home, err := resolveHome()
		if err != nil {
			log.Fatal(err)
		}
		boot.Run(home, cli.Version)
		return
	}

	os.Exit(cli.Dispatch(os.Args[1:], serve, os.Stdout, os.Stderr))
}

// resolveHome은 데몬 경로의 홈 해석이다. 액션 경로는 internal/ctl/cli 가
// 플래그까지 반영해 해석한 값을 serve 에 넘긴다.
func resolveHome() (string, error) {
	home := os.Getenv(dmenv.EnvHome)
	if home == "" {
		userHome, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("홈 디렉터리 확인 실패: %w", err)
		}
		home = filepath.Join(userHome, dmenv.DefaultHomeDir)
	}
	if err := os.MkdirAll(home, 0o755); err != nil {
		return "", fmt.Errorf("DONGMINAL_HOME 생성 실패: %w", err)
	}
	os.Setenv(dmenv.EnvHome, home)
	return home, nil
}

// serve는 웹 서버를 이 프로세스로 실행한다 (FR-FG-1). `dongminal start
// --foreground` 의 실체이며, 배경 모드는 자기 자신을 이 형태로 재실행한다.
func serve(home, host, port string) int {
	os.Setenv(dmenv.EnvHome, home)
	// helper multi-call(dmctl/edit/…)이 서버 주소를 찾는 값이다.
	os.Setenv(dmenv.EnvPort, port)
	os.Setenv(dmenv.EnvHost, host)

	if err := runtime.Install(filepath.Join(home, "bin")); err != nil {
		log.Printf("runtime install: %v", err)
		return 1
	}

	cfg := httpapi.Config{Port: port, DataDir: home, StaticFS: web.FS()}

	// Try daemon mode: connect to dongminald if available
	panedClient := dialOrStartDaemon(home)

	var bd builtDeps
	var err error
	var attnTracker *hub.AttnTracker
	if panedClient != nil {
		// Daemon mode: ToolClient implements ToolHub
		bd, err = buildDepsWithHub(cfg, panedClient)
		attnTracker = bd.attnTracker
		// Wire tool output → attention/activity detection (once per chunk in the
		// readLoop goroutine), and tool exit → activity cleanup.
		if attnTracker != nil {
			panedClient.OnOutput = attnTracker.FeedOutput
			// FR-ATL-3: 활동만 내리고 주의를 남기면 죽은 도구의 알람이 배지에
			// 남는다. 두 레이어를 같은 콜백에서 함께 정리한다 — Forget 이
			// 주의 해제(에지)와 상태 폐기를 한 번에 한다.
			panedClient.OnExit = func(toolID string, code int) {
				attnTracker.SetActivity(toolID, "ended", "", "")
				attnTracker.Forget(toolID)
			}
			// FR-TAN-7: PTY 를 dongminald 가 들고 있으므로 전경 이름은 IPC push
			// 로 온다. direct 모드의 WireForeground 와 같은 Broadcast 에 잇는다.
			panedClient.SetOnForeground(hub.BroadcastForeground(bd.deps.Commands))
			panedClient.FlushEarlyPushes()
		}
	} else {
		// Direct mode: ToolManager directly (backward compatible)
		bd, err = buildDeps(cfg)
	}
	if err != nil {
		// 스키마 미달은 사용자가 조치할 수 있는 상태다 — 스택 대신 안내를 낸다.
		if errors.Is(err, workspace.ErrSchemaTooOld) {
			log.Printf("workspace.json 이 구 스키마입니다.")
			log.Printf("  1) 서버와 데몬을 완전히 정지: dongminal stop --all")
			log.Printf("  2) 변환 내용 확인:            dongminal migrate --dry-run")
			log.Printf("  3) 변환 실행:                 dongminal migrate")
			return 1
		}
		log.Printf("buildDeps: %v", err)
		return 1
	}
	log.Printf("workspace manager ready rev=%d bytes=%d", bd.wsMgr.CurrentRev(), len(bd.wsMgr.Raw()))

	srv, err := httpapi.New(cfg, bd.deps)
	if err != nil {
		log.Printf("server init: %v", err)
		return 1
	}

	ctx, stop := signal.NotifyContext(context.Background(), platform.Current().Process.ShutdownSignals()...)
	defer stop()

	// Close daemon connection IMMEDIATELY on signal, before HTTP server shutdown.
	// This lets dongminald accept the new dongminal's connection right away.
	if panedClient != nil {
		go func() {
			<-ctx.Done()
			panedClient.Close()
		}()
	}

	if bd.pm != nil {
		bd.pm.StartAttentionSweeper(ctx.Done())
	}
	if bd.attnTracker != nil {
		bd.attnTracker.StartSweeper(ctx.Done())
	}
	if bd.sampler != nil {
		bd.sampler.Start(ctx.Done())
	}
	// FR-TAN-8: 전경 조회를 돌리는 주체. 두 모드가 이 하나를 쓴다 — List() 가
	// direct 에서는 ForegroundNames() 를 직접 부르고, 데몬에서는 list RPC 가
	// 되어 dongminald 안에서 같은 일을 시킨다.
	hub.StartForegroundPoll(bd.deps.Tools, ctx.Done())
	// UX_REVISION_SRS FR-DEL-14/18: 끝난 Run 과 조정자를 잃은 Run 을 거둔다.
	// 부팅 직후 한 번 돌므로 epoch 펜싱이 aborted 로 표시한 Run 도 여기서 사라진다.
	srv.StartRunReaper(ctx.Done())
	// RECONNECT_STORM_SRS FR-LOG-1: 서버가 자기 로그의 크기를 스스로 지킨다.
	// 폭주가 4.17 GB 를 만든 뒤에도 상한이 없다는 사실은 그대로였다.
	go cli.WatchLogSize(ctx.Done())
	exposure := "local-only"
	if host == "0.0.0.0" || host == "::" {
		exposure = "exposed to LAN"
	}
	// 플랫폼을 남긴다. 크로스플랫폼 문제 보고에서 가장 먼저 필요한 값이고,
	// WSL 은 리눅스와 빌드가 같아 로그 없이는 구별되지 않는다 (FR-XWS-1).
	log.Printf("dongminal starting on http://%s:%s (%s, platform=%s)",
		host, port, exposure, platform.Current().OS)

	runErr := srv.Run(ctx, host+":"+port)

	log.Printf("shutting down")
	// Close daemon connection FIRST so dongminald can accept new connections.
	if panedClient != nil {
		panedClient.Close()
	}
	if bd.pm != nil {
		// 문을 닫고 인플라이트 저장을 거둔 뒤에 마지막 상태를 쓴다 (boot.go 와 같다).
		bd.pm.StopSaving()
		bd.pm.SaveAll()
	}
	// 샌드박스 컨테이너는 **정지**한다. 지우지 않는 것은 창이 workspace 에 그대로
	// 남아 있기 때문이다 — 다음 기동에서 그 창을 열면 하던 자리로 돌아간다
	// (FR-SBX-44).
	if bd.deps.Sandbox != nil {
		bd.deps.Sandbox.Shutdown()
	}
	_ = bd.wsMgr.Close()
	if runErr != nil {
		log.Printf("server fatal: %v", runErr)
		return 1
	}
	log.Printf("server stopped")
	return 0
}
