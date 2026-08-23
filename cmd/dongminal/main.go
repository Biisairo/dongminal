package main

import (
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

	"dongminal/internal/adapters"
	"dongminal/internal/mcptool"
	"dongminal/internal/mcptool/tools"
	"dongminal/internal/migrate"
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
func dialOrStartDaemon(home string) *server.ToolClient {
	sockPath := filepath.Join(home, "paned.sock")

	// spawn is handed to the reconnect supervisor so it can respawn dongminald
	// if it dies while we are running (FR-13).
	spawn := func() error { return startDaemon(home) }

	// Try connecting. DialToolClient sends hello and waits for response.
	// If the old dongminal is still shutting down, this blocks until
	// dongminald processes the new connection. Add a timeout via goroutine.
	type result struct {
		pc  *server.ToolClient
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

// referencedTools reads workspace.json and returns the tool ids its tabs point
// at (FR-EM-14). A missing file yields an empty set — nothing to restore. A
// parse/schema failure also yields an empty set after logging: respawning
// unreachable shells is worse than starting empty, and the schema gate in the
// web server will tell the user to migrate.
func referencedTools(path string) map[string]struct{} {
	blob, err := os.ReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("workspace 읽기: %v", err)
		}
		return map[string]struct{}{}
	}
	refs, err := workspace.ReferencedToolIDs(blob)
	if err != nil {
		log.Printf("workspace 참조 해석 실패 — 도구를 복원하지 않습니다: %v", err)
		return map[string]struct{}{}
	}
	return refs
}

// runMigrate executes the one-shot v2 entity-model migration and prints a
// report. Exits non-zero on failure so scripts can gate on it.
func runMigrate(home string, args []string) {
	dryRun := false
	for _, a := range args {
		switch a {
		case "--dry-run", "-n":
			dryRun = true
		default:
			fmt.Fprintf(os.Stderr, "unknown flag: %s\n사용법: dongminal migrate [--dry-run]\n", a)
			os.Exit(2)
		}
	}
	rep, err := migrate.Apply(home, dryRun)
	if err != nil {
		fmt.Fprintf(os.Stderr, "마이그레이션 실패: %v\n변경된 파일 없음.\n", err)
		os.Exit(1)
	}
	if rep.Empty {
		fmt.Printf("마이그레이션 대상 없음 (%s)\n", home)
		return
	}
	if dryRun {
		fmt.Println("[dry-run] 파일을 변경하지 않습니다.")
	}
	if rep.AlreadyMigrated {
		fmt.Println("이미 v2 스키마입니다. 참조 정리만 수행합니다.")
	}
	fmt.Printf("Window %d개, Tool %d개\n", rep.Windows, rep.Tools)
	if len(rep.Orphans) > 0 {
		fmt.Printf("고아 도구 %d개 폐기: %v\n", len(rep.Orphans), rep.Orphans)
	}
	if len(rep.GhostRefs) > 0 {
		fmt.Printf("agentsOrder 유령 참조 %d개 제거: %v\n", len(rep.GhostRefs), rep.GhostRefs)
	}
	if len(rep.ShortcutsRenamed) > 0 {
		fmt.Printf("단축키 id %d개 개명: %v\n", len(rep.ShortcutsRenamed), rep.ShortcutsRenamed)
	}
	if len(rep.BrokenRefs) > 0 {
		fmt.Printf("경고: 탭이 참조하나 도구가 없음 %d개: %v\n", len(rep.BrokenRefs), rep.BrokenRefs)
	}
	if !dryRun {
		fmt.Println("백업: *.v1.bak (workspace/tools/settings)")
	}
}

// runDaemon is the entry point for dongminald (DAEMON_SPLIT_SRS Phase 2).
// It creates a ToolManager, loads tools.json, and listens on a Unix socket.
func runDaemon(home string) {
	log.Printf("dongminald starting home=%s", home)

	if err := runtime.Install(filepath.Join(home, "bin")); err != nil {
		log.Fatalf("runtime install: %v", err)
	}

	pm := server.NewToolManager(home, nil)
	pm.LoadAll(referencedTools(dataPath(home, "workspace.json")))

	sockPath := filepath.Join(home, "paned.sock")
	pidPath := filepath.Join(home, "paned.pid")

	ps := server.NewPanedServer(pm, sockPath, pidPath)
	if err := ps.Listen(); err != nil {
		log.Fatalf("dongminald listen: %v", err)
	}

	// On signal, close the listener to unblock Accept() and save state.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM, syscall.SIGHUP)
	defer stop()

	go func() {
		<-ctx.Done()
		ps.Close()
	}()

	log.Printf("dongminald listening on %s", sockPath)

	// Accept loop. Each connection is handled serially; when it drops,
	// the daemon waits for the next dongminal to connect.
	for {
		if err := ps.Accept(); err != nil {
			select {
			case <-ctx.Done():
				log.Printf("dongminald shutting down, saving %d tools...", len(pm.Snapshot()))
				pm.SaveAll()
				return
			default:
			}
			log.Printf("dongminald accept: %v", err)
			// Continue accepting — transient errors are not fatal.
		}
	}
}

type builtDeps struct {
	deps        server.Deps
	pm          *server.ToolManager
	attnTracker *server.AttnTracker
	wsMgr       *workspace.Manager
}

func buildDeps(cfg server.Config) (builtDeps, error) {
	pm := server.NewToolManager(cfg.DataDir, nil)
	cmdHub := server.NewCommandHub()
	// Wire attention SSE before LoadAll so restored tools also get detection.
	server.WireAttention(pm, cmdHub)
	server.WireActivity(pm, cmdHub)

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
func buildDepsWithHub(cfg server.Config, hub server.ToolHub) (builtDeps, error) {
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
// direct and daemon modes. toolHub provides Liveness (IsLive) for the workspace
// manager and ToolHub for tool adapters.
func buildCommonDeps(cfg server.Config, toolHub server.ToolHub, cmdHub *server.CommandHub, attnTracker *server.AttnTracker) (builtDeps, error) {

	wsMgr, err := workspace.New(toolHub, workspace.FilePersister{Path: dataPath(cfg.DataDir, "workspace.json")})
	if err != nil {
		return builtDeps{}, err
	}

	var pa adapters.Tool
	var resolver adapters.Client
	if _, ok := toolHub.(*server.ToolManager); ok {
		// Direct mode: use the concrete ToolManager for richer adapter access.
		pa = adapters.Tool{PM: toolHub.(*server.ToolManager)}
		resolver = adapters.Client{PM: toolHub.(*server.ToolManager)}
	} else {
		pa = adapters.Tool{Hub: toolHub}
		resolver = adapters.Client{Hub: toolHub}
	}

	reg := mcptool.NewRegistry()
	wa := adapters.Workspace{WS: wsMgr}
	mcptool.Register(reg, tools.ListWorkspaceName, tools.ListWorkspaceSpec,
		tools.ListWorkspaceHandler(tools.ListWorkspaceDeps{PM: pa, WS: wa}))
	mcptool.Register(reg, tools.ReadScreenName, tools.ReadScreenSpec,
		tools.ReadScreenHandler(tools.ReadToolDeps{PM: pa, WS: wa}))
	mcptool.Register(reg, tools.ReadOutputName, tools.ReadOutputSpec,
		tools.ReadOutputHandler(tools.ReadToolDeps{PM: pa, WS: wa}))
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
			Tools:       toolHub,
			Work:        wsMgr,
			MCPTools:    reg,
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

	// Migrate subcommand: "dongminal migrate [--dry-run]" converts
	// workspace.json/tools.json to the v2 entity model
	// (ENTITY_MODEL_RESTRUCTURE_SRS P1). Runs standalone and exits.
	if len(os.Args) > 1 && os.Args[1] == "migrate" {
		runMigrate(home, os.Args[2:])
		return
	}

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
			log.Printf("  1) 서버와 데몬을 완전히 정지: ./scripts/stop.sh --all")
			log.Printf("  2) 변환 내용 확인:            ./scripts/migrate.sh --dry-run")
			log.Printf("  3) 변환 실행:                 ./scripts/migrate.sh")
			os.Exit(1)
		}
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
