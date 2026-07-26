package main

import (
	"context"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"dongminal/internal/adapters"
	"dongminal/internal/mcptool"
	"dongminal/internal/mcptool/tools"
	"dongminal/internal/runtime"
	"dongminal/internal/runtimebin"
	"dongminal/internal/server"
	"dongminal/internal/workspace"
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
// returning a PaneClient ready for use. Falls back to nil if the daemon
// is not available and the direct PaneManager path should be used.
//
// Goroutine lifecycle: DialPaneClientWithReconnect spawns a supervise()
// goroutine that watches for connection loss and reconnects with backoff.
// When the caller is done with the PaneClient, it MUST call Close(), which
// closes pc.closed and sets pc.stopped. Both the outer and inner reconnect
// loops in supervise() check <-pc.closed and pc.stopped in their select
// statements, ensuring the goroutine exits promptly. The wrapper goroutine
// here (lines 50-53) is fire-and-forget: it writes its result to a buffered
// channel and exits, regardless of whether the outer select consumes it.
func dialOrStartDaemon(home string) *server.PaneClient {
	sockPath := filepath.Join(home, "paned.sock")

	// spawn is handed to the reconnect supervisor so it can respawn dongminald
	// if it dies while we are running (FR-13).
	spawn := func() error { return startDaemon(home) }

	// Try connecting. DialPaneClient sends hello and waits for response.
	// If the old dongminal is still shutting down, this blocks until
	// dongminald processes the new connection. Add a timeout via goroutine.
	type result struct {
		pc  *server.PaneClient
		err error
	}
	ch := make(chan result, 1)
	go func() {
		pc, err := server.DialPaneClientWithReconnect(sockPath, spawn)
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
		pc, err := server.DialPaneClientWithReconnect(sockPath, spawn)
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

// runDaemon is the entry point for dongminald (DAEMON_SPLIT_SRS Phase 2).
// It creates a PaneManager, loads panes.json, and listens on a Unix socket.
func runDaemon(home string) {
	log.Printf("dongminald starting home=%s", home)

	if err := runtime.Install(filepath.Join(home, "bin")); err != nil {
		log.Fatalf("runtime install: %v", err)
	}

	pm := server.NewPaneManager(home, nil)
	pm.LoadAll()

	sockPath := filepath.Join(home, "paned.sock")
	pidPath := filepath.Join(home, "paned.pid")

	ps := server.NewPanedServer(pm, sockPath, pidPath)
	if err := ps.Listen(); err != nil {
		log.Fatalf("dongminald listen: %v", err)
	}
	defer ps.Close()

	log.Printf("dongminald listening on %s", sockPath)

	// Accept loop. Each connection is handled serially; when it drops,
	// the daemon waits for the next dongminal to connect.
	for {
		if err := ps.Accept(); err != nil {
			log.Printf("dongminald accept: %v", err)
			// Continue accepting — transient errors are not fatal.
		}
	}
}

type builtDeps struct {
	deps        server.Deps
	pm          *server.PaneManager
	attnTracker *server.AttnTracker
	wsMgr       *workspace.Manager
}

func buildDeps(cfg server.Config) (builtDeps, error) {
	pm := server.NewPaneManager(cfg.DataDir, nil)
	cmdHub := server.NewCommandHub()
	// Wire attention SSE before LoadAll so restored panes also get detection.
	server.WireAttention(pm, cmdHub)
	server.WireActivity(pm, cmdHub)

	bd, err := buildCommonDeps(cfg, pm, cmdHub, nil)
	if err != nil {
		return builtDeps{}, err
	}

	pm.SetInvalidator(bd.wsMgr.InvalidatePane)
	pm.LoadAll()
	bd.pm = pm

	return bd, nil
}

// buildDepsWithHub is the daemon-mode variant that uses a PaneHub (PaneClient)
// instead of a direct PaneManager. Attention/activity are not wired here
// because in daemon mode they are driven by output push events from dongminald.
func buildDepsWithHub(cfg server.Config, hub server.PaneHub) (builtDeps, error) {
	cmdHub := server.NewCommandHub()

	// Attention/activity tracker for daemon mode (in-memory in dongminal).
	// L1 OSC detection works from terminal escape sequences. L2 idle detection
	// uses the busy RPC to dongminald to check foreground process status, so a
	// bare prompt does not raise a bogus alarm (FR-15).
	attnTracker := server.NewAttnTracker(cmdHub, server.DefaultIdleMS())
	if bp, ok := hub.(interface{ Busy(string) bool }); ok {
		attnTracker.SetBusyProbe(bp.Busy)
	}

	return buildCommonDeps(cfg, hub, cmdHub, attnTracker)
}

// buildCommonDeps wires up the managers and MCP tool registry shared by both
// direct and daemon modes. panes provides Liveness (IsLive) for the workspace
// manager and PaneHub for tool adapters.
func buildCommonDeps(cfg server.Config, panes server.PaneHub, cmdHub *server.CommandHub, attnTracker *server.AttnTracker) (builtDeps, error) {

	wsMgr, err := workspace.New(panes, workspace.FilePersister{Path: dataPath(cfg.DataDir, "workspace.json")})
	if err != nil {
		return builtDeps{}, err
	}


	var pa adapters.Pane
	var resolver adapters.Client
	if _, ok := panes.(*server.PaneManager); ok {
		// Direct mode: use the concrete PaneManager for richer adapter access.
		pa = adapters.Pane{PM: panes.(*server.PaneManager)}
		resolver = adapters.Client{PM: panes.(*server.PaneManager)}
	} else {
		pa = adapters.Pane{Hub: panes}
		resolver = adapters.Client{Hub: panes}
	}

	reg := mcptool.NewRegistry()
	wa := adapters.Workspace{WS: wsMgr}
	mcptool.Register(reg, tools.ListPanesName, tools.ListPanesSpec,
		tools.ListPanesHandler(tools.ListPanesDeps{PM: pa, WS: wa}))
	mcptool.Register(reg, tools.ReadPaneScreenName, tools.ReadPaneScreenSpec,
		tools.ReadPaneScreenHandler(tools.ReadPaneDeps{PM: pa, WS: wa}))
	mcptool.Register(reg, tools.ReadPaneOutputName, tools.ReadPaneOutputSpec,
		tools.ReadPaneOutputHandler(tools.ReadPaneDeps{PM: pa, WS: wa}))
	mcptool.Register(reg, tools.SendInputName, tools.SendInputSpec,
		tools.SendInputHandler(tools.SendInputDeps{PM: pa, WS: wa}))
	mcptool.Register(reg, tools.SendAgentMessageName, tools.SendAgentMessageSpec,
		tools.SendAgentMessageHandler(tools.SendAgentMessageDeps{PM: pa, WS: wa}))
	mcptool.Register(reg, tools.WhoAmIName, tools.WhoAmISpec,
		tools.WhoAmIHandler(tools.WhoAmIDeps{PM: pa, WS: wa, Resolver: resolver}))
	mcptool.Register(reg, tools.WorkspaceCommandName, tools.WorkspaceCommandSpec,
		tools.WorkspaceCommandHandler(tools.WorkspaceCommandDeps{Broadcaster: adapters.Command{Hub: cmdHub}, WS: wa}))

	return builtDeps{
		deps: server.Deps{
			Panes:       panes,
			Work:        wsMgr,
			Tools:       reg,
			Commands:    cmdHub,
			AttnTracker: attnTracker,
			WhoAmI:      resolver,
		},
		pm:          nil, // set by caller in direct mode
		attnTracker: attnTracker,
		wsMgr:       wsMgr,
	}, nil
}

func main() {
	if code, ok := runtimebin.Dispatch(os.Args); ok {
		os.Exit(code)
	}

	// Daemon subcommand: "dongminal d" starts dongminald (PTY daemon).
	// The symlink "dongminald" is also handled: runtimebin.Dispatch
	// won't match it, so we fall through here and check argv[1].
	daemonMode := false
	if len(os.Args) > 1 && os.Args[1] == "d" {
		daemonMode = true
	}
	if filepath.Base(os.Args[0]) == "dongminald" {
		daemonMode = true
	}

	log.SetFlags(log.Ldate | log.Ltime | log.Lmicroseconds)

	// Resolve DONGMINAL_HOME early — both daemon and server need it.
	home := os.Getenv("DONGMINAL_HOME")
	if home == "" {
		userHome, err := os.UserHomeDir()
		if err != nil {
			log.Fatalf("홈 디렉터리 확인 실패: %v", err)
		}
		home = filepath.Join(userHome, ".dongminal")
	}
	if err := os.MkdirAll(home, 0o755); err != nil {
		log.Fatalf("DONGMINAL_HOME 생성 실패: %v", err)
	}
	os.Setenv("DONGMINAL_HOME", home)

	if daemonMode {
		runDaemon(home)
		return
	}

	port := os.Getenv("PORT")
	if port == "" {
		port = "58146"
	}
	os.Setenv("DONGMINAL_PORT", port)
	host := os.Getenv("DONGMINAL_HOST")
	if host == "" {
		host = "127.0.0.1"
	}
	if err := runtime.Install(filepath.Join(home, "bin")); err != nil {
		log.Fatalf("runtime install: %v", err)
	}

	cfg := server.Config{Port: port, DataDir: home, StaticFS: web.FS()}

	// Try daemon mode: connect to dongminald if available
	panedClient := dialOrStartDaemon(home)

	var bd builtDeps
	var err error
	var attnTracker *server.AttnTracker
	if panedClient != nil {
		// Daemon mode: PaneClient implements PaneHub
		bd, err = buildDepsWithHub(cfg, panedClient)
		attnTracker = bd.attnTracker
		// Wire pane output → attention/activity detection (once per chunk in the
		// readLoop goroutine), and pane exit → activity cleanup.
		if attnTracker != nil {
			panedClient.OnOutput = attnTracker.FeedOutput
			panedClient.OnExit = func(paneID string, code int) {
				attnTracker.SetActivity(paneID, "ended", "", "")
			}
			panedClient.FlushEarlyPushes()
		}
	} else {
		// Direct mode: PaneManager directly (backward compatible)
		bd, err = buildDeps(cfg)
	}
	if err != nil {
		log.Fatalf("buildDeps: %v", err)
	}
	log.Printf("workspace manager ready rev=%d bytes=%d", bd.wsMgr.CurrentRev(), len(bd.wsMgr.Raw()))

	srv, err := server.New(cfg, bd.deps)
	if err != nil {
		log.Fatalf("server init: %v", err)
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
		log.Fatalf("server fatal: %v", runErr)
	}
	log.Printf("server stopped")
}

