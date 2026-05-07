package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"dongminal/internal/adapters"
	"dongminal/internal/mcptool"
	"dongminal/internal/mcptool/tools"
	"dongminal/internal/mdscroll"
	"dongminal/internal/runtime"
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

type builtDeps struct {
	deps  server.Deps
	pm    *server.PaneManager
	csm   *server.CodeServerManager
	wsMgr *workspace.Manager
	msMgr *mdscroll.Manager
}

func buildDeps(cfg server.Config) (builtDeps, error) {
	pm := server.NewPaneManager(cfg.DataDir, nil)
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

	hub := server.NewCommandHub()
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
		tools.WorkspaceCommandHandler(tools.WorkspaceCommandDeps{Broadcaster: adapters.Command{Hub: hub}}))

	return builtDeps{
		deps: server.Deps{
			Panes:    pm,
			CS:       csm,
			Work:     wsMgr,
			Tools:    reg,
			Commands: hub,
			MdScroll: msMgr,
		},
		pm:    pm,
		csm:   csm,
		wsMgr: wsMgr,
		msMgr: msMgr,
	}, nil
}

func main() {
	log.SetFlags(log.Ldate | log.Ltime | log.Lmicroseconds)

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	os.Setenv("DONGMINAL_PORT", port)
	host := os.Getenv("DONGMINAL_HOST")
	if host == "" {
		host = "127.0.0.1"
	}
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
	if err := runtime.Install(filepath.Join(home, "bin")); err != nil {
		log.Fatalf("runtime install: %v", err)
	}

	cfg := server.Config{Port: port, DataDir: home, StaticFS: web.FS()}

	bd, err := buildDeps(cfg)
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
	exposure := "local-only"
	if host == "0.0.0.0" || host == "::" {
		exposure = "exposed to LAN"
	}
	log.Printf("dongminal starting on http://%s:%s (%s)", host, port, exposure)

	runErr := srv.Run(ctx, host+":"+port)

	log.Printf("shutting down")
	bd.pm.SaveAll()
	_ = bd.wsMgr.Close()
	_ = bd.msMgr.Close()
	bd.csm.StopAll()
	if runErr != nil {
		log.Fatalf("server fatal: %v", runErr)
	}
	log.Printf("server stopped")
}
