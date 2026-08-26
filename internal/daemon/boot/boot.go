// Package boot는 dongminald 프로세스의 진입점이다. 진입점 판별(`dongminal d`
// 또는 argv[0]=="dongminald")은 composition root 의 책임이라 main 에 남고,
// 여기부터가 데몬 자신의 코드다.
package boot

import (
	"context"
	"log"
	"os"
	"path/filepath"
	"syscall"

	"os/signal"

	"dongminal/internal/daemon/ipc"
	"dongminal/internal/shared/runtime"
	"dongminal/internal/shared/toolhub"
	"dongminal/internal/shared/workspace"
)

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

// Run is the entry point for dongminald (DAEMON_SPLIT_SRS Phase 2).
// It creates a ToolManager, loads tools.json, and listens on a Unix socket.
func Run(home string) {
	log.Printf("dongminald starting home=%s", home)

	if err := runtime.Install(filepath.Join(home, "bin")); err != nil {
		log.Fatalf("runtime install: %v", err)
	}

	pm := toolhub.NewToolManager(home, nil)
	pm.LoadAll(referencedTools(filepath.Join(home, "workspace.json")))

	sockPath := filepath.Join(home, "paned.sock")
	pidPath := filepath.Join(home, "paned.pid")

	ps := ipc.NewPanedServer(pm, sockPath, pidPath)
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
