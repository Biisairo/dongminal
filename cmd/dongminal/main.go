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
	"dongminal/internal/mdscroll"
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
	csm         *server.CodeServerManager
	wsMgr       *workspace.Manager
	msMgr       *mdscroll.Manager
}

func buildDeps(cfg server.Config) (builtDeps, error) {
	pm := server.NewPaneManager(cfg.DataDir, nil)
	hub := server.NewCommandHub()
	// Wire attention SSE before LoadAll so restored panes also get detection.
	server.WireAttention(pm, hub)
	server.WireActivity(pm, hub)
	csm := server.NewCodeServerManager()
	wsMgr, err := workspace.New(pm, workspace.FilePersister{Path: dataPath(cfg.DataDir, "workspace.json")})
	if err != nil {
		return builtDeps{}, err
	}
	pm.SetInvalidator(wsMgr.InvalidatePane)
	pm.LoadAll()

	msMgr, err := mdscroll.New(mdscroll.FilePersister{Path: dataPath(cfg.DataDir, "mdscroll.json")})
	if err != nil {
		return builtDeps{}, err
	}
	wsMgr.OnIndexUpdate = func() {
		msMgr.Reconcile(wsMgr.TabIDs())
	}
	if removed := msMgr.Reconcile(wsMgr.TabIDs()); removed > 0 {
		log.Printf("mdscroll: pruned %d stale tab(s) at startup", removed)
	}

	reg := mcptool.NewRegistry()
	pa := adapters.Pane{PM: pm}
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
		tools.WhoAmIHandler(tools.WhoAmIDeps{PM: pa, WS: wa, Resolver: adapters.Client{PM: pm}}))
	mcptool.Register(reg, tools.WorkspaceCommandName, tools.WorkspaceCommandSpec,
		tools.WorkspaceCommandHandler(tools.WorkspaceCommandDeps{Broadcaster: adapters.Command{Hub: hub}, WS: wa}))

	return builtDeps{
		deps: server.Deps{
			Panes:    pm,
			CS:       csm,
			Work:     wsMgr,
			Tools:    reg,
			Commands: hub,
			MdScroll: msMgr,
			WhoAmI:   adapters.Client{PM: pm},
		},
		pm:    pm,
		csm:   csm,
		wsMgr: wsMgr,
		msMgr: msMgr,
	}, nil
}

// buildDepsWithHub is the daemon-mode variant that uses a PaneHub (PaneClient)
// instead of a direct PaneManager. Attention/activity are not wired here
// because in daemon mode they are driven by output push events from dongminald.
func buildDepsWithHub(cfg server.Config, hub server.PaneHub) (builtDeps, error) {
	cmdHub := server.NewCommandHub()
	csm := server.NewCodeServerManager()

	// Attention/activity tracker for daemon mode (in-memory in dongminal).
	// L1 OSC detection works from terminal escape sequences. L2 idle detection
	// uses the busy RPC to dongminald to check foreground process status, so a
	// bare prompt does not raise a bogus alarm (FR-15).
	attnTracker := server.NewAttnTracker(cmdHub, server.DefaultIdleMS())
	if bp, ok := hub.(interface{ Busy(string) bool }); ok {
		attnTracker.SetBusyProbe(bp.Busy)
	}

	// Wrap PaneHub.IsLive as workspace.Liveness
	live := paneHubLiveness{hub}
	wsMgr, err := workspace.New(live, workspace.FilePersister{Path: dataPath(cfg.DataDir, "workspace.json")})
	if err != nil {
		return builtDeps{}, err
	}

	msMgr, err := mdscroll.New(mdscroll.FilePersister{Path: dataPath(cfg.DataDir, "mdscroll.json")})
	if err != nil {
		return builtDeps{}, err
	}

	reg := mcptool.NewRegistry()
	pa := adapters.Pane{PM: nil, Hub: hub}
	wa := adapters.Workspace{WS: wsMgr}
	// Daemon-mode whoami resolver: matches the client PID's ancestor chain
	// against pane shell PIDs from the hub's list (FR-16).
	resolver := adapters.Client{Hub: hub}
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
			Panes:       hub,
			CS:          csm,
			Work:        wsMgr,
			Tools:       reg,
			Commands:    cmdHub,
			MdScroll:    msMgr,
			AttnTracker: attnTracker,
			WhoAmI:      resolver,
		},
		pm:          nil,
		attnTracker: attnTracker,
		csm:         csm,
		wsMgr:       wsMgr,
		msMgr:       msMgr,
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
	go bd.csm.Watchdog()

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
	_ = bd.msMgr.Close()
	bd.csm.StopAll()
	if runErr != nil {
		log.Fatalf("server fatal: %v", runErr)
	}
	log.Printf("server stopped")
}

// paneHubLiveness adapts PaneHub.IsLive to workspace.Liveness.
type paneHubLiveness struct {
	hub server.PaneHub
}

func (l paneHubLiveness) IsLive(paneID string) bool { return l.hub.IsLive(paneID) }
