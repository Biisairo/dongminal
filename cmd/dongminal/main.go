package main

import (
	"dongminal/internal/webserver/hub"

	"dongminal/internal/shared/toolhub"

	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"dongminal/internal/ctl/cli"
	"dongminal/internal/daemon/boot"
	"dongminal/internal/helper/runtimebin"
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
	sockPath := filepath.Join(home, "paned.sock")

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
		pc, err := toolclient.DialPaneClientWithReconnect(sockPath, spawn)
		ch <- result{pc, err}
	}()

	select {
	case r := <-ch:
		if r.err == nil {
			log.Printf("connected to dongminald at %s", sockPath)
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
		pc, err := toolclient.DialPaneClientWithReconnect(sockPath, spawn)
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
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
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

func buildDeps(cfg httpapi.Config) (builtDeps, error) {
	pm := toolhub.NewToolManager(cfg.DataDir, nil)
	cmdHub := hub.NewCommandHub()
	// Wire attention SSE before LoadAll so restored tools also get detection.
	hub.WireAttention(pm, cmdHub)
	hub.WireActivity(pm, cmdHub)

	bd, err := buildCommonDeps(cfg, pm, cmdHub, nil)
	if err != nil {
		return builtDeps{}, err
	}

	pm.SetInvalidator(bd.wsMgr.InvalidateTool)
	refs, err := workspace.ReferencedToolIDs(bd.wsMgr.Raw())
	if err != nil {
		return builtDeps{}, fmt.Errorf("workspace 참조 해석: %w", err)
	}
	pm.LoadAll(refs)
	bd.pm = pm

	return bd, nil
}

// buildDepsWithHub is the daemon-mode variant that uses a ToolHub (ToolClient)
// instead of a direct ToolManager. Attention/activity are not wired here
// because in daemon mode they are driven by output push events from dongminald.
func buildDepsWithHub(cfg httpapi.Config, toolHub toolhub.ToolHub) (builtDeps, error) {
	cmdHub := hub.NewCommandHub()

	// Attention/activity tracker for daemon mode (in-memory in dongminal).
	// L1 OSC detection works from terminal escape sequences. L2 idle detection
	// uses the busy RPC to dongminald to check foreground process status, so a
	// bare prompt does not raise a bogus alarm (FR-15).
	attnTracker := hub.NewAttnTracker(cmdHub, hub.DefaultIdleMS())
	if bp, ok := toolHub.(interface{ Busy(string) bool }); ok {
		attnTracker.SetBusyProbe(bp.Busy)
	}

	return buildCommonDeps(cfg, toolHub, cmdHub, attnTracker)
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

	// 상태바 지표 샘플러. 커널을 주기적으로 읽어 스냅샷을 유지하므로 /api/stats 가
	// 요청 경로에서 커널을 호출하지 않는다 (SYSTEM_STATS_SRS FR-STAT-8/9/11).
	sampler := sysstat.NewSampler(sysstat.NewReader(), sysstat.DefaultInterval, "/")

	// git 조회 앞의 single-flight + TTL 캐시 (GIT_SRS 묶음 C). 브라우저 창이
	// 여러 개여도 git 실행 횟수가 창 수에 비례하지 않게 한다 (FR-GIT-63).
	gitStore := store.NewStore(core.New())

	return builtDeps{
		deps: httpapi.Deps{
			Tools:       toolHub,
			Work:        wsMgr,
			Commands:    cmdHub,
			AttnTracker: attnTracker,
			WhoAmI:      resolver,
			ToolIO:      pa,
			WorkIndex:   wa,
			Stats:       sampler,
			Runs:        runStore,
			Worktrees:   worktrees,
			Git:         gitStore,
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
		boot.Run(home)
		return
	}

	os.Exit(cli.Dispatch(os.Args[1:], serve, os.Stdout, os.Stderr))
}

// resolveHome은 데몬 경로의 홈 해석이다. 액션 경로는 internal/ctl/cli 가
// 플래그까지 반영해 해석한 값을 serve 에 넘긴다.
func resolveHome() (string, error) {
	home := os.Getenv("DONGMINAL_HOME")
	if home == "" {
		userHome, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("홈 디렉터리 확인 실패: %w", err)
		}
		home = filepath.Join(userHome, ".dongminal")
	}
	if err := os.MkdirAll(home, 0o755); err != nil {
		return "", fmt.Errorf("DONGMINAL_HOME 생성 실패: %w", err)
	}
	os.Setenv("DONGMINAL_HOME", home)
	return home, nil
}

// serve는 웹 서버를 이 프로세스로 실행한다 (FR-FG-1). `dongminal start
// --foreground` 의 실체이며, 배경 모드는 자기 자신을 이 형태로 재실행한다.
func serve(home, host, port string) int {
	os.Setenv("DONGMINAL_HOME", home)
	// helper multi-call(dmctl/edit/…)이 서버 주소를 찾는 값이다.
	os.Setenv("DONGMINAL_PORT", port)
	os.Setenv("DONGMINAL_HOST", host)

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
			panedClient.OnExit = func(toolID string, code int) {
				attnTracker.SetActivity(toolID, "ended", "", "")
			}
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

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM, syscall.SIGHUP)
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
	exposure := "local-only"
	if host == "0.0.0.0" || host == "::" {
		exposure = "exposed to LAN"
	}
	log.Printf("dongminal starting on http://%s:%s (%s)", host, port, exposure)

	runErr := srv.Run(ctx, host+":"+port)

	log.Printf("shutting down")
	// Close daemon connection FIRST so dongminald can accept new connections.
	if panedClient != nil {
		panedClient.Close()
	}
	if bd.pm != nil {
		bd.pm.SaveAll()
	}
	_ = bd.wsMgr.Close()
	if runErr != nil {
		log.Printf("server fatal: %v", runErr)
		return 1
	}
	log.Printf("server stopped")
	return 0
}
