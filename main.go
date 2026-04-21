package main

import (
	"context"
	"embed"
	"io/fs"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"dongminal/internal/mcptool"
	"dongminal/internal/mcptool/tools"
	"dongminal/internal/server"
	"dongminal/internal/workspace"
)

//go:embed static/*
var staticFiles embed.FS

func dataPath(dataDir, name string) string {
	dir := dataDir
	if dir == "" {
		dir = "."
	}
	return filepath.Join(dir, name)
}

func initBinDir() {
	binDir := filepath.Join(".", "bin")
	os.MkdirAll(binDir, 0755)
	dlScript := `#!/bin/sh
path=$(realpath "$1" 2>/dev/null || echo "$1")
printf '\033]777;Download;%s\007' "$path"
`
	os.WriteFile(filepath.Join(binDir, "download"), []byte(dlScript), 0755)

	editScript := `#!/bin/sh
# edit — code-server 런처 (dongminal)
port="${DONGMINAL_PORT:-8080}"
base="http://127.0.0.1:${port}/api/code-server"

print_help() {
  cat <<'HLP'
사용법:
  edit <path>              해당 경로로 새 code-server 열기
  edit -l, --list          열린 code-server 목록 (URL 클릭 → 열기)
  edit -s, --stop <id|all> 인스턴스 종료 (id 또는 all)
  edit -h, --help, ?       이 도움말
HLP
}

case "${1:-}" in
  "" | -h | --help | "?" )
    print_help
    exit 0
    ;;
  -l | --list )
    resp=$(curl -sf "$base") || { echo "edit: 서버 연결 실패 (port=$port)" >&2; exit 1; }
    printf '\033]777;CodeServerList;%s\007' "$resp"
    exit 0
    ;;
  -s | --stop )
    target="${2:-}"
    if [ -z "$target" ]; then
      echo "사용법: edit -s <id|all>" >&2
      exit 1
    fi
    if [ "$target" = "all" ]; then
      ids=$(curl -sf "$base" | grep -oE '"id":"[^"]*"' | sed 's/"id":"\([^"]*\)"/\1/')
      if [ -z "$ids" ]; then
        echo "열린 인스턴스 없음"
        exit 0
      fi
      for i in $ids; do
        curl -sf -X POST "$base/stop?id=$i" >/dev/null && echo "stopped $i"
      done
    else
      curl -sf -X POST "$base/stop?id=$target" >/dev/null \
        && echo "stopped $target" \
        || { echo "edit: 실패 ($target)" >&2; exit 1; }
    fi
    exit 0
    ;;
  -* )
    echo "edit: 알 수 없는 옵션: $1" >&2
    print_help >&2
    exit 1
    ;;
esac

target="$1"
if [ ! -e "$target" ]; then
  echo "edit: 경로 없음: $target" >&2
  exit 1
fi
if [ -d "$target" ]; then
  abs=$(cd "$target" && pwd)
else
  abs=$(cd "$(dirname "$target")" && printf '%s/%s' "$(pwd)" "$(basename "$target")")
fi
enc=$(printf '%s' "$abs" | sed 's/ /%20/g')
resp=$(curl -sf -X POST "$base?path=${enc}")
if [ -z "$resp" ]; then
  echo "edit: 서버에 연결할 수 없음 (port=$port)" >&2
  exit 1
fi
id=$(printf '%s' "$resp" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
cs_path=$(printf '%s' "$resp" | sed -n 's/.*"path":"\([^"]*\)".*/\1/p')
folder=$(printf '%s' "$resp" | sed -n 's/.*"folder":"\([^"]*\)".*/\1/p')
if [ -z "$id" ] || [ -z "$cs_path" ]; then
  echo "edit: 실패 — $resp" >&2
  exit 1
fi
printf '\033]777;OpenCodeServer;%s|%s|%s\007' "$id" "$cs_path" "$folder"
printf 'VSCode(code-server) 열기: %s (folder=%s)\n' "$cs_path" "$folder"
`
	os.WriteFile(filepath.Join(binDir, "edit"), []byte(editScript), 0755)

	zdotdir := filepath.Join(binDir, "zdotdir")
	os.MkdirAll(zdotdir, 0755)
	zshrc := `export HISTFILE="$HOME/.zsh_history"
export SHELL_SESSIONS_DISABLE=1
export ZSH_COMPDUMP="$HOME/.zcompdump"
[ -f "$HOME/.zshrc" ] && source "$HOME/.zshrc"
_rt_cwd_hook() { printf '\033]777;Cwd;%s\007' "$PWD" }
autoload -Uz add-zsh-hook
add-zsh-hook precmd _rt_cwd_hook
add-zsh-hook chpwd _rt_cwd_hook
`
	os.WriteFile(filepath.Join(zdotdir, ".zshrc"), []byte(zshrc), 0644)

	bashHook := `_rt_cwd_hook() { printf '\033]777;Cwd;%s\007' "$PWD"; }
PROMPT_COMMAND="_rt_cwd_hook${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
`
	os.WriteFile(filepath.Join(binDir, "bash-hook.sh"), []byte(bashHook), 0644)
}

type fsPersister struct{ path string }

func (p fsPersister) Read() ([]byte, error) { return os.ReadFile(p.path) }
func (p fsPersister) Write(b []byte) error  { return os.WriteFile(p.path, b, 0644) }

type builtDeps struct {
	deps  server.Deps
	pm    *server.PaneManager
	csm   *server.CodeServerManager
	wsMgr *workspace.Manager
}

func buildDeps(cfg server.Config) (builtDeps, error) {
	pm := server.NewPaneManager(cfg.DataDir, nil)
	csm := server.NewCodeServerManager()
	wsMgr, err := workspace.New(pm, fsPersister{path: dataPath(cfg.DataDir, "workspace.json")})
	if err != nil {
		return builtDeps{}, err
	}
	pm.SetInvalidator(wsMgr.InvalidatePane)

	pm.LoadAll()

	hub := server.NewCommandHub()
	reg := mcptool.NewRegistry()
	pa := paneAdapter{pm: pm}
	wa := workspaceAdapter{ws: wsMgr}
	reg.Register(tools.ListPanes{PM: pa, WS: wa})
	reg.Register(tools.ReadPaneScreen{PM: pa, WS: wa})
	reg.Register(tools.ReadPaneOutput{PM: pa, WS: wa})
	reg.Register(tools.SendInput{PM: pa, WS: wa})
	reg.Register(tools.SendAgentMessage{PM: pa, WS: wa})
	mcptool.Register(reg, tools.WhoAmIName, tools.WhoAmISpec,
		tools.WhoAmIHandler(tools.WhoAmIDeps{PM: pa, WS: wa, Resolver: clientResolver{pm: pm}}))
	reg.Register(tools.WorkspaceCommand{Broadcaster: cmdBroadcaster{hub: hub}})

	return builtDeps{
		deps: server.Deps{
			Panes:    pm,
			CS:       csm,
			Work:     wsMgr,
			Tools:    reg,
			Commands: hub,
		},
		pm:    pm,
		csm:   csm,
		wsMgr: wsMgr,
	}, nil
}

func main() {
	log.SetFlags(log.Ldate | log.Ltime | log.Lmicroseconds)

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	os.Setenv("DONGMINAL_PORT", port)
	dataDir := os.Getenv("DATA_DIR")
	if dataDir != "" {
		if err := os.MkdirAll(dataDir, 0755); err != nil {
			log.Fatalf("DATA_DIR 생성 실패: %v", err)
		}
	}
	initBinDir()

	staticFS, _ := fs.Sub(staticFiles, "static")
	cfg := server.Config{Port: port, DataDir: dataDir, StaticFS: staticFS}

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

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	log.Printf("dongminal starting on :%s", port)

	runErr := srv.Run(ctx, ":"+port)

	log.Printf("shutting down")
	bd.pm.SaveAll()
	srv.PersistSettings()
	bd.csm.StopAll()
	if runErr != nil {
		log.Fatalf("server fatal: %v", runErr)
	}
	log.Printf("server stopped")
}
